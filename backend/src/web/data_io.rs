//! TASK-58 settings-page data export / import (spec_mcp-tools.md section 12,
//! design tmp/tasks/tm-58/design_settings-data.md): one ledger's confirmed
//! data as a single JSON file (images embedded as base64url WebP bytes) and
//! its restore into a freshly created ledger. The web settings data tab is
//! the user-facing data takeout path — NOT the operator backup (tm-62).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use sqlx::sqlite::SqliteConnection;
use sqlx::{AssertSqlSafe, Connection, Row, SqlitePool, Transaction};

use crate::auth::tokens::{b64url_decode, b64url_encode};
use crate::domain::actor::Actor;
use crate::domain::catalog;
use crate::domain::images::new_image_file;
use crate::domain::labels::{LABEL_COLORS, LabelColor};
use crate::store;

pub const FORMAT: &str = "kakeiboot-ledger-export";
pub const VERSION: i64 = 1;

/// Caps both operations consult: app.toml `[data_io]` plus the shared
/// mcp.toml limits (the web adapter assembles this, like max_query_chars).
pub struct IoLimits {
    pub max_payload_bytes: usize,
    pub max_receipts: usize,
    pub max_items_total: usize,
    pub max_name_chars: usize,
    pub max_ledger_name_chars: usize,
    pub max_label_title_chars: usize,
    pub max_items_per_receipt: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum DataIoError {
    #[error("ledger not found")]
    NotFound,
    #[error("export payload over the configured cap")]
    ExportTooLarge,
    #[error("invalid import file: {0}")]
    Invalid(String),
    #[error("import over the configured cap")]
    TooLarge,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// SQLite constraint failures ("... constraint failed") are file-caused on
/// the import path: import_invalid, not an internal error.
fn classify_db(e: sqlx::Error) -> DataIoError {
    if let sqlx::Error::Database(db) = &e
        && db.message().contains("constraint failed")
    {
        return DataIoError::Invalid("database constraint".into());
    }
    DataIoError::Db(e)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// export

pub struct Exported {
    pub text: String,
    pub receipts: usize,
    pub images: usize,
}

/// One consistent snapshot (BEGIN IMMEDIATE: the read set and the audit row
/// share the transaction) of the ledger's confirmed data. Drafts, logically
/// deleted receipts, members, access tokens and the audit trail itself stay
/// out (design section 1-3).
pub async fn export_ledger(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    image_root: &Path,
    actor: &Actor,
    lim: &IoLimits,
    now: i64,
) -> Result<Exported, DataIoError> {
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(classify_db)?;

    let (name, ledger_created): (String, i64) =
        sqlx::query_as("SELECT name, created_at FROM ledgers WHERE id = ?")
            .bind(ledger_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(classify_db)?
            .ok_or(DataIoError::NotFound)?;

    let titles: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT color, title FROM ledger_labels WHERE ledger_id = ?")
            .bind(ledger_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(classify_db)?;
    let title_of = |color: &str| {
        titles
            .iter()
            .find(|(c, _)| c == color)
            .and_then(|(_, t)| t.clone())
    };
    let labels: Vec<Value> = LABEL_COLORS
        .iter()
        .map(|c| json!({ "color": c.as_str(), "title": title_of(c.as_str()) }))
        .collect();

    let item_categories = export_categories(&mut tx, "item_categories", ledger_id).await?;
    let store_categories = export_categories(&mut tx, "store_categories", ledger_id).await?;

    let stores: Vec<(i64, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, category_id, category_source FROM stores WHERE ledger_id = ? ORDER BY id",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(classify_db)?;
    let aliases: Vec<(i64, String)> = sqlx::query_as(
        "SELECT store_id, alias_norm FROM store_aliases WHERE ledger_id = ? ORDER BY alias_norm",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(classify_db)?;
    let stores_json: Vec<Value> = stores
        .iter()
        .map(|(id, name, cat, src)| {
            json!({
                "id": id, "name": name, "category_id": cat, "category_source": src,
                "aliases": aliases.iter()
                    .filter(|(sid, _)| sid == id)
                    .map(|(_, a)| a)
                    .collect::<Vec<_>>(),
            })
        })
        .collect();

    // images: rows + the stored files' bytes (a missing file is real damage;
    // it fails the export instead of silently breaking the round-trip)
    let img_rows = sqlx::query(
        "SELECT id, storage_path, width, height, byte_size, sha256, mime_type,
                source_file_id, source_host, original_filename, original_filename_source,
                taken_at_local, taken_at_offset, taken_at_source, exif_json, created_at
         FROM images WHERE ledger_id = ? ORDER BY id",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(classify_db)?;
    let mut images_json: Vec<Value> = Vec::with_capacity(img_rows.len());
    for row in &img_rows {
        let rel: &str = row.try_get(1)?;
        let bytes = tokio::fs::read(image_root.join(rel)).await?;
        images_json.push(json!({
            "id": row.try_get::<i64, _>(0)?,
            "width": row.try_get::<i64, _>(2)?,
            "height": row.try_get::<i64, _>(3)?,
            "byte_size": row.try_get::<i64, _>(4)?,
            "sha256_hex": hex(row.try_get::<Vec<u8>, _>(5)?.as_slice()),
            "mime_type": row.try_get::<String, _>(6)?,
            "source_file_id": row.try_get::<Option<String>, _>(7)?,
            "source_host": row.try_get::<Option<String>, _>(8)?,
            "original_filename": row.try_get::<Option<String>, _>(9)?,
            "original_filename_source": row.try_get::<Option<String>, _>(10)?,
            "taken_at_local": row.try_get::<Option<String>, _>(11)?,
            "taken_at_offset": row.try_get::<Option<String>, _>(12)?,
            "taken_at_source": row.try_get::<Option<String>, _>(13)?,
            "exif_json": row.try_get::<Option<String>, _>(14)?,
            "created_at": row.try_get::<i64, _>(15)?,
            "data_base64": b64url_encode(&bytes),
        }));
    }

    // receipts (live only) + items + label assignments
    let receipt_rows = sqlx::query(
        "SELECT id, source, image_id, store_id, store_name_raw, purchased_on, purchased_time,
                tax_mode, total_amount, tax_amount, payment_method, note, revision,
                created_at, updated_at
         FROM receipts WHERE ledger_id = ? AND deleted_at IS NULL ORDER BY id",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(classify_db)?;
    let item_rows = sqlx::query(
        "SELECT id, receipt_id, line_no, line_kind, parent_item_id, name, name_raw, quantity,
                unit, unit_price, amount, amount_incl, tax_rate, category_id, category_source,
                bbox_x, bbox_y, bbox_w, bbox_h
         FROM receipt_items WHERE ledger_id = ? ORDER BY receipt_id, line_no",
    )
    .bind(ledger_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(classify_db)?;
    let line_no_of: HashMap<(i64, i64), i64> = item_rows
        .iter()
        .map(|r| {
            Ok((
                (r.try_get::<i64, _>(1)?, r.try_get::<i64, _>(0)?),
                r.try_get::<i64, _>(2)?,
            ))
        })
        .collect::<Result<HashMap<(i64, i64), i64>, sqlx::Error>>()
        .map_err(classify_db)?;
    let receipt_labels: Vec<(i64, String)> =
        sqlx::query_as("SELECT receipt_id, color FROM receipt_labels WHERE ledger_id = ?")
            .bind(ledger_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(classify_db)?;

    let mut receipts_json: Vec<Value> = Vec::with_capacity(receipt_rows.len());
    for row in &receipt_rows {
        let rid: i64 = row.try_get(0)?;
        let mut labels: Vec<&str> = receipt_labels
            .iter()
            .filter(|(r, _)| *r == rid)
            .filter_map(|(_, c)| LabelColor::parse(c).map(|l| l.as_str()))
            .collect();
        // definition order (the palette order, not the alphabetical DB order)
        labels.sort_by_key(|c| {
            LABEL_COLORS
                .iter()
                .position(|p| p.as_str() == *c)
                .unwrap_or(usize::MAX)
        });
        let mut items: Vec<Value> = Vec::new();
        for it in &item_rows {
            if it.try_get::<i64, _>(1)? != rid {
                continue;
            }
            let parent: Option<i64> = it.try_get(4)?;
            let parent_line = parent
                .and_then(|p| line_no_of.get(&(rid, p)).copied())
                .map(Value::from)
                .unwrap_or(Value::Null);
            let bbox_x: Option<f64> = it.try_get(15)?;
            let bbox = match bbox_x {
                Some(x) => json!([
                    x,
                    it.try_get::<f64, _>(16)?,
                    it.try_get::<f64, _>(17)?,
                    it.try_get::<f64, _>(18)?
                ]),
                None => Value::Null,
            };
            items.push(json!({
                "line_no": it.try_get::<i64, _>(2)?,
                "line_kind": it.try_get::<String, _>(3)?,
                "parent_line_no": parent_line,
                "name": it.try_get::<String, _>(5)?,
                "name_raw": it.try_get::<Option<String>, _>(6)?,
                "quantity": it.try_get::<f64, _>(7)?,
                "unit": it.try_get::<Option<String>, _>(8)?,
                "unit_price": it.try_get::<Option<i64>, _>(9)?,
                "amount": it.try_get::<i64, _>(10)?,
                "amount_incl": it.try_get::<i64, _>(11)?,
                "tax_rate": it.try_get::<Option<i64>, _>(12)?,
                "category_id": it.try_get::<Option<i64>, _>(13)?,
                "category_source": it.try_get::<Option<String>, _>(14)?,
                "bbox": bbox,
            }));
        }
        receipts_json.push(json!({
            "id": rid,
            "source": row.try_get::<String, _>(1)?,
            "image_id": row.try_get::<Option<i64>, _>(2)?,
            "store_id": row.try_get::<Option<i64>, _>(3)?,
            "store_name_raw": row.try_get::<Option<String>, _>(4)?,
            "purchased_on": row.try_get::<String, _>(5)?,
            "purchased_time": row.try_get::<Option<String>, _>(6)?,
            "tax_mode": row.try_get::<Option<String>, _>(7)?,
            "total_amount": row.try_get::<Option<i64>, _>(8)?,
            "tax_amount": row.try_get::<Option<i64>, _>(9)?,
            "payment_method": row.try_get::<Option<String>, _>(10)?,
            "note": row.try_get::<Option<String>, _>(11)?,
            "revision": row.try_get::<i64, _>(12)?,
            "created_at": row.try_get::<i64, _>(13)?,
            "updated_at": row.try_get::<i64, _>(14)?,
            "labels": labels,
            "items": items,
        }));
    }

    let v = json!({
        "format": FORMAT,
        "version": VERSION,
        "exported_at": now,
        "ledger": { "id": ledger_id, "name": name, "created_at": ledger_created },
        "labels": labels,
        "item_categories": item_categories,
        "store_categories": store_categories,
        "stores": stores_json,
        "images": images_json,
        "receipts": receipts_json,
    });
    let text = serde_json::to_string(&v).map_err(|e| DataIoError::Io(std::io::Error::other(e)))?;
    if text.len() > lim.max_payload_bytes {
        return Err(DataIoError::ExportTooLarge);
    }
    let out = Exported {
        text,
        receipts: receipts_json.len(),
        images: images_json.len(),
    };
    catalog::audit(
        &mut tx,
        ledger_id,
        actor,
        "ledger",
        ledger_id,
        "export",
        None,
        Some(&json!({ "receipts": out.receipts, "images": out.images, "bytes": out.text.len() })),
        now,
    )
    .await
    .map_err(classify_db)?;
    tx.commit().await.map_err(classify_db)?;
    Ok(out)
}

async fn export_categories(
    tx: &mut SqliteConnection,
    table: &str,
    ledger_id: i64,
) -> Result<Vec<Value>, DataIoError> {
    // table is one of the two fixed category table names (no user input)
    /// (id, parent_id, name, sort_order, archived_at)
    type CategoryRow = (i64, Option<i64>, String, i64, Option<i64>);
    let sql = format!(
        "SELECT id, parent_id, name, sort_order, archived_at FROM {table}
         WHERE ledger_id = ? ORDER BY parent_id IS NOT NULL, sort_order, id"
    );
    let rows: Vec<CategoryRow> = sqlx::query_as(AssertSqlSafe(sql.as_str()))
        .bind(ledger_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(classify_db)?;
    Ok(rows
        .into_iter()
        .map(|(id, parent, name, sort, archived)| {
            json!({ "id": id, "parent_id": parent, "name": name, "sort_order": sort,
                    "archived_at": archived })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// import: file parsing + validation (design section 2-2)

struct InLabel {
    color: LabelColor,
    title: Option<String>,
}

struct InCategory {
    id: i64,
    parent: Option<i64>,
    name: String,
    sort: i64,
    archived_at: Option<i64>,
}

struct InStore {
    id: i64,
    name: String,
    category: Option<i64>,
    category_source: Option<String>,
    aliases: Vec<String>,
}

struct InImage {
    id: i64,
    width: i64,
    height: i64,
    sha256: Vec<u8>,
    mime_type: String,
    source_file_id: Option<String>,
    source_host: Option<String>,
    original_filename: Option<String>,
    original_filename_source: Option<String>,
    taken_at_local: Option<String>,
    taken_at_offset: Option<String>,
    taken_at_source: Option<String>,
    exif_json: Option<String>,
    created_at: i64,
    data: Vec<u8>,
}

struct InItem {
    line_no: i64,
    discount: bool,
    parent_line: Option<i64>,
    name: String,
    name_raw: Option<String>,
    quantity: f64,
    unit: Option<String>,
    unit_price: Option<i64>,
    amount: i64,
    amount_incl: i64,
    tax_rate: Option<i64>,
    category: Option<i64>,
    category_source: Option<String>,
    bbox: Option<[f64; 4]>,
}

struct InReceipt {
    id: i64,
    source: String,
    image: Option<i64>,
    store: Option<i64>,
    store_name_raw: Option<String>,
    purchased_on: String,
    purchased_time: Option<String>,
    tax_mode: Option<String>,
    total_amount: Option<i64>,
    tax_amount: Option<i64>,
    payment_method: Option<String>,
    note: Option<String>,
    revision: i64,
    created_at: i64,
    updated_at: i64,
    labels: Vec<LabelColor>,
    items: Vec<InItem>,
}

struct ParsedFile {
    name: String,
    labels: Vec<InLabel>,
    item_categories: Vec<InCategory>,
    store_categories: Vec<InCategory>,
    stores: Vec<InStore>,
    images: Vec<InImage>,
    receipts: Vec<InReceipt>,
}

fn bad(what: &str) -> DataIoError {
    DataIoError::Invalid(what.into())
}

fn req_int(m: &Map<String, Value>, k: &str) -> Result<i64, DataIoError> {
    m.get(k).and_then(Value::as_i64).ok_or_else(|| bad(k))
}

fn req_str(m: &Map<String, Value>, k: &str) -> Result<String, DataIoError> {
    m.get(k)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad(k))
}

/// Nullable string: None (absent) stays None; JSON null -> None; a string
/// becomes Some. Any other shape is invalid.
fn opt_str(m: &Map<String, Value>, k: &str) -> Result<Option<String>, DataIoError> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(bad(k)),
    }
}

fn opt_int(m: &Map<String, Value>, k: &str) -> Result<Option<i64>, DataIoError> {
    match m.get(k) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_i64().map(Some).ok_or_else(|| bad(k)),
    }
}

fn array<'a>(v: &'a Value, k: &str) -> Result<&'a Vec<Value>, DataIoError> {
    v.get(k).and_then(Value::as_array).ok_or_else(|| bad(k))
}

fn char_cap(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max
}

/// The receipts.purchased_on CHECK (GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]').
fn date_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && (b[5] - b'0') <= 1
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
        && (b[8] - b'0') <= 3
}

/// The receipts.purchased_time CHECK (GLOB '[0-2][0-9]:[0-5][0-9]*').
fn time_ok(s: &str) -> bool {
    let b: Vec<char> = s.chars().collect();
    b.len() >= 5
        && b[0] >= '0'
        && b[0] <= '2'
        && b[1].is_ascii_digit()
        && b[2] == ':'
        && b[3] >= '0'
        && b[3] <= '5'
        && b[4].is_ascii_digit()
}

const PAYMENT_METHODS: &[&str] = &[
    "cash",
    "credit_card",
    "debit_card",
    "e_money",
    "qr_code",
    "point",
    "gift_card",
    "bank_transfer",
    "other",
];

fn parse_labels(v: &Value, lim: &IoLimits) -> Result<Vec<InLabel>, DataIoError> {
    let mut out = Vec::new();
    for entry in array(v, "labels")? {
        let m = entry.as_object().ok_or_else(|| bad("labels"))?;
        let color = m
            .get("color")
            .and_then(Value::as_str)
            .and_then(LabelColor::parse)
            .ok_or_else(|| bad("labels.color"))?;
        let title = match opt_str(m, "title")? {
            None => None,
            Some(t) => {
                let t = t.trim();
                if t.chars().count() > lim.max_label_title_chars {
                    return Err(bad("labels.title"));
                }
                (!t.is_empty()).then(|| t.to_string())
            }
        };
        if out.iter().any(|l: &InLabel| l.color == color) {
            return Err(bad("labels.color duplicate"));
        }
        out.push(InLabel { color, title });
    }
    Ok(out)
}

fn parse_categories(v: &Value, key: &str, lim: &IoLimits) -> Result<Vec<InCategory>, DataIoError> {
    let mut out = Vec::new();
    for entry in array(v, key)? {
        let m = entry.as_object().ok_or_else(|| bad(key))?;
        let id = req_int(m, "id")?;
        let parent = opt_int(m, "parent_id")?;
        let name = req_str(m, "name")?;
        if !char_cap(&name, lim.max_name_chars) {
            return Err(bad("category.name"));
        }
        out.push(InCategory {
            id,
            parent,
            name,
            sort: req_int(m, "sort_order")?,
            archived_at: opt_int(m, "archived_at")?,
        });
    }
    // uniqueness + parent references (parents may appear in any order) + the
    // 2-level depth cap (a referenced parent must itself be top-level)
    let ids: Vec<i64> = out.iter().map(|c| c.id).collect();
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
        return Err(bad("category.id duplicate"));
    }
    for c in &out {
        if let Some(p) = c.parent {
            let parent = out
                .iter()
                .find(|x| x.id == p)
                .ok_or_else(|| bad("category.parent"))?;
            if parent.parent.is_some() {
                return Err(bad("category.depth"));
            }
        }
    }
    Ok(out)
}

fn parse_stores(v: &Value, lim: &IoLimits) -> Result<Vec<InStore>, DataIoError> {
    let mut out = Vec::new();
    for entry in array(v, "stores")? {
        let m = entry.as_object().ok_or_else(|| bad("stores"))?;
        let name = req_str(m, "name")?;
        if !char_cap(&name, lim.max_name_chars) {
            return Err(bad("store.name"));
        }
        let category_source = opt_str(m, "category_source")?;
        if let Some(src) = &category_source
            && !matches!(src.as_str(), "model" | "user")
        {
            return Err(bad("store.category_source"));
        }
        let mut aliases = Vec::new();
        for a in m
            .get("aliases")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("stores.aliases"))?
        {
            let a = a.as_str().ok_or_else(|| bad("stores.aliases"))?;
            if !char_cap(a, lim.max_name_chars) {
                return Err(bad("store.alias"));
            }
            aliases.push(a.to_string());
        }
        out.push(InStore {
            id: req_int(m, "id")?,
            name,
            category: opt_int(m, "category_id")?,
            category_source,
            aliases,
        });
    }
    let ids: Vec<i64> = out.iter().map(|s| s.id).collect();
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
        return Err(bad("store.id duplicate"));
    }
    Ok(out)
}

fn parse_images(v: &Value) -> Result<Vec<InImage>, DataIoError> {
    let mut out = Vec::new();
    for entry in array(v, "images")? {
        let m = entry.as_object().ok_or_else(|| bad("images"))?;
        let width = req_int(m, "width")?;
        let height = req_int(m, "height")?;
        if width <= 0 || height <= 0 {
            return Err(bad("images.size"));
        }
        let byte_size = req_int(m, "byte_size")?;
        if byte_size <= 0 {
            return Err(bad("images.byte_size"));
        }
        let hexs = req_str(m, "sha256_hex")?;
        if hexs.len() != 64 || !hexs.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(bad("images.sha256_hex"));
        }
        let sha256 = (0..32)
            .map(|i| u8::from_str_radix(&hexs[i * 2..i * 2 + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| bad("images.sha256_hex"))?;
        let data = b64url_decode(
            m.get("data_base64")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("images.data_base64"))?,
        )
        .ok_or_else(|| bad("images.data_base64"))?;
        // integrity: the declared size matches and the payload is WebP
        if data.len() as i64 != byte_size {
            return Err(bad("images.byte_size mismatch"));
        }
        if data.len() < 12 || &data[0..4] != b"RIFF" || &data[8..12] != b"WEBP" {
            return Err(bad("images.data_base64 not webp"));
        }
        let original_filename = opt_str(m, "original_filename")?;
        let original_filename_source = opt_str(m, "original_filename_source")?;
        if original_filename.is_some() != original_filename_source.is_some() {
            return Err(bad("images.original_filename"));
        }
        let taken_at_local = opt_str(m, "taken_at_local")?;
        let taken_at_source = opt_str(m, "taken_at_source")?;
        if taken_at_local.is_some() != taken_at_source.is_some() {
            return Err(bad("images.taken_at"));
        }
        let exif_json = opt_str(m, "exif_json")?;
        if let Some(ex) = &exif_json
            && serde_json::from_str::<Value>(ex).is_err()
        {
            return Err(bad("images.exif_json"));
        }
        out.push(InImage {
            id: req_int(m, "id")?,
            width,
            height,
            sha256,
            mime_type: req_str(m, "mime_type")?,
            source_file_id: opt_str(m, "source_file_id")?,
            source_host: opt_str(m, "source_host")?,
            original_filename,
            original_filename_source,
            taken_at_local,
            taken_at_offset: opt_str(m, "taken_at_offset")?,
            taken_at_source,
            exif_json,
            created_at: req_int(m, "created_at")?,
            data,
        });
    }
    let ids: Vec<i64> = out.iter().map(|i| i.id).collect();
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
        return Err(bad("images.id duplicate"));
    }
    Ok(out)
}

fn parse_receipts(v: &Value, lim: &IoLimits) -> Result<Vec<InReceipt>, DataIoError> {
    let raw = array(v, "receipts")?;
    if raw.len() > lim.max_receipts {
        return Err(DataIoError::TooLarge);
    }
    let mut total_items = 0_usize;
    let mut out = Vec::new();
    for entry in raw {
        let m = entry.as_object().ok_or_else(|| bad("receipts"))?;
        let id = req_int(m, "id")?;
        let source = req_str(m, "source")?;
        if !matches!(source.as_str(), "image" | "manual") {
            return Err(bad("receipts.source"));
        }
        let purchased_on = req_str(m, "purchased_on")?;
        if !date_ok(&purchased_on) {
            return Err(bad("receipts.purchased_on"));
        }
        let purchased_time = opt_str(m, "purchased_time")?;
        if let Some(t) = &purchased_time
            && !time_ok(t)
        {
            return Err(bad("receipts.purchased_time"));
        }
        let tax_mode = opt_str(m, "tax_mode")?;
        if let Some(t) = &tax_mode
            && !matches!(t.as_str(), "inclusive" | "exclusive")
        {
            return Err(bad("receipts.tax_mode"));
        }
        let payment_method = opt_str(m, "payment_method")?;
        if let Some(p) = &payment_method
            && !PAYMENT_METHODS.contains(&p.as_str())
        {
            return Err(bad("receipts.payment_method"));
        }
        let mut labels: Vec<LabelColor> = Vec::new();
        for c in m
            .get("labels")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("receipts.labels"))?
        {
            let color = c
                .as_str()
                .and_then(LabelColor::parse)
                .ok_or_else(|| bad("receipts.labels"))?;
            if labels.contains(&color) {
                return Err(bad("receipts.labels duplicate"));
            }
            labels.push(color);
        }
        let items_raw = m
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| bad("receipts.items"))?;
        if items_raw.len() > lim.max_items_per_receipt {
            return Err(DataIoError::TooLarge);
        }
        total_items += items_raw.len();
        let mut items: Vec<InItem> = Vec::new();
        for it in items_raw {
            let im = it.as_object().ok_or_else(|| bad("receipts.items"))?;
            let line_no = req_int(im, "line_no")?;
            if line_no <= 0 || items.iter().any(|x| x.line_no == line_no) {
                return Err(bad("items.line_no"));
            }
            let kind = req_str(im, "line_kind")?;
            let discount = match kind.as_str() {
                "item" => false,
                "discount" => true,
                _ => return Err(bad("items.line_kind")),
            };
            let name = req_str(im, "name")?;
            if !char_cap(&name, lim.max_name_chars) {
                return Err(bad("items.name"));
            }
            let quantity = im
                .get("quantity")
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("items.quantity"))?;
            if quantity <= 0.0 {
                return Err(bad("items.quantity"));
            }
            let amount = req_int(im, "amount")?;
            let amount_incl = req_int(im, "amount_incl")?;
            if discount && amount > 0 {
                return Err(bad("discount amount"));
            }
            let tax_rate = opt_int(im, "tax_rate")?;
            if let Some(t) = tax_rate
                && !(0..=100).contains(&t)
            {
                return Err(bad("items.tax_rate"));
            }
            let category_source = opt_str(im, "category_source")?;
            if let Some(src) = &category_source
                && !matches!(src.as_str(), "model" | "history" | "user")
            {
                return Err(bad("items.category_source"));
            }
            let bbox = match im.get("bbox") {
                None | Some(Value::Null) => None,
                Some(Value::Array(a)) if a.len() == 4 => {
                    let mut n = [0.0_f64; 4];
                    for (i, slot) in n.iter_mut().enumerate() {
                        *slot = a[i].as_f64().ok_or_else(|| bad("items.bbox"))?;
                    }
                    // the receipt_items CHECK (0..1 coordinates, positive
                    // size, within the picture with the 1.0001 slack)
                    if !((0.0..=1.0).contains(&n[0])
                        && (0.0..=1.0).contains(&n[1])
                        && n[2] > 0.0
                        && n[3] > 0.0
                        && n[0] + n[2] <= 1.0001
                        && n[1] + n[3] <= 1.0001)
                    {
                        return Err(bad("items.bbox"));
                    }
                    Some(n)
                }
                Some(_) => return Err(bad("items.bbox")),
            };
            let parent_line = opt_int(im, "parent_line_no")?;
            if parent_line.is_some() && !discount {
                return Err(bad("items.parent_line_no"));
            }
            items.push(InItem {
                line_no,
                discount,
                parent_line,
                name,
                name_raw: opt_str(im, "name_raw")?,
                quantity,
                unit: opt_str(im, "unit")?,
                unit_price: opt_int(im, "unit_price")?,
                amount,
                amount_incl,
                tax_rate,
                category: opt_int(im, "category_id")?,
                category_source,
                bbox,
            });
        }
        // discount parents resolve to an item line of the same receipt
        for it in &items {
            if let Some(p) = it.parent_line
                && !items.iter().any(|x| !x.discount && x.line_no == p)
            {
                return Err(bad("items.parent_line_no"));
            }
        }
        out.push(InReceipt {
            id,
            source,
            image: opt_int(m, "image_id")?,
            store: opt_int(m, "store_id")?,
            store_name_raw: opt_str(m, "store_name_raw")?,
            purchased_on,
            purchased_time,
            tax_mode,
            total_amount: opt_int(m, "total_amount")?,
            tax_amount: opt_int(m, "tax_amount")?,
            payment_method,
            note: opt_str(m, "note")?,
            revision: req_int(m, "revision")?,
            created_at: req_int(m, "created_at")?,
            updated_at: req_int(m, "updated_at")?,
            labels,
            items,
        });
    }
    if total_items > lim.max_items_total {
        return Err(DataIoError::TooLarge);
    }
    let ids: Vec<i64> = out.iter().map(|r| r.id).collect();
    if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
        return Err(bad("receipts.id duplicate"));
    }
    Ok(out)
}

fn parse_file(file: &Value, lim: &IoLimits) -> Result<ParsedFile, DataIoError> {
    if file.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(bad("format"));
    }
    if file.get("version").and_then(Value::as_i64) != Some(VERSION) {
        return Err(bad("version"));
    }
    let ledger = file
        .get("ledger")
        .and_then(Value::as_object)
        .ok_or_else(|| bad("ledger"))?;
    let name = req_str(ledger, "name")?;
    let name = name.trim();
    if !char_cap(name, lim.max_ledger_name_chars) {
        return Err(bad("ledger.name"));
    }
    let parsed = ParsedFile {
        name: name.to_string(),
        labels: parse_labels(file, lim)?,
        item_categories: parse_categories(file, "item_categories", lim)?,
        store_categories: parse_categories(file, "store_categories", lim)?,
        stores: parse_stores(file, lim)?,
        images: parse_images(file)?,
        receipts: parse_receipts(file, lim)?,
    };
    // cross-collection references must resolve inside the file
    let item_cat_ids: Vec<i64> = parsed.item_categories.iter().map(|c| c.id).collect();
    let store_cat_ids: Vec<i64> = parsed.store_categories.iter().map(|c| c.id).collect();
    let store_ids: Vec<i64> = parsed.stores.iter().map(|s| s.id).collect();
    let image_ids: Vec<i64> = parsed.images.iter().map(|i| i.id).collect();
    for s in &parsed.stores {
        if let Some(c) = s.category
            && !store_cat_ids.contains(&c)
        {
            return Err(bad("store.category_id"));
        }
    }
    for r in &parsed.receipts {
        if let Some(s) = r.store
            && !store_ids.contains(&s)
        {
            return Err(bad("receipt.store_id"));
        }
        if let Some(i) = r.image
            && !image_ids.contains(&i)
        {
            return Err(bad("receipt.image_id"));
        }
        for it in &r.items {
            if let Some(c) = it.category
                && !item_cat_ids.contains(&c)
            {
                return Err(bad("item.category_id"));
            }
        }
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// import: execution

pub struct ImportOutcome {
    pub ledger_id: i64,
    pub name: String,
    pub receipts: usize,
    pub items: usize,
    pub images: usize,
    pub stores: usize,
    pub item_categories: usize,
    pub store_categories: usize,
}

struct WrittenImage {
    key: String,
    rel: String,
    abs: PathBuf,
}

/// Restore an export file as a NEW ledger owned by `actor`'s user: image
/// files are written first, then one BEGIN IMMEDIATE transaction inserts
/// everything (the ledgers_seed_labels trigger creates the five label rows;
/// only their titles are updated). On any failure the transaction rolls back
/// and the written files are removed (compensation). The connection and the
/// transaction are taken before the first write so that every failure after
/// it — a mid-loop fs error, the transaction body, or the commit — runs the
/// same compensation instead of leaving written files behind.
pub async fn import_ledger(
    pool: &SqlitePool,
    image_root: &Path,
    file: &Value,
    actor: &Actor,
    lim: &IoLimits,
    now: i64,
) -> Result<ImportOutcome, DataIoError> {
    let parsed = parse_file(file, lim)?;

    let mut conn = pool.acquire().await.map_err(classify_db)?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(classify_db)?;

    let mut written: Vec<WrittenImage> = Vec::with_capacity(parsed.images.len());
    let outcome = async {
        for img in &parsed.images {
            let (key, rel) = new_image_file(now);
            let abs = image_root.join(&rel);
            if let Some(parent) = abs.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            if let Err(e) = tokio::fs::write(&abs, &img.data).await {
                // a partial file (ENOSPC/EIO mid-write) is not in `written`
                // yet — remove it before propagating
                let _ = tokio::fs::remove_file(&abs).await;
                return Err(e.into());
            }
            written.push(WrittenImage { key, rel, abs });
        }
        import_tx(&mut tx, &parsed, &written, actor, now)
            .await
            .map_err(classify_db)
    }
    .await;

    match outcome {
        Ok(out) => match tx.commit().await {
            Ok(()) => Ok(out),
            Err(e) => {
                remove_written_images(&written).await;
                Err(classify_db(e))
            }
        },
        Err(e) => {
            let _ = tx.rollback().await;
            remove_written_images(&written).await;
            Err(e)
        }
    }
}

/// Best-effort removal of the image files written by a failed import.
async fn remove_written_images(written: &[WrittenImage]) {
    for w in written {
        let _ = tokio::fs::remove_file(&w.abs).await;
    }
}

/// The transaction body. Every error is sqlx here so `classify_db` can sort
/// constraint failures (file-caused) from real internal failures.
async fn import_tx(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    p: &ParsedFile,
    written: &[WrittenImage],
    actor: &Actor,
    now: i64,
) -> Result<ImportOutcome, sqlx::Error> {
    let user_id = actor.user_id;
    let ledger_id: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(&p.name)
    .bind(now)
    .bind(now)
    .fetch_one(&mut **tx)
    .await?;

    for l in &p.labels {
        sqlx::query(
            "UPDATE ledger_labels SET title = ?, updated_at = ? WHERE ledger_id = ? AND color = ?",
        )
        .bind(&l.title)
        .bind(now)
        .bind(ledger_id)
        .bind(l.color.as_str())
        .execute(&mut **tx)
        .await?;
    }

    // categories: top-level rows first so sub rows can map their parents
    let mut item_map: HashMap<i64, i64> = HashMap::new();
    insert_categories(
        tx,
        "item_categories",
        &p.item_categories,
        ledger_id,
        now,
        &mut item_map,
    )
    .await?;
    let mut store_cat_map: HashMap<i64, i64> = HashMap::new();
    insert_categories(
        tx,
        "store_categories",
        &p.store_categories,
        ledger_id,
        now,
        &mut store_cat_map,
    )
    .await?;

    let mut store_map: HashMap<i64, i64> = HashMap::new();
    for s in &p.stores {
        let cat = s.category.and_then(|c| store_cat_map.get(&c).copied());
        let new_id: i64 = sqlx::query_scalar(
            "INSERT INTO stores (ledger_id, name, name_norm, category_id, category_source, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(ledger_id)
        .bind(&s.name)
        .bind(store::normalize_text(&s.name))
        .bind(cat)
        .bind(&s.category_source)
        .bind(now)
        .bind(now)
        .fetch_one(&mut **tx)
        .await?;
        for a in &s.aliases {
            sqlx::query(
                "INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
                 VALUES (?, ?, ?, ?)",
            )
            .bind(ledger_id)
            .bind(store::normalize_text(a))
            .bind(new_id)
            .bind(now)
            .execute(&mut **tx)
            .await?;
        }
        store_map.insert(s.id, new_id);
    }

    let mut image_map: HashMap<i64, i64> = HashMap::new();
    for (img, w) in p.images.iter().zip(written.iter()) {
        let new_id: i64 = sqlx::query_scalar(
            "INSERT INTO images (ledger_id, uploaded_by, file_key, storage_path, mime_type, width,
                 height, byte_size, sha256, source_file_id, source_host, original_filename,
                 original_filename_source, taken_at_local, taken_at_offset, taken_at_source,
                 exif_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(ledger_id)
        .bind(user_id)
        .bind(&w.key)
        .bind(&w.rel)
        .bind(&img.mime_type)
        .bind(img.width)
        .bind(img.height)
        .bind(img.data.len() as i64)
        .bind(&img.sha256)
        .bind(&img.source_file_id)
        .bind(&img.source_host)
        .bind(&img.original_filename)
        .bind(&img.original_filename_source)
        .bind(&img.taken_at_local)
        .bind(&img.taken_at_offset)
        .bind(&img.taken_at_source)
        .bind(&img.exif_json)
        .bind(img.created_at)
        .fetch_one(&mut **tx)
        .await?;
        image_map.insert(img.id, new_id);
    }

    let mut item_count = 0_usize;
    for r in &p.receipts {
        let new_rid: i64 = sqlx::query_scalar(
            "INSERT INTO receipts (ledger_id, created_by, source, image_id, store_id,
                 store_name_raw, purchased_on, purchased_time, tax_mode, total_amount, tax_amount,
                 payment_method, note, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind(ledger_id)
        .bind(user_id)
        .bind(&r.source)
        .bind(r.image.and_then(|i| image_map.get(&i).copied()))
        .bind(r.store.and_then(|s| store_map.get(&s).copied()))
        .bind(&r.store_name_raw)
        .bind(&r.purchased_on)
        .bind(&r.purchased_time)
        .bind(&r.tax_mode)
        .bind(r.total_amount)
        .bind(r.tax_amount)
        .bind(&r.payment_method)
        .bind(&r.note)
        .bind(r.revision)
        .bind(r.created_at)
        .bind(r.updated_at)
        .fetch_one(&mut **tx)
        .await?;
        // item lines first, then discounts (the guard trigger requires the
        // parent item row to exist — approve_draft uses the same two passes)
        let mut line_ids: HashMap<i64, i64> = HashMap::new();
        for pass in [false, true] {
            for it in r.items.iter().filter(|i| i.discount == pass) {
                let parent = it.parent_line.and_then(|l| line_ids.get(&l).copied());
                let new_id: i64 = sqlx::query_scalar(
                    "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind,
                         parent_item_id, name, name_raw, name_norm, name_raw_norm, quantity, unit,
                         unit_price, amount, amount_incl, tax_rate, category_id, category_source,
                         bbox_x, bbox_y, bbox_w, bbox_h, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     RETURNING id",
                )
                .bind(new_rid)
                .bind(ledger_id)
                .bind(it.line_no)
                .bind(if it.discount { "discount" } else { "item" })
                .bind(parent)
                .bind(&it.name)
                .bind(&it.name_raw)
                .bind(store::normalize_text(&it.name))
                .bind(it.name_raw.as_deref().map(store::normalize_text))
                .bind(it.quantity)
                .bind(&it.unit)
                .bind(it.unit_price)
                .bind(it.amount)
                .bind(it.amount_incl)
                .bind(it.tax_rate)
                .bind(it.category.and_then(|c| item_map.get(&c).copied()))
                .bind(&it.category_source)
                .bind(it.bbox.map(|b| b[0]))
                .bind(it.bbox.map(|b| b[1]))
                .bind(it.bbox.map(|b| b[2]))
                .bind(it.bbox.map(|b| b[3]))
                .bind(now)
                .bind(now)
                .fetch_one(&mut **tx)
                .await?;
                if !it.discount {
                    line_ids.insert(it.line_no, new_id);
                }
                item_count += 1;
            }
        }
        for color in LABEL_COLORS.iter() {
            if r.labels.contains(color) {
                sqlx::query(
                    "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
                     VALUES (?, ?, ?, ?, ?)",
                )
                .bind(new_rid)
                .bind(ledger_id)
                .bind(color.as_str())
                .bind(user_id)
                .bind(now)
                .execute(&mut **tx)
                .await?;
            }
        }
    }

    // the membership color the registration path assigns (same rule for
    // every owner: first palette key the user does not use yet, then
    // membership count mod palette)
    let color = match store::assign_member_color(tx, user_id).await {
        Ok(c) => c,
        Err(e) => {
            return Err(match e.downcast::<sqlx::Error>() {
                Ok(se) => se,
                Err(other) => sqlx::Error::Protocol(other.to_string()),
            });
        }
    };
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, color, created_at)
         VALUES (?, ?, 'owner', ?, ?)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(color)
    .bind(now)
    .execute(&mut **tx)
    .await?;

    let out = ImportOutcome {
        ledger_id,
        name: p.name.clone(),
        receipts: p.receipts.len(),
        items: item_count,
        images: p.images.len(),
        stores: p.stores.len(),
        item_categories: p.item_categories.len(),
        store_categories: p.store_categories.len(),
    };
    catalog::audit(
        tx,
        ledger_id,
        actor,
        "ledger",
        ledger_id,
        "import",
        None,
        Some(&json!({
            "name": out.name, "receipts": out.receipts, "items": out.items,
            "images": out.images, "stores": out.stores,
        })),
        now,
    )
    .await?;
    Ok(out)
}

/// Two passes: top-level (parent None) first, then sub rows whose parents are
/// now mapped. Depth is capped at 2 by parse_categories. `table` is one of
/// the two fixed category table names (no user input).
async fn insert_categories(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    table: &str,
    cats: &[InCategory],
    ledger_id: i64,
    now: i64,
    map: &mut HashMap<i64, i64>,
) -> Result<(), sqlx::Error> {
    let insert = format!(
        "INSERT INTO {table} (ledger_id, parent_id, name, sort_order, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
    );
    // top-level rows first (pass 1), then sub rows whose parents are mapped
    for pass in 0..2 {
        for c in cats.iter().filter(|c| c.parent.is_none() == (pass == 0)) {
            let parent = c.parent.and_then(|p| map.get(&p).copied());
            let new_id: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(insert.as_str()))
                .bind(ledger_id)
                .bind(parent)
                .bind(&c.name)
                .bind(c.sort)
                .bind(c.archived_at)
                .bind(now)
                .bind(now)
                .fetch_one(&mut **tx)
                .await?;
            map.insert(c.id, new_id);
        }
    }
    Ok(())
}
