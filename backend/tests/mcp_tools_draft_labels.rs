//! TASK-21: draft-stage labels through the real `/mcp` route —
//! `payload.label_colors` on create_receipt_draft / create_receipt_drafts
//! (intake, normalization, DraftView.labels, schema, per-entry rejection of
//! unknown colors) and the approval carry-over into receipt_labels
//! (idempotent re-approval, set.label_colors via update_receipt_draft,
//! reopen inheritance). Manual drafts only, so no image mock server is
//! needed (spec_mcp-tools.md 7-1, 7-2, 7-3, 7-22; design
//! tmp/tasks/tm-21/design_draft-labels.md).

mod common;

use budget_book::app::{self, AppState};
use budget_book::config::Config;
use budget_book::db;
use common::oauth;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

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

async fn post_jsonrpc(router: &axum::Router, token: &str, body: Value) -> Value {
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

async fn call(router: &axum::Router, token: &str, id: i64, name: &str, args: Value) -> Value {
    post_jsonrpc(
        router,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        }),
    )
    .await
}

async fn call_list(router: &axum::Router, token: &str, id: i64) -> Value {
    post_jsonrpc(
        router,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/list",
            "params": {},
        }),
    )
    .await
}

struct Setup {
    router: axum::Router,
    pool: SqlitePool,
    owner: i64,
    user: i64,
}

async fn setup() -> Setup {
    let mock = oauth::spawn_mock().await;
    let cfg: Config = oauth::oauth_config(&mock, None);
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    let user = common::auth::create_user_direct(&pool, "Draft Label User", None).await;
    let owner: i64 =
        sqlx::query_scalar::<_, Option<i64>>("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap()
            .expect("default ledger");
    Setup {
        router,
        pool,
        owner,
        user,
    }
}

impl Setup {
    async fn token(&self) -> String {
        let grant = common::oauth::insert_grant(
            &self.pool,
            self.user,
            "chatgpt.com",
            "ledger.read ledger.write",
            Some(self.owner),
        )
        .await;
        common::oauth::insert_access_token(&self.pool, grant).await
    }
}

fn payload(store: &str, date: &str, total: i64) -> Value {
    json!({
        "store_name": store,
        "purchased_on": date,
        "total_amount": total,
        "items": [{"line_no": 1, "name": "牛乳", "amount": total}],
    })
}

/// A manual-draft argument object with the given label_colors.
fn manual(labels: Value) -> Value {
    let mut p = payload("イオン", "2026-10-01", 198);
    p["label_colors"] = labels;
    json!({"input_kind": "manual", "payload": p})
}

async fn draft_count(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM drafts")
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn receipt_colors(pool: &SqlitePool, receipt_id: i64) -> Vec<String> {
    let mut v: Vec<String> =
        sqlx::query_scalar("SELECT color FROM receipt_labels WHERE receipt_id = ?")
            .bind(receipt_id)
            .fetch_all(pool)
            .await
            .unwrap();
    v.sort();
    v
}

fn is_error(r: &Value) -> bool {
    r["isError"].as_bool().unwrap_or(false)
}

fn text_of(r: &Value) -> String {
    r["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn labels_of(draft: &Value) -> Value {
    draft["labels"].clone()
}

// [covers:mcp-tools.draft-labels-intake]
#[tokio::test]
async fn label_colors_intake_normalizes_and_reports() {
    let s = setup().await;
    let token = s.token().await;

    // schema: #1 payload, #20 entry payload and #2 set all carry label_colors
    // (the 5-color enum, uniqueItems — registry.rs header_props is shared)
    let list = call_list(&s.router, &token, 1).await;
    let tools = list["tools"].as_array().unwrap();
    let by_name = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap().clone();
    for (tool, node) in [
        ("create_receipt_draft", by_name("create_receipt_draft")["inputSchema"]["properties"]["payload"]["properties"]["label_colors"].clone()),
        ("create_receipt_drafts", by_name("create_receipt_drafts")["inputSchema"]["properties"]["drafts"]["items"]["properties"]["payload"]["properties"]["label_colors"].clone()),
        ("update_receipt_draft", by_name("update_receipt_draft")["inputSchema"]["properties"]["set"]["properties"]["label_colors"].clone()),
    ] {
        assert!(node.is_object(), "{tool}: label_colors missing from schema");
        let colors: Vec<&str> = node["items"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(colors, ["red", "yellow", "green", "blue", "purple"], "{tool}");
        assert_eq!(node["uniqueItems"], json!(true), "{tool}");
    }

    // give red a title so the joined view can be asserted
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = ? AND color = 'red'")
        .bind(s.owner)
        .execute(&s.pool)
        .await
        .unwrap();

    // intake: duplicates are dropped and the palette order is restored; the
    // view joins the ledger's titles in the same order
    let r = call(
        &s.router,
        &token,
        2,
        "create_receipt_draft",
        manual(json!(["blue", "red", "blue"])),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    let d = &r["structuredContent"]["draft"];
    assert_eq!(
        d["payload"]["label_colors"],
        json!(["red", "blue"]),
        "stored payload is the normalized form"
    );
    assert_eq!(
        labels_of(d),
        json!([
            {"color": "red", "title": "旅行"},
            {"color": "blue", "title": null}
        ]),
        "DraftView.labels joins ledger_labels titles in palette order"
    );

    // unknown color: an input validation error, no draft row
    let before = draft_count(&s.pool).await;
    let r = call(
        &s.router,
        &token,
        3,
        "create_receipt_draft",
        manual(json!(["red", "orange"])),
    )
    .await;
    assert!(is_error(&r), "{r}");
    assert!(text_of(&r).contains("label_colors") || text_of(&r).contains("orange"));
    assert_eq!(draft_count(&s.pool).await, before);

    // #20: the same element-level rule — the bad element is rejected, the
    // good one is saved (no new rejection conditions appear)
    let ok_entry =
        json!({"input_kind": "manual", "payload": payload("イオンB", "2026-10-02", 100)});
    let mut bad = ok_entry.clone();
    bad["payload"]["label_colors"] = json!(["orange"]);
    let r = call(
        &s.router,
        &token,
        4,
        "create_receipt_drafts",
        json!({"drafts": [manual(json!(["green"])), bad, ok_entry]}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    let sc = &r["structuredContent"];
    assert_eq!(sc["drafts"].as_array().unwrap().len(), 2);
    assert_eq!(
        sc["rejected"][0]["entry_index"], 1,
        "only the unknown-color element is rejected"
    );
    assert_eq!(
        sc["drafts"][0]["payload"]["label_colors"],
        json!(["green"]),
        "#20 stores label_colors the same way"
    );
    assert_eq!(
        sc["drafts"][0]["labels"],
        json!([{"color": "green", "title": null}])
    );

    // the drafts list rows stay label-free (labels live on the detail view)
    let r = call(&s.router, &token, 5, "get_receipt_drafts", json!({})).await;
    assert!(!is_error(&r), "{r}");
    let rows = r["structuredContent"]["drafts"].as_array().unwrap();
    assert!(!rows.is_empty());
    for row in rows {
        assert!(
            row.get("labels").is_none(),
            "list rows carry no labels: {row}"
        );
    }
}

// [covers:mcp-tools.draft-labels-approve-carry]
#[tokio::test]
async fn labels_carry_over_to_the_receipt() {
    let s = setup().await;
    let token = s.token().await;

    // approve: the draft's labels become receipt_labels in the same tx
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_draft",
        manual(json!(["red", "blue"])),
    )
    .await;
    let d = &r["structuredContent"]["draft"];
    let draft_id = d["draft_id"].as_i64().unwrap();
    let rev = d["revision"].as_i64().unwrap();
    let r = call(
        &s.router,
        &token,
        2,
        "approve_receipt_draft",
        json!({"draft_id": draft_id, "revision": rev}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    let receipt_id = r["structuredContent"]["receipt_id"].as_i64().unwrap();
    assert_eq!(
        receipt_colors(&s.pool, receipt_id).await,
        vec!["blue".to_string(), "red".to_string()],
        "both colors carried over"
    );
    // no receipt/label audit rows: the approval audit (after_json=payload_json)
    // is the sole record of the creation-time assignment
    let label_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'receipt' AND action = 'label'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(label_audits, 0);
    let approve_audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'draft' AND action = 'approve' AND entity_id = ?",
    )
    .bind(draft_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(approve_audits, 1);

    // idempotent re-approval: same receipt, labels unchanged
    let r = call(
        &s.router,
        &token,
        3,
        "approve_receipt_draft",
        json!({"draft_id": draft_id, "revision": rev}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    assert_eq!(
        r["structuredContent"]["receipt_id"].as_i64().unwrap(),
        receipt_id
    );
    assert_eq!(
        receipt_colors(&s.pool, receipt_id).await,
        vec!["blue".to_string(), "red".to_string()]
    );

    // get_receipt shows the carried labels; label_receipts keeps working on
    // top of them (diff semantics unchanged)
    let r = call(
        &s.router,
        &token,
        4,
        "get_receipt",
        json!({"receipt_id": receipt_id}),
    )
    .await;
    let labels = r["structuredContent"]["receipt"]["labels"].clone();
    let mut got: Vec<&str> = labels
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    got.sort();
    assert_eq!(got, ["blue", "red"]);
    // TASK-80: the success text of get_receipt carries the web URL line
    // [covers:mcp-tools.receipt-web-url-line]
    assert!(
        text_of(&r).contains(&format!(
            "webで見る: http://localhost:40281/receipts/{receipt_id}"
        )),
        "{}",
        text_of(&r)
    );

    // set.label_colors then approve: the amended set is what carries over
    let r = call(
        &s.router,
        &token,
        5,
        "create_receipt_draft",
        manual(json!(["red"])),
    )
    .await;
    let d = &r["structuredContent"]["draft"];
    let draft2 = d["draft_id"].as_i64().unwrap();
    let r = call(
        &s.router,
        &token,
        6,
        "update_receipt_draft",
        json!({"draft_id": draft2, "set": {"label_colors": ["green"]}}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    assert_eq!(
        r["structuredContent"]["draft"]["labels"],
        json!([{"color": "green", "title": null}])
    );
    let rev2 = r["structuredContent"]["draft"]["revision"]
        .as_i64()
        .unwrap();
    let r = call(
        &s.router,
        &token,
        7,
        "approve_receipt_draft",
        json!({"draft_id": draft2, "revision": rev2}),
    )
    .await;
    let receipt2 = r["structuredContent"]["receipt_id"].as_i64().unwrap();
    assert_eq!(
        receipt_colors(&s.pool, receipt2).await,
        vec!["green".to_string()],
        "the amended label set carries over"
    );

    // set null clears the draft's labels; the receipt gets none
    let r = call(
        &s.router,
        &token,
        8,
        "create_receipt_draft",
        manual(json!(["yellow"])),
    )
    .await;
    let d = &r["structuredContent"]["draft"];
    let draft3 = d["draft_id"].as_i64().unwrap();
    let r = call(
        &s.router,
        &token,
        9,
        "update_receipt_draft",
        json!({"draft_id": draft3, "set": {"label_colors": null}}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    assert_eq!(r["structuredContent"]["draft"]["labels"], json!([]));
    let rev3 = r["structuredContent"]["draft"]["revision"]
        .as_i64()
        .unwrap();
    let r = call(
        &s.router,
        &token,
        10,
        "approve_receipt_draft",
        json!({"draft_id": draft3, "revision": rev3}),
    )
    .await;
    let receipt3 = r["structuredContent"]["receipt_id"].as_i64().unwrap();
    assert!(receipt_colors(&s.pool, receipt3).await.is_empty());

    // reopen: the payload copy keeps label_colors on the new draft
    let r = call(
        &s.router,
        &token,
        11,
        "create_receipt_draft",
        manual(json!(["purple"])),
    )
    .await;
    let draft4 = r["structuredContent"]["draft"]["draft_id"]
        .as_i64()
        .unwrap();
    let r = call(
        &s.router,
        &token,
        12,
        "discard_receipt_draft",
        json!({"draft_id": draft4}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    let r = call(
        &s.router,
        &token,
        13,
        "reopen_receipt_draft",
        json!({"draft_id": draft4}),
    )
    .await;
    assert!(!is_error(&r), "{r}");
    let reopened = &r["structuredContent"]["draft"];
    assert_eq!(
        reopened["payload"]["label_colors"],
        json!(["purple"]),
        "reopen copies label_colors with the payload"
    );
    assert_eq!(
        labels_of(reopened),
        json!([{"color": "purple", "title": null}])
    );
}
