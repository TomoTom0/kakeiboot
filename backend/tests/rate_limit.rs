//! TASK-10 Phase B: application rate limits (spec_auth.md section 10-1)
//! observed over the HTTP router with small configured windows.

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{self, body_json, post_form};

async fn setup_with_limits(
    f: impl Fn(&mut budget_book::config::Config),
) -> (axum::Router, sqlx::SqlitePool) {
    let mock = oauth::spawn_mock().await;
    let mut cfg = common::repo_config();
    cfg.auth.oauth.cimd_allowed_hosts = vec!["127.0.0.1".into()];
    cfg.auth.oauth.redirect_uri_allowlist = vec![mock.redirect_uri.clone()];
    cfg.auth.oauth.dev.allow_insecure_loopback = true;
    f(&mut cfg);
    let pool = budget_book::db::connect_memory().await.unwrap();
    let state = budget_book::app::AppState::new(&cfg, pool.clone()).unwrap();
    let router = budget_book::app::router(&cfg, state, tokio_util::sync::CancellationToken::new());
    (router, pool)
}

// [covers:auth-ratelimit.webauthn-429]
#[tokio::test]
async fn webauthn_endpoints_rate_limited_per_ip() {
    let (router, pool) = setup_with_limits(|cfg| {
        cfg.auth.rate_limit.webauthn_per_minute = 3;
        cfg.auth.rate_limit.token_accept_per_minute = 1000;
    })
    .await;
    let token = auth::issue_setup_token(&pool, "note").await;
    let client = Client::new();
    for i in 0..3 {
        let resp = client
            .post(
                &router,
                "/api/webauthn/register/info",
                serde_json::json!({ "token": token }),
            )
            .await;
        assert_eq!(resp.status(), 200, "request {i}");
    }
    // 4th request within the minute -> 429 + Retry-After
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .expect("Retry-After");
    let retry: u32 = retry.parse().unwrap();
    assert!((1..=60).contains(&retry), "{retry}");
}

// [covers:auth-ratelimit.authorize-429]
#[tokio::test]
async fn authorize_rate_limited_per_ip() {
    let (router, _pool) = setup_with_limits(|cfg| {
        cfg.auth.rate_limit.authorize_per_minute = 2;
    })
    .await;
    let client = Client::new();
    let query = "/oauth/authorize?response_type=code&client_id=https%3A%2F%2Fchatgpt.com%2Fc&redirect_uri=x&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp";
    // two requests hit the invalid-client error page (still counted)
    for _ in 0..2 {
        let resp = client.get(&router, query).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
    let resp = client.get(&router, query).await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}

// [covers:auth-ratelimit.mcp-user-429]
#[tokio::test]
async fn mcp_rate_limited_per_user() {
    let (router, pool) = setup_with_limits(|cfg| {
        cfg.auth.rate_limit.mcp_per_minute = 2;
    })
    .await;
    let user = auth::create_user_direct(&pool, "Limited", None).await;
    let grant = oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/x",
        "ledger.read",
        None,
    )
    .await;
    let token = oauth::insert_access_token(&pool, grant).await;
    let call = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": "ping", "arguments": {}}
    })
    .to_string();
    async fn call_mcp(
        router: &axum::Router,
        token: &str,
        body: &str,
    ) -> axum::http::Response<axum::body::Body> {
        use tower::ServiceExt as _;
        let builder = axum::http::Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("host", "localhost:40281")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-06-18");
        router
            .clone()
            .oneshot(
                builder
                    .body(axum::body::Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    for _ in 0..2 {
        let resp = call_mcp(&router, &token, &call).await;
        assert_eq!(resp.status(), 200, "authenticated call passes");
    }
    let resp = call_mcp(&router, &token, &call).await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    // another user is unaffected
    let user2 = auth::create_user_direct(&pool, "Unlimited", None).await;
    let grant2 = oauth::insert_grant(
        &pool,
        user2,
        "https://chatgpt.com/clients/x",
        "ledger.read",
        None,
    )
    .await;
    let token2 = oauth::insert_access_token(&pool, grant2).await;
    let resp = call_mcp(&router, &token2, &call).await;
    assert_eq!(resp.status(), 200);
}

// [covers:auth-ratelimit.token-endpoint-429]
#[tokio::test]
async fn token_endpoint_unauthenticated_requests_keyed_by_ip() {
    let (router, _pool) = setup_with_limits(|cfg| {
        cfg.auth.rate_limit.token_endpoint_per_minute = 2;
    })
    .await;
    // before authentication the key is the client IP, so rotating the
    // claimed client_id does not buy more requests (and does not trigger
    // more CIMD fetches)
    for cid in ["c1", "c2"] {
        let form = format!(
            "grant_type=authorization_code&code=x&redirect_uri=y&code_verifier=z&client_id={cid}"
        );
        let resp = post_form(&router, "/oauth/token", &form, &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{cid}");
    }
    let resp = post_form(
        &router,
        "/oauth/token",
        "grant_type=authorization_code&code=x&redirect_uri=y&code_verifier=z&client_id=c3",
        &[],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    // /oauth/revoke shares the same IP bucket
    let resp = post_form(&router, "/oauth/revoke", "token=t&client_id=c4", &[]).await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}

// [covers:auth-ratelimit.token-endpoint-429]
#[tokio::test]
async fn token_endpoint_authenticated_requests_keyed_by_client() {
    let mock = oauth::spawn_mock().await;
    mock.set_auth_method(None); // public client: client_id authenticates
    let mut cfg = oauth::oauth_config(&mock, None);
    cfg.auth.rate_limit.token_endpoint_per_minute = 2;
    cfg.auth.rate_limit.trust_cf_connecting_ip = true;
    let pool = budget_book::db::connect_memory().await.unwrap();
    let state = budget_book::app::AppState::new(&cfg, pool.clone()).unwrap();
    let router = budget_book::app::router(&cfg, state, tokio_util::sync::CancellationToken::new());
    let form = format!(
        "token=unknown&client_id={}",
        oauth::urlencode(&mock.client_id)
    );
    // a fresh IP per request: only the verified client bucket can trip
    for i in 0..2 {
        let resp = post_form(
            &router,
            "/oauth/revoke",
            &form,
            &[("cf-connecting-ip", format!("203.0.113.{i}"))],
        )
        .await;
        assert_eq!(resp.status(), 200, "request {i}");
    }
    let resp = post_form(
        &router,
        "/oauth/revoke",
        &form,
        &[("cf-connecting-ip", "203.0.113.9".into())],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
    let _ = body_json;
}

// [covers:auth-ratelimit.mcp-unauthenticated-ip-429]
#[tokio::test]
async fn mcp_401_paths_rate_limited_per_ip() {
    let (router, _pool) = setup_with_limits(|cfg| {
        cfg.auth.rate_limit.mcp_per_minute = 2;
    })
    .await;
    for _ in 0..2 {
        let resp = oauth::post_form(
            &router,
            "/mcp",
            "{}",
            &[(
                "authorization",
                "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            )],
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
    // the third failed attempt from the same IP is throttled (also without
    // any Authorization header)
    let resp = oauth::post_form(&router, "/mcp", "{}", &[]).await;
    assert_eq!(resp.status(), StatusCode::TOO_MANY_REQUESTS);
}
