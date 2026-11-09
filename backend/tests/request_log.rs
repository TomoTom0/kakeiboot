//! Operational logging (TASK-15, spec_auth.md section 10-5): one
//! representative line per level is captured from the real router and
//! services — request INFO (query dropped, media token redacted), 5xx
//! ERROR, rate-limit WARN, login-failure WARN, tool-call INFO and the
//! cleanup-sweep INFO.

mod common;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use budget_book::app::{self, AppState};
use budget_book::db;
use budget_book::store;
use common::auth::Client;
use common::logcap::LogCapture;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn router(cfg: &budget_book::config::Config, pool: sqlx::SqlitePool) -> Router {
    app::router(
        cfg,
        AppState::new(cfg, pool).unwrap(),
        CancellationToken::new(),
    )
}

// ---------------------------------------------------------------------------
// INFO request log (method / path / status / latency; never the query)

#[tokio::test]
async fn request_logged_at_info_without_query() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    let router = router(&cfg, pool);
    let cap = LogCapture::new();
    let res = router
        .oneshot(
            Request::get("/healthz?access_token=secret-query-value")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains(" INFO ") && l.contains("request "))
        .expect("INFO request line");
    assert!(line.contains("method=GET"), "{line}");
    assert!(line.contains("path=/healthz"), "{line}");
    assert!(line.contains("status=200"), "{line}");
    assert!(line.contains("latency_ms="), "{line}");
    assert!(
        !out.contains("secret-query-value"),
        "query strings must never be logged: {out}"
    );
}

// ---------------------------------------------------------------------------
// INFO request log redacts the media token (spec_auth.md 10-2 / 11-5)

#[tokio::test]
async fn media_token_redacted_in_request_log() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    let router = router(&cfg, pool);
    let cap = LogCapture::new();
    let res = router
        .oneshot(
            Request::get("/media/img/AbCdEf1234567890GhIj")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let out = cap.output();
    assert!(
        out.contains("path=/media/img/<redacted>"),
        "redacted path must be logged: {out}"
    );
    assert!(
        !out.contains("AbCdEf1234567890GhIj"),
        "the media token must never appear in logs: {out}"
    );
}

// ---------------------------------------------------------------------------
// ERROR on 5xx responses

#[tokio::test]
async fn server_error_logged_at_error() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    pool.close().await;
    let router = router(&cfg, pool);
    let cap = LogCapture::new();
    let res = router
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains("ERROR") && l.contains("request "))
        .expect("ERROR request line for the 5xx");
    assert!(
        line.contains("path=/healthz") && line.contains("status=503"),
        "{line}"
    );
}

// ---------------------------------------------------------------------------
// WARN when a rate limiter fires (429 with the limit class)

#[tokio::test]
async fn rate_limit_fires_warn_with_class() {
    let mut cfg = common::repo_config();
    cfg.auth.rate_limit.webauthn_per_minute = 2;
    cfg.auth.rate_limit.token_accept_per_minute = 1000;
    let pool = db::connect_memory().await.unwrap();
    let router = router(&cfg, pool.clone());
    let client = Client::new();
    let cap = LogCapture::new();
    let mut statuses = Vec::new();
    for _ in 0..3 {
        let resp = client
            .post(&router, "/api/webauthn/login/start", serde_json::json!({}))
            .await;
        statuses.push(resp.status());
    }
    assert_eq!(
        statuses,
        vec![
            StatusCode::OK,
            StatusCode::OK,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains("WARN") && l.contains("rate limited"))
        .expect("WARN rate-limit line");
    assert!(line.contains("class=webauthn"), "{line}");
    assert!(line.contains("retry_after_secs="), "{line}");
}

// ---------------------------------------------------------------------------
// WARN on a login failure (audit action granularity, masked detail)

#[tokio::test]
async fn login_failure_warns_with_audit_action() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    let router = router(&cfg, pool.clone());
    let mut client = Client::new();
    common::auth::register_setup_user(&mut client, &router, &pool, "gone").await;
    let user_id: i64 = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (handle, ids) = common::auth::user_webauthn_ids(&pool, user_id).await;
    // user handle known, credential rows removed -> login_mismatch 401
    sqlx::query("DELETE FROM webauthn_credentials")
        .execute(&pool)
        .await
        .unwrap();

    let resp = client
        .post(&router, "/api/webauthn/login/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    client.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(common::auth::body_json(resp).await).unwrap();
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);

    let cap = LogCapture::new();
    let resp = client
        .post(
            &router,
            "/api/webauthn/login/finish",
            serde_json::json!({ "credential": serde_json::to_value(&cred).unwrap() }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains("WARN") && l.contains("auth failure"))
        .expect("WARN auth-failure line");
    assert!(line.contains("action=login_mismatch"), "{line}");
    // the same failure is audited (spec_auth.md 2-4)
    let mismatches: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'login_mismatch'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(mismatches, 1);
}

// ---------------------------------------------------------------------------
// INFO per MCP tool call (name / actor / outcome / duration)

#[tokio::test]
async fn tool_call_logged_at_info() {
    let (addr, cfg, ct, pool) = common::spawn_app_with_pool().await;
    let user = common::auth::create_user_direct(&pool, "Log User", None).await;
    let grant = common::oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/x",
        "ledger.read ledger.write",
        None,
    )
    .await;
    let token = common::oauth::insert_access_token(&pool, grant).await;
    let url = format!("http://{addr}{}", cfg.app.mcp.path);
    let http = reqwest::Client::new();

    let post = |body: serde_json::Value| {
        let http = http.clone();
        let url = url.clone();
        let token = token.clone();
        async move {
            http.post(url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .header("MCP-Protocol-Version", "2025-06-18")
                .header("Authorization", format!("Bearer {token}"))
                .json(&body)
                .send()
                .await
                .unwrap()
        }
    };

    let cap = LogCapture::new();
    let init = post(serde_json::json!({
        "jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"test","version":"0"}}
    }))
    .await;
    assert_eq!(init.status(), 200);
    let call = post(serde_json::json!({
        "jsonrpc":"2.0","id":3,"method":"tools/call",
        "params":{"name":"ping","arguments":{}}
    }))
    .await;
    assert_eq!(call.status(), 200);
    let body = call.text().await.unwrap();
    assert!(body.contains("pong"), "{body}");
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains(" INFO ") && l.contains("tool call"))
        .expect("INFO tool-call line");
    assert!(line.contains("tool=ping"), "{line}");
    assert!(line.contains(&format!("user_id={user}")), "{line}");
    assert!(line.contains("is_error=false"), "{line}");
    assert!(line.contains("latency_ms="), "{line}");
    ct.cancel();
}

// ---------------------------------------------------------------------------
// INFO after the TTL sweep (per-target counts)

#[tokio::test]
async fn cleanup_sweep_logged_at_info_with_counts() {
    let pool = db::connect_memory().await.unwrap();
    let now = budget_book::auth::session::now_ms();
    // one expired ceremony so a count is non-zero
    sqlx::query(
        "INSERT INTO webauthn_ceremonies (id_hash, kind, state_json, created_at, expires_at)
         VALUES (?, 'authenticate', '{}', ?, ?)",
    )
    .bind(vec![0u8; 32])
    .bind(now - 10_000)
    .bind(now - 1_000)
    .execute(&pool)
    .await
    .unwrap();

    let cap = LogCapture::new();
    let report = store::cleanup_expired(&pool, now, "2026-10-17", |_| Ok(()))
        .await
        .unwrap();
    assert_eq!(report.deleted_ceremonies, 1);
    let out = cap.output();
    let line = out
        .lines()
        .find(|l| l.contains(" INFO ") && l.contains("cleanup sweep finished"))
        .expect("INFO sweep line");
    assert!(line.contains("deleted_ceremonies=1"), "{line}");
    assert!(line.contains("deleted_sessions=0"), "{line}");
}
