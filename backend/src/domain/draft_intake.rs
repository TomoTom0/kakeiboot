//! Shared draft intake rules (TASK-18 2-5): the save/approve rules of the
//! single-tool `create_receipt_draft` / `approve_receipt_draft`, extracted so
//! the batch tools (#20 / #21) reuse the exact same behaviour. Nothing in
//! here touches the MCP wire types.

use std::collections::HashSet;

use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use super::catalog;
use super::drafts as dd;
use super::dto::{CategorySource, DraftPayload};
use super::images::{self, ImageFail};
use super::util;
use crate::config::McpLimits;
use crate::mcp::file_arg::{ImageArg, OpenAIFile};
use crate::store::{self, NewDraftImageStatus};

/// A warning in the domain layer; the MCP tools map it to their wire `Warning`
/// (and may extend `detail` with entry/draft ids).
#[derive(Debug, Clone, PartialEq)]
pub struct IntakeWarning {
    pub code: String,
    pub message: String,
    pub detail: Option<Value>,
}

impl IntakeWarning {
    pub fn new(code: &str, message: impl Into<String>, detail: Option<Value>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail,
        }
    }
}

/// A ULID identifying one create_receipt_drafts call (drafts.batch_id).
pub fn new_batch_id(now: i64) -> String {
    let rnd = crate::auth::tokens::random_token();
    let mut lo = [0u8; 16];
    lo.copy_from_slice(&rnd[..16]);
    ulid::Ulid::from_parts(now.max(0) as u64, u128::from_be_bytes(lo)).to_string()
}

// ---------------------------------------------------------------------------
// creation (I1 / I2 / I4 preprocessing)

/// Model-reported metadata of one entry, before validation.
#[derive(Debug, Clone)]
pub struct PrepareInput<'a> {
    pub payload: DraftPayload,
    pub reported_filename: Option<&'a str>,
    pub reported_taken_at: Option<&'a str>,
}

/// One entry after the shared preprocessing.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub payload: DraftPayload,
    /// `reported_taken_at` after the format check (invalid values are dropped
    /// with a warning).
    pub reported_taken_at: Option<String>,
    /// purchased_on was absent at intake (EXIF/model date may fill it later).
    pub purchased_missing: bool,
    /// line_nos whose category came from the history suggestion.
    pub history: HashSet<i64>,
    pub warnings: Vec<IntakeWarning>,
}

/// Why an element did not pass the preprocessing: `Invalid` lists the input
/// errors (the element is not saved, the rest of the call continues), `Db` is
/// a whole-call internal error.
#[derive(Debug)]
pub enum PrepareFail {
    Invalid(Vec<String>),
    Db(sqlx::Error),
}

/// The per-entry preprocessing of `create_receipt_draft`: strip sources,
/// validate the payload, check the reported metadata, suggest categories from
/// history and default purchased_on from the reported taken_at. Warnings
/// travel on the success path only, exactly like the single-tool flow.
pub async fn prepare(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    lim: &McpLimits,
    input: PrepareInput<'_>,
) -> Result<Prepared, PrepareFail> {
    let mut payload = input.payload;
    dd::strip_sources(&mut payload.items);
    // draft labels: normalize to the palette order, empty -> None (TASK-21)
    if let Some(colors) = payload.label_colors.as_mut() {
        super::labels::normalize_colors(colors);
        if colors.is_empty() {
            payload.label_colors = None;
        }
    }
    let mut errs = dd::validate_payload(&payload, lim);
    let max = lim.max_name_chars;
    if input
        .reported_filename
        .is_some_and(|s| s.chars().count() > max)
    {
        errs.push(format!("reported_filename: {max}字以内"));
    }
    if !errs.is_empty() {
        return Err(PrepareFail::Invalid(errs));
    }
    let mut warnings = Vec::new();
    let reported_taken_at = match input.reported_taken_at {
        Some(t) if !util::valid_local_datetime(t) => {
            warnings.push(IntakeWarning::new(
                "reported_taken_at_ignored",
                "reported_taken_at の形式が不正なため記録しませんでした（YYYY-MM-DDTHH:MM[:SS]）",
                None,
            ));
            None
        }
        other => other.map(str::to_string),
    };
    // history suggestion for lines without a category (spec 7-2)
    let mut history = HashSet::new();
    for it in payload.items.iter_mut() {
        if it.category.is_none() {
            let path = catalog::suggest_category(conn, ledger_id, &it.name)
                .await
                .map_err(PrepareFail::Db)?;
            if let Some(path) = path {
                it.category = Some(path);
                it.category_source = Some(CategorySource::History);
                history.insert(it.line_no);
            }
        }
    }
    // purchased_on default from the model-reported taken_at (EXIF later)
    let purchased_missing = payload.purchased_on.is_none();
    if purchased_missing && let Some(t) = &reported_taken_at {
        payload.purchased_on = Some(t[..10].to_string());
    }
    Ok(Prepared {
        payload,
        reported_taken_at,
        purchased_missing,
        history,
        warnings,
    })
}

/// I1 / I2 / I4: the initial image state of one entry from its resolved
/// image argument. A fetchable file object returns `Some(file)` with
/// `unavailable(fetch_interrupted)`; everything else is image-less with the
/// matching reason.
pub fn image_plan(
    manual: bool,
    arg: &ImageArg,
) -> (
    NewDraftImageStatus,
    Option<&'static str>,
    Option<OpenAIFile>,
) {
    match (arg, manual) {
        (_, true) => (NewDraftImageStatus::None, None, None),
        (ImageArg::File(f), false) => (
            NewDraftImageStatus::Unavailable,
            Some("fetch_interrupted"),
            Some(f.clone()),
        ),
        (other, false) => (
            NewDraftImageStatus::Unavailable,
            Some(other.unavailable_reason()),
            None,
        ),
    }
}

// ---------------------------------------------------------------------------
// image settlement (I3a / I3b) — shared by the single and batch flows

/// Record one fetch outcome on every referencing draft: store the image once
/// and attach it to each draft (I3a), or record the failure reason on each
/// (I3b). The image row's `source_host` comes from the fetch response (the
/// `meta` value is ignored for that field). Returns the EXIF taken_at when
/// the conversion succeeded (it is the preferred purchased_on source even
/// when the store failed, like the single-tool flow).
pub async fn settle_image(
    pool: &SqlitePool,
    root: &std::path::Path,
    outcome: &Result<(images::FetchedMeta, images::Processed), ImageFail>,
    draft_ids: &[i64],
    meta: &images::NewImage<'_>,
    now: i64,
) -> anyhow::Result<Option<String>> {
    match outcome {
        Ok((fetched, processed)) => {
            let exif = processed.taken_at_local.clone();
            let with_host = images::NewImage {
                ledger_id: meta.ledger_id,
                uploaded_by: meta.uploaded_by,
                source_file_id: meta.source_file_id,
                source_host: Some(fetched.host.as_str()),
                reported_filename: meta.reported_filename,
                reported_taken_at: meta.reported_taken_at,
            };
            match images::store_image(
                pool,
                root,
                processed,
                fetched.filename.as_deref(),
                &with_host,
                now,
            )
            .await
            {
                Ok(image_id) => {
                    for id in draft_ids {
                        if store::attach_draft_image(pool, *id, image_id, now).await? == 0 {
                            tracing::info!(
                                draft_id = *id,
                                "draft closed during fetch; image left orphaned"
                            );
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, "image store failed");
                    for id in draft_ids {
                        store::fail_draft_image(pool, *id, "fetch_failed", now).await?;
                    }
                }
            }
            Ok(exif)
        }
        Err(fail) => {
            for id in draft_ids {
                tracing::info!(
                    draft_id = *id,
                    reason = fail.reason(),
                    "receipt image not saved"
                );
                store::fail_draft_image(pool, *id, fail.reason(), now).await?;
            }
            Ok(None)
        }
    }
}

/// EXIF-first purchased_on fix after the image settled (spec 7-2): fills the
/// date that was missing at intake from EXIF (preferred) or the
/// model-reported taken_at, updating the stored payload when it changes.
#[allow(clippy::too_many_arguments)]
pub async fn finalize_purchased_on(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
    payload: &mut DraftPayload,
    purchased_missing: bool,
    exif_taken: Option<&str>,
    reported_taken_at: Option<&str>,
    now: i64,
) -> anyhow::Result<Option<IntakeWarning>> {
    if !purchased_missing {
        return Ok(None);
    }
    let Some((t, src)) = (match (exif_taken, reported_taken_at) {
        (Some(t), _) => Some((t, "exif")),
        (None, Some(t)) => Some((t, "model")),
        _ => None,
    }) else {
        return Ok(None);
    };
    let date = t[..10].to_string();
    if payload.purchased_on.as_deref() != Some(date.as_str()) {
        payload.purchased_on = Some(date.clone());
        store::update_draft_payload(pool, draft_id, user_id, payload, now).await?;
    }
    Ok(Some(IntakeWarning::new(
        "purchased_on_from_taken_at",
        format!(
            "購入日が読めなかったため撮影日時（{src}）の日付 {date} を入れました。正しいか確認してください"
        ),
        Some(json!({ "source": src, "purchased_on": date })),
    )))
}

// ---------------------------------------------------------------------------
// approval (shared by approve_receipt_draft and approve_receipt_drafts)

/// The ledger half of the approval context the shared checks need.
#[derive(Debug, Clone)]
pub struct ApproveLedger {
    pub id: i64,
    pub name: String,
    pub active_id: Option<i64>,
}

/// Per-item approval outcome. NotFound / Forbidden are normally resolved
/// before this layer (the MCP draft resolution shared by both tools); the
/// kinds here cover the race where the draft or the role changes between
/// that resolution and the approval transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproveKind {
    Approved,
    Idempotent,
    StaleRevision,
    Conflict,
    Invalid,
    NotFound,
    Forbidden,
}

#[derive(Debug, Clone)]
pub struct ApproveOne {
    pub kind: ApproveKind,
    pub receipt_id: Option<i64>,
    /// StaleRevision: the draft's current revision.
    pub current_revision: Option<i64>,
    /// Invalid: the listed problems.
    pub problems: Vec<String>,
    pub warnings: Vec<IntakeWarning>,
}

/// The per-draft approval flow of `approve_receipt_draft`: the pre-checks,
/// duplicate warnings, the store transaction and the result classification.
/// The MCP layer resolves the draft / ledger / role first (shared code) and
/// maps the kind to its wording.
pub async fn approve_one(
    pool: &SqlitePool,
    user_id: i64,
    row: &dd::DraftRow,
    ledger: &ApproveLedger,
    revision: i64,
    now: i64,
) -> anyhow::Result<ApproveOne> {
    let was_approved = row.status == "approved";
    let mut warnings = Vec::new();
    if row.status == "pending" && row.revision == revision {
        let payload = row.payload();
        let problems = dd::approval_problems(&payload);
        if !problems.is_empty() {
            return Ok(ApproveOne {
                kind: ApproveKind::Invalid,
                receipt_id: None,
                current_revision: None,
                problems,
                warnings,
            });
        }
        // duplicates are read before the draft closes (spec 6); the
        // connection is acquired inline (find_duplicates takes &mut conn)
        let dups = dd::find_duplicates(&mut *pool.acquire().await?, row, &payload).await?;
        for d in dups {
            let code = match d.match_kind.as_str() {
                "file_id" => "duplicate_file",
                "sha256" => "duplicate_image",
                _ => "duplicate_content",
            };
            let k = if d.kind == "draft" {
                "下書き"
            } else {
                "レシート"
            };
            warnings.push(IntakeWarning::new(
                code,
                format!("重複の可能性: {k} #{}（家計簿 {}）", d.id, d.ledger.name),
                Some(serde_json::to_value(&d).unwrap_or(Value::Null)),
            ));
        }
    }
    let out = match store::approve_draft(pool, row.id, user_id, revision, now).await {
        Ok(o) => o,
        Err(store::ApproveError::StaleRevision { current, .. }) => {
            return Ok(ApproveOne {
                kind: ApproveKind::StaleRevision,
                receipt_id: None,
                current_revision: Some(current),
                problems: vec![],
                warnings,
            });
        }
        Err(store::ApproveError::Conflict(_)) => {
            return Ok(ApproveOne {
                kind: ApproveKind::Conflict,
                receipt_id: None,
                current_revision: None,
                problems: vec![],
                warnings,
            });
        }
        Err(store::ApproveError::Payload(p)) => {
            return Ok(ApproveOne {
                kind: ApproveKind::Invalid,
                receipt_id: None,
                current_revision: None,
                problems: vec![p],
                warnings,
            });
        }
        Err(e @ (store::ApproveError::NotFound | store::ApproveError::Forbidden)) => {
            return Ok(ApproveOne {
                kind: if matches!(e, store::ApproveError::NotFound) {
                    ApproveKind::NotFound
                } else {
                    ApproveKind::Forbidden
                },
                receipt_id: None,
                current_revision: None,
                problems: vec![],
                warnings,
            });
        }
        Err(e) => return Err(e.into()),
    };
    for w in &out.warnings {
        warnings.push(match w {
            store::ApproveWarning::TotalDiff { items_total, total_amount } => IntakeWarning::new(
                "total_mismatch",
                format!("明細合計 {} と印字合計 {} が {} 違います", crate::mcp::result::yen(*items_total), crate::mcp::result::yen(*total_amount), crate::mcp::result::yen(total_amount - items_total)),
                Some(json!({ "items_total": items_total, "total_amount": total_amount, "diff": total_amount - items_total })),
            ),
            store::ApproveWarning::UnknownItemCategory { line_no, name } => IntakeWarning::new(
                "unknown_category",
                format!("{line_no}行目のカテゴリ「{name}」は未登録のため未分類で確定しました"),
                Some(json!({ "line_no": line_no, "category": name })),
            ),
            store::ApproveWarning::UnknownStoreCategory { name } => IntakeWarning::new(
                "unknown_category",
                format!("店カテゴリ「{name}」は未登録のため設定しませんでした"),
                Some(json!({ "store_category": name })),
            ),
        });
    }
    if ledger.active_id != Some(ledger.id) {
        warnings.push(IntakeWarning::new(
            "ledger_differs_from_active",
            format!("確定先「{}」は選択中の家計簿とは異なります", ledger.name),
            Some(json!({ "ledger_id": ledger.id, "active_ledger_id": ledger.active_id })),
        ));
    }
    Ok(ApproveOne {
        kind: if was_approved {
            ApproveKind::Idempotent
        } else {
            ApproveKind::Approved
        },
        receipt_id: Some(out.receipt_id),
        current_revision: None,
        problems: vec![],
        warnings,
    })
}
