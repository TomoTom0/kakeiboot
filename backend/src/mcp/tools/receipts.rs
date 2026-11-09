//! Confirmed-receipt tools #7-#10 (spec_mcp-tools.md 7-8 .. 7-11).

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::domain::actor::Actor;
use crate::domain::labels::LabelColor;
use crate::domain::receipts::{self as dr, DeleteOutcome, ReceiptError, ReceiptPatch};
use crate::domain::search::{self, SearchQuery};
use crate::domain::stats::{FilterError, parse_period, resolve_period};
use crate::domain::util;
use crate::mcp::result::{self, envelope, yen};

fn filter_err(e: FilterError) -> rmcp::model::CallToolResult {
    match e {
        FilterError::Invalid(m) => result::invalid(&[m]),
        FilterError::Db(e) => result::internal(e),
    }
}

// ---------------------------------------------------------------------------
// #7 search_receipts

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    period: Option<Value>,
    #[serde(default)]
    store: Option<String>,
    #[serde(default)]
    item_query: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    payment_method: Option<crate::domain::dto::PaymentMethod>,
    /// OR filter over the label palette (spec 7-8)
    #[serde(default)]
    label_colors: Option<Vec<LabelColor>>,
    #[serde(default)]
    include_deleted: bool,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn search(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: SearchArgs = parse(args)?;
    let ledger = c.target(a.ledger_id).await?;
    let mode = a.mode.as_deref().unwrap_or("receipts");
    if mode != "receipts" && mode != "items" {
        return Err(result::invalid(&["mode: \"receipts\" か \"items\"".into()]));
    }
    let range = match &a.period {
        Some(v) => Some(
            parse_period(v)
                .and_then(|p| resolve_period(&p, util::jst_date(c.now)))
                .map_err(|m| result::invalid(&[m]))?,
        ),
        None => None,
    };
    let cursor = match &a.cursor {
        Some(s) => Some(search::decode_cursor(s).ok_or_else(|| {
            result::invalid(&["cursor: 前回の結果の next_cursor をそのまま渡してください".into()])
        })?),
        None => None,
    };
    let lim = c.limits();
    let limit = a
        .limit
        .unwrap_or(lim.search_default_limit)
        .clamp(1, lim.search_max_limit);
    // TASK-73: search query length cap (spec 3-5) at the input validation
    // point, the same decode_cursor pattern; whitespace-only stays Ok.
    search::check_query_text(
        "store",
        a.store.as_deref().unwrap_or(""),
        lim.max_query_chars,
    )
    .map_err(filter_err)?;
    search::check_query_text(
        "item_query",
        a.item_query.as_deref().unwrap_or(""),
        lim.max_query_chars,
    )
    .map_err(filter_err)?;
    let q = SearchQuery {
        store: a.store,
        text: None,
        store_id: None,
        item_query: a.item_query,
        category: a.category,
        payment_method: a.payment_method.map(|p| p.as_str().to_string()),
        label_colors: a.label_colors.unwrap_or_default(),
        include_deleted: a.include_deleted,
    };
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    let res = if mode == "items" {
        search::search_items(&mut conn, ledger.id, range.as_ref(), &q, limit, cursor).await
    } else {
        search::search_receipts(&mut conn, ledger.id, range.as_ref(), &q, limit, cursor).await
    }
    .map_err(filter_err)?;
    drop(conn);
    let period_resolved = range
        .as_ref()
        .map(|r| serde_json::to_value(r.resolved()).unwrap_or(Value::Null));
    let mut thumbs = Map::new();
    for (rid, img) in res.images.iter().take(20) {
        if let Some(u) = c.image_url(*img).await {
            thumbs.insert(format!("receipt:{rid}"), u);
        }
    }
    let unit = if mode == "items" {
        "明細"
    } else {
        "レシート"
    };
    let mut text = format!(
        "{unit} {} 件（合計 {}）。{}",
        res.total_count,
        yen(res.sum_amount),
        ledger.text_suffix()
    );
    if mode != "items" {
        // TASK-167 D-3: the derived representative items ride the content
        // text too — one compact line per listed receipt (store + top items),
        // so the model reads what was bought without consulting the rows
        for r in &res.rows {
            let names: Vec<&str> = r
                .get("top_items")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|t| t.get("name").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            if names.is_empty() {
                continue;
            }
            let store = r
                .get("store_name")
                .and_then(Value::as_str)
                .unwrap_or("店名なし");
            text.push_str(&format!("\n{store}: {}", names.join("・")));
        }
    }
    if res.next_cursor.is_some() {
        text.push_str(&format!(
            "\n{} 件を表示。続きは next_cursor を cursor に渡してください。",
            res.rows.len()
        ));
    }
    let (view, key) = if mode == "items" {
        ("item_list", "items")
    } else {
        ("receipt_list", "receipts")
    };
    let mut body = json!({
        "period_resolved": period_resolved,
        "total_count": res.total_count,
        "sum_amount": res.sum_amount,
        "next_cursor": res.next_cursor,
    });
    body[key] = Value::Array(res.rows);
    let meta = (!thumbs.is_empty()).then(|| json!({ "images": thumbs }));
    Ok(result::ok(
        text,
        envelope(view, Some(&ledger), &[], body),
        meta,
    ))
}

// ---------------------------------------------------------------------------
// #8 get_receipt

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetArgs {
    receipt_id: i64,
    #[serde(default)]
    ledger_id: Option<i64>,
}

async fn receipt_meta(c: &Call<'_>, receipt_id: i64, ledger_id: i64) -> Option<Value> {
    let img = dr::receipt_image_id(c.db(), receipt_id, ledger_id)
        .await
        .ok()??;
    let u = c.image_url(img).await?;
    Some(json!({ "images": { "receipt_image": u } }))
}

fn receipt_line(v: &crate::domain::dto::ReceiptView) -> String {
    let store = v
        .store
        .as_ref()
        .map(|s| s.name.clone())
        .or(v.store_name_raw.clone())
        .unwrap_or_else(|| "店不明".into());
    format!(
        "レシート #{}（rev {}）: {} / {} / 明細{}行 合計 {}{}",
        v.receipt_id,
        v.revision,
        store,
        v.purchased_on,
        v.items.len(),
        yen(v.items_total),
        if v.deleted_at.is_some() {
            "（削除済み）"
        } else {
            ""
        }
    )
}

pub async fn get(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: GetArgs = parse(args)?;
    let ledger = c.target(a.ledger_id).await?;
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    let view = dr::receipt_view(&mut conn, a.receipt_id, ledger.id)
        .await
        .map_err(result::internal)?
        .ok_or_else(result::not_found)?;
    drop(conn);
    let meta = receipt_meta(c, a.receipt_id, ledger.id).await;
    let mut text = format!("{}。{}", receipt_line(&view), ledger.text_suffix());
    if let Some(n) = &view.note {
        text.push_str(&format!("\nメモ: {}", util::truncate_chars(n, 100)));
    }
    text.push_str(&format!("\n{}", c.receipt_web_line(view.receipt_id)));
    Ok(result::ok(
        text,
        envelope("receipt", Some(&ledger), &[], json!({ "receipt": view })),
        meta,
    ))
}

// ---------------------------------------------------------------------------
// #9 update_receipt

#[derive(Debug, Deserialize)]
struct UpdateArgs {
    receipt_id: i64,
    revision: i64,
    #[serde(default)]
    ledger_id: Option<i64>,
    #[serde(flatten)]
    patch: Map<String, Value>,
}

pub async fn update(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: UpdateArgs = parse(args)?;
    let patch: ReceiptPatch = serde_json::from_value(Value::Object(a.patch))
        .map_err(|e| result::invalid(&[format!("引数: {e}")]))?;
    let ledger = c.target_writer(a.ledger_id).await?;
    let actor = Actor::mcp(c.auth.user_id, &c.auth.client_id, c.auth.grant_id);
    let out = dr::update_receipt(
        c.db(),
        ledger.id,
        &actor,
        a.receipt_id,
        a.revision,
        &patch,
        c.limits(),
        c.now,
    )
    .await;
    match out {
        Ok(o) => {
            let meta = receipt_meta(c, a.receipt_id, ledger.id).await;
            Ok(result::ok(
                format!(
                    "{}を修正しました。{}\n変更: {}\n元に戻すときは before の値で update_receipt を呼んでください。",
                    receipt_line(&o.view),
                    ledger.text_suffix(),
                    o.changed.join(", ")
                ),
                envelope(
                    "receipt",
                    Some(&ledger),
                    &[],
                    json!({ "receipt": o.view, "changed": o.changed, "before": o.before }),
                ),
                meta,
            ))
        }
        Err(ReceiptError::NotFound) => Err(result::not_found()),
        Err(ReceiptError::Invalid(e)) => Err(result::invalid(&e)),
        Err(ReceiptError::Stale(v)) => Err(result::err_with(
            format!(
                "レシートが更新されています（現在 rev {}）。最新の内容を確認し、その revision で修正し直してください。",
                v.revision
            ),
            Some(envelope("receipt", Some(&ledger), &[], json!({ "receipt": v }))),
            None,
        )),
        Err(ReceiptError::Deleted(v)) => Err(result::err_with(
            "このレシートは削除済みです。修正するには先に delete_receipt の restore:true で復元してください。".into(),
            Some(envelope("receipt", Some(&ledger), &[], json!({ "receipt": v }))),
            None,
        )),
        Err(ReceiptError::Db(e)) => Err(result::internal(e)),
    }
}

// ---------------------------------------------------------------------------
// #10 delete_receipt

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteArgs {
    receipt_id: i64,
    #[serde(default)]
    restore: bool,
    #[serde(default)]
    confirm: bool,
    #[serde(default)]
    revision: Option<i64>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn delete(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: DeleteArgs = parse(args)?;
    let ledger = c.target_writer(a.ledger_id).await?;
    let actor = Actor::mcp(c.auth.user_id, &c.auth.client_id, c.auth.grant_id);
    let (outcome, status) = match dr::delete_or_restore(
        c.db(),
        ledger.id,
        &actor,
        a.receipt_id,
        a.restore,
        a.confirm,
        a.revision,
        c.now,
    )
    .await
    {
        Ok(x) => x,
        Err(ReceiptError::NotFound) => return Err(result::not_found()),
        Err(ReceiptError::Invalid(e)) => return Err(result::invalid(&e)),
        Err(e) => return Err(result::internal(e)),
    };
    let body = serde_json::to_value(&status).unwrap_or(Value::Null);
    let structured = envelope("receipt_status", Some(&ledger), &[], body);
    let id = a.receipt_id;
    let suffix = ledger.text_suffix();
    let preview_line = || {
        status
            .preview
            .as_ref()
            .map(|p| {
                format!(
                    "対象: {} / {} / {} / 明細{}行",
                    p["store_name"].as_str().unwrap_or("店不明"),
                    p["purchased_on"].as_str().unwrap_or(""),
                    yen(p["amount"].as_i64().unwrap_or(0)),
                    p["item_count"]
                )
            })
            .unwrap_or_default()
    };
    match outcome {
        DeleteOutcome::Preview => Ok(result::ok(
            format!(
                "まだ削除していません。{}\n{}\nユーザーに対象を示し、明示の同意を得てから confirm:true と revision={} を付けて再度呼んでください（削除後も90日以内なら復元できます）。",
                suffix,
                preview_line(),
                status.revision
            ),
            structured,
            None,
        )),
        DeleteOutcome::Deleted => Ok(result::ok(
            format!(
                "レシート #{id} を削除しました。{suffix}\n90日以内なら delete_receipt の restore:true で復元できます（{} まで）。",
                status.purge_after.clone().unwrap_or_default()
            ),
            structured,
            None,
        )),
        DeleteOutcome::Restored => Ok(result::ok(
            format!("レシート #{id} を復元しました。{suffix}"),
            structured,
            None,
        )),
        DeleteOutcome::AlreadyDone => Ok(result::ok(
            if status.deleted_at.is_some() {
                format!(
                    "レシート #{id} は既に削除済みです（90日以内なら restore:true で復元できます）。{suffix}"
                )
            } else {
                format!("レシート #{id} は削除されていません。{suffix}")
            },
            structured,
            None,
        )),
        DeleteOutcome::Stale => Err(result::err_with(
            format!(
                "レシートが更新されています（現在 rev {}）。何も変更していません。最新の内容をユーザーに示して確認し直してください。\n{}",
                status.revision,
                preview_line()
            ),
            Some(structured),
            None,
        )),
    }
}
