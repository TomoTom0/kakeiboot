//! TASK-10 Phase B: OAuth 2.1 metadata, authorize endpoint, consent screen
//! API and the decision POST (spec_auth.md sections 4-1, 4-2, 4-5, 4-6, 11-3)
//! against a local CIMD / JWKS mock server.

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{self, MockMode, body_json, body_text, get, pkce_pair, post_json_raw};

fn cookie_headers(client: &Client) -> Vec<(&'static str, String)> {
    let cookies = client
        .cookies
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ");
    vec![("cookie", cookies)]
}

// [covers:auth-oauth.as-metadata-shape]
#[tokio::test]
async fn authorization_server_metadata_shape() {
    let (router, _pool, _cfg) = oauth::oauth_setup(&oauth::spawn_mock().await).await;
    let resp = get(&router, "/.well-known/oauth-authorization-system", &[]).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let resp = get(&router, "/.well-known/oauth-authorization-server", &[]).await;
    assert_eq!(resp.status(), 200);
    let doc = body_json(resp).await;
    assert_eq!(doc["issuer"], "http://localhost:40281");
    assert_eq!(
        doc["authorization_endpoint"],
        "http://localhost:40281/oauth/authorize"
    );
    assert_eq!(doc["token_endpoint"], "http://localhost:40281/oauth/token");
    assert_eq!(
        doc["revocation_endpoint"],
        "http://localhost:40281/oauth/revoke"
    );
    assert_eq!(doc["response_types_supported"], serde_json::json!(["code"]));
    assert_eq!(
        doc["grant_types_supported"],
        serde_json::json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(
        doc["code_challenge_methods_supported"],
        serde_json::json!(["S256"])
    );
    assert_eq!(
        doc["token_endpoint_auth_methods_supported"],
        serde_json::json!(["private_key_jwt", "none"])
    );
    assert_eq!(
        doc["token_endpoint_auth_signing_alg_values_supported"],
        serde_json::json!(["RS256", "PS256", "ES256"])
    );
    assert_eq!(
        doc["revocation_endpoint_auth_methods_supported"],
        serde_json::json!(["private_key_jwt", "none"])
    );
    assert_eq!(
        doc["scopes_supported"],
        serde_json::json!(["ledger.read", "ledger.write"])
    );
    assert_eq!(doc["client_id_metadata_document_supported"], true);
    assert_eq!(doc["authorization_response_iss_parameter_supported"], true);
    // no DCR endpoint
    assert!(doc.get("registration_endpoint").is_none());
}

// [covers:auth-oauth.prm-metadata-shape]
#[tokio::test]
async fn protected_resource_metadata_and_cache_headers() {
    let (router, _pool, _cfg) = oauth::oauth_setup(&oauth::spawn_mock().await).await;
    for path in [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
    ] {
        let resp = get(&router, path, &[]).await;
        assert_eq!(resp.status(), 200, "{path}");
        assert_eq!(
            resp.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("public, max-age=3600"),
            "{path}"
        );
        let doc = body_json(resp).await;
        assert_eq!(doc["resource"], "http://localhost:40281/mcp");
        assert_eq!(
            doc["authorization_servers"],
            serde_json::json!(["http://localhost:40281"])
        );
        assert_eq!(
            doc["scopes_supported"],
            serde_json::json!(["ledger.read", "ledger.write"])
        );
        assert_eq!(
            doc["bearer_methods_supported"],
            serde_json::json!(["header"])
        );
        assert_eq!(doc["resource_name"], "budget-book");
    }
    // openid-configuration is not provided
    let resp = get(&router, "/.well-known/openid-configuration", &[]).await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

async fn setup_with_user() -> (axum::Router, sqlx::SqlitePool, oauth::MockIds, Client) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, cfg) = oauth::oauth_setup(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Flow User").await;
    let _ = cfg;
    (router, pool, mock, client)
}

/// One authorize request with explicit query override support.
async fn authorize_query(
    router: &axum::Router,
    client: &Client,
    query: &str,
) -> axum::http::Response<axum::body::Body> {
    client
        .get(router, &format!("/oauth/authorize?{query}"))
        .await
}

fn location_of(resp: &axum::http::Response<axum::body::Body>) -> String {
    resp.headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

// [covers:auth-oauth.authorize-happy-path]
#[tokio::test]
async fn authorize_redirects_by_login_state() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (verifier, challenge) = pkce_pair();
    let _ = verifier;
    let query = format!(
        "response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp&state=xyz",
        oauth::urlencode(&mock.client_id),
        oauth::urlencode(&mock.redirect_uri)
    );
    // not logged in -> /login?req=R
    let anon = Client::new();
    let resp = authorize_query(&router, &anon, &query).await;
    assert_eq!(resp.status(), 302);
    let loc = location_of(&resp);
    assert!(loc.starts_with("/login?req="), "{loc}");
    let req_id = loc.trim_start_matches("/login?req=").to_string();

    // logged in -> /oauth/consent?req=R, parameters persisted
    let resp = authorize_query(&router, &client, &query).await;
    assert_eq!(resp.status(), 302);
    let loc = location_of(&resp);
    assert!(loc.starts_with("/oauth/consent?req="), "{loc}");

    let hash = oauth::token_hash(&req_id);
    let row: Option<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT client_id, resource, state, scope FROM oauth_authorization_requests WHERE id_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&_pool)
    .await
    .unwrap();
    let Some((cid, resource, state, scope)) = row else {
        panic!("authorization request row missing");
    };
    assert_eq!(cid, mock.client_id);
    assert_eq!(resource, "http://localhost:40281/mcp");
    assert_eq!(state.as_deref(), Some("xyz"));
    assert_eq!(scope, "ledger.read ledger.write"); // default scopes
}

// [covers:auth-oauth.authorize-invalid-client-no-redirect]
#[tokio::test]
async fn authorize_invalid_client_is_error_page() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let base = |client_id: &str, redirect: &str| {
        format!(
            "response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
            oauth::urlencode(client_id),
            oauth::urlencode(redirect)
        )
    };
    // allowlist-external host
    let resp = authorize_query(
        &router,
        &client,
        &base("https://example.com/clients/x", &mock.redirect_uri),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(location_of(&resp).is_empty(), "must not redirect");
    assert!(body_text(resp).await.contains("接続を開始できません"));

    // syntactically invalid client_id
    let resp = authorize_query(&router, &client, &base("not a url", &mock.redirect_uri)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(location_of(&resp).is_empty());

    // CIMD unreachable (mock returns 500)
    mock.set_mode(MockMode::Error);
    let resp = authorize_query(&router, &client, &base(&mock.client_id, &mock.redirect_uri)).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(location_of(&resp).is_empty());
    mock.set_mode(MockMode::Normal);

    // redirect_uri not registered (differs from the document + allowlist)
    let resp = authorize_query(
        &router,
        &client,
        &base(&mock.client_id, "http://127.0.0.1:1/other-cb"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(location_of(&resp).is_empty());
}

// [covers:auth-oauth.authorize-errors-redirect]
#[tokio::test]
async fn authorize_parameter_errors_redirect_with_error() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let redirect = oauth::urlencode(&mock.redirect_uri);
    let client_id = oauth::urlencode(&mock.client_id);
    let resource = "http%3A%2F%2Flocalhost%3A40281%2Fmcp";
    let good = format!(
        "response_type=code&client_id={client_id}&redirect_uri={redirect}&code_challenge={challenge}&code_challenge_method=S256&resource={resource}&state=st1"
    );
    let cases: Vec<(&str, &str, String)> = vec![
        (
            "unsupported_response_type",
            "token",
            good.replacen("response_type=code", "response_type=token", 1),
        ),
        (
            "invalid_request",
            "missing challenge",
            good.replace("&code_challenge_method=S256", "")
                .replace(&format!("&code_challenge={challenge}"), ""),
        ),
        (
            "invalid_request",
            "plain method",
            good.replace("code_challenge_method=S256", "code_challenge_method=plain"),
        ),
        (
            "invalid_request",
            "bad challenge charset",
            good.replace(&challenge, &"x".repeat(42)),
        ),
        (
            "invalid_scope",
            "unknown scope",
            format!("{good}&scope=ledger.admin"),
        ),
        (
            "invalid_target",
            "resource mismatch",
            good.replace(resource, "http%3A%2F%2Flocalhost%3A40281%2Fother"),
        ),
        (
            "invalid_request",
            "missing resource",
            good.replace(&format!("&resource={resource}"), ""),
        ),
        (
            "invalid_request",
            "resource with fragment",
            good.replace(resource, "http%3A%2F%2Flocalhost%3A40281%2Fmcp%23frag"),
        ),
    ];
    for (expected_error, label, query) in cases {
        let resp = authorize_query(&router, &client, &query).await;
        assert_eq!(resp.status(), 302, "{label}: status");
        let loc = location_of(&resp);
        assert!(loc.starts_with(&mock.redirect_uri), "{label}: {loc}");
        let error = oauth::extract_query_param(&loc, "error").unwrap_or_default();
        assert_eq!(error, expected_error, "{label}");
        assert_eq!(
            oauth::extract_query_param(&loc, "state").as_deref(),
            Some("st1"),
            "{label}"
        );
        assert_eq!(
            oauth::extract_query_param(&loc, "iss").as_deref(),
            Some("http%3A%2F%2Flocalhost%3A40281"),
            "{label}"
        );
    }
    // scope omit -> defaults are stored (no error)
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    let row: (String,) =
        sqlx::query_as("SELECT scope FROM oauth_authorization_requests WHERE id_hash = ?")
            .bind(oauth::token_hash(&req_id))
            .fetch_one(&_pool)
            .await
            .unwrap();
    assert_eq!(row.0, "ledger.read ledger.write");
}

// [covers:auth-oauth.authorize-duplicate-params]
#[tokio::test]
async fn authorize_duplicate_parameters_rejected() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let query = format!(
        "response_type=code&response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
        oauth::urlencode(&mock.client_id),
        oauth::urlencode(&mock.redirect_uri)
    );
    let resp = authorize_query(&router, &client, &query).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert!(location_of(&resp).is_empty());
}

// [covers:auth-oauth.consent-info-binding]
#[tokio::test]
async fn consent_info_requires_session_and_binds_user() {
    let (router, pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;

    // no session -> 401
    let resp = get(&router, &format!("/api/oauth/requests/{req_id}"), &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // session owner opens it -> 200 and user_id bound
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let bound: i64 =
        sqlx::query_scalar("SELECT user_id FROM oauth_authorization_requests WHERE id_hash = ?")
            .bind(oauth::token_hash(&req_id))
            .fetch_one(&pool)
            .await
            .unwrap();
    let owner: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name = 'Flow User'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(bound, owner);

    // a second user's session gets 404 (bound to another user)
    let mut other = Client::new();
    auth::register_setup_user(&mut other, &router, &pool, "Other User").await;
    let resp = other
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // expired request -> 404 for the owner
    sqlx::query("UPDATE oauth_authorization_requests SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // unknown id -> 404
    let resp = client
        .get(
            &router,
            "/api/oauth/requests/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// [covers:auth-oauth.consent-info-payload]
#[tokio::test]
async fn consent_info_payload_shape() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(
        &router,
        &client,
        &mock,
        &challenge,
        Some("ledger.read"),
        None,
    )
    .await;
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    // client_display derives from the allowlisted host (127.0.0.1 in tests)
    assert_eq!(body["client_display"], "127.0.0.1");
    assert_eq!(body["client_id"], mock.client_id.as_str());
    let scopes = body["scopes"].as_array().unwrap();
    assert_eq!(scopes.len(), 1);
    assert_eq!(scopes[0]["name"], "ledger.read");
    assert!(
        scopes[0]["description"]
            .as_str()
            .unwrap()
            .contains("家計簿の参照"),
        "{scopes:?}"
    );
    // the initial ledger is the user's default ledger; TASK-79 names the
    // auto-created personal ledger "<表示名>の家計簿"
    let ledger_name = body["ledger_name"].as_str().expect("ledger_name");
    assert_eq!(ledger_name, "Flow Userの家計簿");
    // TASK-20: the initial ledger also reports the user's palette color
    // (ledger_members.color; registration assigns the first palette key)
    assert_eq!(body["ledger_color"], "teal");
    assert_eq!(body["user_display_name"], "Flow User");

    // with no selectable ledger (default cleared, no prior grant) both the
    // name and the color are null
    sqlx::query("UPDATE users SET default_ledger_id = NULL WHERE display_name = 'Flow User'")
        .execute(&_pool)
        .await
        .unwrap();
    let (_, challenge2) = pkce_pair();
    let req2 = oauth::authorize(
        &router,
        &client,
        &mock,
        &challenge2,
        Some("ledger.read"),
        None,
    )
    .await;
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req2}"))
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert!(body["ledger_name"].is_null(), "no selectable ledger");
    assert!(body["ledger_color"].is_null(), "no color without a ledger");
}

// [covers:auth-oauth.decision-allow]
#[tokio::test]
async fn decision_allow_issues_code() {
    let (router, pool, mock, client) = setup_with_user().await;
    let (verifier, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, Some("st-42")).await;

    // Origin is required (spec 3-1)
    let no_origin = post_json_raw(
        &router,
        "/oauth/authorize/decision",
        serde_json::json!({ "req": req_id, "decision": "allow" }).to_string(),
        &cookie_headers(&client),
    )
    .await;
    assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);

    // the consent view binds the request to the session user (spec 4-2)
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    // decision (cookie client sends Origin)
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let redirect_to = body["redirect_to"].as_str().unwrap();
    assert!(redirect_to.starts_with(&mock.redirect_uri), "{redirect_to}");
    let code = oauth::extract_query_param(redirect_to, "code").expect("code");
    assert_eq!(
        oauth::extract_query_param(redirect_to, "state").as_deref(),
        Some("st-42")
    );
    assert_eq!(
        oauth::extract_query_param(redirect_to, "iss").as_deref(),
        Some("http%3A%2F%2Flocalhost%3A40281")
    );

    // the request row is gone; the code row exists with grant_id NULL, 60s TTL
    let gone: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM oauth_authorization_requests WHERE id_hash = ?")
            .bind(oauth::token_hash(&req_id))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(gone, 0);
    let code_row: Option<(Option<i64>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT used_at, grant_id, expires_at FROM oauth_auth_codes WHERE code_hash = ?",
    )
    .bind(oauth::token_hash(&code))
    .fetch_optional(&pool)
    .await
    .unwrap();
    let (used_at, grant_id, expires_at) = code_row.expect("code row");
    assert!(used_at.is_none());
    assert!(grant_id.is_none());
    let now = budget_book::auth::session::now_ms();
    assert!(
        expires_at <= now + 61_000 && expires_at > now,
        "{expires_at}"
    );

    // double decision (req already consumed) -> 400
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let _ = verifier;
}

// [covers:auth-oauth.decision-deny]
#[tokio::test]
async fn decision_deny_redirects_access_denied() {
    let (router, pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, Some("deny-st")).await;
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "deny" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let redirect_to = body["redirect_to"].as_str().unwrap();
    assert_eq!(
        oauth::extract_query_param(redirect_to, "error").as_deref(),
        Some("access_denied")
    );
    assert_eq!(
        oauth::extract_query_param(redirect_to, "state").as_deref(),
        Some("deny-st")
    );
    assert_eq!(
        oauth::extract_query_param(redirect_to, "iss").as_deref(),
        Some("http%3A%2F%2Flocalhost%3A40281")
    );
    // no code issued, request row deleted
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_auth_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(codes, 0);
    let gone: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM oauth_authorization_requests WHERE id_hash = ?")
            .bind(oauth::token_hash(&req_id))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(gone, 0);
}

// [covers:auth-oauth.decision-allow]
#[tokio::test]
async fn decision_for_foreign_request_rejected() {
    let (router, pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    // another user posts the decision for this req (user_id not bound yet ->
    // no match for the session user)
    let mut other = Client::new();
    auth::register_setup_user(&mut other, &router, &pool, "Foreign User").await;
    let resp = other
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    // no code exists
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_auth_codes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(codes, 0);
}

// [covers:auth-oauth.authorize-state-length]
#[tokio::test]
async fn authorize_state_over_512_is_invalid_request() {
    let (router, _pool, mock, client) = setup_with_user().await;
    let (_, challenge) = pkce_pair();
    let base = format!(
        "response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
        oauth::urlencode(&mock.client_id),
        oauth::urlencode(&mock.redirect_uri)
    );
    // exactly 512 characters is accepted
    let ok = format!("{base}&state={}", "s".repeat(512));
    let resp = authorize_query(&router, &client, &ok).await;
    assert_eq!(resp.status(), 302);
    assert!(location_of(&resp).starts_with("/oauth/consent?req="));
    // 513 characters: invalid_request redirect, the state is not echoed
    let long = format!("{base}&state={}", "s".repeat(513));
    let resp = authorize_query(&router, &client, &long).await;
    assert_eq!(resp.status(), 302);
    let loc = location_of(&resp);
    assert!(loc.starts_with(&mock.redirect_uri), "{loc}");
    assert_eq!(
        oauth::extract_query_param(&loc, "error").as_deref(),
        Some("invalid_request")
    );
    assert!(oauth::extract_query_param(&loc, "state").is_none());
}

// ---------------------------------------------------------------------------
// TASK-149: a claude.ai CIMD client (public, token_endpoint_auth_method=none)
// runs the whole flow. The production CIMD document is served from
// https://claude.ai (unreachable from tests); the oauth_clients cache row
// (fresh TTL) stands in as the CIMD source — the fetch machinery itself is
// covered by the cimd-fetch-cache conditions against the loopback mock.

// [covers:auth-oauth.claude-cimd-full-flow]
#[tokio::test]
async fn claude_cimd_client_full_flow() {
    const CLAUDE_CLIENT_ID: &str = "https://claude.ai/oauth/client-metadata";
    const CLAUDE_CB: &str = "https://claude.ai/api/mcp/auth_callback";
    let mock = oauth::spawn_mock().await;
    // repo config plus the TASK-149 D1 entries (the loopback mock stays
    // allowlisted for the rate-limit raised setup; claude.ai joins the hosts
    // and its fixed callback joins the redirect allowlist)
    let mut cfg = oauth::oauth_config(&mock, None);
    cfg.auth.oauth.cimd_allowed_hosts.push("claude.ai".into());
    cfg.auth.oauth.redirect_uri_allowlist.push(CLAUDE_CB.into());
    let pool = budget_book::db::connect_memory().await.expect("memory db");
    let state = budget_book::app::AppState::new(&cfg, pool.clone()).expect("app state");
    let router = budget_book::app::router(&cfg, state, tokio_util::sync::CancellationToken::new());
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Claude Flow User").await;

    // the CIMD record for the claude client, as a fresh cache row (auth none)
    let now = budget_book::auth::session::now_ms();
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, client_name,
             redirect_uris_json, token_endpoint_auth_method, jwks_uri, etag,
             fetched_at, expires_at)
         VALUES (?, '{}', 'Claude', ?, 'none', NULL, NULL, ?, ?)",
    )
    .bind(CLAUDE_CLIENT_ID)
    .bind(serde_json::json!([CLAUDE_CB]).to_string())
    .bind(now)
    .bind(now + 3_600_000)
    .execute(&pool)
    .await
    .unwrap();

    // authorize (PKCE S256 + state + resource) with the claude client_id and
    // its hosted-Claude callback
    let (verifier, challenge) = pkce_pair();
    let query = format!(
        "response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp&state=cs-7",
        oauth::urlencode(CLAUDE_CLIENT_ID),
        oauth::urlencode(CLAUDE_CB),
    );
    let resp = client
        .get(&router, &format!("/oauth/authorize?{query}"))
        .await;
    assert_eq!(resp.status(), 302, "claude authorize");
    let location = location_of(&resp);
    assert!(
        location.starts_with("/oauth/consent?req="),
        "unexpected redirect: {location}"
    );
    let req_id = location
        .split("req=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap();

    // consent info: the fixed display name for the claude.ai host, the
    // client_id URL alongside
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200, "claude consent info");
    let body = body_json(resp).await;
    assert_eq!(body["client_display"], "Claude");
    assert_eq!(body["client_id"], CLAUDE_CLIENT_ID);
    assert!(
        body["ledger_name"].as_str().is_some_and(|n| !n.is_empty()),
        "initial ledger selected"
    );

    // decision allow -> code on the claude callback
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "claude decision");
    let body = body_json(resp).await;
    let redirect_to = body["redirect_to"].as_str().unwrap();
    assert!(redirect_to.starts_with(CLAUDE_CB), "{redirect_to}");
    let code = oauth::extract_query_param(redirect_to, "code").expect("code");
    assert_eq!(
        oauth::extract_query_param(redirect_to, "state").as_deref(),
        Some("cs-7")
    );

    // token exchange: public client — client_id form param only, no assertion
    let form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_id={}",
        oauth::urlencode(CLAUDE_CB),
        oauth::urlencode(CLAUDE_CLIENT_ID),
    );
    let resp = oauth::post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "claude public client exchange");
    let body = body_json(resp).await;
    let access_token = body["access_token"].as_str().unwrap();
    let refresh_token = body["refresh_token"].as_str().unwrap();
    assert_eq!(body["token_type"], "Bearer");
    assert_eq!(body["scope"], "ledger.read ledger.write");

    // the grant belongs to the claude client
    let client_of_grant: String = sqlx::query_scalar(
        "SELECT g.client_id FROM oauth_grants g
         JOIN oauth_access_tokens t ON t.grant_id = g.id WHERE t.token_hash = ?",
    )
    .bind(oauth::token_hash(access_token))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(client_of_grant, CLAUDE_CLIENT_ID);

    // refresh: client_id param only, rotation issues a new refresh token
    let form = format!(
        "grant_type=refresh_token&refresh_token={refresh_token}&client_id={}",
        oauth::urlencode(CLAUDE_CLIENT_ID),
    );
    let resp = oauth::post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "claude public client refresh");
    let body = body_json(resp).await;
    let next_refresh = body["refresh_token"].as_str().unwrap();
    assert_ne!(next_refresh, refresh_token, "refresh rotation");
    assert!(body["access_token"].as_str().is_some_and(|t| !t.is_empty()));
}
