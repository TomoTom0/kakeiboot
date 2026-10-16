//! Confirmed receipts (spec_mcp-tools.md 7-9 .. 7-11; spec_data-model.md
//! 6, 8): the ReceiptView, update_receipt with `before`, and the two-step
//! logical delete / restore.

use serde_json::{Map, Value, json};
use sqlx::{Connection, SqliteConnection, SqlitePool};

use super::actor::Actor;
use super::catalog::{self, CatKind};
use super::dto::{
    DraftItem, Label, LineKind, ReceiptImageView, ReceiptItemView, ReceiptStoreView, ReceiptView,
    TaxMode,
};
use super::labels;
use super::util;
use crate::config::McpLimits;
use crate::store::{compute_amounts_incl, normalize_text};

/// Days a logically deleted receipt stays restorable (spec_data-model 12).
pub const PURGE_DAYS: i64 = 90;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, sqlx::FromRow)]
struct ItemRow {
    id: i64,
    line_no: i64,
    line_kind: String,
    parent_item_id: Option<i64>,
    name: String,
    name_raw: Option<String>,
    quantity: f64,
    unit: Option<String>,
    unit_price: Option<i64>,
    amount: i64,
    amount_incl: i64,
    tax_rate: Option<i64>,
    category_id: Option<i64>,
    category_source: Option<String>,
    bbox_x: Option<f64>,
    bbox_y: Option<f64>,
    bbox_w: Option<f64>,
    bbox_h: Option<f64>,
}

async fn load_items(conn: &mut SqliteConnection, receipt_id: i64) -> sqlx::Result<Vec<ItemRow>> {
    sqlx::query_as(
        "SELECT id, line_no, line_kind, parent_item_id, name, name_raw, quantity, unit, unit_price,
                amount, amount_incl, tax_rate, category_id, category_source, bbox_x, bbox_y, bbox_w, bbox_h
         FROM receipt_items WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(receipt_id)
    .fetch_all(conn)
    .await
}

async fn item_view(conn: &mut SqliteConnection, r: &ItemRow) -> sqlx::Result<ReceiptItemView> {
    let category = match r.category_id {
        Some(c) => catalog::path_of(conn, CatKind::Item, c).await?,
        None => None,
    };
    let bbox = match (r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h) {
        (Some(x), Some(y), Some(w), Some(h)) => Some([x, y, w, h]),
        _ => None,
    };
    Ok(ReceiptItemView {
        item_id: r.id,
        line_no: r.line_no,
        line_kind: r.line_kind.clone(),
        parent_item_id: r.parent_item_id,
        name: r.name.clone(),
        name_raw: r.name_raw.clone(),
        quantity: r.quantity,
        unit: r.unit.clone(),
        unit_price: r.unit_price,
        amount: r.amount,
        amount_incl: r.amount_incl,
        tax_rate: r.tax_rate,
        category,
        category_source: r.category_source.clone(),
        bbox,
    })
}

type HeaderRow = (
    i64,            // revision
    String,         // source
    Option<i64>,    // image_id
    Option<i64>,    // store_id
    Option<String>, // store_name_raw
    String,         // purchased_on
    Option<String>, // purchased_time
    Option<String>, // tax_mode
    Option<i64>,    // total_amount
    Option<i64>,    // tax_amount
    Option<String>, // payment_method
    Option<String>, // note
    i64,            // created_at
    i64,            // updated_at
    Option<i64>,    // deleted_at
);

async fn load_header(
    conn: &mut SqliteConnection,
    receipt_id: i64,
    ledger_id: i64,
) -> sqlx::Result<Option<HeaderRow>> {
    sqlx::query_as(
        "SELECT revision, source, image_id, store_id, store_name_raw, purchased_on, purchased_time,
                tax_mode, total_amount, tax_amount, payment_method, note, created_at, updated_at, deleted_at
         FROM receipts WHERE id = ? AND ledger_id = ?",
    )
    .bind(receipt_id)
    .bind(ledger_id)
    .fetch_optional(conn)
    .await
}

/// The ReceiptView (7-9). None = not in this ledger.
pub async fn receipt_view(
    conn: &mut SqliteConnection,
    receipt_id: i64,
    ledger_id: i64,
) -> sqlx::Result<Option<ReceiptView>> {
    let Some(h) = load_header(conn, receipt_id, ledger_id).await? else {
        return Ok(None);
    };
    let store = match h.3 {
        Some(sid) => {
            let s: Option<(String, Option<i64>)> =
                sqlx::query_as("SELECT name, category_id FROM stores WHERE id = ?")
                    .bind(sid)
                    .fetch_optional(&mut *conn)
                    .await?;
            match s {
                Some((name, cat)) => {
                    let category = match cat {
                        Some(c) => catalog::path_of(conn, CatKind::Store, c).await?,
                        None => None,
                    };
                    Some(ReceiptStoreView {
                        store_id: sid,
                        name,
                        category,
                    })
                }
                None => None,
            }
        }
        None => None,
    };
    let rows = load_items(conn, receipt_id).await?;
    let mut items = Vec::with_capacity(rows.len());
    for r in &rows {
        items.push(item_view(conn, r).await?);
    }
    let items_total: i64 = items.iter().map(|i| i.amount_incl).sum();
    let image = match h.2 {
        Some(img) => {
            #[allow(clippy::type_complexity)]
            let m: Option<(i64, i64, Option<String>, Option<String>, Option<String>)> =
                sqlx::query_as(
                    "SELECT width, height, original_filename, taken_at_local, taken_at_source
                     FROM images WHERE id = ?",
                )
                .bind(img)
                .fetch_optional(&mut *conn)
                .await?;
            m.map(|(w, hh, f, t, ts)| ReceiptImageView {
                width: w,
                height: hh,
                original_filename: f,
                taken_at: t,
                taken_at_source: ts,
            })
        }
        None => None,
    };
    let from_draft_id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM drafts WHERE approved_receipt_id = ? LIMIT 1")
            .bind(receipt_id)
            .fetch_optional(&mut *conn)
            .await?;
    let receipt_labels = labels::labels_of(&mut *conn, ledger_id, &[receipt_id])
        .await?
        .remove(&receipt_id)
        .unwrap_or_default();
    Ok(Some(ReceiptView {
        receipt_id,
        revision: h.0,
        source: h.1,
        has_image: h.2.is_some(),
        deleted_at: h.14.map(util::jst_iso),
        store,
        store_name_raw: h.4,
        purchased_on: h.5,
        purchased_time: h.6,
        tax_mode: h.7,
        total_amount: h.8,
        tax_amount: h.9,
        payment_method: h.10,
        note: h.11,
        labels: receipt_labels,
        items,
        items_total,
        total_diff: h.8.map(|t| t - items_total),
        image,
        from_draft_id,
        created_at: util::jst_iso(h.12),
        updated_at: util::jst_iso(h.13),
    }))
}

/// image_id of a receipt in the ledger (for the widget URL).
pub async fn receipt_image_id(
    pool: &SqlitePool,
    receipt_id: i64,
    ledger_id: i64,
) -> sqlx::Result<Option<i64>> {
    Ok(sqlx::query_scalar::<_, Option<i64>>(
        "SELECT image_id FROM receipts WHERE id = ? AND ledger_id = ? AND deleted_at IS NULL",
    )
    .bind(receipt_id)
    .bind(ledger_id)
    .fetch_optional(pool)
    .await?
    .flatten())
}

// ---------------------------------------------------------------------------
// update_receipt (7-10)

#[derive(Debug, thiserror::Error)]
pub enum ReceiptError {
    #[error("not found")]
    NotFound,
    #[error("invalid input")]
    Invalid(Vec<String>),
    /// revision mismatch: latest view attached
    #[error("stale revision")]
    Stale(Box<ReceiptView>),
    #[error("receipt is deleted")]
    Deleted(Box<ReceiptView>),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptPatch {
    #[serde(default)]
    pub set: Option<Map<String, Value>>,
    #[serde(default)]
    pub upsert_items: Option<Vec<Map<String, Value>>>,
    #[serde(default)]
    pub delete_item_ids: Option<Vec<i64>>,
}

pub struct UpdateOutcome {
    pub view: ReceiptView,
    pub changed: Vec<String>,
    pub before: Value,
}

const SET_KEYS: &[&str] = &[
    "store_name",
    "store_category",
    "purchased_on",
    "purchased_time",
    "tax_mode",
    "total_amount",
    "tax_amount",
    "payment_method",
    "note",
];
const ITEM_FIELDS: &[&str] = &[
    "item_id",
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

fn str_or_null(v: &Value) -> Result<Option<String>, ()> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(()),
    }
}

fn int_or_null(v: &Value) -> Result<Option<i64>, ()> {
    match v {
        Value::Null => Ok(None),
        v => v.as_i64().map(Some).ok_or(()),
    }
}

/// Apply update_receipt in one BEGIN IMMEDIATE transaction.
#[allow(clippy::too_many_arguments)]
pub async fn update_receipt(
    pool: &SqlitePool,
    ledger_id: i64,
    actor: &Actor,
    receipt_id: i64,
    revision: i64,
    patch: &ReceiptPatch,
    lim: &McpLimits,
    now: i64,
) -> Result<UpdateOutcome, ReceiptError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let Some(before_view) = receipt_view(&mut tx, receipt_id, ledger_id).await? else {
        return Err(ReceiptError::NotFound);
    };
    if before_view.deleted_at.is_some() {
        return Err(ReceiptError::Deleted(Box::new(before_view)));
    }
    if before_view.revision != revision {
        return Err(ReceiptError::Stale(Box::new(before_view)));
    }
    let mut errs = Vec::new();
    let mut changed = Vec::new();
    let mut before_set = Map::new();
    let header_before = serde_json::to_value(&before_view).unwrap_or(Value::Null);

    // ---- header
    if let Some(set) = &patch.set {
        for (k, v) in set {
            if !SET_KEYS.contains(&k.as_str()) {
                errs.push(format!("set.{k}: 変更できない項目です"));
                continue;
            }
            match k.as_str() {
                "store_name" => match str_or_null(v) {
                    Ok(name) => {
                        let name = name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                        if name
                            .as_ref()
                            .is_some_and(|n| n.chars().count() > lim.max_name_chars)
                        {
                            errs.push(format!("set.store_name: {}字以内", lim.max_name_chars));
                            continue;
                        }
                        let sid = crate::store::resolve_or_create_store(
                            &mut tx,
                            ledger_id,
                            name.as_deref(),
                            now,
                        )
                        .await?;
                        sqlx::query("UPDATE receipts SET store_id = ? WHERE id = ?")
                            .bind(sid)
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    Err(()) => errs.push("set.store_name: 文字列か null".into()),
                },
                "store_category" => match str_or_null(v) {
                    Ok(path) => {
                        let sid: Option<i64> =
                            sqlx::query_scalar("SELECT store_id FROM receipts WHERE id = ?")
                                .bind(receipt_id)
                                .fetch_one(&mut *tx)
                                .await?;
                        let Some(sid) = sid else {
                            errs.push(
                                "set.store_category: 店が未設定のレシートです（先に store_name）"
                                    .into(),
                            );
                            continue;
                        };
                        let cat = match &path {
                            Some(p) => {
                                match catalog::resolve_path(&mut tx, CatKind::Store, ledger_id, p)
                                    .await?
                                {
                                    Some(c) => Some(c),
                                    None => {
                                        errs.push(format!(
                                        "set.store_category: 店カテゴリ「{p}」がありません（get_catalog の category_paths.store から選ぶ）"
                                    ));
                                        continue;
                                    }
                                }
                            }
                            None => None,
                        };
                        sqlx::query("UPDATE stores SET category_id = ?, category_source = 'user', updated_at = ? WHERE id = ?")
                            .bind(cat)
                            .bind(now)
                            .bind(sid)
                            .execute(&mut *tx)
                            .await?;
                    }
                    Err(()) => errs.push("set.store_category: 文字列か null".into()),
                },
                "purchased_on" => match v.as_str().and_then(util::parse_date) {
                    Some(d) => {
                        sqlx::query("UPDATE receipts SET purchased_on = ? WHERE id = ?")
                            .bind(util::fmt_date(d))
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    None => errs.push("set.purchased_on: \"YYYY-MM-DD\"（null 不可）".into()),
                },
                "purchased_time" => match str_or_null(v) {
                    Ok(t) if t.as_deref().is_none_or(util::valid_time) => {
                        sqlx::query("UPDATE receipts SET purchased_time = ? WHERE id = ?")
                            .bind(t)
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    _ => errs.push("set.purchased_time: \"HH:MM[:SS]\" か null".into()),
                },
                "tax_mode" => match str_or_null(v) {
                    Ok(t)
                        if t.as_deref()
                            .is_none_or(|s| s == "inclusive" || s == "exclusive") =>
                    {
                        sqlx::query("UPDATE receipts SET tax_mode = ? WHERE id = ?")
                            .bind(t)
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    _ => errs.push("set.tax_mode: \"inclusive\" / \"exclusive\" / null".into()),
                },
                "total_amount" | "tax_amount" => match int_or_null(v) {
                    Ok(n) => {
                        let sql = format!("UPDATE receipts SET {k} = ? WHERE id = ?");
                        sqlx::query(sqlx::AssertSqlSafe(sql))
                            .bind(n)
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    Err(()) => errs.push(format!("set.{k}: 整数か null")),
                },
                "payment_method" => {
                    let ok = v.is_null()
                        || serde_json::from_value::<super::dto::PaymentMethod>(v.clone()).is_ok();
                    if ok {
                        sqlx::query("UPDATE receipts SET payment_method = ? WHERE id = ?")
                            .bind(v.as_str())
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    } else {
                        errs.push("set.payment_method: cash / credit_card / debit_card / e_money / qr_code / point / gift_card / bank_transfer / other / null".into());
                    }
                }
                "note" => match str_or_null(v) {
                    Ok(n)
                        if n.as_ref()
                            .is_none_or(|s| s.chars().count() <= lim.max_note_chars) =>
                    {
                        sqlx::query("UPDATE receipts SET note = ? WHERE id = ?")
                            .bind(n)
                            .bind(receipt_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    _ => errs.push(format!(
                        "set.note: {}字以内の文字列か null",
                        lim.max_note_chars
                    )),
                },
                _ => {}
            }
            let old = match k.as_str() {
                "store_name" => json!(before_view.store.as_ref().map(|s| s.name.clone())),
                "store_category" => {
                    json!(before_view.store.as_ref().and_then(|s| s.category.clone()))
                }
                other => header_before.get(other).cloned().unwrap_or(Value::Null),
            };
            before_set.insert(k.clone(), old);
            changed.push(k.clone());
        }
    }

    // ---- delete items
    let mut items_deleted = Vec::new();
    if let Some(del) = &patch.delete_item_ids {
        for id in del {
            let victims: Vec<&super::dto::ReceiptItemView> = before_view
                .items
                .iter()
                .filter(|i| i.item_id == *id || i.parent_item_id == Some(*id))
                .collect();
            if !before_view.items.iter().any(|i| i.item_id == *id) {
                errs.push(format!(
                    "delete_item_ids: item_id={id} はこのレシートにありません"
                ));
                continue;
            }
            sqlx::query("DELETE FROM receipt_items WHERE id = ? AND receipt_id = ?")
                .bind(id)
                .bind(receipt_id)
                .execute(&mut *tx)
                .await?;
            for v in victims {
                items_deleted.push(serde_json::to_value(v).unwrap_or(Value::Null));
            }
            changed.push(format!("items[item_id={id}] 削除"));
        }
    }

    // ---- upsert items
    let mut items_updated = Vec::new();
    if let Some(ups) = &patch.upsert_items {
        for u in ups {
            if let Some(bad) = u.keys().find(|k| !ITEM_FIELDS.contains(&k.as_str())) {
                errs.push(format!("upsert_items.{bad}: 未知の項目です"));
                continue;
            }
            match u.get("item_id").and_then(Value::as_i64) {
                Some(item_id) => {
                    let Some(old) = before_view.items.iter().find(|i| i.item_id == item_id) else {
                        errs.push(format!(
                            "upsert_items: item_id={item_id} はこのレシートにありません"
                        ));
                        continue;
                    };
                    let old_v = serde_json::to_value(old).unwrap_or(Value::Null);
                    let mut fields = Map::new();
                    for (k, v) in u {
                        if k == "item_id" {
                            continue;
                        }
                        if let Err(e) = update_item_field(
                            &mut tx, ledger_id, receipt_id, item_id, k, v, lim, now,
                        )
                        .await?
                        {
                            errs.push(format!("upsert_items[item_id={item_id}].{k}: {e}"));
                            continue;
                        }
                        fields.insert(k.clone(), old_v.get(k).cloned().unwrap_or(Value::Null));
                    }
                    items_updated.push(json!({ "item_id": item_id, "fields": fields }));
                    changed.push(format!("items[item_id={item_id}]"));
                }
                None => {
                    // new line
                    let mut obj = u.clone();
                    if !obj.contains_key("line_no") {
                        let max: i64 = sqlx::query_scalar(
                            "SELECT COALESCE(MAX(line_no), 0) FROM receipt_items WHERE receipt_id = ?",
                        )
                        .bind(receipt_id)
                        .fetch_one(&mut *tx)
                        .await?;
                        obj.insert("line_no".into(), json!(max + 1));
                    }
                    let parent_line = obj.get("parent_line_no").and_then(Value::as_i64);
                    let category_path = obj
                        .get("category")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let mut it: DraftItem = match serde_json::from_value(Value::Object(obj)) {
                        Ok(i) => i,
                        Err(e) => {
                            errs.push(format!(
                                "upsert_items（追加行）: name と amount が必要です（{e}）"
                            ));
                            continue;
                        }
                    };
                    it.category_source = None;
                    let mut parent_id = None;
                    if let Some(pl) = parent_line {
                        parent_id = sqlx::query_scalar::<_, i64>(
                            "SELECT id FROM receipt_items WHERE receipt_id = ? AND line_no = ? AND line_kind = 'item'",
                        )
                        .bind(receipt_id)
                        .bind(pl)
                        .fetch_optional(&mut *tx)
                        .await?;
                        if parent_id.is_none() {
                            errs.push(format!(
                                "upsert_items: parent_line_no={pl} の品目行がありません"
                            ));
                            continue;
                        }
                    }
                    let cat = match &category_path {
                        Some(p) => {
                            match catalog::resolve_path(&mut tx, CatKind::Item, ledger_id, p)
                                .await?
                            {
                                Some(c) => Some(c),
                                None => {
                                    errs.push(format!("upsert_items: カテゴリ「{p}」がありません（get_catalog の category_paths.item から選ぶ）"));
                                    continue;
                                }
                            }
                        }
                        None => None,
                    };
                    if category_path.is_some() {
                        it.category_source = Some(super::dto::CategorySource::User);
                    }
                    let single = super::drafts::validate_payload(
                        &serde_json::from_value(json!({ "items": [it.clone()] }))
                            .unwrap_or_else(|_| unreachable_payload()),
                        lim,
                    );
                    if !single.is_empty() && it.line_kind == LineKind::Item {
                        errs.extend(single);
                        continue;
                    }
                    let res = crate::store::insert_receipt_item(
                        &mut tx, ledger_id, receipt_id, &it, cat, parent_id, it.amount, now,
                    )
                    .await;
                    match res {
                        Ok(id) => changed.push(format!("items[item_id={id}] 追加")),
                        Err(e) => errs.push(format!(
                            "upsert_items（追加行 line_no={}）: {}",
                            it.line_no,
                            short_db(&e)
                        )),
                    }
                }
            }
        }
    }
    if !errs.is_empty() {
        return Err(ReceiptError::Invalid(errs));
    }
    if changed.is_empty() {
        return Err(ReceiptError::Invalid(vec![
            "変更がありません。set / upsert_items / delete_item_ids のいずれかを指定してください"
                .into(),
        ]));
    }
    recompute_receipt(&mut tx, receipt_id).await?;
    sqlx::query("UPDATE receipts SET revision = revision + 1, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(receipt_id)
        .execute(&mut *tx)
        .await?;
    let after_view = receipt_view(&mut tx, receipt_id, ledger_id)
        .await?
        .ok_or(ReceiptError::NotFound)?;
    let mut before = Map::new();
    if !before_set.is_empty() {
        before.insert("set".into(), Value::Object(before_set));
    }
    if !items_updated.is_empty() {
        before.insert("items_updated".into(), Value::Array(items_updated));
    }
    if !items_deleted.is_empty() {
        before.insert("items_deleted".into(), Value::Array(items_deleted));
    }
    let before = Value::Object(before);
    catalog::audit(
        &mut tx,
        ledger_id,
        actor,
        "receipt",
        receipt_id,
        "update",
        Some(&before),
        Some(&json!({ "changed": changed, "revision": after_view.revision })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(UpdateOutcome {
        view: after_view,
        changed,
        before,
    })
}

fn unreachable_payload() -> super::dto::DraftPayload {
    serde_json::from_value(json!({ "items": [] })).expect("empty payload")
}

fn short_db(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(d) => d.message().to_string(),
        other => other.to_string(),
    }
}

/// One field of an existing item. Ok(Err(msg)) is an input error.
#[allow(clippy::too_many_arguments)]
async fn update_item_field(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    receipt_id: i64,
    item_id: i64,
    k: &str,
    v: &Value,
    lim: &McpLimits,
    now: i64,
) -> sqlx::Result<Result<(), String>> {
    macro_rules! set {
        ($sql:expr, $val:expr) => {{
            sqlx::query($sql)
                .bind($val)
                .bind(now)
                .bind(item_id)
                .bind(receipt_id)
                .execute(&mut *conn)
                .await?;
            return Ok(Ok(()));
        }};
    }
    match k {
        "name" => match v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
            Some(n) if n.chars().count() <= lim.max_name_chars => {
                sqlx::query("UPDATE receipt_items SET name = ?, name_norm = ?, updated_at = ? WHERE id = ? AND receipt_id = ?")
                    .bind(n)
                    .bind(normalize_text(n))
                    .bind(now)
                    .bind(item_id)
                    .bind(receipt_id)
                    .execute(&mut *conn)
                    .await?;
                Ok(Ok(()))
            }
            _ => Ok(Err(format!("1〜{}字の文字列", lim.max_name_chars))),
        },
        "name_raw" => match str_or_null(v) {
            Ok(n) => {
                sqlx::query("UPDATE receipt_items SET name_raw = ?, name_raw_norm = ?, updated_at = ? WHERE id = ? AND receipt_id = ?")
                    .bind(&n)
                    .bind(n.as_deref().map(normalize_text))
                    .bind(now)
                    .bind(item_id)
                    .bind(receipt_id)
                    .execute(&mut *conn)
                    .await?;
                Ok(Ok(()))
            }
            Err(()) => Ok(Err("文字列か null".into())),
        },
        "quantity" => match v.as_f64() {
            Some(q) if q > 0.0 && q.is_finite() => set!(
                "UPDATE receipt_items SET quantity = ?, updated_at = ? WHERE id = ? AND receipt_id = ?",
                q
            ),
            _ => Ok(Err("0より大きい数".into())),
        },
        "unit" => match str_or_null(v) {
            Ok(u) => set!(
                "UPDATE receipt_items SET unit = ?, updated_at = ? WHERE id = ? AND receipt_id = ?",
                u
            ),
            Err(()) => Ok(Err("文字列か null".into())),
        },
        "unit_price" => match int_or_null(v) {
            Ok(n) => set!(
                "UPDATE receipt_items SET unit_price = ?, updated_at = ? WHERE id = ? AND receipt_id = ?",
                n
            ),
            Err(()) => Ok(Err("整数か null".into())),
        },
        "amount" => match v.as_i64() {
            Some(a) => {
                let r = sqlx::query("UPDATE receipt_items SET amount = ?, updated_at = ? WHERE id = ? AND receipt_id = ?")
                    .bind(a)
                    .bind(now)
                    .bind(item_id)
                    .bind(receipt_id)
                    .execute(&mut *conn)
                    .await;
                match r {
                    Ok(_) => Ok(Ok(())),
                    Err(sqlx::Error::Database(d)) if d.message().contains("CHECK") => {
                        Ok(Err("値引行の amount は0以下".into()))
                    }
                    Err(e) => Err(e),
                }
            }
            None => Ok(Err("整数（円）".into())),
        },
        "tax_rate" => match int_or_null(v) {
            Ok(r) if r.is_none_or(|x| matches!(x, 0 | 8 | 10)) => set!(
                "UPDATE receipt_items SET tax_rate = ?, updated_at = ? WHERE id = ? AND receipt_id = ?",
                r
            ),
            _ => Ok(Err("0 / 8 / 10 / null".into())),
        },
        "category" => {
            let path = match str_or_null(v) {
                Ok(p) => p,
                Err(()) => return Ok(Err("文字列か null".into())),
            };
            let cat = match &path {
                Some(p) => match catalog::resolve_path(conn, CatKind::Item, ledger_id, p).await? {
                    Some(c) => Some(c),
                    None => {
                        return Ok(Err(format!(
                            "カテゴリ「{p}」がありません（get_catalog の category_paths.item から選ぶ）"
                        )));
                    }
                },
                None => None,
            };
            sqlx::query("UPDATE receipt_items SET category_id = ?, category_source = 'user', updated_at = ? WHERE id = ? AND receipt_id = ?")
                .bind(cat)
                .bind(now)
                .bind(item_id)
                .bind(receipt_id)
                .execute(&mut *conn)
                .await?;
            Ok(Ok(()))
        }
        "bbox" => {
            let b: Option<[f64; 4]> = match serde_json::from_value(v.clone()) {
                Ok(b) => b,
                Err(_) => return Ok(Err("[x, y, 幅, 高さ]（0〜1）か null".into())),
            };
            let r = sqlx::query("UPDATE receipt_items SET bbox_x = ?, bbox_y = ?, bbox_w = ?, bbox_h = ?, updated_at = ? WHERE id = ? AND receipt_id = ?")
                .bind(b.map(|b| b[0]))
                .bind(b.map(|b| b[1]))
                .bind(b.map(|b| b[2]))
                .bind(b.map(|b| b[3]))
                .bind(now)
                .bind(item_id)
                .bind(receipt_id)
                .execute(&mut *conn)
                .await;
            match r {
                Ok(_) => Ok(Ok(())),
                Err(sqlx::Error::Database(d)) if d.message().contains("CHECK") => {
                    Ok(Err("[x, y, 幅, 高さ] を 0〜1 の範囲で".into()))
                }
                Err(e) => Err(e),
            }
        }
        "line_no" => match v.as_i64() {
            Some(n) if n >= 1 => {
                let r = sqlx::query("UPDATE receipt_items SET line_no = ?, updated_at = ? WHERE id = ? AND receipt_id = ?")
                    .bind(n)
                    .bind(now)
                    .bind(item_id)
                    .bind(receipt_id)
                    .execute(&mut *conn)
                    .await;
                match r {
                    Ok(_) => Ok(Ok(())),
                    Err(sqlx::Error::Database(d)) if d.message().contains("UNIQUE") => {
                        Ok(Err("同じ line_no の行があります".into()))
                    }
                    Err(e) => Err(e),
                }
            }
            _ => Ok(Err("1以上の整数".into())),
        },
        "line_kind" | "parent_line_no" => Ok(Err(
            "既存行の種別・値引の対象は変更できません（行を削除して追加し直してください）".into(),
        )),
        _ => Ok(Err("未知の項目".into())),
    }
}

/// Re-run the discount category copy and amount_incl (spec_data-model 6-2,
/// 8) after an edit.
async fn recompute_receipt(conn: &mut SqliteConnection, receipt_id: i64) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE receipt_items SET category_id = (SELECT p.category_id FROM receipt_items p WHERE p.id = receipt_items.parent_item_id),
                category_source = (SELECT p.category_source FROM receipt_items p WHERE p.id = receipt_items.parent_item_id)
         WHERE receipt_id = ? AND parent_item_id IS NOT NULL",
    )
    .bind(receipt_id)
    .execute(&mut *conn)
    .await?;
    let (tax_mode, tax_amount): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT tax_mode, tax_amount FROM receipts WHERE id = ?")
            .bind(receipt_id)
            .fetch_one(&mut *conn)
            .await?;
    let rows: Vec<(i64, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT id, amount, tax_rate, amount_incl FROM receipt_items WHERE receipt_id = ? ORDER BY line_no",
    )
    .bind(receipt_id)
    .fetch_all(&mut *conn)
    .await?;
    let items: Vec<DraftItem> = rows
        .iter()
        .map(|(_, amount, rate, _)| {
            serde_json::from_value(
                json!({ "line_no": 1, "name": "x", "amount": amount, "tax_rate": rate }),
            )
            .expect("item")
        })
        .collect();
    let mode = match tax_mode.as_deref() {
        Some("exclusive") => Some(TaxMode::Exclusive),
        Some("inclusive") => Some(TaxMode::Inclusive),
        _ => None,
    };
    let incl = compute_amounts_incl(&items, mode, tax_amount);
    for ((id, _, _, old), new) in rows.iter().zip(incl) {
        if *old != new {
            sqlx::query("UPDATE receipt_items SET amount_incl = ? WHERE id = ?")
                .bind(new)
                .bind(id)
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// delete / restore (7-11)

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeleteStatus {
    pub receipt_id: i64,
    pub revision: i64,
    pub deleted_at: Option<String>,
    pub purge_after: Option<String>,
    /// Kept across logical delete / restore (labels ride along, spec 6-4).
    pub labels: Vec<Label>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<Value>,
}

/// What happened in delete_receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeleteOutcome {
    Preview,
    Deleted,
    Restored,
    /// already in the target state
    AlreadyDone,
    /// revision mismatch (isError, latest state returned)
    Stale,
}

#[allow(clippy::too_many_arguments)]
pub async fn delete_or_restore(
    pool: &SqlitePool,
    ledger_id: i64,
    actor: &Actor,
    receipt_id: i64,
    restore: bool,
    confirm: bool,
    revision: Option<i64>,
    now: i64,
) -> Result<(DeleteOutcome, DeleteStatus), ReceiptError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let Some(view) = receipt_view(&mut tx, receipt_id, ledger_id).await? else {
        return Err(ReceiptError::NotFound);
    };
    let deleted_ms: Option<i64> =
        sqlx::query_scalar("SELECT deleted_at FROM receipts WHERE id = ?")
            .bind(receipt_id)
            .fetch_one(&mut *tx)
            .await?;
    let preview = json!({
        "store_name": view.store.as_ref().map(|s| s.name.clone()).or(view.store_name_raw.clone()),
        "purchased_on": view.purchased_on,
        "amount": view.items_total,
        "item_count": view.items.len(),
    });
    let status = |rev: i64, del: Option<i64>, with_preview: bool| DeleteStatus {
        receipt_id,
        revision: rev,
        deleted_at: del.map(util::jst_iso),
        purge_after: del.map(|d| util::jst_iso(d + PURGE_DAYS * DAY_MS)),
        labels: view.labels.clone(),
        preview: with_preview.then(|| preview.clone()),
    };
    if restore {
        if deleted_ms.is_none() {
            return Ok((
                DeleteOutcome::AlreadyDone,
                status(view.revision, None, false),
            ));
        }
        if revision.is_some_and(|r| r != view.revision) {
            return Ok((
                DeleteOutcome::Stale,
                status(view.revision, deleted_ms, true),
            ));
        }
        let rev: i64 = sqlx::query_scalar(
            "UPDATE receipts SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision",
        )
        .bind(now)
        .bind(receipt_id)
        .fetch_one(&mut *tx)
        .await?;
        catalog::audit(
            &mut tx, ledger_id, actor, "receipt", receipt_id, "restore", None, None, now,
        )
        .await?;
        tx.commit().await?;
        return Ok((DeleteOutcome::Restored, status(rev, None, false)));
    }
    if deleted_ms.is_some() {
        return Ok((
            DeleteOutcome::AlreadyDone,
            status(view.revision, deleted_ms, false),
        ));
    }
    if !confirm {
        return Ok((DeleteOutcome::Preview, status(view.revision, None, true)));
    }
    let Some(rev) = revision else {
        return Err(ReceiptError::Invalid(vec![
            "confirm:true には revision（preview で返した値）が必要です".into(),
        ]));
    };
    if rev != view.revision {
        return Ok((DeleteOutcome::Stale, status(view.revision, None, true)));
    }
    let new_rev: i64 = sqlx::query_scalar(
        "UPDATE receipts SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? RETURNING revision",
    )
    .bind(now)
    .bind(now)
    .bind(receipt_id)
    .fetch_one(&mut *tx)
    .await?;
    catalog::audit(
        &mut tx,
        ledger_id,
        actor,
        "receipt",
        receipt_id,
        "delete",
        Some(&preview),
        None,
        now,
    )
    .await?;
    tx.commit().await?;
    Ok((DeleteOutcome::Deleted, status(new_rev, Some(now), false)))
}
