//! Store layer over the schema: ledger creation with the category seed,
//! the draft lifecycle (create / update / image attach / discard / approve /
//! reopen), and the TTL cleanup job (spec_data-model.md sections 7, 9, 12).
//!
//! All write transactions start with BEGIN IMMEDIATE (section 3). Wiring the
//! cleanup into the server runtime is TASK-10/11; here it is a callable
//! function with an injected image-file deletion callback.

use sqlx::sqlite::{SqliteConnection, SqlitePool};
use sqlx::{AssertSqlSafe, Connection};

use crate::domain::dto::{DraftItem, DraftPayload, LineKind, TaxMode};

const DAY_MS: i64 = 86_400_000;
/// pending draft lifetime (section 7): expires 14 days after the last update.
pub const DRAFT_TTL_MS: i64 = 14 * DAY_MS;

// ---------------------------------------------------------------------------
// normalization (spec_data-model.md section 5-2)

/// NFKC, lowercase, strip whitespace, hiragana to katakana.
pub fn normalize_text(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nfkc: String = s.nfkc().collect();
    nfkc.to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| match c {
            'ぁ'..='ゖ' => char::from_u32(u32::from(c) + 0x60).unwrap_or(c),
            other => other,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// ledger name and per-user ledger color (section 4, migration 0008)

/// Fallback name for the personal ledger created at registration (section 4):
/// used when the display name is empty after trimming (unreachable through
/// the register API, which requires one) or when `max_ledger_name_chars` is
/// too small to hold the suffix. Migration 0008 renamed the ledgers created
/// under the earlier naming rule to this literal (TASK-16); TASK-79 brought
/// registration back to the display-name formula.
pub const DEFAULT_LEDGER_NAME: &str = "default book";

/// The suffix of the auto-created personal ledger name (TASK-79; the same
/// formula migration 0008 matched for its rename backfill).
const PERSONAL_LEDGER_SUFFIX: &str = "の家計簿";

/// Name of the personal ledger created at registration (section 4, TASK-79):
/// `"<表示名>の家計簿"`. The display name is trimmed and cut on a character
/// boundary to `max_chars` minus the suffix length so the whole name fits the
/// rename rule (`max_ledger_name_chars`); an empty display name or a cap too
/// small for the suffix falls back to [`DEFAULT_LEDGER_NAME`].
pub fn personal_ledger_name(display_name: &str, max_chars: usize) -> String {
    let display = display_name.trim();
    let suffix_chars = PERSONAL_LEDGER_SUFFIX.chars().count();
    if display.is_empty() || max_chars <= suffix_chars {
        return DEFAULT_LEDGER_NAME.to_string();
    }
    let keep = max_chars - suffix_chars;
    let head: String = display.chars().take(keep).collect();
    format!("{head}{PERSONAL_LEDGER_SUFFIX}")
}

/// Ledger color palette (`ledger_members.color` CHECK, migration 0008), in
/// assignment order. The first key is the column DEFAULT.
pub const LEDGER_COLORS: [&str; 6] = ["teal", "orange", "pink", "brown", "slate", "graphite"];

/// Color for a new membership of `user_id`: the first palette key the user
/// does not use yet; with every key used, (membership count mod 6).
pub async fn assign_member_color(
    conn: &mut SqliteConnection,
    user_id: i64,
) -> anyhow::Result<&'static str> {
    let used: Vec<String> =
        sqlx::query_scalar("SELECT color FROM ledger_members WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?;
    if let Some(c) = LEDGER_COLORS.iter().find(|c| !used.iter().any(|u| u == *c)) {
        return Ok(c);
    }
    Ok(LEDGER_COLORS[used.len() % LEDGER_COLORS.len()])
}

// ---------------------------------------------------------------------------
// ledger creation + category seed (section 9)

/// Item category initial set: (top-level name, sub categories).
const ITEM_CATEGORY_SEED: &[(&str, &[&str])] = &[
    ("食費", &["食料品", "外食", "飲料", "菓子"]),
    ("日用品", &["消耗品", "衛生用品"]),
    ("住居・光熱", &[]),
    ("交通", &["電車", "バス", "タクシー", "燃料"]),
    ("医療・健康", &["薬", "通院"]),
    ("衣服・美容", &[]),
    ("趣味・娯楽", &[]),
    ("教育・書籍", &[]),
    ("交際", &[]),
    ("その他", &[]),
];

/// Store category initial set: top level only (section 9).
const STORE_CATEGORY_SEED: &[&str] = &[
    "スーパー",
    "コンビニ",
    "ドラッグストア",
    "飲食店",
    "百貨店・専門店",
    "ネット通販",
    "交通機関",
    "その他",
];

/// Insert the initial category sets for one ledger (section 9).
pub async fn seed_categories(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    now: i64,
) -> anyhow::Result<()> {
    seed_category_table(conn, "item_categories", ledger_id, now, ITEM_CATEGORY_SEED).await?;
    let store_rows: Vec<(&str, &[&str])> =
        STORE_CATEGORY_SEED.iter().map(|n| (*n, &[][..])).collect();
    seed_category_table(conn, "store_categories", ledger_id, now, &store_rows).await
}

async fn seed_category_table(
    conn: &mut SqliteConnection,
    table: &str,
    ledger_id: i64,
    now: i64,
    seed: &[(&str, &[&str])],
) -> anyhow::Result<()> {
    // table is one of the two fixed category table names (no user input).
    let insert = format!(
        "INSERT INTO {table} (ledger_id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
    );
    for (sort, (top, subs)) in seed.iter().enumerate() {
        let top_id: i64 = sqlx::query_scalar::<_, i64>(AssertSqlSafe(insert.as_str()))
            .bind(ledger_id)
            .bind(None::<i64>)
            .bind(top)
            .bind(sort as i64)
            .bind(now)
            .bind(now)
            .fetch_one(&mut *conn)
            .await?;
        for (sub_sort, sub) in subs.iter().enumerate() {
            sqlx::query_scalar::<_, i64>(AssertSqlSafe(insert.as_str()))
                .bind(ledger_id)
                .bind(top_id)
                .bind(sub)
                .bind(sub_sort as i64)
                .bind(now)
                .bind(now)
                .fetch_one(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

/// Create a ledger and seed its categories in one BEGIN IMMEDIATE transaction.
pub async fn create_ledger_with_seed(
    pool: &SqlitePool,
    name: &str,
    now: i64,
) -> anyhow::Result<i64> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(name)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;
    seed_categories(&mut tx, id, now).await?;
    tx.commit().await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// draft lifecycle (sections 7-2 .. 7-4)

/// Draft image state at creation (section 7-4 step 1). `attached` is not a
/// creation state: it is only reached through [`attach_draft_image`], so the
/// type excludes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NewDraftImageStatus {
    /// Manual input: no image involved, reason must be None.
    None,
    /// Image input whose fetch result is not recorded yet (reason required).
    Unavailable,
}

impl NewDraftImageStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Draft creation parameters (section 7-4 step 1).
#[derive(Debug, Clone)]
pub struct NewDraft {
    pub ledger_id: i64,
    pub user_id: i64,
    pub image_status: NewDraftImageStatus,
    pub image_unavailable_reason: Option<&'static str>,
    pub source_file_id: Option<String>,
    pub reported_filename: Option<String>,
    pub reported_taken_at: Option<String>,
    /// Sibling group of one create_receipt_drafts call (TASK-18); None for
    /// the single-tool flow and reopen.
    pub batch_id: Option<String>,
}

/// Insert pending drafts with revision 1 and expires_at = now + 14 days, all
/// in one BEGIN IMMEDIATE transaction (TASK-18: the batch commits before any
/// image fetch; a mid-insert constraint violation rolls the whole call back
/// so no partial rows survive). Ids come back in entry order.
pub async fn create_drafts(
    pool: &SqlitePool,
    entries: &[(DraftPayload, NewDraft)],
    now: i64,
) -> anyhow::Result<Vec<i64>> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let mut ids = Vec::with_capacity(entries.len());
    for (payload, d) in entries {
        let payload_json = serde_json::to_string(payload)?;
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO drafts (ledger_id, user_id, status, revision, payload_json,
                source_file_id, image_status, image_unavailable_reason,
                reported_filename, reported_taken_at, batch_id, created_at, updated_at, expires_at)
             VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(d.ledger_id)
        .bind(d.user_id)
        .bind(&payload_json)
        .bind(&d.source_file_id)
        .bind(d.image_status.as_str())
        .bind(d.image_unavailable_reason)
        .bind(&d.reported_filename)
        .bind(&d.reported_taken_at)
        .bind(&d.batch_id)
        .bind(now)
        .bind(now)
        .bind(now + DRAFT_TTL_MS)
        .fetch_one(&mut *tx)
        .await?;
        ids.push(id);
    }
    tx.commit().await?;
    Ok(ids)
}

/// Insert one pending draft (a one-entry `create_drafts` call).
pub async fn create_draft(
    pool: &SqlitePool,
    payload: &DraftPayload,
    d: &NewDraft,
    now: i64,
) -> anyhow::Result<i64> {
    let ids = create_drafts(pool, &[(payload.clone(), d.clone())], now).await?;
    Ok(ids[0])
}

/// Apply a payload patch by replacing the JSON, bumping revision and renewing
/// expires_at (section 7-3). Returns the new revision, or None when the draft
/// is not a pending draft of this user (0 rows).
pub async fn update_draft_payload(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
    payload: &DraftPayload,
    now: i64,
) -> anyhow::Result<Option<i64>> {
    let payload_json = serde_json::to_string(payload)?;
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let revision: Option<i64> = sqlx::query_scalar(
        "UPDATE drafts SET payload_json = ?, revision = revision + 1, updated_at = ?, expires_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'
         RETURNING revision",
    )
    .bind(&payload_json)
    .bind(now)
    .bind(now + DRAFT_TTL_MS)
    .bind(draft_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(revision)
}

/// I3a: record a fetched image on its draft (section 7-4 step 3, success path).
/// Returns the affected row count; 0 means the draft was closed while the
/// image was being fetched (the image stays orphaned for the TTL sweep).
pub async fn attach_draft_image(
    pool: &SqlitePool,
    draft_id: i64,
    image_id: i64,
    now: i64,
) -> anyhow::Result<u64> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE drafts SET image_id = ?, image_status = 'attached', image_unavailable_reason = NULL,
                revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'",
    )
    .bind(image_id)
    .bind(now)
    .bind(draft_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n)
}

/// I3b: record why the image could not be saved (section 7-4 step 3, failure
/// path). Same 0-row semantics as [`attach_draft_image`].
pub async fn fail_draft_image(
    pool: &SqlitePool,
    draft_id: i64,
    reason: &str,
    now: i64,
) -> anyhow::Result<u64> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE drafts SET image_unavailable_reason = ?, revision = revision + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'",
    )
    .bind(reason)
    .bind(now)
    .bind(draft_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n)
}

/// Discard a pending draft (section 7-3). Returns affected rows; 0 means the
/// draft does not exist, belongs to another user, or is not pending.
pub async fn discard_draft(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
    now: i64,
) -> anyhow::Result<u64> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let n = sqlx::query(
        "UPDATE drafts SET status = 'discarded', image_id = NULL, closed_at = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'",
    )
    .bind(now)
    .bind(now)
    .bind(draft_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n)
}

// ---------------------------------------------------------------------------
// approval transaction (section 7-5)

#[derive(Debug, thiserror::Error)]
pub enum ApproveError {
    #[error("draft not found")]
    NotFound,
    #[error("draft status is {0}")]
    Conflict(String),
    #[error("stale revision {current}")]
    StaleRevision { current: i64, payload: String },
    #[error("editor role required for this ledger")]
    Forbidden,
    #[error("invalid draft payload: {0}")]
    Payload(String),
    #[error("invariant violated during approval")]
    Invariant,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Warnings returned by approval (section 7-5 return values, minus the
/// duplicate detection trio which is TASK-9).
#[derive(Debug, Clone, PartialEq)]
pub enum ApproveWarning {
    TotalDiff { items_total: i64, total_amount: i64 },
    UnknownStoreCategory { name: String },
    UnknownItemCategory { line_no: i64, name: String },
}

#[derive(Debug, Clone)]
pub struct ApproveOutcome {
    pub receipt_id: i64,
    pub warnings: Vec<ApproveWarning>,
}

/// Draft columns read at the start of approval (section 7-5 step 1).
type DraftRow = (
    String,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    String,
    String,
);

/// Approve a pending draft, expanding its payload into receipts /
/// receipt_items inside one BEGIN IMMEDIATE transaction (section 7-5).
pub async fn approve_draft(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
    revision: i64,
    now: i64,
) -> Result<ApproveOutcome, ApproveError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;

    // step 1: read the draft
    let row: Option<DraftRow> = sqlx::query_as(
        "SELECT status, revision, ledger_id, image_id, approved_receipt_id, approved_revision,
                    payload_json, image_status
             FROM drafts WHERE id = ? AND user_id = ?",
    )
    .bind(draft_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((
        status,
        current_revision,
        ledger_id,
        image_id,
        approved_receipt_id,
        approved_revision,
        payload_json,
        image_status,
    )) = row
    else {
        return Err(ApproveError::NotFound);
    };
    if status == "approved" && approved_revision == Some(revision) {
        // Idempotent success (section 7-4). A NULL approved_receipt_id means
        // the receipt was physically deleted afterwards (ON DELETE SET NULL);
        // approval cannot repeat anymore, so it is a conflict, not a panic.
        let Some(receipt_id) = approved_receipt_id else {
            return Err(ApproveError::Conflict(status));
        };
        tx.commit().await?;
        return Ok(ApproveOutcome {
            receipt_id,
            warnings: vec![],
        });
    }
    if status != "pending" {
        return Err(ApproveError::Conflict(status));
    }
    if current_revision != revision {
        return Err(ApproveError::StaleRevision {
            current: current_revision,
            payload: payload_json,
        });
    }

    // editor-or-above membership check (section 4)
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
            .bind(ledger_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
    if !matches!(role.as_deref(), Some("owner") | Some("editor")) {
        return Err(ApproveError::Forbidden);
    }

    // step 2: validate payload, resolve / create the store
    let payload: DraftPayload =
        serde_json::from_str(&payload_json).map_err(|e| ApproveError::Payload(e.to_string()))?;
    let purchased_on = payload
        .purchased_on
        .clone()
        .ok_or_else(|| ApproveError::Payload("purchased_on is required to approve".into()))?;

    let mut warnings = Vec::new();
    let store_display = payload
        .store_name
        .clone()
        .or_else(|| payload.store_name_raw.clone());
    let store_id =
        resolve_or_create_store(&mut tx, ledger_id, store_display.as_deref(), now).await?;
    if let (Some(store_id), Some(cat_path)) = (store_id, payload.store_category.as_deref()) {
        let cat_id = resolve_category(&mut tx, "store_categories", ledger_id, cat_path).await?;
        match cat_id {
            Some(cat_id) => {
                // user-chosen categories (section 5-3) survive; NULL / 'model'
                // rows take the model estimate.
                sqlx::query(
                    "UPDATE stores SET category_id = ?, category_source = 'model'
                     WHERE id = ? AND (category_source IS NULL OR category_source <> 'user')",
                )
                .bind(cat_id)
                .bind(store_id)
                .execute(&mut *tx)
                .await?;
            }
            None => warnings.push(ApproveWarning::UnknownStoreCategory {
                name: cat_path.to_string(),
            }),
        }
    }

    // step 3: insert the receipt header (source from image_status, section 6-1)
    let source = if image_status == "none" {
        "manual"
    } else {
        "image"
    };
    let receipt_id: i64 = sqlx::query_scalar(
        "INSERT INTO receipts (ledger_id, created_by, source, image_id, store_id, store_name_raw,
            purchased_on, purchased_time, tax_mode, total_amount, tax_amount, payment_method, note,
            revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(source)
    .bind(image_id)
    .bind(store_id)
    .bind(&payload.store_name_raw)
    .bind(&purchased_on)
    .bind(&payload.purchased_time)
    .bind(payload.tax_mode.map(|m| m.as_str()))
    .bind(payload.total_amount)
    .bind(payload.tax_amount)
    .bind(payload.payment_method.map(|m| m.as_str()))
    .bind(&payload.note)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    // step 3b: the draft's labels carry over inside the same tx (TASK-21,
    // spec_data-model.md 7-5): INSERT OR IGNORE — the idempotent re-approval
    // returns before this point, and the FK target row always exists (the
    // 0009 seed trigger plants all five colors per ledger). The sole audit
    // record of the creation-time assignment is the draft approve audit
    // (after_json = payload_json, which carries label_colors); no separate
    // receipt/label audit row is written.
    if let Some(colors) = &payload.label_colors {
        for c in colors {
            sqlx::query(
                "INSERT OR IGNORE INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(receipt_id)
            .bind(ledger_id)
            .bind(c.as_str())
            .bind(user_id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
    }

    // step 4: receipt items (category per line; item lines first, then discounts)
    let mut category_ids: Vec<Option<i64>> = Vec::with_capacity(payload.items.len());
    for it in &payload.items {
        match it.category.as_deref() {
            Some(path) => {
                let id = resolve_category(&mut tx, "item_categories", ledger_id, path).await?;
                if id.is_none() {
                    warnings.push(ApproveWarning::UnknownItemCategory {
                        line_no: it.line_no,
                        name: path.to_string(),
                    });
                }
                category_ids.push(id);
            }
            None => category_ids.push(None),
        }
    }

    let amounts_incl = compute_amounts_incl(&payload.items, payload.tax_mode, payload.tax_amount);

    // item lines first so discounts can reference them
    let mut line_row_ids: Vec<(i64, i64)> = Vec::with_capacity(payload.items.len());
    for (i, it) in payload.items.iter().enumerate() {
        if it.line_kind != LineKind::Item {
            continue;
        }
        let id = insert_receipt_item(
            &mut tx,
            ledger_id,
            receipt_id,
            it,
            category_ids[i],
            None,
            amounts_incl[i],
            now,
        )
        .await?;
        line_row_ids.push((it.line_no, id));
    }
    // discount lines: parent_line_no -> parent_item_id, category copied
    for (i, it) in payload.items.iter().enumerate() {
        if it.line_kind != LineKind::Discount {
            continue;
        }
        let parent_id = it.parent_line_no.and_then(|pl| {
            line_row_ids
                .iter()
                .find(|(ln, _)| *ln == pl)
                .map(|(_, id)| *id)
        });
        let category_id = parent_id
            .and_then(|pid| {
                let parent_line = line_row_ids.iter().find(|(_, id)| *id == pid)?.0;
                let parent_idx = payload
                    .items
                    .iter()
                    .position(|q| q.line_no == parent_line)?;
                category_ids[parent_idx]
            })
            .or(category_ids[i]);
        insert_receipt_item(
            &mut tx,
            ledger_id,
            receipt_id,
            it,
            category_id,
            parent_id,
            amounts_incl[i],
            now,
        )
        .await?;
    }

    // step 5: flip the draft (invariant: exactly 1 row inside this IMMEDIATE tx)
    let flipped = sqlx::query(
        "UPDATE drafts SET status = 'approved', approved_receipt_id = ?, approved_revision = ?,
                image_id = NULL, closed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending' AND revision = ?",
    )
    .bind(receipt_id)
    .bind(revision)
    .bind(now)
    .bind(now)
    .bind(draft_id)
    .bind(revision)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if flipped != 1 {
        return Err(ApproveError::Invariant);
    }

    // step 6: audit
    sqlx::query(
        "INSERT INTO audit_events (ledger_id, user_id, actor_kind, entity_type, entity_id, action,
            before_json, after_json, created_at)
         VALUES (?, ?, 'mcp', 'draft', ?, 'approve', NULL, ?, ?)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(draft_id)
    .bind(&payload_json)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // total diff warning (item + discount lines combined, tax-inclusive)
    let items_total: i64 = amounts_incl.iter().sum();
    if let Some(total_amount) = payload.total_amount
        && total_amount != items_total
    {
        warnings.push(ApproveWarning::TotalDiff {
            items_total,
            total_amount,
        });
    }
    Ok(ApproveOutcome {
        receipt_id,
        warnings,
    })
}

/// Resolve a store by normalized name through store_aliases then
/// stores.name_norm; create both rows when unknown (section 5-2). Returns
/// Ok(None) when there is no usable store name.
pub(crate) async fn resolve_or_create_store(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    display: Option<&str>,
    now: i64,
) -> Result<Option<i64>, sqlx::Error> {
    let Some(display) = display else {
        return Ok(None);
    };
    let norm = normalize_text(display);
    if norm.is_empty() {
        return Ok(None);
    }
    let by_alias: Option<i64> = sqlx::query_scalar(
        "SELECT store_id FROM store_aliases WHERE ledger_id = ? AND alias_norm = ?",
    )
    .bind(ledger_id)
    .bind(&norm)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(store_id) = by_alias {
        return Ok(Some(store_id));
    }
    let by_name: Option<i64> =
        sqlx::query_scalar("SELECT id FROM stores WHERE ledger_id = ? AND name_norm = ?")
            .bind(ledger_id)
            .bind(&norm)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(store_id) = by_name {
        return Ok(Some(store_id));
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(ledger_id)
    .bind(display)
    .bind(&norm)
    .bind(now)
    .bind(now)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(ledger_id)
    .bind(&norm)
    .bind(id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(Some(id))
}

/// Resolve "Top" or "Top/Sub" against a category table (item_categories or
/// store_categories) within one ledger. Returns None when unknown.
pub(crate) async fn resolve_category(
    conn: &mut SqliteConnection,
    table: &str,
    ledger_id: i64,
    path: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let (top, sub) = match path.split_once('/') {
        Some((t, s)) => (t.trim(), Some(s.trim())),
        None => (path.trim(), None),
    };
    // table is one of the two fixed category table names (no user input).
    match sub {
        Some(sub) => {
            let sql = format!(
                "SELECT c.id FROM {table} c JOIN {table} p ON p.id = c.parent_id
                 WHERE c.ledger_id = ? AND p.name = ? AND c.name = ?"
            );
            sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
                .bind(ledger_id)
                .bind(top)
                .bind(sub)
                .fetch_optional(&mut *conn)
                .await
        }
        None => {
            let sql = format!(
                "SELECT id FROM {table} WHERE ledger_id = ? AND parent_id IS NULL AND name = ?"
            );
            sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
                .bind(ledger_id)
                .bind(top)
                .fetch_optional(&mut *conn)
                .await
        }
    }
}

#[allow(clippy::too_many_arguments)] // private helper mirroring the column list
pub(crate) async fn insert_receipt_item(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    receipt_id: i64,
    it: &DraftItem,
    category_id: Option<i64>,
    parent_item_id: Option<i64>,
    amount_incl: i64,
    now: i64,
) -> Result<i64, sqlx::Error> {
    let name_norm = normalize_text(&it.name);
    let name_raw_norm = it.name_raw.as_deref().map(normalize_text);
    sqlx::query_scalar(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id,
            name, name_raw, name_norm, name_raw_norm, quantity, unit, unit_price, amount, amount_incl,
            tax_rate, category_id, category_source, bbox_x, bbox_y, bbox_w, bbox_h, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(it.line_no)
    .bind(it.line_kind.as_str())
    .bind(parent_item_id)
    .bind(&it.name)
    .bind(&it.name_raw)
    .bind(&name_norm)
    .bind(&name_raw_norm)
    .bind(it.quantity.unwrap_or(1.0))
    .bind(&it.unit)
    .bind(it.unit_price)
    .bind(it.amount)
    .bind(amount_incl)
    .bind(it.tax_rate)
    .bind(category_id)
    .bind(it.category_source.map_or("model", |s| s.as_str()))
    .bind(it.bbox.map(|b| b[0]))
    .bind(it.bbox.map(|b| b[1]))
    .bind(it.bbox.map(|b| b[2]))
    .bind(it.bbox.map(|b| b[3]))
    .bind(now)
    .bind(now)
    .fetch_one(&mut *conn)
    .await
}

/// Compute amount_incl per line (section 8):
/// - inclusive or unknown: amount as-is
/// - exclusive: amount * (100 + rate) / 100 per line, truncating the fraction;
///   when a printed tax amount exists, the gap between the converted total and
///   (net total + printed tax) is added to the largest-amount line so the
///   totals match.
pub(crate) fn compute_amounts_incl(
    items: &[DraftItem],
    tax_mode: Option<TaxMode>,
    tax_amount: Option<i64>,
) -> Vec<i64> {
    if tax_mode != Some(TaxMode::Exclusive) {
        return items.iter().map(|it| it.amount).collect();
    }
    let mut incl: Vec<i64> = items
        .iter()
        .map(|it| it.amount * (100 + it.tax_rate.unwrap_or(0)) / 100)
        .collect();
    if let Some(tax_amount) = tax_amount {
        let net_total: i64 = items.iter().map(|it| it.amount).sum();
        let converted: i64 = incl.iter().sum();
        let diff = (net_total + tax_amount) - converted;
        if diff != 0 && !items.is_empty() {
            let mut max_i = 0;
            for (i, it) in items.iter().enumerate() {
                if it.amount > items[max_i].amount {
                    max_i = i;
                }
            }
            incl[max_i] += diff;
        }
    }
    incl
}

// ---------------------------------------------------------------------------
// reopen (section 7-2)

#[derive(Debug, thiserror::Error)]
pub enum ReopenError {
    #[error("draft not found")]
    NotFound,
    #[error("only discarded/expired drafts can be reopened, status is {0}")]
    NotClosed(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Reopen a closed (discarded / expired) draft by inserting a fresh pending
/// draft (section 7-2): payload and reported_* are copied, source_file_id /
/// image_id are NULL, revision 1, expires_at = now + 14d, image state is
/// `none` when the original was `none`, otherwise `unavailable` + `reopened`.
/// Draft columns read by reopen (section 7-2).
type ReopenRow = (
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
);

/// The original row is untouched; an audit row records `reopened_from`.
pub async fn reopen_draft(
    pool: &SqlitePool,
    draft_id: i64,
    user_id: i64,
    now: i64,
) -> Result<i64, ReopenError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<ReopenRow> = sqlx::query_as(
        "SELECT ledger_id, status, payload_json, reported_filename, reported_taken_at, image_status
         FROM drafts WHERE id = ? AND user_id = ?",
    )
    .bind(draft_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((ledger_id, status, payload_json, reported_filename, reported_taken_at, image_status)) =
        row
    else {
        return Err(ReopenError::NotFound);
    };
    if status != "discarded" && status != "expired" {
        return Err(ReopenError::NotClosed(status));
    }
    let (new_status, reason) = if image_status == "none" {
        ("none", None)
    } else {
        ("unavailable", Some("reopened"))
    };
    let new_id: i64 = sqlx::query_scalar(
        "INSERT INTO drafts (ledger_id, user_id, status, revision, payload_json,
            image_status, image_unavailable_reason, reported_filename, reported_taken_at,
            created_at, updated_at, expires_at)
         VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(&payload_json)
    .bind(new_status)
    .bind(reason)
    .bind(&reported_filename)
    .bind(&reported_taken_at)
    .bind(now)
    .bind(now)
    .bind(now + DRAFT_TTL_MS)
    .fetch_one(&mut *tx)
    .await?;
    let after = serde_json::json!({ "reopened_from": draft_id }).to_string();
    sqlx::query(
        "INSERT INTO audit_events (ledger_id, user_id, actor_kind, entity_type, entity_id, action,
            before_json, after_json, created_at)
         VALUES (?, ?, 'mcp', 'draft', ?, 'reopen', NULL, ?, ?)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(new_id)
    .bind(&after)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(new_id)
}

// ---------------------------------------------------------------------------
// TTL cleanup (section 12)

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CleanupReport {
    pub expired_drafts: u64,
    pub deleted_drafts: u64,
    pub nulled_draft_payloads: u64,
    pub purged_receipts: u64,
    pub orphan_image_candidates: u64,
    pub deleted_orphan_images: u64,
    pub deleted_image_tokens: u64,
    pub deleted_auth_codes: u64,
    pub deleted_jtis: u64,
    pub deleted_ceremonies: u64,
    pub deleted_access_tokens: u64,
    pub deleted_refresh_tokens: u64,
    pub deleted_sessions: u64,
    pub deleted_grants: u64,
    pub deleted_invitations: u64,
    pub deleted_register_invitations: u64,
    pub deleted_share_tickets: u64,
    pub deleted_authz_requests: u64,
    pub deleted_subject_hashes: u64,
    pub nulled_recovery_ip_hashes: u64,
    pub auto_rejected_recoveries: u64,
    pub deleted_recovery_requests: u64,
    pub deleted_overflow_daily: u64,
}

/// Run the TTL sweep (section 12). Orphan image candidates are picked after
/// the draft / receipt sweeps, their files are deleted outside any write
/// transaction (filesystem I/O must not hold the BEGIN IMMEDIATE write lock),
/// and the rows are then dropped in a new transaction, re-checking that the
/// image is still unreferenced. A row is deleted only after
/// `delete_image_file(storage_path)` succeeds; on failure it is kept for the
/// next run. `cutoff_day` is the JST date 90 days ago for
/// recovery_overflow_daily. Scheduling (tokio interval) is TASK-10/11.
pub async fn cleanup_expired<F>(
    pool: &SqlitePool,
    now: i64,
    cutoff_day: &str,
    mut delete_image_file: F,
) -> anyhow::Result<CleanupReport>
where
    F: FnMut(&str) -> std::io::Result<()>,
{
    let mut conn = pool.acquire().await?;
    let mut r = CleanupReport::default();

    macro_rules! sweep {
        ($tx:ident, $field:ident, $sql:expr, $($bind:expr),*) => {{
            let mut q = sqlx::query($sql);
            $( q = q.bind($bind); )*
            r.$field = q.execute(&mut *$tx).await?.rows_affected();
        }};
    }

    // tx 1: draft / receipt sweeps, then the orphan candidates (section 12
    // order: expiry and purges first so their images become visible orphans).
    let orphans: Vec<(i64, String)> = {
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
        sweep!(
            tx,
            expired_drafts,
            "UPDATE drafts SET status = 'expired', image_id = NULL, closed_at = ?
             WHERE status = 'pending' AND expires_at < ?",
            now,
            now
        );
        sweep!(
            tx,
            deleted_drafts,
            "DELETE FROM drafts WHERE status IN ('expired','discarded') AND closed_at < ?",
            now - 30 * DAY_MS
        );
        sweep!(
            tx,
            nulled_draft_payloads,
            "UPDATE drafts SET payload_json = NULL
             WHERE status = 'approved' AND closed_at < ? AND payload_json IS NOT NULL",
            now - 90 * DAY_MS
        );
        sweep!(
            tx,
            purged_receipts,
            "DELETE FROM receipts WHERE deleted_at IS NOT NULL AND deleted_at < ?",
            now - 90 * DAY_MS
        );
        let orphans: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, storage_path FROM images im
             WHERE im.created_at < ?
               AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.image_id = im.id)
               AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.image_id = im.id)",
        )
        .bind(now - DAY_MS)
        .fetch_all(&mut *tx)
        .await?;
        tx.commit().await?;
        orphans
    };
    r.orphan_image_candidates = orphans.len() as u64;

    // delete the files first (section 12), outside the write transactions
    let mut files_deleted: Vec<i64> = Vec::with_capacity(orphans.len());
    for (id, path) in &orphans {
        if delete_image_file(path).is_ok() {
            files_deleted.push(*id);
        }
    }

    // tx 2: drop the rows whose files are gone, then the remaining sweeps
    {
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
        for id in files_deleted {
            r.deleted_orphan_images += sqlx::query(
                "DELETE FROM images WHERE id = ? AND created_at < ?
                   AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.image_id = images.id)
                   AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.image_id = images.id)",
            )
            .bind(id)
            .bind(now - DAY_MS)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        }
        sweep!(
            tx,
            deleted_image_tokens,
            "DELETE FROM image_access_tokens WHERE expires_at < ?",
            now
        );
        sweep!(
            tx,
            deleted_auth_codes,
            "DELETE FROM oauth_auth_codes WHERE expires_at < ?",
            now - DAY_MS
        );
        sweep!(
            tx,
            deleted_jtis,
            "DELETE FROM oauth_client_assertion_jtis WHERE expires_at < ?",
            now
        );
        sweep!(
            tx,
            deleted_ceremonies,
            "DELETE FROM webauthn_ceremonies WHERE expires_at < ?",
            now
        );
        sweep!(
            tx,
            deleted_access_tokens,
            "DELETE FROM oauth_access_tokens WHERE expires_at < ?",
            now - DAY_MS
        );
        // a revoked refresh row (a child superseded by a grace reissue) is
        // kept while its grant is live (unrevoked, before the absolute
        // expiry): presenting it stays a reuse signal even long after its
        // own expiry (spec_auth.md 4-9 step 1, TASK-140). A row whose grant
        // is dead or missing follows the expiry + 1 day rule.
        sweep!(
            tx,
            deleted_refresh_tokens,
            "DELETE FROM oauth_refresh_tokens WHERE expires_at < ?
                AND (revoked_at IS NULL OR grant_id NOT IN
                     (SELECT id FROM oauth_grants WHERE revoked_at IS NULL AND absolute_expires_at > ?))",
            now - DAY_MS,
            now
        );
        sweep!(
            tx,
            deleted_sessions,
            "DELETE FROM web_sessions WHERE absolute_expires_at < ?",
            now - DAY_MS
        );
        sweep!(
            tx,
            deleted_grants,
            "DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
                OR absolute_expires_at < ?",
            now - 30 * DAY_MS,
            now - 30 * DAY_MS
        );
        sweep!(
            tx,
            deleted_invitations,
            "DELETE FROM invitations WHERE (used_at IS NULL AND expires_at < ?)
                OR (used_at IS NOT NULL AND used_at < ?)",
            now - DAY_MS,
            now - 30 * DAY_MS
        );
        sweep!(
            tx,
            deleted_register_invitations,
            "DELETE FROM register_invitations WHERE (used_at IS NULL AND expires_at < ?)
                OR (used_at IS NOT NULL AND used_at < ?)",
            now - DAY_MS,
            now - 30 * DAY_MS
        );
        sweep!(
            tx,
            deleted_share_tickets,
            "DELETE FROM ledger_share_tickets WHERE (accepted_at IS NULL AND expires_at < ?)
                OR (accepted_at IS NOT NULL AND accepted_at < ?)",
            now - DAY_MS,
            now - 30 * DAY_MS
        );
        sweep!(
            tx,
            deleted_authz_requests,
            "DELETE FROM oauth_authorization_requests WHERE expires_at < ?",
            now
        );
        sweep!(
            tx,
            deleted_subject_hashes,
            "DELETE FROM user_subject_hashes WHERE last_seen_at < ?",
            now - 400 * DAY_MS
        );
        sweep!(
            tx,
            nulled_recovery_ip_hashes,
            "UPDATE recovery_requests SET ip_hash = NULL
             WHERE ip_hash IS NOT NULL AND created_at < ?",
            now - DAY_MS
        );
        sweep!(tx, auto_rejected_recoveries,
            "UPDATE recovery_requests SET status = 'rejected', closed_at = ?, close_note = 'auto: expired'
             WHERE status = 'open' AND created_at < ?", now, now - 90 * DAY_MS);
        sweep!(
            tx,
            deleted_recovery_requests,
            "DELETE FROM recovery_requests WHERE closed_at IS NOT NULL AND closed_at < ?",
            now - 180 * DAY_MS
        );
        sweep!(
            tx,
            deleted_overflow_daily,
            "DELETE FROM recovery_overflow_daily WHERE day < ?",
            cutoff_day
        );
        tx.commit().await?;
    }
    // one INFO line with every target's count (spec_auth.md 10-5, TASK-15)
    tracing::info!(
        expired_drafts = r.expired_drafts,
        deleted_drafts = r.deleted_drafts,
        nulled_draft_payloads = r.nulled_draft_payloads,
        purged_receipts = r.purged_receipts,
        orphan_image_candidates = r.orphan_image_candidates,
        deleted_orphan_images = r.deleted_orphan_images,
        deleted_image_tokens = r.deleted_image_tokens,
        deleted_auth_codes = r.deleted_auth_codes,
        deleted_jtis = r.deleted_jtis,
        deleted_ceremonies = r.deleted_ceremonies,
        deleted_access_tokens = r.deleted_access_tokens,
        deleted_refresh_tokens = r.deleted_refresh_tokens,
        deleted_sessions = r.deleted_sessions,
        deleted_grants = r.deleted_grants,
        deleted_invitations = r.deleted_invitations,
        deleted_register_invitations = r.deleted_register_invitations,
        deleted_share_tickets = r.deleted_share_tickets,
        deleted_authz_requests = r.deleted_authz_requests,
        deleted_subject_hashes = r.deleted_subject_hashes,
        nulled_recovery_ip_hashes = r.nulled_recovery_ip_hashes,
        auto_rejected_recoveries = r.auto_rejected_recoveries,
        deleted_recovery_requests = r.deleted_recovery_requests,
        deleted_overflow_daily = r.deleted_overflow_daily,
        "cleanup sweep finished"
    );
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-register.personal-ledger-name]
    #[test]
    fn personal_ledger_name_rules() {
        // the formula matches migration 0008's match pattern
        assert_eq!(personal_ledger_name("花子", 100), "花子の家計簿");
        // surrounding whitespace is trimmed off the display name
        assert_eq!(personal_ledger_name("  太郎\t", 100), "太郎の家計簿");
        // an empty (or blank) display name falls back to the shared constant
        assert_eq!(personal_ledger_name("", 100), DEFAULT_LEDGER_NAME);
        assert_eq!(personal_ledger_name("   ", 100), DEFAULT_LEDGER_NAME);
        // a display name that would push the whole name past the cap is cut
        // on the display side so the suffix survives (TASK-79 review #13)
        let display100: String = "あ".repeat(100);
        let name = personal_ledger_name(&display100, 100);
        assert_eq!(name.chars().count(), 100, "fits max_ledger_name_chars");
        assert!(name.ends_with("の家計簿"), "suffix kept: {name}");
        // a cap too small to hold the suffix falls back to the constant
        assert_eq!(personal_ledger_name("花子", 4), DEFAULT_LEDGER_NAME);
    }
}
