//! /mcp connectivity over the real TCP server (spec_auth.md section 5-1):
//! every request carries a valid Bearer token now that the auth middleware
//! guards the endpoint.

mod common;

use serde_json::{Value, json};

const PROTOCOL_VERSION: &str = "2025-06-18";

async fn post(client: &reqwest::Client, url: &str, body: Value, token: &str) -> reqwest::Response {
    client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", PROTOCOL_VERSION)
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .unwrap()
}

// [covers:auth-mcp.authcontext-reaches-tool]
#[tokio::test]
async fn mcp_initialize_list_and_call_ping() {
    let (addr, cfg, ct, pool) = common::spawn_app_with_pool().await;
    let url = format!("http://{addr}{}", cfg.app.mcp.path);
    let client = reqwest::Client::new();

    // provision a grant + access token directly
    let user = common::auth::create_user_direct(&pool, "Ping User", None).await;
    let grant = common::oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/x",
        "ledger.read ledger.write",
        None,
    )
    .await;
    let token = common::oauth::insert_access_token(&pool, grant).await;

    let init = post(
        &client,
        &url,
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name":"test","version":"0"}
        }}),
        &token,
    )
    .await;
    assert_eq!(init.status(), 200);
    let init: Value = init.json().await.unwrap();
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "{init}"
    );

    let list: Value = post(
        &client,
        &url,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}),
        &token,
    )
    .await
    .json()
    .await
    .unwrap();
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"ping"), "{list}");

    let call: Value = post(
        &client,
        &url,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{}}}),
        &token,
    )
    .await
    .json()
    .await
    .unwrap();
    let text = call["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("pong"), "{call}");
    assert!(text.contains(&format!("user_id={user}")), "{call}");
    assert_ne!(call["result"]["isError"], true);

    ct.cancel();
}

// [covers:auth-mcp.no-token-401]
#[tokio::test]
async fn mcp_without_bearer_is_401() {
    let (addr, cfg, ct) = common::spawn_app().await;
    let url = format!("http://{addr}{}", cfg.app.mcp.path);
    let res = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("MCP-Protocol-Version", PROTOCOL_VERSION)
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    assert!(
        res.headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("resource_metadata"))
    );
    ct.cancel();
}

// [covers:auth-mcp.invalid-token-401]
#[tokio::test]
async fn mcp_with_unknown_token_is_401() {
    let (addr, cfg, ct) = common::spawn_app().await;
    let url = format!("http://{addr}{}", cfg.app.mcp.path);
    let res = reqwest::Client::new()
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    assert!(
        res.headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|c| c.contains("invalid_token"))
    );
    ct.cancel();
}

// [covers:auth-mcp.invalid-token-401]
#[tokio::test]
async fn mcp_rejects_disallowed_host() {
    let (addr, cfg, ct, pool) = common::spawn_app_with_pool().await;
    let url = format!("http://{addr}{}", cfg.app.mcp.path);
    let user = common::auth::create_user_direct(&pool, "Host User", None).await;
    let grant = common::oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/x",
        "ledger.read",
        None,
    )
    .await;
    let token = common::oauth::insert_access_token(&pool, grant).await;
    let res = reqwest::Client::new()
        .post(&url)
        .header("Host", "evil.example.com")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream")
        .header("Authorization", format!("Bearer {token}"))
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#)
        .send()
        .await
        .unwrap();
    assert!(res.status().is_client_error(), "status {}", res.status());
    ct.cancel();
}
