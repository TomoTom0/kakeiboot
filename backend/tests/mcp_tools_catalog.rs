//! TASK-11: the catalog tools (#11-#13) and summarize_spending (#14) through
//! the real `/mcp` route (spec_mcp-tools.md 7-12 .. 7-15, 10).

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

fn rpc(id: i64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

async fn call(router: &axum::Router, token: &str, id: i64, name: &str, args: Value) -> Value {
    let body = rpc(id, "tools/call", json!({"name": name, "arguments": args}));
    let headers = mcp_headers(token);
    let mut builder = axum::http::Request::builder().method("POST").uri("/mcp");
    for (k, v) in &headers {
        builder = builder.header(*k, v.as_str());
    }
    use tower::ServiceExt as _;
    let resp = router
        .clone()
        .oneshot(builder.body(axum::body::Body::from(body)).unwrap())
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

/// Owner ledger (the user's default, becomes the grant's active ledger) plus
/// a viewer-side ledger. The owner ledger's id is returned as `owner`.
async fn setup() -> (axum::Router, sqlx::SqlitePool, String, i64, i64, i64) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, _cfg) = oauth::oauth_setup(&mock).await;
    let user = common::auth::create_user_direct(&pool, "Catalog User", None).await;
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
    let grant = oauth::insert_grant(
        &pool,
        user,
        &mock.client_id,
        "ledger.read ledger.write",
        Some(owner),
    )
    .await;
    let token = oauth::insert_access_token(&pool, grant).await;
    (router, pool, token, grant, user, owner)
}

async fn insert_store(pool: &sqlx::SqlitePool, id: i64, ledger_id: i64, name: &str) {
    sqlx::query(
        "INSERT INTO stores (id, ledger_id, name, name_norm, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(name)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
}

// [covers:mcp-tools.get-catalog]
#[tokio::test]
async fn get_catalog_returns_trees_paths_and_query_stores() {
    let (router, pool, token, _grant, _user, owner) = setup().await;
    let top = common::insert_category(&pool, "item_categories", owner, None, "Food").await;
    common::insert_category(&pool, "item_categories", owner, Some(top), "Snacks").await;
    common::insert_category(&pool, "store_categories", owner, None, "Supermarket").await;
    insert_store(&pool, 5, owner, "Seven Mart").await;
    let sql = "INSERT INTO receipts (id, ledger_id, created_by, source, purchased_on, store_id, created_at, updated_at)
                 VALUES (30, ?, 1, 'manual', '2026-10-01', 5, 0, 0)";
    sqlx::query(sql).bind(owner).execute(&pool).await.unwrap();

    // default include: both trees, no stores section
    let r = call(&router, &token, 1, "get_catalog", json!({})).await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "catalog");
    assert_eq!(sc["ledger"]["id"], json!(owner));
    let tops = sc["item_categories"].as_array().unwrap();
    assert_eq!(tops[0]["name"], "Food");
    assert_eq!(tops[0]["children"][0]["name"], "Snacks");
    assert_eq!(sc["store_categories"][0]["name"], "Supermarket");
    assert!(sc.get("stores").is_none(), "stores only with a query");
    assert_eq!(sc["category_paths"]["item"][1], json!("Food/Snacks"));
    assert_eq!(sc["category_paths"]["store"][0], json!("Supermarket"));

    // with a store query: the stores section appears with usage counts
    let r = call(
        &router,
        &token,
        2,
        "get_catalog",
        json!({ "store_query": "seven" }),
    )
    .await;
    let sc = &r["structuredContent"];
    let stores = sc["stores"].as_array().unwrap();
    assert_eq!(stores.len(), 1);
    assert_eq!(stores[0]["store_id"], json!(5));
    assert_eq!(stores[0]["receipt_count"], json!(1));

    // an unknown include value is an input error naming the field
    let r = call(
        &router,
        &token,
        3,
        "get_catalog",
        json!({ "include": ["bogus"] }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("include")
    );
}

// [covers:mcp-tools.manage-category-handler]
#[tokio::test]
async fn manage_category_two_step_create_idempotent_and_viewer_refused() {
    let (router, pool, token, _grant, user, _owner) = setup().await;

    // creating a subcategory before its parent is an input error that names
    // the missing parent (the model is told to create it first)
    let r = call(
        &router,
        &token,
        1,
        "manage_category",
        json!({ "kind": "item", "action": "create", "category": "Books/Tech" }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(r["content"][0]["text"].as_str().unwrap().contains("Books"));

    // create the parent, then the child (spec 7-13: two calls)
    let r = call(
        &router,
        &token,
        2,
        "manage_category",
        json!({ "kind": "item", "action": "create", "category": "Books" }),
    )
    .await;
    let sc = &r["structuredContent"];
    assert_eq!(sc["category"]["path"], json!("Books"));
    assert_eq!(sc["created"], json!(true));
    // create again: idempotent, created = false
    let r = call(
        &router,
        &token,
        3,
        "manage_category",
        json!({ "kind": "item", "action": "create", "category": "Books" }),
    )
    .await;
    assert_eq!(r["structuredContent"]["created"], json!(false));
    // now the subcategory works
    let r = call(
        &router,
        &token,
        4,
        "manage_category",
        json!({ "kind": "item", "action": "create", "category": "Books/Tech" }),
    )
    .await;
    assert_eq!(
        r["structuredContent"]["category"]["path"],
        json!("Books/Tech")
    );

    // rename
    let r = call(
        &router,
        &token,
        5,
        "manage_category",
        json!({ "kind": "item", "action": "rename", "category": "Books/Tech", "new_name": "Eng" }),
    )
    .await;
    assert_eq!(
        r["structuredContent"]["category"]["path"],
        json!("Books/Eng")
    );
    // audit rows follow every actual mutation (the idempotent no-op create
    // does not audit)
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'item_category' AND action IN ('create', 'rename')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 3, "Books, Books/Tech creates + one rename");

    // archive hides it from the default tree
    let r = call(
        &router,
        &token,
        6,
        "manage_category",
        json!({ "kind": "item", "action": "archive", "category": "Books/Eng" }),
    )
    .await;
    assert_eq!(r["structuredContent"]["category"]["archived"], json!(true));

    // unknown category on a mutating action: the shared not-found text
    let r = call(
        &router,
        &token,
        7,
        "manage_category",
        json!({ "kind": "item", "action": "archive", "category": "Nope" }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("見つかりません")
    );

    // viewer role on the viewer-side ledger: refused even though the scope
    // allows writes
    let viewer_ledger: i64 = sqlx::query_scalar(
        "SELECT ledger_id FROM ledger_members WHERE user_id = ? AND role = 'viewer'",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    let r = call(
        &router,
        &token,
        8,
        "manage_category",
        json!({ "kind": "item", "action": "create", "category": "X", "ledger_id": viewer_ledger }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("閲覧のみ")
    );
}

// [covers:mcp-tools.manage-store-handler]
#[tokio::test]
async fn manage_store_updates_name_category_and_returns_before() {
    let (router, pool, token, _grant, user, owner) = setup().await;
    insert_store(&pool, 5, owner, "Seven Mart").await;
    let cat = common::insert_category(&pool, "store_categories", owner, None, "Supermarket").await;

    // an empty change is an input error
    let r = call(&router, &token, 1, "manage_store", json!({ "store_id": 5 })).await;
    assert_eq!(r["isError"], json!(true));
    assert!(r["content"][0]["text"].as_str().unwrap().contains("name"));

    // rename + categorize; `before` carries the old name for undo
    let r = call(
        &router,
        &token,
        2,
        "manage_store",
        json!({ "store_id": 5, "name": "Seven Mart Ekimae", "category": "Supermarket" }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "store_change");
    assert_eq!(sc["store"]["name"], json!("Seven Mart Ekimae"));
    assert_eq!(sc["store"]["category"], json!("Supermarket"));
    assert_eq!(sc["before"]["name"], json!("Seven Mart"));
    assert!(sc["before"]["category"].is_null());
    let (db_name, db_cat): (String, Option<i64>) =
        sqlx::query_as("SELECT name, category_id FROM stores WHERE id = 5")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(db_name, "Seven Mart Ekimae");
    assert_eq!(db_cat, Some(cat));

    // category null clears it
    let r = call(
        &router,
        &token,
        3,
        "manage_store",
        json!({ "store_id": 5, "category": null }),
    )
    .await;
    assert!(r["structuredContent"]["store"]["category"].is_null());

    // a store of the viewer-side ledger: not found for this owner path
    let viewer_ledger: i64 = sqlx::query_scalar(
        "SELECT ledger_id FROM ledger_members WHERE user_id = ? AND role = 'viewer'",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    insert_store(&pool, 6, viewer_ledger, "Other").await;
    let r = call(
        &router,
        &token,
        4,
        "manage_store",
        json!({ "store_id": 6, "name": "Nope" }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("見つかりません")
    );
}

// [covers:mcp-tools.summarize-handler]
#[tokio::test]
async fn summarize_reports_by_category_with_filters_and_validation() {
    let (router, pool, token, _grant, _user, owner) = setup().await;
    // two receipts on 2026-10-01/02 with one item line each (100 incl)
    common::insert_receipt(&pool, 30, owner).await;
    common::insert_item(&pool, 1, 30, owner, "Milk").await;
    common::insert_receipt(&pool, 31, owner).await;
    sqlx::query("UPDATE receipts SET purchased_on = '2026-10-02' WHERE id = 31")
        .execute(&pool)
        .await
        .unwrap();
    common::insert_item(&pool, 2, 31, owner, "Bread").await;

    // explicit period so the test is independent of the run date
    let args = json!({
        "report": "by_category",
        "period": { "from": "2026-10-01", "to": "2026-10-31" },
    });
    let r = call(&router, &token, 1, "summarize_spending", args).await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "stats");
    assert_eq!(sc["report"], json!("by_category"));
    assert_eq!(sc["totals"]["value"], json!(200));
    assert_eq!(sc["totals"]["receipts"], json!(2));
    // compare_period for an explicit range is the same number of days
    assert!(sc["compare_period"]["from"].is_string());
    // both items are uncategorized -> one 未分類 row carrying the full total
    let rows = sc["sections"][0]["rows"].as_array().unwrap();
    assert_eq!(rows[0]["labels"][0], "未分類");
    assert_eq!(rows[0]["value"], json!(200));
    // the notes explain the uncategorized amount
    let notes = sc["notes"].as_array().unwrap();
    assert!(notes.iter().any(|n| n.as_str().unwrap().contains("未分類")));
    // the content text mentions the total and the ledger name
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("200円") && text.contains("Catalog Userの家計簿"),
        "{text}"
    );

    // a bad report name is an input error listing the valid ones
    let r = call(
        &router,
        &token,
        2,
        "summarize_spending",
        json!({ "report": "bogus" }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("by_category")
    );

    // item_price_history requires filters.item_query
    let r = call(
        &router,
        &token,
        3,
        "summarize_spending",
        json!({ "report": "item_price_history" }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("item_query")
    );

    // with item_query it returns per-purchase rows
    let r = call(
        &router,
        &token,
        4,
        "summarize_spending",
        json!({
            "report": "item_price_history",
            "filters": { "item_query": "milk" },
            "period": { "from": "2026-10-01", "to": "2026-10-31" },
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let rows = r["structuredContent"]["sections"][0]["rows"]
        .as_array()
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["labels"][2], "Milk");
    assert_eq!(rows[0]["value"], json!(100));
}

// [covers:mcp-tools.summarize-filters-no-store-id]
#[tokio::test]
async fn summarize_filters_store_id_is_web_only() {
    let (router, pool, token, _grant, _user, owner) = setup().await;
    common::insert_receipt(&pool, 30, owner).await;
    common::insert_item(&pool, 1, 30, owner, "Milk").await;

    // filters.store_id stays web-only: deny_unknown_fields rejects it as an
    // unknown key even though Filters now carries the field (serde(skip))
    let r = call(
        &router,
        &token,
        1,
        "summarize_spending",
        json!({
            "report": "by_category",
            "period": { "from": "2026-10-01", "to": "2026-10-31" },
            "filters": { "store_id": 1 }
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("store_id"), "{text}");

    // the input schema's filters never lists the web-only key
    let body = rpc(2, "tools/list", json!({}));
    let headers = mcp_headers(&token);
    let mut builder = axum::http::Request::builder().method("POST").uri("/mcp");
    for (k, v) in &headers {
        builder = builder.header(*k, v.as_str());
    }
    use tower::ServiceExt as _;
    let resp = router
        .clone()
        .oneshot(builder.body(axum::body::Body::from(body)).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let tools = v["result"]["tools"].as_array().cloned().unwrap();
    let filters = &tools
        .iter()
        .find(|t| t["name"] == "summarize_spending")
        .unwrap()["inputSchema"]["properties"]["filters"]["properties"];
    let mut keys: Vec<&str> = filters
        .as_object()
        .expect("filters schema object")
        .keys()
        .map(|k| k.as_str())
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "category",
            "item_query",
            "label_colors",
            "store",
            "store_category"
        ],
        "no store_id in the MCP filters schema"
    );
}

// [covers:mcp-catalog.labels]
#[tokio::test]
async fn get_catalog_includes_label_definitions() {
    let (router, pool, token, _grant, _user, owner) = setup().await;
    // a titled label so the resolution use case (title -> color) is visible
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = ? AND color = 'red'")
        .bind(owner)
        .execute(&pool)
        .await
        .unwrap();

    let r = call(&router, &token, 1, "get_catalog", json!({})).await;
    assert_eq!(r["isError"], json!(false));
    let labels = r["structuredContent"]["labels"].as_array().expect("labels");
    let colors: Vec<&str> = labels
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["red", "yellow", "green", "blue", "purple"]);
    assert_eq!(labels[0]["title"], "旅行");
    assert!(labels[1]["title"].is_null());
}

// [covers:mcp-tools.query-length]
#[tokio::test]
async fn summarize_and_get_catalog_query_length_is_input_error() {
    let (router, _pool, token, _grant, _user, _owner) = setup().await;
    // TASK-73: over-cap search strings (max_query_chars = 200) are whole-call
    // input errors whose message carries the limit
    let over = "x".repeat(201);
    // summarize_spending: filters.store / filters.item_query
    for filters in [json!({ "store": over }), json!({ "item_query": over })] {
        let r = call(
            &router,
            &token,
            1,
            "summarize_spending",
            json!({
                "report": "by_category",
                "period": { "from": "2026-10-01", "to": "2026-10-31" },
                "filters": filters,
            }),
        )
        .await;
        assert_eq!(r["isError"], json!(true), "filters: {filters}");
        let text = r["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("200"), "the limit is in the message: {text}");
    }
    // get_catalog: store_query
    let r = call(
        &router,
        &token,
        2,
        "get_catalog",
        json!({ "store_query": over }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"].as_str().unwrap().contains("200"),
        "the limit is in the message"
    );
}
