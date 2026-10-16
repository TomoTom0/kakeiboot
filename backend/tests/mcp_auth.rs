//! TASK-10 Phase B: the MCP resource server (spec_auth.md sections 5-1, 5-3,
//! 6, 7-4, 11-6) — Bearer validation responses, AuthContext delivery to the
//! tool handler, subject hash recording, last_used updates and the connected
//! apps / ledger switching APIs.

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{self, body_json, put_json};
use serde_json::json;

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

fn rpc(id: i64, method: &str, params: serde_json::Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

async fn post_mcp(
    router: &axum::Router,
    token: &str,
    body: String,
) -> axum::http::Response<axum::body::Body> {
    let headers = mcp_headers(token);
    let mut builder = axum::http::Request::builder().method("POST").uri("/mcp");
    for (k, v) in &headers {
        builder = builder.header(*k, v.as_str());
    }
    use tower::ServiceExt as _;
    router
        .clone()
        .oneshot(builder.body(axum::body::Body::from(body)).unwrap())
        .await
        .unwrap()
}

async fn setup_with_grant() -> (
    axum::Router,
    sqlx::SqlitePool,
    oauth::MockIds,
    String, // access token
    i64,    // grant id
    i64,    // user id
) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, _cfg) = oauth::oauth_setup(&mock).await;
    let user = common::auth::create_user_direct(&pool, "Mcp User", None).await;
    let default_ledger: Option<i64> =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    let grant = oauth::insert_grant(
        &pool,
        user,
        &mock.client_id,
        "ledger.read ledger.write",
        default_ledger,
    )
    .await;
    let token = oauth::insert_access_token(&pool, grant).await;
    (router, pool, mock, token, grant, user)
}

// [covers:auth-mcp.no-token-401]
#[tokio::test]
async fn mcp_without_token_is_401_with_challenge() {
    let (router, _pool, _mock, _token, _grant, _user) = setup_with_grant().await;
    let body = rpc(
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        }),
    );
    // no Authorization
    let resp = oauth::post_form(&router, "/mcp", &body, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let challenge = resp
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .unwrap();
    assert!(challenge.starts_with("Bearer "), "{challenge}");
    assert!(
        challenge.contains(
            "resource_metadata=\"http://localhost:40281/.well-known/oauth-protected-resource/mcp\""
        ),
        "{challenge}"
    );
    assert!(
        challenge.contains("scope=\"ledger.read ledger.write\""),
        "{challenge}"
    );
    assert!(!challenge.contains("error="), "{challenge}");

    // query access_token is rejected the same way
    let resp = oauth::post_form(&router, "/mcp?access_token=whatever", &body, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // two Authorization headers
    let resp = oauth::post_form(
        &router,
        "/mcp",
        &body,
        &[
            ("authorization", "Bearer AAAA".into()),
            ("authorization", "Bearer BBBB".into()),
        ],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// [covers:auth-mcp.invalid-token-401]
#[tokio::test]
async fn invalid_tokens_get_invalid_token_challenge() {
    let (router, pool, mock, token, grant, user) = setup_with_grant().await;
    let body = rpc(
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        }),
    );
    let check = |resp: axum::http::Response<axum::body::Body>| {
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let challenge = resp
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
            .unwrap();
        assert!(challenge.contains("error=\"invalid_token\""), "{challenge}");
        assert!(challenge.contains("resource_metadata"), "{challenge}");
    };
    // unknown token
    check(
        oauth::post_form(
            &router,
            "/mcp",
            &body,
            &[("authorization", "Bearer AAAAAAAA".into())],
        )
        .await,
    );
    // wrong-length / non-b64 token
    check(
        oauth::post_form(
            &router,
            "/mcp",
            &body,
            &[("authorization", "Bearer !!!".into())],
        )
        .await,
    );
    // expired token
    sqlx::query("UPDATE oauth_access_tokens SET expires_at = 1 WHERE token_hash = ?")
        .bind(oauth::token_hash(&token))
        .execute(&pool)
        .await
        .unwrap();
    check(post_mcp(&router, &token, body.clone()).await);
    sqlx::query("UPDATE oauth_access_tokens SET expires_at = ? WHERE token_hash = ?")
        .bind(budget_book::auth::session::now_ms() + 3_600_000)
        .bind(oauth::token_hash(&token))
        .execute(&pool)
        .await
        .unwrap();
    // revoked grant
    sqlx::query("UPDATE oauth_grants SET revoked_at = 1, revoked_reason = 'admin' WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    check(post_mcp(&router, &token, body.clone()).await);
    sqlx::query("UPDATE oauth_grants SET revoked_at = NULL, revoked_reason = NULL WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    // resource mismatch (foreign resource on the grant)
    sqlx::query("UPDATE oauth_grants SET resource = 'http://localhost:40281/other' WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    check(post_mcp(&router, &token, body.clone()).await);
    sqlx::query("UPDATE oauth_grants SET resource = 'http://localhost:40281/mcp' WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    // disabled user
    sqlx::query("UPDATE users SET disabled_at = 1 WHERE id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    check(post_mcp(&router, &token, body.clone()).await);
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let _ = mock;
}

// [covers:auth-mcp.authcontext-reaches-tool]
#[tokio::test]
async fn auth_context_reaches_the_tool_handler() {
    let (router, pool, mock, token, grant, user) = setup_with_grant().await;
    let default_ledger: Option<i64> =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();

    // initialize -> tools/list -> tools/call ping (stateless, one POST each)
    let init = rpc(
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        }),
    );
    let resp = post_mcp(&router, &token, init).await;
    assert_eq!(resp.status(), 200, "initialize with a valid token");

    let list = rpc(2, "tools/list", json!({}));
    let resp = post_mcp(&router, &token, list).await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let names: Vec<&str> = body["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["name"].as_str())
        .collect();
    assert!(names.contains(&"ping"), "{names:?}");

    let call = rpc(3, "tools/call", json!({"name": "ping", "arguments": {}}));
    let resp = post_mcp(&router, &token, call).await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.starts_with("pong"), "{text}");
    assert!(text.contains(&format!("user_id={user}")), "{text}");
    assert!(
        text.contains(&format!("(id={})", default_ledger.unwrap())),
        "{text}"
    );
    let _ = (grant, mock);
}

// [covers:auth-mcp.ledger-none-passes]
#[tokio::test]
async fn unselected_ledger_passes_with_none() {
    let (router, pool, _mock, token, grant, user) = setup_with_grant().await;
    // unselected
    sqlx::query("UPDATE oauth_grants SET active_ledger_id = NULL WHERE id = ?")
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    let call = rpc(1, "tools/call", json!({"name": "ping", "arguments": {}}));
    let resp = post_mcp(&router, &token, call).await;
    assert_eq!(resp.status(), 200, "ledger None is not an HTTP error");
    let body = body_json(resp).await;
    let text = body["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("ledger=none"), "{text}");

    // out-of-membership selection also resolves to None (trigger clears it,
    // emulate by re-adding the FK-less state: set active to a ledger then
    // remove the membership — the DB trigger resets it, so assert that)
    let ledger2: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('L2', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)")
        .bind(ledger2)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE oauth_grants SET active_ledger_id = ? WHERE id = ?")
        .bind(ledger2)
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
        .bind(ledger2)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, None, "membership removal resets the selection");
}

// [covers:auth-mcp.last-used-update]
#[tokio::test]
async fn last_used_updates_at_five_minute_intervals() {
    let (router, pool, _mock, token, grant, _user) = setup_with_grant().await;
    let call = rpc(1, "tools/call", json!({"name": "ping", "arguments": {}}));
    post_mcp(&router, &token, call.clone()).await;
    let first: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(first.is_some(), "first call sets last_used_at");

    // second call within the interval does not bump it
    post_mcp(&router, &token, call.clone()).await;
    let second: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(first, second, "throttled to 5 minutes");

    // after the interval it updates
    let later = budget_book::auth::session::now_ms() - 6 * 60_000;
    sqlx::query("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?")
        .bind(later)
        .bind(grant)
        .execute(&pool)
        .await
        .unwrap();
    post_mcp(&router, &token, call).await;
    let third: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(third.unwrap() > later, "updated after the interval");
}

// [covers:auth-mcp.subject-hash-recording]
#[tokio::test]
async fn subject_hash_recorded_from_call_meta() {
    let (router, pool, _mock, token, _grant, user) = setup_with_grant().await;
    // the MCP protocol puts request metadata in params._meta
    let mut call = serde_json::from_str::<serde_json::Value>(&rpc(
        1,
        "tools/call",
        json!({"name": "ping", "arguments": {}}),
    ))
    .unwrap();
    call["params"]["_meta"] = json!({"openai/subject": "subject-abc-123"});
    post_mcp(&router, &token, call.to_string()).await;
    // expected v1 hash
    let expected = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(b"budget-book/openai-subject/v1:subject-abc-123");
        h.finalize().to_vec()
    };
    let row: Option<(i64, i64, String)> = sqlx::query_as(
        "SELECT user_id, first_seen_at, issuer FROM user_subject_hashes WHERE subject_hash = ?",
    )
    .bind(&expected)
    .fetch_optional(&pool)
    .await
    .unwrap();
    let (uid, first_seen, issuer) = row.expect("subject hash row");
    assert_eq!(uid, user);
    assert_eq!(issuer, "openai");
    let _ = first_seen;

    // second call within an hour: last_seen_at unchanged
    post_mcp(&router, &token, call.to_string()).await;
    let seen: (i64, i64) = sqlx::query_as(
        "SELECT first_seen_at, last_seen_at FROM user_subject_hashes WHERE subject_hash = ?",
    )
    .bind(&expected)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(seen.0, seen.1, "last_seen_at throttled to 1 hour");
}

// ---------------------------------------------------------------------------
// ledger service + connected apps API

async fn add_membership(pool: &sqlx::SqlitePool, user: i64, name: &str, role: &str) -> i64 {
    let ledger: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES (?, 0, 0) RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, ?, 0)",
    )
    .bind(ledger)
    .bind(user)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
    ledger
}

// [covers:auth-ledger.list-ledgers]
// [covers:auth-ledger.whoami-view]
#[tokio::test]
async fn list_ledgers_and_whoami_views() {
    let pool = common::mem_pool().await;
    let user = common::auth::create_user_direct(&pool, "Ledger User", None).await;
    let l2 = add_membership(&pool, user, "Shared", "viewer").await;
    let default_ledger: Option<i64> =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();

    // service layer directly (the MCP tool wiring arrives in TASK-11)
    let views = {
        let mut conn = pool.acquire().await.unwrap();
        budget_book::auth::ledger::list_ledgers(&mut conn, user, Some(l2))
            .await
            .unwrap()
    };
    assert_eq!(views.len(), 2);
    let active: Vec<_> = views.iter().filter(|v| v.is_active).collect();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].ledger_id, l2);
    assert_eq!(
        active[0].role,
        budget_book::auth::ledger::LedgerRole::Viewer
    );
    let personal = views
        .iter()
        .find(|v| Some(v.ledger_id) == default_ledger)
        .unwrap();
    assert_eq!(personal.role, budget_book::auth::ledger::LedgerRole::Owner);
    assert!(!personal.is_active);

    // null selection: nothing flagged active
    {
        let mut conn = pool.acquire().await.unwrap();
        let views = budget_book::auth::ledger::list_ledgers(&mut conn, user, None)
            .await
            .unwrap();
        assert!(views.iter().all(|v| !v.is_active));
    }

    // whoami with and without an active ledger
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    {
        let mut conn = pool.acquire().await.unwrap();
        let view = budget_book::auth::ledger::whoami(
            &mut conn,
            user,
            Some((
                l2,
                "Shared".into(),
                budget_book::auth::ledger::LedgerRole::Viewer,
            )),
        )
        .await
        .unwrap();
        assert_eq!(view.account_number, account);
        assert_eq!(view.display_name, "Ledger User");
        assert_eq!(view.active_ledger.as_ref().unwrap().0, l2);
        let view = budget_book::auth::ledger::whoami(&mut conn, user, None)
            .await
            .unwrap();
        assert!(view.active_ledger.is_none());
    }
}

// [covers:auth-ledger.switch-ledger-tx]
#[tokio::test]
async fn switch_ledger_membership_checked() {
    let pool = common::mem_pool().await;
    let user = common::auth::create_user_direct(&pool, "Switch User", None).await;
    let l2 = add_membership(&pool, user, "Target", "editor").await;
    let client_id = "https://chatgpt.com/clients/x";
    let grant = oauth::insert_grant(&pool, user, client_id, "ledger.read", None).await;

    let out = budget_book::auth::ledger::switch_ledger(
        &pool,
        grant,
        user,
        l2,
        "mcp",
        Some(client_id),
        1000,
    )
    .await
    .expect("switch succeeds");
    assert_eq!(out.ledger_id, l2);
    assert_eq!(out.role, budget_book::auth::ledger::LedgerRole::Editor);
    assert!(out.previous_ledger_id.is_none());
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, Some(l2));
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'oauth_grant' AND action = 'switch_ledger' AND entity_id = ? AND actor_kind = 'mcp'",
    )
    .bind(grant)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit > 0, "switch audit recorded");

    // non-member and nonexistent ledger are the same error
    let other = common::auth::create_user_direct(&pool, "Other", None).await;
    let err =
        budget_book::auth::ledger::switch_ledger(&pool, grant, other, l2, "mcp", None, 2000).await;
    assert!(matches!(
        err,
        Err(budget_book::auth::ledger::SwitchError::GrantNotFound)
    ));
    let err =
        budget_book::auth::ledger::switch_ledger(&pool, grant, user, 9999, "mcp", None, 3000).await;
    assert!(matches!(
        err,
        Err(budget_book::auth::ledger::SwitchError::NotSelectable)
    ));
    let err =
        budget_book::auth::ledger::switch_ledger(&pool, grant, other, 9999, "mcp", None, 3000)
            .await;
    assert!(
        matches!(
            err,
            Err(budget_book::auth::ledger::SwitchError::GrantNotFound)
        ),
        "grant ownership is checked before the ledger"
    );
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, Some(l2), "failed switches leave the state intact");
}

// [covers:auth-ledger.grants-api]
// [covers:auth-ledger.switch-api]
#[tokio::test]
async fn grants_web_api_list_revoke_switch() {
    let mock = oauth::spawn_mock().await;
    let (router, pool, _cfg) = oauth::oauth_setup(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Apps User").await;
    let user: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name = 'Apps User'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let l2 = add_membership(&pool, user, "Shared", "editor").await;
    let grant1 = oauth::insert_grant(
        &pool,
        user,
        &mock.client_id,
        "ledger.read ledger.write",
        None,
    )
    .await;
    let grant2 = oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/y",
        "ledger.read",
        Some(l2),
    )
    .await;

    // list shows both with the active ledger name
    let resp = client.get(&router, "/api/oauth/grants").await;
    assert_eq!(resp.status(), 200);
    let list = body_json(resp).await;
    let arr = list.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    let g2 = arr
        .iter()
        .find(|g| g["id"].as_i64() == Some(grant2))
        .expect("grant2 listed");
    assert_eq!(g2["active_ledger_name"], "Shared");
    assert_eq!(g2["scope"], "ledger.read");

    // switch via the API
    let resp = put_json(
        &router,
        &format!("/api/oauth/grants/{grant1}/active-ledger"),
        json!({ "ledger_id": l2 }),
        &[("origin", "http://localhost:40281".into())],
    )
    .await;
    // no session on this raw request -> 401; use the cookie client instead
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // switch with the session
    let resp = client
        .put(
            &router,
            &format!("/api/oauth/grants/{grant1}/active-ledger"),
            json!({ "ledger_id": l2 }),
        )
        .await;
    assert_eq!(resp.status(), 200, "switch via session");
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(grant1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, Some(l2));

    // non-member ledger -> 409
    let resp = client
        .put(
            &router,
            &format!("/api/oauth/grants/{grant1}/active-ledger"),
            json!({ "ledger_id": 99999 }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);

    // another user's grant -> 404
    let mut other = Client::new();
    auth::register_setup_user(&mut other, &router, &pool, "Apps Other").await;
    let resp = other
        .put(
            &router,
            &format!("/api/oauth/grants/{grant1}/active-ledger"),
            json!({ "ledger_id": l2 }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let resp = other
        .delete(&router, &format!("/api/oauth/grants/{grant1}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // revoke grant1: tokens die and it leaves the list
    let access = oauth::insert_access_token(&pool, grant1).await;
    let resp = client
        .delete(&router, &format!("/api/oauth/grants/{grant1}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let reason: Option<String> =
        sqlx::query_scalar("SELECT revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(grant1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("user"));
    let resp = oauth::post_form(
        &router,
        "/mcp",
        "{}",
        &[("authorization", format!("Bearer {access}"))],
    )
    .await;
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "revoked grant kills tokens"
    );
    let resp = client.get(&router, "/api/oauth/grants").await;
    let list = body_json(resp).await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    let _ = grant2;
}
