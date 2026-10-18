//! search_receipts (spec_mcp-tools.md 7-8; spec_data-model.md 13-2):
//! receipt / item lists with FTS5 trigram + LIKE fallback, store LIKE,
//! category and payment filters, and an opaque keyset cursor over
//! (purchased_on DESC, id DESC).

use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqliteConnection;

use super::catalog::{self, CatKind};
use super::labels::{self, LabelColor};
use super::stats::{Bind, FilterError, Range, bind_all, item_match, store_like};
use super::util::fmt_date;
use crate::auth::tokens::{b64url_decode, b64url_encode};

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SearchQuery {
    pub store: Option<String>,
    /// Cross-field text query (web /search receipts tab): item name OR
    /// store name/aliases. `search_items` treats it as an item-name match.
    /// MCP never sets it (SearchArgs is built by hand).
    #[serde(default)]
    pub text: Option<String>,
    /// Exact store filter (web only; MCP keeps the name-based `store`).
    #[serde(default)]
    pub store_id: Option<i64>,
    pub item_query: Option<String>,
    pub category: Option<String>,
    pub payment_method: Option<String>,
    /// OR filter: only receipts holding one of these colors (spec 7-8).
    #[serde(default)]
    pub label_colors: Vec<LabelColor>,
    #[serde(default)]
    pub include_deleted: bool,
}

pub fn encode_cursor(date: &str, id: i64) -> String {
    b64url_encode(format!("{date}|{id}").as_bytes())
}

pub fn decode_cursor(c: &str) -> Option<(String, i64)> {
    let raw = String::from_utf8(b64url_decode(c)?).ok()?;
    let (d, id) = raw.split_once('|')?;
    super::util::parse_date(d)?;
    Some((d.to_string(), id.parse().ok()?))
}

/// TASK-73: free-text search query length cap (spec_mcp-tools.md 3-5).
/// `kind` is the param label for the message — "store" / "item_query" / "q"
/// / "store_query" (the store catalog search is "store_query" on both the
/// web `query` and MCP `store_query` paths, per design 3). The length is
/// the input as received (chars, pre-normalize; `max` comes from
/// mcp.toml `[limits] max_query_chars`). Whitespace-only input is the
/// existing filter skip and is checked first, so it stays Ok (design 3-3).
pub fn check_query_text(kind: &str, s: &str, max: usize) -> Result<(), FilterError> {
    if s.trim().is_empty() {
        return Ok(());
    }
    if s.chars().count() > max {
        return Err(FilterError::Invalid(format!(
            "{kind} が長すぎます（上限 {max} 字）"
        )));
    }
    Ok(())
}

/// Item-level conditions over `receipt_items i` (name / category). `text`
/// (the /search cross-field query) is folded in as an item-name match only
/// for the item-level list (`search_items`); the receipts path passes None
/// and applies the item-OR-store form via `text_condition` instead.
async fn item_conditions(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    q: &SearchQuery,
    text: Option<&str>,
) -> Result<(String, Vec<Bind>), FilterError> {
    let mut sql = String::new();
    let mut binds = Vec::new();
    if let Some(iq) = q.item_query.as_deref().filter(|s| !s.trim().is_empty()) {
        let (frag, b) = item_match("i.id", iq)?;
        sql.push_str(&frag);
        binds.extend(b);
    }
    if let Some(t) = text.filter(|s| !s.trim().is_empty()) {
        let (frag, b) = item_match("i.id", t)?;
        sql.push_str(&frag);
        binds.extend(b);
    }
    if let Some(c) = &q.category {
        if c.trim() == "未分類" {
            sql.push_str(" AND i.category_id IS NULL");
        } else {
            let id = catalog::resolve_path(conn, CatKind::Item, ledger_id, c)
                .await?
                .ok_or_else(|| {
                    FilterError::Invalid(format!(
                        "カテゴリ「{c}」がありません（get_catalog の category_paths.item）"
                    ))
                })?;
            sql.push_str(" AND i.category_id IN (SELECT id FROM item_categories WHERE id = ? OR parent_id = ?)");
            binds.push(Bind::I(id));
            binds.push(Bind::I(id));
        }
    }
    Ok((sql, binds))
}

/// Receipt-level conditions over `receipts r`.
fn receipt_conditions(
    ledger_id: i64,
    range: Option<&Range>,
    q: &SearchQuery,
) -> (String, Vec<Bind>) {
    let mut sql = String::from("r.ledger_id = ?");
    let mut binds = vec![Bind::I(ledger_id)];
    if !q.include_deleted {
        sql.push_str(" AND r.deleted_at IS NULL");
    }
    if let Some(r) = range {
        sql.push_str(" AND r.purchased_on BETWEEN ? AND ?");
        binds.push(Bind::S(fmt_date(r.from)));
        binds.push(Bind::S(fmt_date(r.to)));
    }
    if let Some(s) = q.store.as_deref().filter(|s| !s.trim().is_empty()) {
        let (frag, b) = store_like("r.store_id", s);
        sql.push_str(&frag);
        binds.extend(b);
    }
    if let Some(sid) = q.store_id {
        sql.push_str(" AND r.store_id = ?");
        binds.push(Bind::I(sid));
    }
    if let Some(pm) = &q.payment_method {
        sql.push_str(" AND r.payment_method = ?");
        binds.push(Bind::S(pm.clone()));
    }
    if !q.label_colors.is_empty() {
        let placeholders = vec!["?"; q.label_colors.len()].join(", ");
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM receipt_labels rl WHERE rl.receipt_id = r.id AND rl.color IN ({placeholders}))"
        ));
        binds.extend(
            q.label_colors
                .iter()
                .map(|c| Bind::S(c.as_str().to_string())),
        );
    }
    (sql, binds)
}

/// Cross-field text query (web /search): item names OR store name/aliases,
/// reusing item_match / store_like. The ` AND ` prefix of both fragments
/// is stripped to embed them as the two disjuncts. `item_frag`/`item_binds`
/// are reused for the per-receipt matched_items query.
struct TextFilter {
    /// " AND (EXISTS (...) OR <store expr>)" — appended to the receipt WHERE
    clause: String,
    binds: Vec<Bind>,
    /// " AND i.id IN (...)" — the item-name half, for matched_items
    item_frag: String,
    item_binds: Vec<Bind>,
}

fn text_condition(text: &str) -> Result<TextFilter, FilterError> {
    let (item_frag, item_binds) = item_match("i.id", text)?;
    let (store_frag, store_binds) = store_like("r.store_id", text);
    let store_expr = store_frag.strip_prefix(" AND ").unwrap_or(&store_frag);
    let clause = format!(
        " AND (EXISTS (SELECT 1 FROM receipt_items i WHERE i.receipt_id = r.id{item_frag}) OR {store_expr})"
    );
    let mut binds = item_binds.clone();
    binds.extend(store_binds);
    Ok(TextFilter {
        clause,
        binds,
        item_frag,
        item_binds,
    })
}

pub struct SearchResult {
    pub total_count: i64,
    pub sum_amount: i64,
    pub rows: Vec<Value>,
    pub next_cursor: Option<String>,
    /// (receipt_id, image_id) for thumbnails
    pub images: Vec<(i64, i64)>,
}

pub async fn search_receipts(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    range: Option<&Range>,
    q: &SearchQuery,
    limit: i64,
    cursor: Option<(String, i64)>,
) -> Result<SearchResult, FilterError> {
    let (rsql, rb) = receipt_conditions(ledger_id, range, q);
    let text = q
        .text
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(text_condition)
        .transpose()?;
    let (isql, ib) = item_conditions(conn, ledger_id, q, None).await?;
    let has_item_filter = !isql.is_empty();
    let item_exists = if has_item_filter {
        format!(" AND EXISTS (SELECT 1 FROM receipt_items i WHERE i.receipt_id = r.id{isql})")
    } else {
        String::new()
    };
    let text_clause = text.as_ref().map_or(String::new(), |t| t.clause.clone());
    let mut binds: Vec<Bind> = rb.clone();
    if let Some(t) = &text {
        binds.extend(t.binds.clone());
    }
    binds.extend(ib.clone());
    // totals (no cursor)
    let sql = format!(
        "SELECT COUNT(*), COALESCE(SUM((SELECT COALESCE(SUM(amount_incl), 0) FROM receipt_items x WHERE x.receipt_id = r.id)), 0)
         FROM receipts r WHERE {rsql}{text_clause}{item_exists}"
    );
    let (total_count, sum_amount): (i64, i64) =
        bind_all(sqlx::query_as(sqlx::AssertSqlSafe(sql)), &binds)
            .fetch_one(&mut *conn)
            .await?;
    let mut page_binds = binds.clone();
    let mut cur_sql = String::new();
    if let Some((d, id)) = &cursor {
        cur_sql = " AND (r.purchased_on < ? OR (r.purchased_on = ? AND r.id < ?))".into();
        page_binds.push(Bind::S(d.clone()));
        page_binds.push(Bind::S(d.clone()));
        page_binds.push(Bind::I(*id));
    }
    page_binds.push(Bind::I(limit + 1));
    let sql = format!(
        "SELECT r.id, r.purchased_on, r.purchased_time, COALESCE(s.name, r.store_name_raw), r.image_id,
                (SELECT COALESCE(SUM(amount_incl), 0) FROM receipt_items x WHERE x.receipt_id = r.id),
                (SELECT COUNT(*) FROM receipt_items x WHERE x.receipt_id = r.id),
                r.deleted_at IS NOT NULL, r.deleted_at
         FROM receipts r LEFT JOIN stores s ON s.id = r.store_id
         WHERE {rsql}{text_clause}{item_exists}{cur_sql}
         ORDER BY r.purchased_on DESC, r.id DESC LIMIT ?"
    );
    #[allow(clippy::type_complexity)]
    type Row = (
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        bool,
        Option<i64>,
    );
    let mut rows: Vec<Row> = bind_all(sqlx::query_as(sqlx::AssertSqlSafe(sql)), &page_binds)
        .fetch_all(&mut *conn)
        .await?;
    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| encode_cursor(&r.1, r.0))
    } else {
        None
    };
    // labels of the page's receipts in one query (no N+1)
    let page_ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let page_labels = labels::labels_of(&mut *conn, ledger_id, &page_ids).await?;
    let mut out = Vec::with_capacity(rows.len());
    let mut images = Vec::new();
    for (id, date, time, store, image_id, amount, count, deleted, deleted_at) in rows {
        let mut v = json!({
            "receipt_id": id, "purchased_on": date, "purchased_time": time, "store_name": store,
            "amount": amount, "item_count": count, "has_image": image_id.is_some(),
            "deleted_at": deleted_at.map(super::util::jst_iso),
        });
        v["labels"] = json!(page_labels.get(&id).cloned().unwrap_or_default());
        if deleted {
            v["deleted"] = json!(true);
        }
        if let Some(img) = image_id
            && !deleted
        {
            images.push((id, img));
        }
        if has_item_filter || text.is_some() {
            let text_frag = text.as_ref().map_or(String::new(), |t| t.item_frag.clone());
            let sql = format!(
                "SELECT i.name, i.amount_incl FROM receipt_items i WHERE i.receipt_id = ?{text_frag}{isql} ORDER BY i.line_no LIMIT 20"
            );
            let mut b = vec![Bind::I(id)];
            if let Some(t) = &text {
                b.extend(t.item_binds.clone());
            }
            b.extend(ib.clone());
            let m: Vec<(String, i64)> = bind_all(sqlx::query_as(sqlx::AssertSqlSafe(sql)), &b)
                .fetch_all(&mut *conn)
                .await?;
            v["matched_items"] = json!(
                m.into_iter()
                    .map(|(n, a)| json!({ "name": n, "amount": a }))
                    .collect::<Vec<_>>()
            );
        }
        out.push(v);
    }
    Ok(SearchResult {
        total_count,
        sum_amount,
        rows: out,
        next_cursor,
        images,
    })
}

pub async fn search_items(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    range: Option<&Range>,
    q: &SearchQuery,
    limit: i64,
    cursor: Option<(String, i64)>,
) -> Result<SearchResult, FilterError> {
    let (rsql, rb) = receipt_conditions(ledger_id, range, q);
    let (isql, ib) = item_conditions(conn, ledger_id, q, q.text.as_deref()).await?;
    let mut binds = rb;
    binds.extend(ib);
    let base = format!(
        "FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id LEFT JOIN stores s ON s.id = r.store_id
         WHERE {rsql}{isql}"
    );
    let (total_count, sum_amount): (i64, i64) = bind_all(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*), COALESCE(SUM(i.amount_incl), 0) {base}"
        ))),
        &binds,
    )
    .fetch_one(&mut *conn)
    .await?;
    let mut page_binds = binds.clone();
    let mut cur_sql = String::new();
    if let Some((d, id)) = &cursor {
        cur_sql = " AND (r.purchased_on < ? OR (r.purchased_on = ? AND i.id < ?))".into();
        page_binds.push(Bind::S(d.clone()));
        page_binds.push(Bind::S(d.clone()));
        page_binds.push(Bind::I(*id));
    }
    page_binds.push(Bind::I(limit + 1));
    #[allow(clippy::type_complexity)]
    type Row = (
        i64,
        i64,
        String,
        Option<i64>,
        Option<String>,
        String,
        f64,
        Option<String>,
        Option<i64>,
        i64,
        Option<i64>,
    );
    let mut rows: Vec<Row> = bind_all(
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT i.id, r.id, r.purchased_on, r.store_id, COALESCE(s.name, r.store_name_raw), i.name, i.quantity, i.unit,
                    i.unit_price, i.amount_incl, i.category_id
             {base}{cur_sql} ORDER BY r.purchased_on DESC, i.id DESC LIMIT ?"
        ))),
        &page_binds,
    )
    .fetch_all(&mut *conn)
    .await?;
    let next_cursor = if rows.len() as i64 > limit {
        rows.truncate(limit as usize);
        rows.last().map(|r| encode_cursor(&r.2, r.0))
    } else {
        None
    };
    let mut out = Vec::with_capacity(rows.len());
    for (item_id, receipt_id, date, store_id, store, name, qty, unit, unit_price, incl, cat) in rows
    {
        let category = match cat {
            Some(c) => catalog::path_of(conn, CatKind::Item, c).await?,
            None => None,
        };
        out.push(json!({
            "item_id": item_id, "receipt_id": receipt_id, "purchased_on": date,
            "store_id": store_id, "store_name": store,
            "name": name, "quantity": qty, "unit": unit, "unit_price": unit_price,
            "amount_incl": incl, "category": category,
        }));
    }
    Ok(SearchResult {
        total_count,
        sum_amount,
        rows: out,
        next_cursor,
        images: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip() {
        let c = encode_cursor("2026-10-01", 42);
        assert_eq!(decode_cursor(&c), Some(("2026-10-01".into(), 42)));
        assert_eq!(decode_cursor("garbage!"), None);
    }

    // TASK-73: the search query length cap helper. Both adapters (web api.rs
    // and the MCP tools) call it at their input validation points, the same
    // decode_cursor pattern; the cap itself comes from mcp.toml [limits]
    // max_query_chars (spec_mcp-tools.md 3-5).

    // [covers:mcp-tools.query-length]
    #[test]
    fn check_query_text_char_boundaries() {
        // 200 chars pass, 201 fail; the cap arrives as an argument so the
        // configured [limits] value drives it, never a hardcoded constant
        assert!(check_query_text("q", &"a".repeat(200), 200).is_ok());
        assert!(check_query_text("item_query", &"a".repeat(201), 200).is_err());
        assert!(check_query_text("store", &"b".repeat(50), 50).is_ok());
        assert!(check_query_text("store_query", &"b".repeat(51), 50).is_err());
        // the length is the input as received (design 2-1: 入力時点・normalize
        // 前), not the trimmed one: 201 chars of which 200 are content still
        // exceed the cap
        let padded = format!("{} ", "a".repeat(200));
        assert!(check_query_text("q", &padded, 200).is_err());
    }

    // [covers:mcp-tools.query-length]
    #[test]
    fn check_query_text_counts_chars_not_bytes() {
        // hiragana: 100 chars = 300 UTF-8 bytes must pass (a byte counter
        // would reject it) and 201 chars (603 bytes) must fail — the cap
        // counts chars, the same unit as max_name_chars / truncate_chars
        assert!(check_query_text("q", &"あ".repeat(100), 200).is_ok());
        assert!(
            check_query_text("item_query", &"あ".repeat(201), 200).is_err(),
            "hiragana is counted per char, not per UTF-8 byte"
        );
    }

    // [covers:mcp-tools.query-length]
    #[test]
    fn check_query_text_error_names_kind_and_limit() {
        for kind in ["store", "item_query", "q", "store_query"] {
            let err = check_query_text(kind, &"x".repeat(201), 200).unwrap_err();
            match err {
                FilterError::Invalid(msg) => {
                    assert!(msg.contains(kind), "{kind} is named in: {msg}");
                    assert!(msg.contains("200"), "the limit is in: {msg}");
                }
                other => panic!("expected Invalid, got {other:?}"),
            }
        }
    }

    // [covers:mcp-tools.query-length]
    #[test]
    fn check_query_text_trim_empty_wins_over_length() {
        // 201 whitespace chars satisfy both "trim-empty" (the existing
        // filter skip) and "over the cap": the trim-empty check is applied
        // first, so this is not a length error and the existing behavior
        // is kept (design 3-3 優先順位)
        assert!(check_query_text("q", &" ".repeat(201), 200).is_ok());
        assert!(check_query_text("store", &" ".repeat(201), 200).is_ok());
        assert!(check_query_text("item_query", "", 200).is_ok());
    }
}
