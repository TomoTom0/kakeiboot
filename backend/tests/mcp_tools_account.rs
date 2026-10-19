//! TASK-11: the account tools (#15-#17), the widget image refresher (W1) and
//! the service mounting of the 18 registry tools — all through the real
//! Streamable HTTP `/mcp` route with a Bearer token, so the ToolRouter
//! wiring is covered too (spec_mcp-tools.md 2, 7-16 .. 7-18, 7-20, 11-1).

mod common;

use common::oauth;
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

async fn post_mcp(router: &axum::Router, token: &str, body: String) -> Value {
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
    serde_json::from_slice(&bytes).unwrap()
}

/// A JSON-RPC response body -> result field (asserts no protocol error).
fn result_of(v: &Value) -> &Value {
    assert!(v.get("error").is_none(), "protocol error: {v}");
    &v["result"]
}

async fn setup_with_ledger() -> (axum::Router, sqlx::SqlitePool, String, i64, i64, i64) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, _cfg) = oauth::oauth_setup(&mock).await;
    let user = common::auth::create_user_direct(&pool, "Tool User", None).await;
    // create_user_direct makes the user's own ledger (owner); add a second
    // one as viewer so role variety exists
    let active: i64 =
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
        Some(active),
    )
    .await;
    let token = oauth::insert_access_token(&pool, grant).await;
    (router, pool, token, grant, user, active)
}

// [covers:mcp-tools.mounting]
#[tokio::test]
async fn tools_list_mounts_registry_tools_and_ping() {
    let (router, _pool, token, _grant, _user, _active) = setup_with_ledger().await;
    let v = post_mcp(&router, &token, rpc(1, "tools/list", json!({}))).await;
    let tools = result_of(&v)["tools"].as_array().cloned().unwrap();
    let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    names.sort_unstable();
    let mut expected: Vec<&str> = [
        "ping",
        "create_receipt_draft",
        "update_receipt_draft",
        "approve_receipt_draft",
        "discard_receipt_draft",
        "reopen_receipt_draft",
        "get_receipt_drafts",
        "search_receipts",
        "get_receipt",
        "update_receipt",
        "delete_receipt",
        "get_catalog",
        "manage_category",
        "manage_store",
        "summarize_spending",
        "whoami",
        "list_ledgers",
        "switch_ledger",
        "rename_ledger",
        "label_receipts",
        "create_receipt_drafts",
        "approve_receipt_drafts",
        "refresh_widget_images",
    ]
    .to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected, "22 model tools + W1 + ping");
    // a widget-rendering tool carries the paired uri/_meta keys (spec 2-1)
    let summarize = tools
        .iter()
        .find(|t| t["name"] == "summarize_spending")
        .unwrap();
    assert_eq!(
        summarize["_meta"]["ui"]["resourceUri"],
        summarize["_meta"]["openai/outputTemplate"]
    );
    // the widget-only tool is app-visible
    let refresh = tools
        .iter()
        .find(|t| t["name"] == "refresh_widget_images")
        .unwrap();
    assert_eq!(refresh["_meta"]["ui"]["visibility"], json!(["app"]));
}

// [covers:mcp-tools.widget-resource]
#[tokio::test]
async fn widget_resource_list_and_read() {
    let (router, _pool, token, _grant, _user, _active) = setup_with_ledger().await;
    let list = post_mcp(&router, &token, rpc(1, "resources/list", json!({}))).await;
    let resources = result_of(&list)["resources"].as_array().cloned().unwrap();
    assert_eq!(resources.len(), 1, "one widget template");
    let uri = resources[0]["uri"].as_str().unwrap().to_string();
    assert!(uri.starts_with("ui://budget-book/widget-"), "{uri}");
    assert_eq!(resources[0]["mimeType"], "text/html;profile=mcp-app");
    let read = post_mcp(
        &router,
        &token,
        rpc(2, "resources/read", json!({ "uri": uri })),
    )
    .await;
    let contents = result_of(&read)["contents"].as_array().cloned().unwrap();
    assert_eq!(contents.len(), 1);
    assert!(contents[0]["text"].as_str().unwrap().contains("<"));
    // an unknown URI is an error, not the template
    let bad = post_mcp(
        &router,
        &token,
        rpc(
            3,
            "resources/read",
            json!({ "uri": "ui://budget-book/other.html" }),
        ),
    )
    .await;
    assert!(bad.get("error").is_some(), "unknown resource rejected");
}

// [covers:mcp-tools.whoami-envelope]
#[tokio::test]
async fn whoami_returns_account_and_active_ledger() {
    let (router, _pool, token, _grant, user, active) = setup_with_ledger().await;
    let v = post_mcp(
        &router,
        &token,
        rpc(1, "tools/call", json!({"name": "whoami", "arguments": {}})),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "account");
    assert!(sc["ledger"].is_null(), "whoami envelope ledger is null");
    let expect_number: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&_pool)
        .await
        .unwrap();
    assert_eq!(sc["account_number"], json!(expect_number));
    assert_eq!(sc["active_ledger"]["id"], json!(active));
    // the text names the active ledger so the model can repeat it
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("アカウント番号"), "{text}");
}

// [covers:mcp-tools.list-ledgers-handler]
#[tokio::test]
async fn list_ledgers_marks_the_active_one() {
    let (router, _pool, token, _grant, _user, active) = setup_with_ledger().await;
    let v = post_mcp(
        &router,
        &token,
        rpc(
            1,
            "tools/call",
            json!({"name": "list_ledgers", "arguments": {}}),
        ),
    )
    .await;
    let sc = &result_of(&v)["structuredContent"];
    assert_eq!(sc["view"], "ledgers");
    assert!(sc["ledger"].is_null());
    assert_eq!(sc["active_ledger_id"], json!(active));
    let ledgers = sc["ledgers"].as_array().unwrap();
    assert_eq!(ledgers.len(), 2);
    let actives: Vec<&Value> = ledgers.iter().filter(|l| l["is_active"] == true).collect();
    assert_eq!(actives.len(), 1, "exactly one active");
    // roles come through as strings
    let roles: Vec<&str> = ledgers.iter().filter_map(|l| l["role"].as_str()).collect();
    assert!(roles.contains(&"owner") && roles.contains(&"viewer"));
}

// [covers:mcp-tools.switch-ledger-handler]
#[tokio::test]
async fn switch_ledger_updates_grant_and_reports_previous() {
    let (router, pool, token, grant, _user, active) = setup_with_ledger().await;
    // the viewer-side ledger is the switch target
    let target: i64 = sqlx::query_scalar(
        "SELECT l.id FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = (SELECT user_id FROM oauth_grants WHERE id = ?) AND m.role = 'viewer'",
    )
    .bind(grant)
    .fetch_one(&pool)
    .await
    .unwrap();
    let v = post_mcp(
        &router,
        &token,
        rpc(
            1,
            "tools/call",
            json!({"name": "switch_ledger", "arguments": { "ledger_id": target }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "ledger_switched");
    assert_eq!(sc["ledger"]["id"], json!(target));
    assert_eq!(sc["previous"]["id"], json!(active));
    let db_active: i64 =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(db_active, target, "the grant's active ledger moved");
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'oauth_grant' AND entity_id = ? AND action = 'switch_ledger'",
    )
    .bind(grant)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1, "one audit row for the switch");

    // a non-member ledger id: same error as a nonexistent one (spec 7-18)
    let bad = post_mcp(
        &router,
        &token,
        rpc(
            2,
            "tools/call",
            json!({"name": "switch_ledger", "arguments": { "ledger_id": 999 }}),
        ),
    )
    .await;
    let r = result_of(&bad);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .starts_with("見つかりません"),
        "member and nonexistent ids are indistinguishable"
    );
}

// [covers:mcp-tools.refresh-widget-images]
#[tokio::test]
async fn refresh_widget_images_issues_urls_and_nulls_foreign_refs() {
    let (router, pool, token, grant, user, _active) = setup_with_ledger().await;
    // a pending draft of this user with an image, on the active ledger
    // (the schema CHECK ties image_status='attached' to image_id NOT NULL,
    // so both are set together)
    let active: i64 = sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
        .bind(grant)
        .fetch_one(&pool)
        .await
        .unwrap();
    let draft = common::insert_draft_min(&pool, active, user, "none", None).await;
    common::insert_image(&pool, 10, active).await;
    sqlx::query("UPDATE drafts SET image_status = 'attached', image_id = 10 WHERE id = ?")
        .bind(draft)
        .execute(&pool)
        .await
        .unwrap();
    // a receipt of a ledger this user belongs to, with an image
    common::insert_receipt(&pool, 20, active).await;
    sqlx::query("UPDATE receipts SET image_id = 10 WHERE id = 20")
        .execute(&pool)
        .await
        .unwrap();
    // a foreign pending draft (another user)
    common::insert_user(&pool, 77).await;
    let foreign = common::insert_draft_min(&pool, active, 77, "none", None).await;
    sqlx::query("UPDATE drafts SET image_status = 'attached', image_id = 10 WHERE id = ?")
        .bind(foreign)
        .execute(&pool)
        .await
        .unwrap();

    let v = post_mcp(
        &router,
        &token,
        rpc(
            1,
            "tools/call",
            json!({"name": "refresh_widget_images", "arguments": { "refs": [
                { "kind": "draft", "id": draft },
                { "kind": "receipt", "id": 20 },
                { "kind": "draft", "id": foreign },
                { "kind": "receipt", "id": 999 },
            ]}}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "images");
    assert!(sc["ledger"].is_null());
    let images = &r["_meta"]["images"];
    assert!(
        images[&format!("draft:{draft}")]["url"].is_string(),
        "own draft"
    );
    assert!(images["receipt:20"]["url"].is_string(), "member receipt");
    assert!(
        images[&format!("draft:{foreign}")].is_null(),
        "foreign draft"
    );
    assert!(images["receipt:999"].is_null(), "nonexistent receipt");

    // over the ref limit: input error, not an internal one
    let refs: Vec<Value> = (0..21)
        .map(|i| json!({ "kind": "receipt", "id": i }))
        .collect();
    let over = post_mcp(
        &router,
        &token,
        rpc(
            2,
            "tools/call",
            json!({"name": "refresh_widget_images", "arguments": { "refs": refs }}),
        ),
    )
    .await;
    let r = result_of(&over);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"].as_str().unwrap().contains("refs"),
        "input validation error names the field"
    );
}

// [covers:mcp-tools.subject-hash-on-tool-failure]
#[tokio::test]
async fn subject_hash_recorded_even_when_the_tool_fails() {
    let (router, pool, token, _grant, user, active) = setup_with_ledger().await;
    // get_receipt on a nonexistent id is a tool error (isError), not a
    // protocol error — the recording must still happen (spec_auth.md 7-4)
    let mut call = serde_json::from_str::<Value>(&rpc(
        1,
        "tools/call",
        json!({"name": "get_receipt", "arguments": { "receipt_id": 999999, "ledger_id": active }}),
    ))
    .unwrap();
    call["params"]["_meta"] = json!({"openai/subject": "failing-subject-1"});
    let v = post_mcp(&router, &token, call.to_string()).await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(true), "the tool failed as arranged");
    let expected = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(b"budget-book/openai-subject/v1:failing-subject-1");
        h.finalize().to_vec()
    };
    let recorded: Option<i64> =
        sqlx::query_scalar("SELECT user_id FROM user_subject_hashes WHERE subject_hash = ?")
            .bind(&expected)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert_eq!(recorded, Some(user), "hash recorded despite tool failure");
}

// [covers:mcp-tools.query-length]
#[tokio::test]
async fn search_receipts_query_length_is_input_error() {
    let (router, _pool, token, _grant, _user, _active) = setup_with_ledger().await;
    // TASK-73: an over-cap store / item_query (max_query_chars = 200) is a
    // whole-call input error whose message carries the limit so the model
    // can retry with a shorter query
    let over = "x".repeat(201);
    for args in [json!({ "item_query": over }), json!({ "store": over })] {
        let v = post_mcp(
            &router,
            &token,
            rpc(
                1,
                "tools/call",
                json!({"name": "search_receipts", "arguments": args}),
            ),
        )
        .await;
        let r = result_of(&v);
        assert_eq!(r["isError"], json!(true), "args: {args}");
        let text = r["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("200"), "the limit is in the message: {text}");
    }
}

// [covers:mcp-tools.ledger-rename]
#[tokio::test]
async fn rename_ledger_changes_name_and_validates_input() {
    let (router, pool, token, grant, user, active) = setup_with_ledger().await;
    // setup: the user owns the active ledger ("Tool Userの家計簿") and holds a
    // viewer membership on "viewer-side" — the rename target and the
    // within-user duplicate both come from there

    // success: the envelope ledger carries the NEW name with role and source,
    // before_name reports the old one, and the text names both
    let v = post_mcp(
        &router,
        &token,
        rpc(
            1,
            "tools/call",
            json!({"name": "rename_ledger", "arguments": { "name": "新しい名前" }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "ledger_renamed");
    assert_eq!(sc["ledger"]["id"], json!(active));
    assert_eq!(sc["ledger"]["name"], "新しい名前");
    assert_eq!(sc["ledger"]["source"], "active");
    assert_eq!(sc["ledger"]["role"], "owner");
    assert_eq!(sc["before_name"], "Tool Userの家計簿");
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("「Tool Userの家計簿」から「新しい名前」に変更しました"),
        "{text}"
    );
    let db_name: String = sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
        .bind(active)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(db_name, "新しい名前", "the row itself moved");

    // [covers:auth-ledger.rename-ledger] the same-name resend stays a success
    // (no-op)
    let v = post_mcp(
        &router,
        &token,
        rpc(
            2,
            "tools/call",
            json!({"name": "rename_ledger", "arguments": { "name": "新しい名前" }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let text = r["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("すでに"), "the no-op text says so: {text}");

    // [covers:auth-ledger.rename-ledger] the single recorded row is the mcp
    // actor carrying the grant's client_id; the resend added none
    let audit: (i64, String, Option<String>) = sqlx::query_as(
        "SELECT COUNT(*), actor_kind, client_id FROM audit_events
         WHERE entity_type = 'ledger' AND action = 'rename_ledger'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit.0, 1, "no-op resend adds no audit row");
    assert_eq!(audit.1, "mcp");
    let client_id: String = sqlx::query_scalar("SELECT client_id FROM oauth_grants WHERE id = ?")
        .bind(grant)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(audit.2.as_deref(), Some(client_id.as_str()));

    // name is required: a missing field is a parse-level input error
    let v = post_mcp(
        &router,
        &token,
        rpc(
            3,
            "tools/call",
            json!({"name": "rename_ledger", "arguments": { "ledger_id": active }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("入力エラー"),
        "parse-level invalid"
    );

    // trim-empty and over the cap: input errors whose message carries the
    // limit number (max_ledger_name_chars = 100)
    for name in ["   ".to_string(), "あ".repeat(101)] {
        let v = post_mcp(
            &router,
            &token,
            rpc(
                4,
                "tools/call",
                json!({"name": "rename_ledger", "arguments": { "name": name }}),
            ),
        )
        .await;
        let r = result_of(&v);
        assert_eq!(r["isError"], json!(true), "{name}");
        let text = r["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("家計簿名"), "{text}");
        assert!(text.contains("100"), "the limit is in the message: {text}");
    }

    // [covers:auth-ledger.rename-ledger] the user's own viewer-side membership
    // holds "viewer-side": renaming the active ledger onto it is an isError
    let v = post_mcp(
        &router,
        &token,
        rpc(
            5,
            "tools/call",
            json!({"name": "rename_ledger", "arguments": { "name": "viewer-side" }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("同じ名前の家計簿"),
        "the duplicate is refused"
    );

    // a viewer membership target: write refused
    let viewer_ledger: i64 = sqlx::query_scalar(
        "SELECT l.id FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? AND m.role = 'viewer'",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    let v = post_mcp(
        &router,
        &token,
        rpc(
            6,
            "tools/call",
            json!({"name": "rename_ledger",
                   "arguments": { "ledger_id": viewer_ledger, "name": "x" }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("閲覧のみ"),
        "viewer target is refused"
    );

    // an explicit ledger_id resolves as explicit (trimmed name applies)
    let v = post_mcp(
        &router,
        &token,
        rpc(
            7,
            "tools/call",
            json!({"name": "rename_ledger",
                   "arguments": { "ledger_id": active, "name": " 明示指定 " }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["ledger"]["source"], "explicit");
    assert_eq!(sc["ledger"]["name"], "明示指定");

    // no active ledger and no ledger_id: the pick-again error
    sqlx::query("UPDATE oauth_grants SET active_ledger_id = NULL WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    let v = post_mcp(
        &router,
        &token,
        rpc(
            8,
            "tools/call",
            json!({"name": "rename_ledger", "arguments": { "name": "まだある" }}),
        ),
    )
    .await;
    let r = result_of(&v);
    assert_eq!(r["isError"], json!(true));
    assert!(
        r["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("選び直してください"),
        "the pick-again guidance"
    );
}
