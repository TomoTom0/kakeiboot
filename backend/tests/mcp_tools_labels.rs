//! TASK-17: label tools through the real `/mcp` route — tool #19
//! label_receipts (batch add/remove, skips, role and input errors), the
//! label_colors filter of search_receipts and summarize_spending
//! (spec_mcp-tools.md 2, 7-8, 7 new section, 10).

mod common;

use common::oauth::{self};
use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2025-06-18";

fn mcp_headers(token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("host", "localhost:40281".into()),
        ("authorization", format!("Bearer {token}")),
        ("content-type", "application/json".into()),
        ("accept", "application/json, text/event-stream".into()),
        ("mcp-protocol-version", PROTOCOL_VERSION.into()),
    ]
}

async fn call(router: &axum::Router, token: &str, id: i64, name: &str, args: Value) -> Value {
    let body = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {"name": name, "arguments": args},
    });
    let headers = mcp_headers(token);
    let mut builder = axum::http::Request::builder().method("POST").uri("/mcp");
    for (k, v) in &headers {
        builder = builder.header(*k, v.as_str());
    }
    use tower::ServiceExt as _;
    let resp = router
        .clone()
        .oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v.get("error").is_none(), "protocol error: {v}");
    v["result"].clone()
}

/// Owner ledger (the grant's active ledger) with receipts 101..103 on it,
/// plus a viewer-side ledger. Returns (router, pool, token, owner, viewer_ledger).
async fn setup() -> (axum::Router, sqlx::SqlitePool, String, i64, i64) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, _cfg) = oauth::oauth_setup(&mock).await;
    let user = common::auth::create_user_direct(&pool, "Label User", None).await;
    let owner: i64 =
        sqlx::query_scalar::<_, Option<i64>>("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap()
            .expect("default ledger");
    let viewer_ledger: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('viewer-side', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    common::insert_member(&pool, viewer_ledger, user, "viewer").await;
    for id in [101i64, 102, 103] {
        sqlx::query(
            "INSERT INTO receipts (id, ledger_id, created_by, source, purchased_on, created_at, updated_at)
             VALUES (?, ?, 1, 'manual', '2026-10-10', 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    }
    let grant = oauth::insert_grant(
        &pool,
        user,
        &mock.client_id,
        "ledger.read ledger.write",
        Some(owner),
    )
    .await;
    let token = oauth::insert_access_token(&pool, grant).await;
    (router, pool, token, owner, viewer_ledger)
}

async fn insert_label(pool: &sqlx::SqlitePool, ledger_id: i64, receipt_id: i64, color: &str) {
    sqlx::query(
        "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
         VALUES (?, ?, ?, 1, 0)",
    )
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(color)
    .execute(pool)
    .await
    .unwrap();
}

async fn receipt_audit_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE entity_type = 'receipt' AND action = 'label'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

// [covers:mcp-tools.label-receipts]
#[tokio::test]
async fn label_receipts_batch_idempotent_and_skips() {
    let (router, pool, token, owner, _viewer_ledger) = setup().await;
    // 102 is soft-deleted: skipped, not an error
    sqlx::query("UPDATE receipts SET deleted_at = 500 WHERE id = 102")
        .execute(&pool)
        .await
        .unwrap();

    let r = call(
        &router,
        &token,
        1,
        "label_receipts",
        json!({ "receipt_ids": [101, 102, 999], "add": ["red", "blue"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "label_change");
    assert_eq!(sc["ledger"]["id"], json!(owner));
    let colors: Vec<&str> = sc["receipts"][0]["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["red", "blue"], "101 labeled");
    let skipped: Vec<(i64, &str)> = sc["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["receipt_id"].as_i64().unwrap(),
                s["reason"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(skipped, [(999, "not_found"), (102, "deleted")]);

    // idempotent resend: same labels, no extra audit row, revision untouched
    let rev_before: i64 = sqlx::query_scalar("SELECT revision FROM receipts WHERE id = 101")
        .fetch_one(&pool)
        .await
        .unwrap();
    let audits = receipt_audit_count(&pool).await;
    let r = call(
        &router,
        &token,
        2,
        "label_receipts",
        json!({ "receipt_ids": [101], "add": ["red", "blue"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert_eq!(
        r["structuredContent"]["receipts"][0]["labels"],
        sc["receipts"][0]["labels"]
    );
    assert_eq!(receipt_audit_count(&pool).await, audits, "no new audit row");
    let rev_after: i64 = sqlx::query_scalar("SELECT revision FROM receipts WHERE id = 101")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rev_after, rev_before, "labels do not bump revision");

    // remove works as a diff too
    let r = call(
        &router,
        &token,
        3,
        "label_receipts",
        json!({ "receipt_ids": [101], "remove": ["red"] }),
    )
    .await;
    let colors: Vec<&str> = r["structuredContent"]["receipts"][0]["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["blue"]);
}

// [covers:mcp-tools.label-receipts]
#[tokio::test]
async fn label_receipts_errors() {
    let (router, _pool, token, _owner, viewer_ledger) = setup().await;

    // every receipt skipped: the whole call is an error
    let r = call(
        &router,
        &token,
        1,
        "label_receipts",
        json!({ "receipt_ids": [999, 998], "add": ["red"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));

    // viewer ledger: the whole call is an error with the shared wording
    let r = call(
        &router,
        &token,
        2,
        "label_receipts",
        json!({ "receipt_ids": [101], "add": ["red"], "ledger_id": viewer_ledger }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("閲覧のみ")
    );

    // input validation: both empty / crossing / unknown color / over 50 ids
    for (id, args) in [
        (3, json!({ "receipt_ids": [101], "add": [], "remove": [] })),
        (
            4,
            json!({ "receipt_ids": [101], "add": ["red"], "remove": ["red"] }),
        ),
        (5, json!({ "receipt_ids": [101], "add": ["orange"] })),
        (
            6,
            json!({ "receipt_ids": (1i64..=51).collect::<Vec<_>>(), "add": ["red"] }),
        ),
    ] {
        let r = call(&router, &token, id, "label_receipts", args.clone()).await;
        assert_eq!(r["isError"], json!(true), "args {args}");
    }
}

/// A grant with no active ledger for the same user (the "choose again" path).
#[tokio::test]
// [covers:mcp-tools.label-receipts]
async fn label_receipts_no_ledger_selected() {
    let (router, pool, _token, owner, _viewer) = setup().await;
    let user: i64 =
        sqlx::query_scalar("SELECT user_id FROM oauth_grants WHERE active_ledger_id = ?")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let grant =
        oauth::insert_grant(&pool, user, "chatgpt.com", "ledger.read ledger.write", None).await;
    let token = oauth::insert_access_token(&pool, grant).await;

    let r = call(
        &router,
        &token,
        1,
        "label_receipts",
        json!({ "receipt_ids": [101], "add": ["red"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("switch_ledger"),
        "prompts to re-choose the ledger: {text}"
    );
}

/// Read scope only: the write tool is refused with the scope challenge.
#[tokio::test]
// [covers:mcp-tools.label-receipts]
async fn label_receipts_read_scope_refused() {
    let (router, pool, _token, owner, _viewer) = setup().await;
    let user: i64 =
        sqlx::query_scalar("SELECT user_id FROM oauth_grants WHERE active_ledger_id = ?")
            .bind(owner)
            .fetch_one(&pool)
            .await
            .unwrap();
    let mock = oauth::spawn_mock().await;
    let grant = oauth::insert_grant(&pool, user, &mock.client_id, "ledger.read", Some(owner)).await;
    let token = oauth::insert_access_token(&pool, grant).await;

    let r = call(
        &router,
        &token,
        1,
        "label_receipts",
        json!({ "receipt_ids": [101], "add": ["red"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("ledger.write"),
        "names the missing scope: {text}"
    );
}

// [covers:mcp-search.label-filter]
#[tokio::test]
async fn search_receipts_label_filter() {
    let (router, pool, token, owner, _viewer) = setup().await;
    // one item line per receipt so the items mode has rows to list
    for id in [101i64, 102] {
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (?, ?, 1, 'x', 'x', 100, 100, 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();
    }
    insert_label(&pool, owner, 101, "red").await;
    insert_label(&pool, owner, 102, "blue").await;
    // 103 stays unlabeled

    // receipts mode: only receipts holding one of the colors, rows carry labels
    let r = call(
        &router,
        &token,
        1,
        "search_receipts",
        json!({ "label_colors": ["red"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let rows = sc["receipts"].as_array().unwrap();
    let ids: Vec<i64> = rows
        .iter()
        .map(|x| x["receipt_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [101]);
    assert_eq!(rows[0]["labels"][0]["color"], "red");

    // OR across colors
    let r = call(
        &router,
        &token,
        2,
        "search_receipts",
        json!({ "label_colors": ["red", "blue"] }),
    )
    .await;
    let rows = r["structuredContent"]["receipts"].as_array().unwrap();
    let ids: Vec<i64> = rows
        .iter()
        .map(|x| x["receipt_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [102, 101]);

    // items mode: no labels column on the rows
    let r = call(
        &router,
        &token,
        3,
        "search_receipts",
        json!({ "mode": "items", "label_colors": ["red"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let rows = r["structuredContent"]["items"].as_array().unwrap();
    assert!(!rows.is_empty());
    assert!(
        rows.iter().all(|x| x.get("labels").is_none()),
        "items rows carry no labels in the first release"
    );
}

// [covers:mcp-stats.label-filter]
#[tokio::test]
async fn summarize_spending_label_filter_and_echo() {
    let (router, pool, token, owner, _viewer) = setup().await;
    // amounts via items so the totals reflect the fixtures
    for (id, amount) in [(101i64, 300), (102, 80), (103, 180)] {
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (?, ?, 1, 'x', 'x', ?, ?, 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .bind(amount)
        .bind(amount)
        .execute(&pool)
        .await
        .unwrap();
    }
    insert_label(&pool, owner, 101, "red").await;
    insert_label(&pool, owner, 103, "red").await;
    // 103 is out of the October range; the shared setup inserts every
    // receipt on 2026-10-10
    sqlx::query("UPDATE receipts SET purchased_on = '2026-09-30' WHERE id = 103")
        .execute(&pool)
        .await
        .unwrap();

    let r = call(
        &router,
        &token,
        1,
        "summarize_spending",
        json!({
            "report": "monthly_overview",
            "period": { "month": "2026-10" },
            "filters": { "label_colors": ["red"] }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["totals"]["value"], 300, "only the red receipt (101)");
    // the applied filters are echoed
    assert_eq!(sc["filters"]["label_colors"], json!(["red"]));

    // an empty array means "no filter"
    let r = call(
        &router,
        &token,
        2,
        "summarize_spending",
        json!({
            "report": "monthly_overview",
            "period": { "month": "2026-10" },
            "filters": { "label_colors": [] }
        }),
    )
    .await;
    let sc = &r["structuredContent"];
    assert_eq!(sc["totals"]["value"], 380);
    assert!(sc["filters"].is_null(), "empty filters are not echoed");

    // a value outside the 5-color enum is an input error
    let r = call(
        &router,
        &token,
        3,
        "summarize_spending",
        json!({
            "report": "monthly_overview",
            "period": { "month": "2026-10" },
            "filters": { "label_colors": ["orange"] }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
}

// [covers:mcp-stats.trend-matrix-meta] TASK-116 (design tmp/tasks/tm-116/
// design_breakdown-expansion.md §3-3-1): monthly_overview and monthly_trend
// ship the stacked-composition matrix through `_meta` (the widget-only
// channel, spec §3-4 / §10) — the same shape as the web REST
// GET /analysis/trend result. The sections body and the input schema stay
// untouched; monthly_overview keeps daily_cumulative alongside.
#[tokio::test]
async fn summarize_spending_trend_matrix_meta() {
    let (router, pool, token, owner, _viewer) = setup().await;
    // amounts via items so the matrix reflects the fixtures; every item is
    // unattributed, so the category axis holds a single 未分類 series
    for (id, amount) in [(101i64, 300), (102, 80), (103, 180)] {
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (?, ?, 1, 'x', 'x', ?, ?, 0, 0)",
        )
        .bind(id)
        .bind(owner)
        .bind(amount)
        .bind(amount)
        .execute(&pool)
        .await
        .unwrap();
    }
    insert_label(&pool, owner, 101, "red").await;
    insert_label(&pool, owner, 103, "red").await;

    // monthly_overview: the matrix rides the same last-6-months sub-range as
    // the trend section, zero-filled ascending, same order and length as the
    // section rows
    let r = call(
        &router,
        &token,
        1,
        "summarize_spending",
        json!({
            "report": "monthly_overview",
            "period": { "month": "2026-10" }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let tm = &r["_meta"]["trend_matrix"];
    assert_eq!(
        tm["axis"], "category",
        "the same axis value as the REST trend"
    );
    assert_eq!(tm["metric"], "amount");
    assert_eq!(tm["granularity"], "month");
    let trend = sc["sections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == json!("trend"))
        .unwrap();
    let row_keys: Vec<&str> = trend["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["keys"][0].as_str().unwrap())
        .collect();
    let buckets: Vec<&str> = tm["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert_eq!(
        buckets,
        vec![
            "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"
        ]
    );
    assert_eq!(
        buckets, row_keys,
        "same order and length as the section rows"
    );
    // the whole spend is unattributed: one 未分類 series and no「その他」series
    // (the residual is derived frontend-side from bucket_totals - series)
    let series = tm["series"].as_array().unwrap();
    assert_eq!(series.len(), 1);
    assert_eq!(series[0]["key"], serde_json::Value::Null);
    assert_eq!(series[0]["label"], "未分類");
    assert_eq!(series[0]["values"], json!([0, 0, 0, 0, 0, 560]));
    assert_eq!(series[0]["total"], 560);
    assert_eq!(tm["bucket_totals"], json!([0, 0, 0, 0, 0, 560]));
    assert_eq!(tm["truncated_rows"], 0);
    // monthly_overview keeps its daily_cumulative alongside the matrix
    assert!(
        !r["_meta"]["daily_cumulative"]
            .as_array()
            .unwrap()
            .is_empty(),
        "daily_cumulative survives next to trend_matrix"
    );

    // monthly_trend: the matrix covers the requested range itself (10 months
    // here); _meta exists now that the matrix is always non-empty
    let r = call(
        &router,
        &token,
        2,
        "summarize_spending",
        json!({
            "report": "monthly_trend",
            "period": { "from": "2026-01-01", "to": "2026-10-31" }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let tm = &r["_meta"]["trend_matrix"];
    let buckets: Vec<&str> = tm["buckets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_str().unwrap())
        .collect();
    assert_eq!(buckets.first(), Some(&"2026-01"));
    assert_eq!(buckets.last(), Some(&"2026-10"));
    assert_eq!(buckets.len(), 10, "the whole requested range, zero-filled");
    let totals = tm["bucket_totals"].as_array().unwrap();
    assert_eq!(totals[9], json!(560));
    assert_eq!(
        tm["series"].as_array().unwrap()[0]["values"]
            .as_array()
            .unwrap()[9],
        json!(560)
    );

    // the label filter narrows the matrix under the same condition as the
    // totals (red = receipts 101 + 103 = 480)
    let r = call(
        &router,
        &token,
        3,
        "summarize_spending",
        json!({
            "report": "monthly_overview",
            "period": { "month": "2026-10" },
            "filters": { "label_colors": ["red"] }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let tm = &r["_meta"]["trend_matrix"];
    let series = tm["series"].as_array().unwrap();
    assert_eq!(series.len(), 1);
    assert_eq!(series[0]["values"], json!([0, 0, 0, 0, 0, 480]));
    assert_eq!(tm["bucket_totals"], json!([0, 0, 0, 0, 0, 480]));
}
