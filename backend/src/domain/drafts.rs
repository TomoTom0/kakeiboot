//! Draft views and helpers for the MCP draft tools (spec_mcp-tools.md 5, 6,
//! 7-2 .. 7-7): payload validation, patch application, the DraftView
//! (resolution, image display, possible duplicates) and the draft list.

use std::collections::HashSet;

use serde_json::{Map, Value, json};
use sqlx::{SqliteConnection, SqlitePool};

use super::catalog::{self, CatKind};
use super::dto::{
    CategoryResolution, CategorySource, DraftImageView, DraftItem, DraftPayload, DraftView,
    ImageMetaView, Label, LedgerRef, LineKind, PossibleDuplicate, ReportedMeta, Resolution,
    StoreResolution,
};
use super::util;
use crate::config::McpLimits;
use crate::store::{compute_amounts_incl, normalize_text};

// ---------------------------------------------------------------------------
// validation (spec 3-5, 7-1)

/// Validate a payload; returns the list of problems (field + how to fix).
/// Draft creation does not require purchased_on (approval does).
pub fn validate_payload(p: &DraftPayload, lim: &McpLimits) -> Vec<String> {
    let mut errs = Vec::new();
    let name_max = lim.max_name_chars;
    let check_len = |errs: &mut Vec<String>, field: &str, v: &Option<String>, max: usize| {
        if let Some(s) = v
            && s.chars().count() > max
        {
            errs.push(format!("{field}: {max}字以内にしてください"));
        }
    };
    check_len(&mut errs, "store_name", &p.store_name, name_max);
    check_len(&mut errs, "store_name_raw", &p.store_name_raw, name_max);
    check_len(&mut errs, "store_category", &p.store_category, name_max);
    check_len(&mut errs, "note", &p.note, lim.max_note_chars);
    if let Some(d) = &p.purchased_on
        && util::parse_date(d).is_none()
    {
        errs.push("purchased_on: \"YYYY-MM-DD\" 形式の実在する日付にしてください".into());
    }
    if let Some(t) = &p.purchased_time
        && !util::valid_time(t)
    {
        errs.push("purchased_time: \"HH:MM\" または \"HH:MM:SS\" にしてください".into());
    }
    if p.items.len() > lim.max_items {
        errs.push(format!("items: {}行以内にしてください", lim.max_items));
    }
    let mut seen = HashSet::new();
    let item_lines: HashSet<i64> = p
        .items
        .iter()
        .filter(|i| i.line_kind == LineKind::Item)
        .map(|i| i.line_no)
        .collect();
    for it in &p.items {
        let at = format!("items[line_no={}]", it.line_no);
        if it.line_no < 1 {
            errs.push(format!("{at}: line_no は1以上にしてください"));
        }
        if !seen.insert(it.line_no) {
            errs.push(format!("{at}: line_no が重複しています（draft 内で一意）"));
        }
        if it.name.trim().is_empty() {
            errs.push(format!(
                "{at}.name: 空にできません（読めた範囲を入れてください）"
            ));
        }
        check_len(
            &mut errs,
            &format!("{at}.name"),
            &Some(it.name.clone()),
            name_max,
        );
        check_len(&mut errs, &format!("{at}.name_raw"), &it.name_raw, name_max);
        check_len(&mut errs, &format!("{at}.category"), &it.category, name_max);
        check_len(&mut errs, &format!("{at}.unit"), &it.unit, name_max);
        if it.quantity.is_some_and(|q| !(q > 0.0 && q.is_finite())) {
            errs.push(format!("{at}.quantity: 0より大きい数にしてください"));
        }
        if let Some(r) = it.tax_rate
            && !matches!(r, 0 | 8 | 10)
        {
            errs.push(format!("{at}.tax_rate: 0 / 8 / 10 か null にしてください"));
        }
        match it.line_kind {
            LineKind::Discount => {
                if it.amount > 0 {
                    errs.push(format!("{at}.amount: 値引行は0以下（負数）にしてください"));
                }
                if let Some(pl) = it.parent_line_no
                    && !item_lines.contains(&pl)
                {
                    errs.push(format!(
                        "{at}.parent_line_no: 品目行（line_kind=item）の line_no を指定してください"
                    ));
                }
            }
            LineKind::Item => {
                if it.parent_line_no.is_some() {
                    errs.push(format!(
                        "{at}.parent_line_no: 品目行には指定できません（値引行のみ）"
                    ));
                }
            }
        }
        if let Some([x, y, w, h]) = it.bbox
            && !((0.0..=1.0).contains(&x)
                && (0.0..=1.0).contains(&y)
                && w > 0.0
                && h > 0.0
                && x + w <= 1.0001
                && y + h <= 1.0001)
        {
            errs.push(format!(
                "{at}.bbox: [x, y, 幅, 高さ] を 0〜1 の比率で、画像からはみ出さないようにしてください（不明なら省略）"
            ));
        }
    }
    errs
}

/// Approval preconditions (spec 4: 承認の検証失敗).
pub fn approval_problems(p: &DraftPayload) -> Vec<String> {
    let mut errs = Vec::new();
    if p.purchased_on.is_none() {
        errs.push("purchased_on: 購入日が未入力です（update_receipt_draft で設定）".into());
    }
    if p.items.is_empty() {
        errs.push("items: 明細が0行です（update_receipt_draft で追加）".into());
    }
    errs
}

/// Model input never decides category_source (server-managed).
pub fn strip_sources(items: &mut [DraftItem]) {
    for it in items {
        it.category_source = None;
    }
}

// ---------------------------------------------------------------------------
// patch (7-3)

const HEADER_KEYS: &[&str] = &[
    "store_name",
    "store_name_raw",
    "store_category",
    "purchased_on",
    "purchased_time",
    "tax_mode",
    "total_amount",
    "tax_amount",
    "payment_method",
    "note",
    // draft-stage labels (TASK-21): array to replace, null to clear
    "label_colors",
];
const ITEM_KEYS: &[&str] = &[
    "line_no",
    "line_kind",
    "parent_line_no",
    "name",
    "name_raw",
    "quantity",
    "unit",
    "unit_price",
    "amount",
    "tax_rate",
    "category",
    "bbox",
];

#[derive(Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftPatch {
    #[serde(default)]
    pub set: Option<Map<String, Value>>,
    #[serde(default)]
    pub upsert_items: Option<Vec<Map<String, Value>>>,
    #[serde(default)]
    pub delete_line_nos: Option<Vec<i64>>,
    #[serde(default)]
    pub replace_items: Option<Vec<DraftItem>>,
}

/// Apply a patch; returns the new payload and the changed field list, or the
/// input errors.
pub fn apply_patch(
    current: &DraftPayload,
    patch: &DraftPatch,
) -> Result<(DraftPayload, Vec<String>), Vec<String>> {
    let mut errs = Vec::new();
    if patch.replace_items.is_some()
        && (patch.upsert_items.is_some() || patch.delete_line_nos.is_some())
    {
        errs.push("replace_items は upsert_items / delete_line_nos と同時に使えません".into());
        return Err(errs);
    }
    let mut obj = serde_json::to_value(current)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let mut changed = Vec::new();
    if let Some(set) = &patch.set {
        for (k, v) in set {
            if !HEADER_KEYS.contains(&k.as_str()) {
                errs.push(format!(
                    "set.{k}: 変更できない項目です（明細は upsert_items / replace_items）"
                ));
                continue;
            }
            if v.is_null() {
                obj.remove(k);
            } else {
                obj.insert(k.clone(), v.clone());
            }
            changed.push(k.clone());
        }
    }
    let mut items: Vec<Map<String, Value>> = obj
        .remove("items")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    if let Some(rep) = &patch.replace_items {
        let mut rep = rep.clone();
        strip_sources(&mut rep);
        items = rep
            .iter()
            .filter_map(|i| serde_json::to_value(i).ok()?.as_object().cloned())
            .collect();
        changed.push("items".into());
    }
    if let Some(del) = &patch.delete_line_nos {
        for ln in del {
            let before = items.len();
            items.retain(|i| i.get("line_no").and_then(Value::as_i64) != Some(*ln));
            if items.len() == before {
                errs.push(format!("delete_line_nos: line_no={ln} の明細はありません"));
            } else {
                changed.push(format!("items[line_no={ln}] 削除"));
            }
        }
    }
    if let Some(ups) = &patch.upsert_items {
        for u in ups {
            let Some(ln) = u.get("line_no").and_then(Value::as_i64) else {
                errs.push("upsert_items: 各要素に line_no（整数）が必要です".into());
                continue;
            };
            if let Some(bad) = u.keys().find(|k| !ITEM_KEYS.contains(&k.as_str())) {
                errs.push(format!("upsert_items[line_no={ln}].{bad}: 未知の項目です"));
                continue;
            }
            let touches_category = u.contains_key("category");
            match items
                .iter_mut()
                .find(|i| i.get("line_no").and_then(Value::as_i64) == Some(ln))
            {
                Some(existing) => {
                    for (k, v) in u {
                        if v.is_null() {
                            existing.remove(k);
                        } else {
                            existing.insert(k.clone(), v.clone());
                        }
                    }
                    if touches_category {
                        existing.insert("category_source".into(), json!("user"));
                    }
                    changed.push(format!("items[line_no={ln}]"));
                }
                None => {
                    if !u.contains_key("name") || !u.contains_key("amount") {
                        errs.push(format!(
                            "upsert_items[line_no={ln}]: 新しい行には name と amount が必要です"
                        ));
                        continue;
                    }
                    let mut n: Map<String, Value> = u
                        .iter()
                        .filter(|(_, v)| !v.is_null())
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    if touches_category {
                        n.insert("category_source".into(), json!("user"));
                    }
                    items.push(n);
                    changed.push(format!("items[line_no={ln}] 追加"));
                }
            }
        }
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    if changed.is_empty() {
        return Err(vec![
            "変更がありません。set / upsert_items / delete_line_nos / replace_items のいずれかを指定してください"
                .into(),
        ]);
    }
    items.sort_by_key(|i| i.get("line_no").and_then(Value::as_i64).unwrap_or(0));
    obj.insert(
        "items".into(),
        Value::Array(items.into_iter().map(Value::Object).collect()),
    );
    match serde_json::from_value::<DraftPayload>(Value::Object(obj)) {
        Ok(p) => Ok((p, changed)),
        Err(e) => Err(vec![format!("payload の型が不正です: {e}")]),
    }
}

// ---------------------------------------------------------------------------
// rows

/// The drafts row as the tools need it.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DraftRow {
    pub id: i64,
    pub ledger_id: i64,
    pub user_id: i64,
    pub status: String,
    pub revision: i64,
    pub payload_json: Option<String>,
    pub source_file_id: Option<String>,
    pub image_id: Option<i64>,
    pub image_status: String,
    pub image_unavailable_reason: Option<String>,
    pub reported_filename: Option<String>,
    pub reported_taken_at: Option<String>,
    pub approved_receipt_id: Option<i64>,
    /// Same-batch sibling group of one create_receipt_drafts call (TASK-18);
    /// NULL for single-tool creation and reopen.
    pub batch_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub expires_at: i64,
}

impl DraftRow {
    pub fn payload(&self) -> DraftPayload {
        self.payload_json
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(DraftPayload {
                store_name: None,
                store_name_raw: None,
                store_category: None,
                purchased_on: None,
                purchased_time: None,
                tax_mode: None,
                total_amount: None,
                tax_amount: None,
                payment_method: None,
                note: None,
                label_colors: None,
                items: vec![],
            })
    }
}

const DRAFT_COLS: &str = "id, ledger_id, user_id, status, revision, payload_json, source_file_id,
    image_id, image_status, image_unavailable_reason, reported_filename, reported_taken_at,
    approved_receipt_id, batch_id, created_at, updated_at, expires_at";

/// The user's draft by id (other users' drafts look absent).
pub async fn load_draft(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
) -> sqlx::Result<Option<DraftRow>> {
    let sql = format!("SELECT {DRAFT_COLS} FROM drafts WHERE id = ? AND user_id = ?");
    sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(draft_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

/// Image display wording (spec 5-4).
pub fn image_display(row: &DraftRow, now: i64, fetch_timeout_secs: u64) -> String {
    match row.image_status.as_str() {
        "none" => "画像なし（手動入力）".into(),
        "attached" if row.status == "pending" => "画像あり".into(),
        "attached" => "画像あり（確定済み・下書きからは表示しません）".into(),
        _ => {
            let processing_window = (fetch_timeout_secs as i64 + 60) * 1000;
            if row.image_unavailable_reason.as_deref() == Some("fetch_interrupted")
                && row.status == "pending"
                && now - row.created_at < processing_window
            {
                "画像を処理中".into()
            } else {
                "画像なし".into()
            }
        }
    }
}

/// The DraftView (7-1) for one row.
pub async fn draft_view(
    pool: &SqlitePool,
    row: &DraftRow,
    now: i64,
    fetch_timeout_secs: u64,
    history_lines: &HashSet<i64>,
) -> anyhow::Result<DraftView> {
    let payload = row.payload();
    let mut conn = pool.acquire().await?;
    let resolution = resolve_payload(&mut conn, row.ledger_id, &payload, history_lines).await?;
    // draft-stage labels with the ledger's titles, in palette order (TASK-21)
    let label_defs = super::labels::list_labels(&mut conn, row.ledger_id).await?;
    let labels: Vec<Label> = payload
        .label_colors
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| {
            label_defs.iter().find(|d| d.color == c).map(|d| Label {
                color: d.color,
                title: d.title.clone(),
            })
        })
        .collect();
    let image_meta = match row.image_id {
        Some(img) => {
            #[allow(clippy::type_complexity)]
            let m: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> =
                sqlx::query_as(
                    "SELECT original_filename, original_filename_source, taken_at_local, taken_at_source
                     FROM images WHERE id = ?",
                )
                .bind(img)
                .fetch_optional(&mut *conn)
                .await?;
            m.map(|(f, fs, t, ts)| ImageMetaView {
                original_filename: f,
                original_filename_source: fs,
                taken_at: t,
                taken_at_source: ts,
            })
        }
        None => None,
    };
    // find_duplicates borrows the same connection: callers must not hand the
    // pool while holding it (max_connections(1) in-memory setups deadlock)
    let possible_duplicates = if row.status == "pending" {
        find_duplicates(&mut conn, row, &payload).await?
    } else {
        vec![]
    };
    Ok(DraftView {
        draft_id: row.id,
        revision: row.revision,
        status: row.status.clone(),
        input_kind: if row.image_status == "none" {
            "manual".into()
        } else {
            "image".into()
        },
        image: DraftImageView {
            status: row.image_status.clone(),
            reason: row.image_unavailable_reason.clone(),
            display: image_display(row, now, fetch_timeout_secs),
        },
        reported: ReportedMeta {
            filename: row.reported_filename.clone(),
            taken_at: row.reported_taken_at.clone(),
        },
        image_meta,
        payload,
        labels,
        resolution,
        approved_receipt_id: row.approved_receipt_id,
        possible_duplicates,
        expires_at: util::jst_iso(row.expires_at),
    })
}

/// Server-side resolution forecast (store / categories / totals).
pub async fn resolve_payload(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    p: &DraftPayload,
    history_lines: &HashSet<i64>,
) -> sqlx::Result<Resolution> {
    let store_name = p.store_name.as_deref().or(p.store_name_raw.as_deref());
    let store = match store_name {
        Some(n) => match catalog::find_store(conn, ledger_id, n).await? {
            Some(id) => StoreResolution {
                status: "existing".into(),
                store_id: Some(id),
            },
            None => StoreResolution {
                status: "new".into(),
                store_id: None,
            },
        },
        None => StoreResolution {
            status: "new".into(),
            store_id: None,
        },
    };
    let mut categories = Vec::with_capacity(p.items.len());
    for it in &p.items {
        let (status, resolved) = match it.category.as_deref() {
            Some(path) => {
                match catalog::resolve_path(conn, CatKind::Item, ledger_id, path).await? {
                    Some(id) => {
                        let canon = catalog::path_of(conn, CatKind::Item, id).await?;
                        let st = if history_lines.contains(&it.line_no)
                            || it.category_source == Some(CategorySource::History)
                        {
                            "history"
                        } else {
                            "ok"
                        };
                        (st, canon)
                    }
                    None => ("unknown", None),
                }
            }
            None => ("unknown", None),
        };
        categories.push(CategoryResolution {
            line_no: it.line_no,
            input: it.category.clone(),
            status: status.into(),
            resolved,
        });
    }
    let items_total: i64 = compute_amounts_incl(&p.items, p.tax_mode, p.tax_amount)
        .iter()
        .sum();
    Ok(Resolution {
        store,
        categories,
        items_total,
        total_diff: p.total_amount.map(|t| t - items_total),
    })
}

/// Total used by duplicate detection: printed total, else items total.
pub fn draft_total(p: &DraftPayload) -> i64 {
    p.total_amount.unwrap_or_else(|| {
        compute_amounts_incl(&p.items, p.tax_mode, p.tax_amount)
            .iter()
            .sum()
    })
}

// ---------------------------------------------------------------------------
// duplicate detection (spec 6). Read-only.

fn norm_opt(s: Option<&str>) -> Option<String> {
    s.map(normalize_text).filter(|n| !n.is_empty())
}

async fn ledger_name(conn: &mut SqliteConnection, id: i64) -> sqlx::Result<String> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT name FROM ledgers WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?
            .unwrap_or_default(),
    )
}

/// Possible duplicates of one pending draft.
pub async fn find_duplicates(
    conn: &mut SqliteConnection,
    d: &DraftRow,
    p: &DraftPayload,
) -> anyhow::Result<Vec<PossibleDuplicate>> {
    let mut hits: Vec<(String, i64, i64, String)> = Vec::new(); // kind, id, ledger, match
    // 1. same file_id. Same-batch siblings (one photo shared by several
    // receipts of one create_receipt_drafts call, TASK-18) are excluded here
    // only: sha256 and content matches keep firing.
    if let Some(fid) = &d.source_file_id {
        let drafts: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT id, ledger_id FROM drafts
             WHERE user_id = ? AND source_file_id = ? AND status = 'pending' AND id <> ?
               AND (? IS NULL OR batch_id IS NULL OR batch_id <> ?)",
        )
        .bind(d.user_id)
        .bind(fid)
        .bind(d.id)
        .bind(&d.batch_id)
        .bind(&d.batch_id)
        .fetch_all(&mut *conn)
        .await?;
        for (id, l) in drafts {
            hits.push(("draft".into(), id, l, "file_id".into()));
        }
        let receipts: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT r.id, r.ledger_id FROM receipts r JOIN images im ON im.id = r.image_id
             WHERE im.ledger_id = ? AND im.source_file_id = ? AND r.deleted_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM drafts od
                     WHERE od.approved_receipt_id = r.id AND od.batch_id = ?)",
        )
        .bind(d.ledger_id)
        .bind(fid)
        .bind(&d.batch_id)
        .fetch_all(&mut *conn)
        .await?;
        for (id, l) in receipts {
            hits.push(("receipt".into(), id, l, "file_id".into()));
        }
    }
    // 2. same image sha256 in the ledger
    if let Some(img) = d.image_id {
        let receipts: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT r.id, r.ledger_id FROM images me
             JOIN images o ON o.ledger_id = me.ledger_id AND o.sha256 = me.sha256 AND o.id <> me.id
             JOIN receipts r ON r.image_id = o.id AND r.deleted_at IS NULL
             WHERE me.id = ?",
        )
        .bind(img)
        .fetch_all(&mut *conn)
        .await?;
        for (id, l) in receipts {
            hits.push(("receipt".into(), id, l, "sha256".into()));
        }
        let drafts: Vec<(i64, i64)> = sqlx::query_as(
            "SELECT dr.id, dr.ledger_id FROM images me
             JOIN images o ON o.ledger_id = me.ledger_id AND o.sha256 = me.sha256 AND o.id <> me.id
             JOIN drafts dr ON dr.image_id = o.id AND dr.status = 'pending'
             WHERE me.id = ? AND dr.id <> ?",
        )
        .bind(img)
        .bind(d.id)
        .fetch_all(&mut *conn)
        .await?;
        for (id, l) in drafts {
            hits.push(("draft".into(), id, l, "sha256".into()));
        }
    }
    // 3. (store, purchased_on, total)
    if let Some(date) = &p.purchased_on {
        let total = draft_total(p);
        let my_raw = norm_opt(p.store_name_raw.as_deref());
        let my_name = norm_opt(p.store_name.as_deref());
        let my_store = match p.store_name.as_deref().or(p.store_name_raw.as_deref()) {
            Some(n) => catalog::find_store(&mut *conn, d.ledger_id, n).await?,
            None => None,
        };
        #[allow(clippy::type_complexity)]
        let receipts: Vec<(i64, Option<i64>, Option<String>, Option<i64>, i64)> =
            sqlx::query_as(
            "SELECT r.id, r.store_id, r.store_name_raw, r.total_amount,
                    (SELECT COALESCE(SUM(amount_incl), 0) FROM receipt_items i WHERE i.receipt_id = r.id)
             FROM receipts r WHERE r.ledger_id = ? AND r.purchased_on = ? AND r.deleted_at IS NULL",
        )
        .bind(d.ledger_id)
        .bind(date)
        .fetch_all(&mut *conn)
        .await?;
        for (id, store_id, raw, printed, items_sum) in receipts {
            let same_store = match my_store {
                Some(s) => store_id == Some(s),
                None => my_raw.is_some() && my_raw == norm_opt(raw.as_deref()),
            };
            if same_store && printed.unwrap_or(items_sum) == total {
                hits.push(("receipt".into(), id, d.ledger_id, "content".into()));
            }
        }
        let others: Vec<(i64, i64, Option<String>)> = sqlx::query_as(
            "SELECT id, ledger_id, payload_json FROM drafts
             WHERE user_id = ? AND status = 'pending' AND id <> ?",
        )
        .bind(d.user_id)
        .bind(d.id)
        .fetch_all(&mut *conn)
        .await?;
        for (id, l, pj) in others {
            let Some(op) = pj.and_then(|s| serde_json::from_str::<DraftPayload>(&s).ok()) else {
                continue;
            };
            if op.purchased_on.as_deref() != Some(date.as_str()) || draft_total(&op) != total {
                continue;
            }
            let o_raw = norm_opt(op.store_name_raw.as_deref());
            let same_store = if l == d.ledger_id {
                let o_store = match op.store_name.as_deref().or(op.store_name_raw.as_deref()) {
                    Some(n) => catalog::find_store(&mut *conn, l, n).await?,
                    None => None,
                };
                match (my_store, o_store) {
                    (Some(a), Some(b)) => a == b,
                    _ => my_raw.is_some() && my_raw == o_raw,
                }
            } else if my_raw.is_some() || o_raw.is_some() {
                my_raw.is_some() && my_raw == o_raw
            } else {
                my_name.is_some() && my_name == norm_opt(op.store_name.as_deref())
            };
            if same_store {
                hits.push(("draft".into(), id, l, "content".into()));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (kind, id, l, m) in hits {
        if !seen.insert((kind.clone(), id, m.clone())) {
            continue;
        }
        let name = ledger_name(&mut *conn, l).await?;
        out.push(PossibleDuplicate {
            kind,
            id,
            ledger: LedgerRef { id: l, name },
            match_kind: m,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// list (7-7)

pub async fn list_drafts(
    pool: &SqlitePool,
    user_id: i64,
    ledger_id: Option<i64>,
    statuses: &[String],
    limit: i64,
    now: i64,
    fetch_timeout_secs: u64,
) -> anyhow::Result<Vec<Value>> {
    let placeholders = vec!["?"; statuses.len()].join(",");
    let sql = format!(
        "SELECT {DRAFT_COLS} FROM drafts d
         WHERE user_id = ? AND status IN ({placeholders})
           AND (? IS NULL OR ledger_id = ?)
           AND EXISTS (SELECT 1 FROM ledger_members m WHERE m.ledger_id = d.ledger_id AND m.user_id = d.user_id)
         ORDER BY updated_at DESC, id DESC LIMIT ?"
    );
    let mut q = sqlx::query_as::<_, DraftRow>(sqlx::AssertSqlSafe(sql)).bind(user_id);
    for s in statuses {
        q = q.bind(s);
    }
    let rows = q
        .bind(ledger_id)
        .bind(ledger_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    let mut out = Vec::with_capacity(rows.len());
    let mut conn = pool.acquire().await?;
    for r in rows {
        let p = r.payload();
        let lname = ledger_name(&mut conn, r.ledger_id).await?;
        let dups = if r.status == "pending" {
            find_duplicates(&mut conn, &r, &p).await?
        } else {
            vec![]
        };
        let items_total: i64 = compute_amounts_incl(&p.items, p.tax_mode, p.tax_amount)
            .iter()
            .sum();
        out.push(json!({
            "draft_id": r.id,
            "revision": r.revision,
            "status": r.status,
            "ledger": { "id": r.ledger_id, "name": lname },
            "store_name": p.store_name.clone().or(p.store_name_raw.clone()),
            "purchased_on": p.purchased_on,
            "items_total": items_total,
            "item_count": p.items.len(),
            "image_status": r.image_status,
            "image_unavailable_reason": r.image_unavailable_reason,
            "image_display": image_display(&r, now, fetch_timeout_secs),
            "possible_duplicates": dups,
            "updated_at": util::jst_iso(r.updated_at),
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lim() -> McpLimits {
        McpLimits {
            max_items: 3,
            max_name_chars: 5,
            max_ledger_name_chars: 100,
            max_note_chars: 10,
            search_default_limit: 20,
            search_max_limit: 50,
            max_query_chars: 200,
            stats_max_rows: 200,
            catalog_max_stores: 50,
            widget_refs_max: 20,
            drafts_default_limit: 20,
            drafts_max_limit: 50,
            max_label_title_chars: 20,
            max_label_batch: 50,
            batch_max_drafts: 10,
            batch_max_approve: 20,
        }
    }

    fn item(ln: i64, name: &str, amount: i64) -> DraftItem {
        serde_json::from_value(json!({"line_no": ln, "name": name, "amount": amount})).unwrap()
    }

    fn payload(items: Vec<DraftItem>) -> DraftPayload {
        serde_json::from_value(json!({ "items": items })).unwrap()
    }

    // [covers:mcp-draft.payload-validation]
    #[test]
    fn validation_lists_each_problem() {
        let mut p = payload(vec![item(1, "牛乳", 100), item(1, "パンパンパンパン", 50)]);
        p.purchased_on = Some("2026-02-30".into());
        p.items[1].line_kind = LineKind::Discount;
        p.items[1].parent_line_no = Some(9);
        p.items[0].tax_rate = Some(5);
        p.items[0].bbox = Some([0.9, 0.0, 0.5, 0.1]);
        let errs = validate_payload(&p, &lim());
        let all = errs.join("\n");
        for needle in [
            "purchased_on",
            "line_no が重複",
            "5字以内",
            "値引行は0以下",
            "parent_line_no",
            "tax_rate",
            "bbox",
        ] {
            assert!(all.contains(needle), "{needle} missing in {all}");
        }
        let ok = payload(vec![item(1, "牛乳", 100)]);
        assert!(validate_payload(&ok, &lim()).is_empty());
        let too_many = payload((1..=4).map(|i| item(i, "a", 1)).collect());
        assert!(
            validate_payload(&too_many, &lim())
                .join("")
                .contains("3行以内")
        );
    }

    // [covers:mcp-draft.patch-merge-and-exclusive]
    #[test]
    fn patch_rules() {
        let cur = payload(vec![item(1, "牛乳", 100), item(2, "パン", 50)]);
        // field merge + category marks user + add + delete
        let patch: DraftPatch = serde_json::from_value(json!({
            "set": { "store_name": "店", "note": null },
            "upsert_items": [
                { "line_no": 1, "category": "食費/食料品" },
                { "line_no": 3, "name": "卵", "amount": 200 }
            ],
            "delete_line_nos": [2]
        }))
        .unwrap();
        let (p, changed) = apply_patch(&cur, &patch).unwrap();
        assert_eq!(p.store_name.as_deref(), Some("店"));
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[0].name, "牛乳");
        assert_eq!(p.items[0].amount, 100);
        assert_eq!(p.items[0].category_source, Some(CategorySource::User));
        assert_eq!(p.items[1].line_no, 3);
        assert!(changed.iter().any(|c| c == "store_name"));
        // new line without amount
        let bad: DraftPatch =
            serde_json::from_value(json!({ "upsert_items": [{ "line_no": 9, "name": "x" }] }))
                .unwrap();
        assert!(apply_patch(&cur, &bad).unwrap_err()[0].contains("name と amount"));
        // exclusive
        let bad: DraftPatch = serde_json::from_value(json!({
            "replace_items": [{ "line_no": 1, "name": "a", "amount": 1 }],
            "delete_line_nos": [1]
        }))
        .unwrap();
        assert!(apply_patch(&cur, &bad).unwrap_err()[0].contains("同時に使えません"));
        // empty
        assert!(apply_patch(&cur, &DraftPatch::default()).is_err());
        // header key that is not allowed
        let bad: DraftPatch = serde_json::from_value(json!({ "set": { "items": [] } })).unwrap();
        assert!(apply_patch(&cur, &bad).is_err());
    }
}
