//! Draft tools #1-#6 and the batch tools #20 / #21 (spec_mcp-tools.md 5, 6,
//! 7-2 .. 7-7 and the TASK-18 batch section). The save / approve rules live
//! in `domain::draft_intake` and are shared by the single and batch flows.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse, require_role};
use crate::domain::catalog::{self, CatKind};
use crate::domain::draft_intake as di;
use crate::domain::drafts::{
    self as dd, DraftPatch, DraftRow, apply_patch, draft_view, validate_payload,
};
use crate::domain::dto::{DraftPayload, DraftView};
use crate::domain::images::{self, NewImage};
use crate::mcp::file_arg::{self, ImageArg, ImageList, OpenAIFile};
use crate::mcp::result::{self, LedgerInfo, Warning, envelope, yen};
use crate::store::{self, NewDraft, NewDraftImageStatus, ReopenError};

fn draft_meta(url: Option<Value>) -> Option<Value> {
    url.map(|u| json!({ "images": { "draft_image": u } }))
}

async fn view_of(
    c: &Call<'_>,
    row: &DraftRow,
    history: &HashSet<i64>,
) -> Result<DraftView, rmcp::model::CallToolResult> {
    draft_view(
        c.db(),
        row,
        c.now,
        c.env.cfg.image.fetch_timeout_secs,
        history,
    )
    .await
    .map_err(result::internal)
}

async fn reload(c: &Call<'_>, id: i64) -> Result<DraftRow, rmcp::model::CallToolResult> {
    dd::load_draft(c.db(), id, c.auth.user_id)
        .await
        .map_err(result::internal)?
        .ok_or_else(result::not_found)
}

async fn meta_for(c: &Call<'_>, row: &DraftRow) -> Option<Value> {
    match (row.image_id, row.status.as_str()) {
        (Some(img), "pending") => draft_meta(c.image_url(img).await),
        _ => None,
    }
}

/// Short summary line of a draft for content text.
fn summary(v: &DraftView) -> String {
    let p = &v.payload;
    let store = p
        .store_name
        .clone()
        .or(p.store_name_raw.clone())
        .unwrap_or_else(|| "店名未入力".into());
    let date = p
        .purchased_on
        .clone()
        .unwrap_or_else(|| "日付未入力".into());
    format!(
        "下書き #{}（rev {}）: {} / {} / 明細{}行 合計 {}",
        v.draft_id,
        v.revision,
        store,
        date,
        p.items.len(),
        yen(v.resolution.items_total)
    )
}

fn dup_line(v: &DraftView) -> Option<String> {
    if v.possible_duplicates.is_empty() {
        return None;
    }
    let list: Vec<String> = v
        .possible_duplicates
        .iter()
        .map(|d| {
            let k = if d.kind == "draft" {
                "下書き"
            } else {
                "レシート"
            };
            format!("{k} #{}", d.id)
        })
        .collect();
    Some(format!(
        "重複の可能性: {}。ユーザーに確認し、不要な方を破棄・削除してください。",
        list.join(" / ")
    ))
}

fn categories_hint_needed(v: &DraftView) -> bool {
    v.resolution
        .categories
        .iter()
        .any(|c| c.status == "unknown" && c.input.is_some())
}

async fn categories_hint(c: &Call<'_>, ledger_id: i64) -> Option<Value> {
    let mut conn = c.db().acquire().await.ok()?;
    let item = catalog::category_paths(&mut conn, CatKind::Item, ledger_id)
        .await
        .ok()?;
    let store = catalog::category_paths(&mut conn, CatKind::Store, ledger_id)
        .await
        .ok()?;
    Some(json!({ "item": item, "store": store }))
}

// ---------------------------------------------------------------------------
// #1 create_receipt_draft

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    input_kind: String,
    #[serde(default)]
    #[allow(dead_code)]
    receipt_image: Option<Value>,
    #[serde(default)]
    reported_filename: Option<String>,
    #[serde(default)]
    reported_taken_at: Option<String>,
    payload: DraftPayload,
    #[serde(default)]
    ledger_id: Option<i64>,
}

/// `domain::draft_intake` warning -> wire `Warning`.
fn warning_of(w: di::IntakeWarning) -> Warning {
    Warning::new(&w.code, w.message, w.detail)
}

/// Same, tagged with the entry/draft it belongs to (batch tools).
fn warning_with_ids(mut w: di::IntakeWarning, entry_index: usize, draft_id: i64) -> Warning {
    let mut detail = w.detail.unwrap_or_else(|| json!({}));
    if let Value::Object(m) = &mut detail {
        m.insert("entry_index".into(), json!(entry_index));
        m.insert("draft_id".into(), json!(draft_id));
    }
    w.detail = Some(detail);
    warning_of(w)
}

/// First text block of an already-built error result (to reuse the exact
/// wording of the shared resolution helpers in per-item results).
fn first_text(r: &rmcp::model::CallToolResult) -> String {
    r.content
        .iter()
        .find_map(|b| match b {
            rmcp::model::ContentBlock::Text(t) => Some(t.text.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

pub async fn create(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: CreateArgs = parse(args)?;
    let image = file_arg::classify(args, "receipt_image");
    let manual = match a.input_kind.as_str() {
        "manual" => true,
        "image" => false,
        _ => {
            return Err(result::invalid(&[
                "input_kind: \"image\" か \"manual\"".into()
            ]));
        }
    };
    if manual && image.is_present() {
        return Err(result::err(
            "手動入力では画像を渡さない。画像があるなら input_kind=image にしてください。",
        ));
    }
    let ledger = c.target_writer(a.ledger_id).await?;
    let prepared = {
        let mut conn = c.db().acquire().await.map_err(result::internal)?;
        match di::prepare(
            &mut conn,
            ledger.id,
            c.limits(),
            di::PrepareInput {
                payload: a.payload,
                reported_filename: a.reported_filename.as_deref(),
                reported_taken_at: a.reported_taken_at.as_deref(),
            },
        )
        .await
        {
            Ok(p) => p,
            Err(di::PrepareFail::Invalid(errs)) => return Err(result::invalid(&errs)),
            Err(di::PrepareFail::Db(e)) => return Err(result::internal(e)),
        }
    };
    let di::Prepared {
        mut payload,
        reported_taken_at,
        purchased_missing,
        history,
        warnings: intake_warnings,
    } = prepared;
    let mut warnings: Vec<Warning> = intake_warnings.into_iter().map(warning_of).collect();
    let (status, reason, file) = di::image_plan(manual, &image);
    // I1 / I2 / I4: the draft is committed before any fetch
    let draft_id = store::create_draft(
        c.db(),
        &payload,
        &NewDraft {
            ledger_id: ledger.id,
            user_id: c.auth.user_id,
            image_status: status,
            image_unavailable_reason: reason,
            source_file_id: file.as_ref().map(|f| f.file_id.clone()),
            reported_filename: a.reported_filename.clone(),
            reported_taken_at: reported_taken_at.clone(),
            batch_id: None,
        },
        c.now,
    )
    .await
    .map_err(result::internal)?;
    // I3a / I3b: fetch + convert once, inside the deadline
    let mut exif_taken: Option<String> = None;
    if let Some(f) = &file {
        let outcome = images::fetch_and_process(
            &c.env.http,
            &f.download_url,
            &c.env.cfg.image,
            &c.env.decode_gate,
        )
        .await;
        let now = crate::auth::session::now_ms();
        exif_taken = di::settle_image(
            c.db(),
            &c.env.image_root,
            &outcome,
            &[draft_id],
            &NewImage {
                ledger_id: ledger.id,
                uploaded_by: c.auth.user_id,
                source_file_id: Some(&f.file_id),
                source_host: None, // filled from the fetched response
                reported_filename: a.reported_filename.as_deref(),
                reported_taken_at: reported_taken_at.as_deref(),
            },
            now,
        )
        .await
        .map_err(result::internal)?;
    }
    // purchased_on from EXIF (preferred) when the printed date was missing
    if let Some(w) = di::finalize_purchased_on(
        c.db(),
        draft_id,
        c.auth.user_id,
        &mut payload,
        purchased_missing,
        exif_taken.as_deref(),
        reported_taken_at.as_deref(),
        c.now,
    )
    .await
    .map_err(result::internal)?
    {
        warnings.push(warning_of(w));
    }
    let row = reload(c, draft_id).await?;
    let view = view_of(c, &row, &history).await?;
    let mut lines = vec![format!("{}。{}", summary(&view), ledger.text_suffix())];
    match row.image_status.as_str() {
        "attached" => lines.push("画像を保存しました。".into()),
        "unavailable" => lines.push("画像なしで保存しました。".into()),
        _ => {}
    }
    if let Some(d) = dup_line(&view) {
        lines.push(d);
    }
    lines.push(
        "内容を確認し、修正があれば update_receipt_draft、問題なければユーザーの承認後に approve_receipt_draft（revision を渡す）を呼んでください。".into(),
    );
    let mut body = json!({ "draft": view });
    if categories_hint_needed(&view)
        && let Some(h) = categories_hint(c, ledger.id).await
    {
        body["categories_hint"] = h;
        lines.push("未知のカテゴリがあります。categories_hint の候補から update_receipt_draft で直してください。".into());
    }
    let meta = meta_for(c, &row).await;
    Ok(result::ok(
        lines.join("\n"),
        envelope("draft", Some(&ledger), &warnings, body),
        meta,
    ))
}

// ---------------------------------------------------------------------------
// #2 update_receipt_draft

#[derive(Debug, Deserialize)]
struct UpdateArgs {
    draft_id: i64,
    #[serde(default)]
    ledger_id: Option<i64>,
    #[serde(flatten)]
    patch: Map<String, Value>,
}

pub async fn update(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: UpdateArgs = parse(args)?;
    let patch: DraftPatch = serde_json::from_value(Value::Object(a.patch))
        .map_err(|e| result::invalid(&[format!("引数: {e}")]))?;
    let (row, ledger) = c.draft(a.draft_id, a.ledger_id).await?;
    require_role(&ledger)?;
    if row.status != "pending" {
        return Err(conflict(c, &row, &ledger).await);
    }
    let (mut payload, changed) =
        apply_patch(&row.payload(), &patch).map_err(|e| result::invalid(&e))?;
    // draft labels: keep the stored payload in the normalized form (TASK-21),
    // same as the intake path
    if let Some(colors) = payload.label_colors.as_mut() {
        crate::domain::labels::normalize_colors(colors);
        if colors.is_empty() {
            payload.label_colors = None;
        }
    }
    let errs = validate_payload(&payload, c.limits());
    if !errs.is_empty() {
        return Err(result::invalid(&errs));
    }
    let rev = store::update_draft_payload(c.db(), row.id, c.auth.user_id, &payload, c.now)
        .await
        .map_err(result::internal)?;
    if rev.is_none() {
        let row = reload(c, row.id).await?;
        return Err(conflict(c, &row, &ledger).await);
    }
    let row = reload(c, row.id).await?;
    let view = view_of(c, &row, &HashSet::new()).await?;
    let mut lines = vec![
        format!("{}。{}", summary(&view), ledger.text_suffix()),
        format!("変更: {}", changed.join(", ")),
    ];
    if let Some(d) = dup_line(&view) {
        lines.push(d);
    }
    lines.push("承認されたら approve_receipt_draft に revision を渡してください。".into());
    let mut body = json!({ "draft": view, "changed": changed });
    if categories_hint_needed(&view)
        && let Some(h) = categories_hint(c, ledger.id).await
    {
        body["categories_hint"] = h;
    }
    let meta = meta_for(c, &row).await;
    Ok(result::ok(
        lines.join("\n"),
        envelope("draft", Some(&ledger), &[], body),
        meta,
    ))
}

/// Conflict hint for a non-pending draft: state + guidance (spec 4). Shared
/// by the single and batch approve flows.
fn conflict_hint(row: &DraftRow) -> String {
    match row.status.as_str() {
        "approved" => format!(
            "この下書きは確定済みです（レシート #{}）。修正は update_receipt を使ってください。",
            row.approved_receipt_id
                .map_or("-".into(), |r| r.to_string())
        ),
        "discarded" => {
            "この下書きは破棄済みです。作り直すなら reopen_receipt_draft を使ってください。".into()
        }
        "expired" => {
            "この下書きは期限切れです。作り直すなら reopen_receipt_draft を使ってください。".into()
        }
        s => format!("この下書きは {s} です。"),
    }
}

/// Conflict for a non-pending draft: state + guidance (spec 4).
async fn conflict(
    c: &Call<'_>,
    row: &DraftRow,
    ledger: &LedgerInfo,
) -> rmcp::model::CallToolResult {
    let hint = conflict_hint(row);
    let structured = match view_of(c, row, &HashSet::new()).await {
        Ok(v) => Some(envelope("draft", Some(ledger), &[], json!({ "draft": v }))),
        Err(_) => None,
    };
    result::err_with(hint, structured, None)
}

// ---------------------------------------------------------------------------
// #3 approve_receipt_draft

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApproveArgs {
    draft_id: i64,
    revision: i64,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn approve(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: ApproveArgs = parse(args)?;
    let (row, ledger) = c.draft(a.draft_id, a.ledger_id).await?;
    require_role(&ledger)?;
    let ledger_ctx = di::ApproveLedger {
        id: ledger.id,
        name: ledger.name.clone(),
        active_id: ledger.active_id,
    };
    let out = di::approve_one(c.db(), c.auth.user_id, &row, &ledger_ctx, a.revision, c.now)
        .await
        .map_err(result::internal)?;
    match out.kind {
        di::ApproveKind::Invalid => return Err(result::invalid(&out.problems)),
        di::ApproveKind::StaleRevision => {
            let current = out.current_revision.unwrap_or(row.revision);
            let row = reload(c, row.id).await?;
            let view = view_of(c, &row, &HashSet::new()).await?;
            let meta = meta_for(c, &row).await;
            return Err(result::err_with(
                format!(
                    "表示中の内容が古くなっています（現在 rev {current}）。最新内容を確認してから承認してください。"
                ),
                Some(envelope(
                    "draft",
                    Some(&ledger),
                    &[],
                    json!({ "draft": view }),
                )),
                meta,
            ));
        }
        di::ApproveKind::Conflict => {
            let row = reload(c, row.id).await?;
            return Err(conflict(c, &row, &ledger).await);
        }
        // raced with a removal / role change after the resolution above
        di::ApproveKind::NotFound => return Err(result::not_found()),
        di::ApproveKind::Forbidden => return Err(result::viewer_only()),
        di::ApproveKind::Approved | di::ApproveKind::Idempotent => {}
    }
    let was_approved = out.kind == di::ApproveKind::Idempotent;
    let receipt_id = out.receipt_id.unwrap_or(0);
    let warnings: Vec<Warning> = out.warnings.into_iter().map(warning_of).collect();
    let row = reload(c, row.id).await?;
    let view = view_of(c, &row, &HashSet::new()).await?;
    let mut lines = vec![format!(
        "{}登録しました（家計簿 {} / レシート #{}）。{}",
        if was_approved { "既に" } else { "" },
        ledger.name,
        receipt_id,
        ledger.text_suffix()
    )];
    for w in &warnings {
        lines.push(format!("注意: {}", w.message));
    }
    lines.push(c.receipt_web_line(receipt_id));
    Ok(result::ok(
        lines.join("\n"),
        envelope(
            "draft",
            Some(&ledger),
            &warnings,
            json!({ "draft": view, "receipt_id": receipt_id, "idempotent_hit": was_approved }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #4 discard_receipt_draft

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DraftIdArgs {
    draft_id: i64,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn discard(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: DraftIdArgs = parse(args)?;
    let (row, ledger) = c.draft(a.draft_id, a.ledger_id).await?;
    require_role(&ledger)?;
    let status_body =
        |r: &DraftRow| json!({ "draft_id": r.id, "status": r.status, "revision": r.revision });
    match row.status.as_str() {
        "pending" => {
            store::discard_draft(c.db(), row.id, c.auth.user_id, c.now)
                .await
                .map_err(result::internal)?;
            let row = reload(c, row.id).await?;
            Ok(result::ok(
                format!(
                    "下書き #{} を破棄しました。{}\n30日以内なら reopen_receipt_draft で作り直せます。",
                    row.id,
                    ledger.text_suffix()
                ),
                envelope("draft_status", Some(&ledger), &[], status_body(&row)),
                None,
            ))
        }
        "discarded" => Ok(result::ok(
            format!(
                "下書き #{} は既に破棄済みです。{}",
                row.id,
                ledger.text_suffix()
            ),
            envelope("draft_status", Some(&ledger), &[], status_body(&row)),
            None,
        )),
        "expired" => Ok(result::ok(
            format!(
                "下書き #{} は期限切れです（破棄と同じ扱い）。{}",
                row.id,
                ledger.text_suffix()
            ),
            envelope("draft_status", Some(&ledger), &[], status_body(&row)),
            None,
        )),
        _ => Err(result::err_with(
            "確定済みです。delete_receipt を使ってください。".into(),
            Some(envelope(
                "draft_status",
                Some(&ledger),
                &[],
                status_body(&row),
            )),
            None,
        )),
    }
}

// ---------------------------------------------------------------------------
// #5 reopen_receipt_draft

pub async fn reopen(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: DraftIdArgs = parse(args)?;
    let (row, ledger) = c.draft(a.draft_id, a.ledger_id).await?;
    require_role(&ledger)?;
    let new_id = match store::reopen_draft(c.db(), row.id, c.auth.user_id, c.now).await {
        Ok(id) => id,
        Err(ReopenError::NotFound) => return Err(result::not_found()),
        Err(ReopenError::NotClosed(s)) if s == "pending" => {
            return Err(result::err(
                "この下書きは未確定のままです。reopen せずに update_receipt_draft でそのまま修正できます。",
            ));
        }
        Err(ReopenError::NotClosed(_)) => {
            return Err(result::err(
                "この下書きは確定済みです。修正は update_receipt を使ってください。",
            ));
        }
        Err(e) => return Err(result::internal(e)),
    };
    let new_row = reload(c, new_id).await?;
    let view = view_of(c, &new_row, &HashSet::new()).await?;
    Ok(result::ok(
        format!(
            "下書き #{} を作り直しました（元: #{}）。{}。{}\n画像は引き継いでいません。",
            new_id,
            row.id,
            summary(&view),
            ledger.text_suffix()
        ),
        envelope(
            "draft",
            Some(&ledger),
            &[],
            json!({ "draft": view, "reopened_from": row.id }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #6 get_receipt_drafts

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetArgs {
    #[serde(default)]
    draft_id: Option<i64>,
    #[serde(default)]
    status: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn get(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: GetArgs = parse(args)?;
    if let Some(id) = a.draft_id {
        let (row, ledger) = c.draft(id, a.ledger_id).await?;
        let view = view_of(c, &row, &HashSet::new()).await?;
        let meta = meta_for(c, &row).await;
        let mut lines = vec![format!(
            "{}（{}）。{}",
            summary(&view),
            view.status,
            ledger.text_suffix()
        )];
        lines.push(format!("画像: {}", view.image.display));
        if let Some(d) = dup_line(&view) {
            lines.push(d);
        }
        return Ok(result::ok(
            lines.join("\n"),
            envelope("draft", Some(&ledger), &[], json!({ "draft": view })),
            meta,
        ));
    }
    let statuses = a.status.unwrap_or_else(|| vec!["pending".into()]);
    if statuses.is_empty()
        || statuses
            .iter()
            .any(|s| !matches!(s.as_str(), "pending" | "approved" | "discarded" | "expired"))
    {
        return Err(result::invalid(&[
            "status: pending / approved / discarded / expired の配列".into(),
        ]));
    }
    let lim = c.limits();
    let limit = a
        .limit
        .unwrap_or(lim.drafts_default_limit)
        .clamp(1, lim.drafts_max_limit);
    let ledger = match a.ledger_id {
        Some(l) => Some(c.target(Some(l)).await?),
        None => None,
    };
    let rows = dd::list_drafts(
        c.db(),
        c.auth.user_id,
        ledger.as_ref().map(|l| l.id),
        &statuses,
        limit,
        c.now,
        c.env.cfg.image.fetch_timeout_secs,
    )
    .await
    .map_err(result::internal)?;
    let text = if rows.is_empty() {
        "該当する下書きはありません。".to_string()
    } else {
        let names: Vec<String> = rows
            .iter()
            .map(|r| {
                format!(
                    "#{}（{}）",
                    r["draft_id"],
                    r["ledger"]["name"].as_str().unwrap_or("")
                )
            })
            .collect();
        format!("下書き {} 件: {}", rows.len(), names.join(", "))
    };
    let text = match &ledger {
        Some(l) => format!("{text}\n{}", l.text_suffix()),
        None => format!("{text}\n（全家計簿の自分の下書き）"),
    };
    Ok(result::ok(
        text,
        envelope(
            "draft_list",
            ledger.as_ref(),
            &[],
            json!({ "drafts": rows }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #20 create_receipt_drafts / #21 approve_receipt_drafts (TASK-18)

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBatchArgs {
    // kept as a raw Value: the lenient classification happens in file_arg
    #[serde(default)]
    #[allow(dead_code)]
    receipt_images: Option<Value>,
    drafts: Vec<Value>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchEntry {
    input_kind: String,
    #[serde(default)]
    image_index: Option<i64>,
    #[serde(default)]
    reported_filename: Option<String>,
    #[serde(default)]
    reported_taken_at: Option<String>,
    payload: DraftPayload,
}

/// One saved entry of a batch call (entry order preserved).
struct BatchSaved {
    index: usize,
    draft_id: i64,
    manual: bool,
    image_index: Option<i64>,
    reported_filename: Option<String>,
    prepared: di::Prepared,
    status: NewDraftImageStatus,
    reason: Option<&'static str>,
    file: Option<OpenAIFile>,
}

pub async fn create_batch(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: CreateBatchArgs = parse(args)?;
    if a.drafts.is_empty() {
        return Err(result::invalid(&["drafts: 1件以上指定してください".into()]));
    }
    // 0. whole-call preprocessing: the same conditions as the single tool's
    // argument errors (spec 4), everything else stays per-entry
    let ledger = c.target_writer(a.ledger_id).await?;
    let lim = c.limits();
    let list = ImageList::classify(args, "receipt_images");

    // 1. per-entry preprocessing; failing entries are not saved, the rest
    // continues (design 1-5: only the single-tool pre-checks reject)
    let mut saved: Vec<BatchSaved> = Vec::new();
    let mut rejected: Vec<(usize, Vec<String>)> = Vec::new();
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    for (i, v) in a.drafts.iter().enumerate() {
        if i >= lim.batch_max_drafts {
            rejected.push((
                i,
                vec![format!(
                    "件数上限: 1回の呼び出しは{}件までです。この要素は保存していません",
                    lim.batch_max_drafts
                )],
            ));
            continue;
        }
        let e: BatchEntry = match serde_json::from_value(v.clone()) {
            Ok(e) => e,
            Err(err) => {
                rejected.push((i, vec![format!("要素の形式が不正です: {err}")]));
                continue;
            }
        };
        let manual = match e.input_kind.as_str() {
            "manual" => true,
            "image" => false,
            _ => {
                rejected.push((i, vec!["input_kind: \"image\" か \"manual\"".into()]));
                continue;
            }
        };
        // the single-tool input mix-up, per element
        if manual && e.image_index.is_some() {
            rejected.push((
                i,
                vec!["手動入力では image_index を渡さない。画像があるなら input_kind=image にしてください。".into()],
            ));
            continue;
        }
        let prepared = match di::prepare(
            &mut conn,
            ledger.id,
            lim,
            di::PrepareInput {
                payload: e.payload,
                reported_filename: e.reported_filename.as_deref(),
                reported_taken_at: e.reported_taken_at.as_deref(),
            },
        )
        .await
        {
            Ok(p) => p,
            Err(di::PrepareFail::Invalid(errs)) => {
                rejected.push((i, errs));
                continue;
            }
            Err(di::PrepareFail::Db(e)) => return Err(result::internal(e)),
        };
        saved.push(BatchSaved {
            index: i,
            draft_id: 0,
            manual,
            image_index: e.image_index,
            reported_filename: e.reported_filename.clone(),
            prepared,
            status: NewDraftImageStatus::None,
            reason: None,
            file: None,
        });
    }
    drop(conn);
    if saved.is_empty() {
        return Err(result::err_with(
            reject_text(&rejected),
            Some(envelope(
                "draft_batch",
                Some(&ledger),
                &[],
                json!({
                    "batch_id": null,
                    "drafts": [],
                    "entry_draft_ids": a.drafts.iter().map(|_| Value::Null).collect::<Vec<_>>(),
                    "rejected": reject_json(&rejected),
                    "images": [],
                }),
            )),
            None,
        ));
    }

    // 2. image plan: index resolution with the sole-image-entry rule (1-4)
    let sole_image_entry = saved.iter().filter(|e| !e.manual).count() == 1;
    for e in &mut saved {
        let arg = list.resolve(e.image_index, sole_image_entry);
        let (status, reason, file) = di::image_plan(e.manual, &arg);
        e.status = status;
        e.reason = reason;
        e.file = file;
    }

    // 3. all saved drafts in one transaction, before any fetch (P3)
    let batch_id = di::new_batch_id(c.now);
    let insert: Vec<(DraftPayload, NewDraft)> = saved
        .iter()
        .map(|e| {
            (
                e.prepared.payload.clone(),
                NewDraft {
                    ledger_id: ledger.id,
                    user_id: c.auth.user_id,
                    image_status: e.status,
                    image_unavailable_reason: e.reason,
                    source_file_id: e.file.as_ref().map(|f| f.file_id.clone()),
                    reported_filename: e.reported_filename.clone(),
                    reported_taken_at: e.prepared.reported_taken_at.clone(),
                    batch_id: Some(batch_id.clone()),
                },
            )
        })
        .collect();
    let ids = store::create_drafts(c.db(), &insert, c.now)
        .await
        .map_err(result::internal)?;
    for (e, id) in saved.iter_mut().zip(ids) {
        e.draft_id = id;
    }

    // 4. fetch each referenced valid file once per file_id, outside the tx,
    //    inside the concurrency cap and the whole-call deadline (2-5)
    let mut groups: Vec<(String, OpenAIFile, Vec<usize>)> = Vec::new();
    for (ei, e) in saved.iter().enumerate() {
        if let Some(f) = &e.file {
            match groups.iter_mut().find(|(fid, _, _)| fid == &f.file_id) {
                Some((_, _, idxs)) => idxs.push(ei),
                None => groups.push((f.file_id.clone(), f.clone(), vec![ei])),
            }
        }
    }
    let files: Vec<(String, String)> = groups
        .iter()
        .map(|(fid, f, _)| (fid.clone(), f.download_url.clone()))
        .collect();
    let fetched = if files.is_empty() {
        Vec::new()
    } else {
        images::fetch_images(
            &c.env.http,
            &c.env.decode_gate,
            &c.env.cfg.image,
            files,
            images::BatchFetchOpts {
                fetch_concurrency: c.env.cfg.image.batch_fetch_concurrency,
                deadline: std::time::Instant::now()
                    + std::time::Duration::from_secs(c.env.cfg.image.batch_fetch_deadline_secs),
            },
        )
        .await
    };
    let outcomes: std::collections::HashMap<
        String,
        Result<(images::FetchedMeta, images::Processed), images::ImageFail>,
    > = fetched.into_iter().collect();

    // 5. settle each file on its referencing drafts (short tx per file),
    //    then the per-draft EXIF purchased_on fix
    let settle_now = crate::auth::session::now_ms();
    let mut exif_by_file: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for (fid, file, idxs) in &groups {
        let draft_ids: Vec<i64> = idxs.iter().map(|&ei| saved[ei].draft_id).collect();
        let first = &saved[idxs[0]];
        let Some(outcome) = outcomes.get(fid) else {
            continue;
        };
        let exif = di::settle_image(
            c.db(),
            &c.env.image_root,
            outcome,
            &draft_ids,
            &NewImage {
                ledger_id: ledger.id,
                uploaded_by: c.auth.user_id,
                source_file_id: Some(&file.file_id),
                source_host: None, // filled from the fetched response
                reported_filename: first.reported_filename.as_deref(),
                reported_taken_at: first.prepared.reported_taken_at.as_deref(),
            },
            settle_now,
        )
        .await
        .map_err(result::internal)?;
        exif_by_file.insert(fid.clone(), exif);
    }
    let mut warnings: Vec<Warning> = Vec::new();
    for e in &mut saved {
        let index = e.index;
        let draft_id = e.draft_id;
        for w in e.prepared.warnings.drain(..) {
            warnings.push(warning_with_ids(w, index, draft_id));
        }
        let mut payload = e.prepared.payload.clone();
        let exif = e
            .file
            .as_ref()
            .and_then(|f| exif_by_file.get(&f.file_id))
            .and_then(|o| o.as_deref());
        if let Some(w) = di::finalize_purchased_on(
            c.db(),
            draft_id,
            c.auth.user_id,
            &mut payload,
            e.prepared.purchased_missing,
            exif,
            e.prepared.reported_taken_at.as_deref(),
            c.now,
        )
        .await
        .map_err(result::internal)?
        {
            warnings.push(warning_with_ids(w, index, draft_id));
        }
        e.prepared.payload = payload;
    }

    // 6. reload everything and build the response (7)
    let mut views: Vec<DraftView> = Vec::with_capacity(saved.len());
    let mut meta_drafts = serde_json::Map::new();
    let mut hint_needed = false;
    let mut attached = 0usize;
    // image state per draft after settle: the images[] outcome follows what
    // the drafts actually got (a store failure leaves them fetch_failed)
    let mut image_state: std::collections::HashMap<i64, (bool, Option<String>)> =
        std::collections::HashMap::new();
    for e in &saved {
        let row = reload(c, e.draft_id).await?;
        if row.image_status == "attached" {
            attached += 1;
        }
        image_state.insert(
            e.draft_id,
            (
                row.image_status == "attached",
                row.image_unavailable_reason.clone(),
            ),
        );
        let view = view_of(c, &row, &e.prepared.history).await?;
        hint_needed |= categories_hint_needed(&view);
        if row.image_id.is_some()
            && row.status == "pending"
            && let Some(u) = c.image_url(row.image_id.unwrap()).await
        {
            meta_drafts.insert(e.draft_id.to_string(), u);
        }
        views.push(view);
    }
    // entry_draft_ids: id per input entry, null for the rejected ones
    let mut entry_draft_ids: Vec<Value> = vec![Value::Null; a.drafts.len()];
    for e in &saved {
        entry_draft_ids[e.index] = json!(e.draft_id);
    }
    // images[]: one record per receipt_images index (1-4). Unreferenced
    // indexes are recorded without a fetch and without any warning.
    let mut images_out: Vec<Value> = Vec::new();
    if let Some(items) = list.items() {
        for (i, element) in items.iter().enumerate() {
            let mut draft_ids: Vec<i64> = Vec::new();
            for e in &saved {
                if !e.manual && list.resolve_index(e.image_index, sole_image_entry) == Some(i) {
                    draft_ids.push(e.draft_id);
                }
            }
            if draft_ids.is_empty() {
                images_out.push(json!({ "index": i, "outcome": "unreferenced", "draft_ids": [] }));
                continue;
            }
            // attached when a referencing draft actually holds the image;
            // otherwise the reason recorded on the drafts (the fetch/convert
            // reason, or fetch_failed when the store failed)
            let any_attached = draft_ids
                .iter()
                .any(|id| image_state.get(id).is_some_and(|(a, _)| *a));
            let reason: Option<String> = if any_attached {
                None
            } else {
                let from_draft = draft_ids
                    .iter()
                    .find_map(|id| image_state.get(id).and_then(|(_, r)| r.clone()));
                Some(from_draft.unwrap_or_else(|| match element {
                    ImageArg::File(f) => match outcomes.get(&f.file_id) {
                        Some(Err(fail)) => fail.reason().to_string(),
                        _ => "fetch_failed".to_string(),
                    },
                    other => other.unavailable_reason().to_string(),
                }))
            };
            let outcome = if reason.is_none() {
                "attached"
            } else {
                "unavailable"
            };
            let mut record = json!({ "index": i, "outcome": outcome, "draft_ids": draft_ids });
            if let Some(r) = reason {
                record["reason"] = json!(r);
            }
            images_out.push(record);
        }
    }
    let n = saved.len();
    let imageless = n - attached;
    let mut lines = vec![format!(
        "家計簿 {} に下書きを {} 件作成しました（画像あり {} 件 / 画像なし {} 件）。",
        ledger.name, n, attached, imageless
    )];
    for v in &views {
        lines.push(summary(v));
    }
    if imageless > 0 {
        lines.push("画像なしで保存しました。".into());
    }
    for (i, errs) in rejected.iter().filter(|(i, _)| *i < lim.batch_max_drafts) {
        lines.push(reject_line(*i, errs));
    }
    if a.drafts.len() > lim.batch_max_drafts {
        lines.push(format!(
            "件数上限（{}件）を超えた分（drafts[{}] 以降）は保存していません。その分は別の呼び出しで作成してください。",
            lim.batch_max_drafts,
            lim.batch_max_drafts
        ));
    }
    for v in &views {
        if let Some(d) = dup_line(v) {
            lines.push(d);
        }
    }
    lines.push(
        "内容を確認し、修正は update_receipt_draft（draft_id を指定）、承認されたら approve_receipt_drafts（各 revision を渡す）。".into(),
    );
    if hint_needed {
        lines.push("未知のカテゴリがあります。categories_hint の候補から update_receipt_draft で直してください。".into());
    }
    let mut body = json!({
        "batch_id": batch_id,
        "drafts": views,
        "entry_draft_ids": entry_draft_ids,
        "rejected": reject_json(&rejected),
        "images": images_out,
    });
    if hint_needed && let Some(h) = categories_hint(c, ledger.id).await {
        body["categories_hint"] = h;
    }
    let meta = if meta_drafts.is_empty() {
        None
    } else {
        Some(json!({ "images": { "drafts": meta_drafts } }))
    };
    Ok(result::ok(
        lines.join("\n"),
        envelope("draft_batch", Some(&ledger), &warnings, body),
        meta,
    ))
}

fn reject_json(rejected: &[(usize, Vec<String>)]) -> Value {
    json!(
        rejected
            .iter()
            .map(|(i, errs)| json!({ "entry_index": i, "errors": errs }))
            .collect::<Vec<_>>()
    )
}

/// Content-text line of one not-saved element (design 1-5): the input fix,
/// never a resend prompt.
fn reject_line(i: usize, errs: &[String]) -> String {
    format!(
        "drafts[{i}] は入力エラーのため保存していません: {}。直した内容でその要素だけを作成してください（保存済みの下書きを含めて呼び直さない）。",
        errs.join("、")
    )
}

fn reject_text(rejected: &[(usize, Vec<String>)]) -> String {
    let mut lines = vec!["下書きは作成できませんでした。".to_string()];
    for (i, errs) in rejected {
        lines.push(reject_line(*i, errs));
    }
    lines.join("\n")
}

// ---------------------------------------------------------------------------
// #21 approve_receipt_drafts

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApproveBatchItem {
    draft_id: i64,
    revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApproveBatchArgs {
    items: Vec<ApproveBatchItem>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn approve_batch(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: ApproveBatchArgs = parse(args)?;
    let lim = c.limits();
    // whole-call validation errors (design 2-4): approve resends lose
    // nothing, so the size limit is a hard error with split guidance
    if a.items.is_empty() {
        return Err(result::invalid(&[format!(
            "items: 1〜{}件の承認対象を指定してください",
            lim.batch_max_approve
        )]));
    }
    if a.items.len() > lim.batch_max_approve {
        return Err(result::invalid(&[format!(
            "items: 1回で承認できるのは{}件までです。それより多い場合は分けて呼んでください",
            lim.batch_max_approve
        )]));
    }
    let mut seen = HashSet::new();
    if a.items.iter().any(|i| !seen.insert(i.draft_id)) {
        return Err(result::invalid(&[
            "items: 同じ draft_id が複数回出ています。1件ずつ指定してください".into(),
        ]));
    }
    let not_found_text = first_text(&result::not_found());
    let mut results: Vec<Value> = Vec::with_capacity(a.items.len());
    let mut warnings: Vec<Warning> = Vec::new();
    let mut resolved: Vec<(DraftRow, LedgerInfo)> = Vec::new();
    let mut success = 0usize;
    for item in &a.items {
        // resolution and role check shared with the single tool
        let (row, ledger) = match c.draft(item.draft_id, a.ledger_id).await {
            Ok(v) => v,
            Err(r) => {
                let msg = first_text(&r);
                let outcome = if msg == not_found_text {
                    "not_found"
                } else {
                    "invalid"
                };
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": outcome,
                    "receipt_id": null, "revision": item.revision, "message": msg,
                }));
                continue;
            }
        };
        if let Err(r) = require_role(&ledger) {
            results.push(json!({
                "draft_id": item.draft_id, "outcome": "forbidden",
                "receipt_id": null, "revision": item.revision, "message": first_text(&r),
            }));
            continue;
        }
        // one ledger per call: later items on another ledger are invalid
        if let Some((_, base)) = resolved.first()
            && base.id != row.ledger_id
        {
            results.push(json!({
                "draft_id": item.draft_id, "outcome": "invalid",
                "receipt_id": null, "revision": item.revision,
                "message": "別の家計簿の下書きは分けて承認してください。",
            }));
            continue;
        }
        let ledger_ctx = di::ApproveLedger {
            id: ledger.id,
            name: ledger.name.clone(),
            active_id: ledger.active_id,
        };
        let out = di::approve_one(
            c.db(),
            c.auth.user_id,
            &row,
            &ledger_ctx,
            item.revision,
            c.now,
        )
        .await
        .map_err(result::internal)?;
        // raced with a removal / role change after the resolution above:
        // reported on this item only, like the resolution-time outcomes
        match out.kind {
            di::ApproveKind::NotFound => {
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": "not_found",
                    "receipt_id": null, "revision": item.revision, "message": not_found_text,
                }));
                continue;
            }
            di::ApproveKind::Forbidden => {
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": "forbidden",
                    "receipt_id": null, "revision": item.revision,
                    "message": first_text(&result::viewer_only()),
                }));
                continue;
            }
            _ => {}
        }
        for w in out.warnings {
            warnings.push(warning_with_draft_id(w, row.id));
        }
        match out.kind {
            di::ApproveKind::NotFound | di::ApproveKind::Forbidden => unreachable!(),
            di::ApproveKind::Approved | di::ApproveKind::Idempotent => {
                success += 1;
                results.push(json!({
                    "draft_id": item.draft_id,
                    "outcome": if out.kind == di::ApproveKind::Idempotent { "idempotent" } else { "approved" },
                    "receipt_id": out.receipt_id, "revision": item.revision,
                }));
            }
            di::ApproveKind::StaleRevision => {
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": "stale_revision",
                    "receipt_id": null,
                    "revision": out.current_revision.unwrap_or(item.revision),
                    "message": format!(
                        "表示中の内容が古くなっています（現在 rev {}）。最新内容を確認してから承認してください。",
                        out.current_revision.unwrap_or(item.revision)
                    ),
                }));
            }
            di::ApproveKind::Conflict => {
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": "conflict",
                    "receipt_id": null, "revision": item.revision,
                    "message": conflict_hint(&row),
                }));
            }
            di::ApproveKind::Invalid => {
                results.push(json!({
                    "draft_id": item.draft_id, "outcome": "invalid",
                    "receipt_id": null, "revision": item.revision,
                    "message": out.problems.join(" / "),
                }));
            }
        }
        resolved.push((row, ledger));
    }
    // drafts: the post-processing state of every resolved item
    let mut views: Vec<DraftView> = Vec::with_capacity(resolved.len());
    for (row, _) in &resolved {
        let row = reload(c, row.id).await?;
        views.push(view_of(c, &row, &HashSet::new()).await?);
    }
    let ledger_info = resolved.first().map(|(_, l)| l.clone());
    let mut lines = Vec::new();
    if success > 0 {
        lines.push(format!(
            "{} 件を確定しました（家計簿 {}）。",
            success,
            ledger_info.as_ref().map_or("", |l| l.name.as_str())
        ));
    } else {
        lines.push("どの下書きも確定できませんでした。".into());
    }
    for r in &results {
        if matches!(r["outcome"].as_str(), Some("approved") | Some("idempotent")) {
            continue;
        }
        lines.push(format!(
            "下書き #{}: {}",
            r["draft_id"],
            r["message"]
                .as_str()
                .unwrap_or(r["outcome"].as_str().unwrap_or(""))
        ));
    }
    for w in &warnings {
        lines.push(format!("注意: {}", w.message));
    }
    for r in &results {
        if !matches!(r["outcome"].as_str(), Some("approved") | Some("idempotent")) {
            continue;
        }
        if let Some(rid) = r["receipt_id"].as_i64() {
            lines.push(c.receipt_web_line(rid));
        }
    }
    let body = json!({ "batch_id": null, "drafts": views, "results": results });
    let structured = envelope("draft_batch", ledger_info.as_ref(), &warnings, body);
    if success > 0 {
        Ok(result::ok(lines.join("\n"), structured, None))
    } else {
        Err(result::err_with(lines.join("\n"), Some(structured), None))
    }
}

/// Same as [`warning_with_ids`] for the approve flow (draft id only).
fn warning_with_draft_id(mut w: di::IntakeWarning, draft_id: i64) -> Warning {
    let mut detail = w.detail.unwrap_or_else(|| json!({}));
    if let Value::Object(m) = &mut detail {
        m.insert("draft_id".into(), json!(draft_id));
    }
    w.detail = Some(detail);
    warning_of(w)
}
