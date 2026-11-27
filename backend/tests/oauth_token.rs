//! TASK-10 Phase B: the token endpoint (PKCE code exchange, grant creation
//! with supersede, client authentication via private_key_jwt with the mock
//! JWKS, jti single-use, kid refetch) and revocation
//! (spec_auth.md sections 4-4, 4-7, 4-10, 4-11, 11-4).

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{
    self, MockMode, body_json, make_assertion, pkce_pair, post_form, tamper_signature,
};

const ASSERTION_TYPE: &str = "urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer";

async fn setup() -> (
    axum::Router,
    sqlx::SqlitePool,
    oauth::MockIds,
    Client,
    String, // issuer
) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, cfg) = oauth::oauth_setup(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Token User").await;
    (router, pool, mock, client, cfg.auth.issuer.clone())
}

fn exchange_form(
    mock: &oauth::MockIds,
    code: &str,
    verifier: &str,
    assertion: Option<&str>,
) -> String {
    let mut form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}",
        oauth::urlencode(&mock.redirect_uri)
    );
    if let Some(a) = assertion {
        form.push_str(&format!(
            "&client_assertion={a}&client_assertion_type={ASSERTION_TYPE}"
        ));
    }
    form
}

async fn get_code(
    router: &axum::Router,
    client: &Client,
    mock: &oauth::MockIds,
    challenge: &str,
    scope: Option<&str>,
) -> String {
    let req_id = oauth::authorize(router, client, mock, challenge, scope, None).await;
    let resp = client
        .get(router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let resp = client
        .post(
            router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    oauth::extract_query_param(body["redirect_to"].as_str().unwrap(), "code").unwrap()
}

fn fresh_assertion(mock: &oauth::MockIds, issuer: &str, jti: &str) -> String {
    make_assertion(&mock.client_id, issuer, Some("k1"), jti, &[])
}

// [covers:auth-oauth.token-response-shape]
// [covers:auth-oauth.client-auth-private-key-jwt]
#[tokio::test]
async fn code_exchange_success_and_response_shape() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    assert_eq!(flow.scope, "ledger.read ledger.write");

    // response headers were checked on a fresh exchange here; repeat one with
    // a new code to assert headers explicitly
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, Some("ledger.read")).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        resp.headers().get("pragma").and_then(|v| v.to_str().ok()),
        Some("no-cache")
    );
    let body = body_json(resp).await;
    assert_eq!(body["token_type"], "Bearer");
    assert!(body["expires_in"].as_i64().unwrap() > 0);
    assert_eq!(body["scope"], "ledger.read");
    assert!(!body["access_token"].as_str().unwrap().is_empty());
    assert!(!body["refresh_token"].as_str().unwrap().is_empty());
}

// [covers:auth-oauth.pkce-verification]
#[tokio::test]
async fn pkce_failures_consume_the_code() {
    let (router, pool, mock, client, issuer) = setup().await;
    // 1. wrong verifier
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let wrong = format!("{}x", verifier).replace('x', "q");
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &wrong,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    let used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM oauth_auth_codes WHERE code_hash = ?")
            .bind(oauth::token_hash(&code))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(used.is_some(), "the code counts as consumed");

    // 2. verifier shape violations (too short / too long / bad charset)
    for bad in [
        "short",
        &"a".repeat(129),
        &("x".to_string() + &"a".repeat(50)),
    ] {
        let (_, challenge) = pkce_pair();
        let code = get_code(&router, &client, &mock, &challenge, None).await;
        let jti = oauth::b64url_of_random();
        let form = exchange_form(
            &mock,
            &code,
            bad,
            Some(&fresh_assertion(&mock, &issuer, &jti)),
        );
        let resp = post_form(&router, "/oauth/token", &form, &[]).await;
        let status = resp.status();
        let body = body_json(resp).await;
        assert_eq!(status, 400, "{body}");
        assert_eq!(body["error"], "invalid_grant", "verifier {bad:?}");
        let used: Option<i64> =
            sqlx::query_scalar("SELECT used_at FROM oauth_auth_codes WHERE code_hash = ?")
                .bind(oauth::token_hash(&code))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(used.is_some(), "verifier {bad:?} consumes the code");
    }
}

// [covers:auth-oauth.code-single-use-replay]
#[tokio::test]
async fn code_replay_revokes_grant_after_response() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // replay the same code: the used_at check fires before PKCE, so any
    // well-formed verifier exercises the code_reuse branch
    let (verifier, _) = pkce_pair();
    let _ = verifier;
    // exchange the same code again: used_at is set -> code_reuse path
    let resp = {
        let jti2 = oauth::b64url_of_random();
        let form = exchange_form(
            &mock,
            &flow.code,
            "a".repeat(43).as_str(),
            Some(&fresh_assertion(&mock, &issuer, &jti2)),
        );
        post_form(&router, "/oauth/token", &form, &[]).await
    };
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    // the grant issued by the first exchange is revoked (committed)
    let row: (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(row.0.is_some(), "grant revoked after the error response");
    assert_eq!(row.1.as_deref(), Some("code_reuse"));
}

// [covers:auth-oauth.code-expired-and-mismatch]
#[tokio::test]
async fn expired_or_mismatched_codes_are_invalid_grant() {
    let (router, pool, mock, client, issuer) = setup().await;
    // expired code
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    sqlx::query("UPDATE oauth_auth_codes SET expires_at = 1 WHERE code_hash = ?")
        .bind(oauth::token_hash(&code))
        .execute(&pool)
        .await
        .unwrap();
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 400);
    let used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM oauth_auth_codes WHERE code_hash = ?")
            .bind(oauth::token_hash(&code))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(used.is_some());

    // redirect_uri mismatch
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let mut form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    form = form.replace(
        &oauth::urlencode(&mock.redirect_uri),
        &oauth::urlencode("http://127.0.0.1:1/other"),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 400);

    // resource mismatch (token request carries a different resource)
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let form = format!(
        "{}&resource=http%3A%2F%2Flocalhost%3A40281%2Fother",
        exchange_form(
            &mock,
            &code,
            &verifier,
            Some(&fresh_assertion(&mock, &issuer, &jti))
        )
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "invalid_grant");

    // disabled user (disable the code owner after issuance)
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    sqlx::query("UPDATE users SET disabled_at = 1 WHERE id = (SELECT user_id FROM oauth_auth_codes WHERE code_hash = ?)")
        .bind(oauth::token_hash(&code))
        .execute(&pool)
        .await
        .unwrap();
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 400);
}

// [covers:auth-oauth.grant-create-supersede]
#[tokio::test]
async fn reconnection_supersedes_old_grant_and_inherits_ledger() {
    let (router, pool, mock, client, issuer) = setup().await;
    let first = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // give the first grant a distinct active ledger (second membership)
    let user: i64 = sqlx::query_scalar("SELECT user_id FROM oauth_grants WHERE id = ?")
        .bind(first.grant_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let ledger2: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('Second', 0, 0) RETURNING id",
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
        .bind(first.grant_id)
        .execute(&pool)
        .await
        .unwrap();

    let second = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;

    // old grant revoked with superseded; new grant inherits the ledger
    let old: (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(first.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(old.0.is_some());
    assert_eq!(old.1.as_deref(), Some("superseded"));
    let new_active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(second.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(new_active, Some(ledger2));

    // grant_create audit row exists
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'oauth_grant' AND action = 'grant_create' AND entity_id = ?",
    )
    .bind(second.grant_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit > 0);

    // the first grant's access token is dead on /mcp
    let resp = oauth::post_form(
        &router,
        "/oauth/token",
        &format!(
            "grant_type=refresh_token&refresh_token={}",
            first.refresh_token
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);
}

// [covers:auth-oauth.grant-initial-ledger]
#[tokio::test]
async fn grant_initial_ledger_resolution() {
    let (router, pool, mock, client, issuer) = setup().await;
    let user: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name = 'Token User'")
        .fetch_one(&pool)
        .await
        .unwrap();
    // default: personal ledger (owner) -> that ledger becomes active
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let default_ledger: Option<i64> =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, default_ledger);

    // lose the membership of the default ledger -> unselected
    sqlx::query("DELETE FROM ledger_members WHERE user_id = ? AND ledger_id = ?")
        .bind(user)
        .bind(default_ledger.unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    let resp = client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    let body = body_json(resp).await;
    assert!(body["ledger_name"].is_null(), "{}", body["ledger_name"]);
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    let _ = resp;
    // find the newest grant: active_ledger_id NULL
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(2) // second grant for this user+client
            .fetch_optional(&pool)
            .await
            .unwrap()
            .flatten();
    assert_eq!(active, None);
}

// [covers:auth-oauth.client-auth-none]
#[tokio::test]
async fn public_client_authenticates_with_client_id_only() {
    let mock = oauth::spawn_mock().await;
    let (router, pool, cfg) = oauth::oauth_setup(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Public Client User").await;
    mock.set_auth_method(None); // token_endpoint_auth_method omitted -> none

    let (verifier, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    client
        .get(&router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    let resp = client
        .post(
            &router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    let body = body_json(resp).await;
    let code = oauth::extract_query_param(body["redirect_to"].as_str().unwrap(), "code").unwrap();

    // no assertion needed, client_id param only
    let form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_id={}",
        oauth::urlencode(&mock.redirect_uri),
        oauth::urlencode(&mock.client_id)
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "public client exchange");

    // assertion sent anyway -> invalid_client (method declares none)
    let (_, challenge) = pkce_pair();
    let code = {
        let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
        client
            .get(&router, &format!("/api/oauth/requests/{req_id}"))
            .await;
        let resp = client
            .post(
                &router,
                "/oauth/authorize/decision",
                serde_json::json!({ "req": req_id, "decision": "allow" }),
            )
            .await;
        let body = body_json(resp).await;
        oauth::extract_query_param(body["redirect_to"].as_str().unwrap(), "code").unwrap()
    };
    let assertion = fresh_assertion(&mock, &cfg.auth.issuer, "jti-x");
    let form = exchange_form(&mock, &code, &verifier, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // forged client_id -> invalid_client
    let (_, challenge) = pkce_pair();
    let code = {
        let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
        client
            .get(&router, &format!("/api/oauth/requests/{req_id}"))
            .await;
        let resp = client
            .post(
                &router,
                "/oauth/authorize/decision",
                serde_json::json!({ "req": req_id, "decision": "allow" }),
            )
            .await;
        let body = body_json(resp).await;
        oauth::extract_query_param(body["redirect_to"].as_str().unwrap(), "code").unwrap()
    };
    let form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_id=http%3A%2F%2F127.0.0.1%3A1%2Fother",
        oauth::urlencode(&mock.redirect_uri)
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// [covers:auth-oauth.assertion-claims-validation]
#[tokio::test]
async fn assertion_claim_violations_are_invalid_client() {
    let (router, _pool, mock, client, issuer) = setup().await;
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;

    let overrides: Vec<(&str, Vec<(&str, serde_json::Value)>)> = vec![
        ("bad signature", vec![]),
        (
            "iss mismatch",
            vec![("iss", serde_json::json!("https://other.example/c"))],
        ),
        (
            "sub mismatch",
            vec![("sub", serde_json::json!("https://other.example/c"))],
        ),
        (
            "aud mismatch",
            vec![("aud", serde_json::json!("https://other.example/api"))],
        ),
        (
            "exp window",
            vec![(
                "exp",
                serde_json::json!(budget_book::auth::session::now_ms() / 1000 + 900),
            )],
        ),
        (
            "iat future",
            vec![(
                "iat",
                serde_json::json!(budget_book::auth::session::now_ms() / 1000 + 600),
            )],
        ),
        ("empty jti", vec![("jti", serde_json::json!(""))]),
        ("missing jti", vec![("jti", serde_json::Value::Null)]),
        ("missing aud", vec![("aud", serde_json::Value::Null)]),
    ];
    for (label, ovs) in &overrides {
        let jti = oauth::b64url_of_random();
        let mut assertion = make_assertion(&mock.client_id, &issuer, Some("k1"), &jti, ovs);
        if *label == "bad signature" {
            assertion = tamper_signature(&assertion);
        }
        let form = exchange_form(&mock, &code, &verifier, Some(&assertion));
        let resp = post_form(&router, "/oauth/token", &form, &[]).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{label}");
        let body = body_json(resp).await;
        assert_eq!(body["error"], "invalid_client", "{label}");
    }
    // no kid
    let jti = oauth::b64url_of_random();
    let assertion = make_assertion(&mock.client_id, &issuer, None, &jti, &[]);
    let form = exchange_form(&mock, &code, &verifier, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "missing kid");
    // disallowed header alg (HS256): hand-built JWT (the server inspects the
    // header before any crypto, so the bogus signature is fine)
    let jti = oauth::b64url_of_random();
    let assertion = {
        let _b64 = |v: &str| {
            oauth::urlencode(
                &budget_book::auth::tokens::b64url_encode(v.as_bytes())
                    .to_string()
                    .clone(),
            )
        };
        let header = r#"{"alg":"HS256","kid":"k1"}"#;
        let claims = serde_json::json!({
            "iss": mock.client_id, "sub": mock.client_id, "aud": issuer,
            "exp": budget_book::auth::session::now_ms() / 1000 + 300,
            "iat": budget_book::auth::session::now_ms() / 1000,
            "jti": jti,
        });
        let enc = |v: String| budget_book::auth::tokens::b64url_encode(v.as_bytes());
        format!(
            "{}.{}.{}",
            enc(header.to_string()),
            enc(claims.to_string()),
            enc(String::new())
        )
    };
    let form = exchange_form(&mock, &code, &verifier, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "HS256");

    // the code is still usable with a good assertion (above failures happen
    // before the exchange transaction)
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "valid assertion still works");
}

// [covers:auth-oauth.client-auth-private-key-jwt]
#[tokio::test]
async fn assertion_required_for_private_key_jwt_clients() {
    let (router, _pool, mock, client, issuer) = setup().await;
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    // missing assertion (client declares private_key_jwt by default)
    let form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_id={}",
        oauth::urlencode(&mock.redirect_uri),
        oauth::urlencode(&mock.client_id)
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    let status = resp.status();
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let has_challenge = resp.headers().get("www-authenticate").is_some(); // RFC 6749 5.2
    let body = body_json(resp).await;
    assert_eq!(body["error"], "invalid_client");
    assert!(has_challenge);
    let _ = issuer;
}

// [covers:auth-oauth.assertion-jti-reuse]
#[tokio::test]
async fn assertion_jti_single_use() {
    let (router, pool, mock, client, issuer) = setup().await;
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let assertion = fresh_assertion(&mock, &issuer, "same-jti");
    let form = exchange_form(&mock, &code, &verifier, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "first use");

    // a second code with the same assertion (same jti) -> replay
    let (_, challenge) = pkce_pair();
    let code2 = get_code(&router, &client, &mock, &challenge, None).await;
    let form = exchange_form(&mock, &code2, &verifier, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "invalid_client");
    // code2 untouched (assertion validation precedes the exchange)
    let used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM oauth_auth_codes WHERE code_hash = ?")
            .bind(oauth::token_hash(&code2))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(used.is_none());
}

// [covers:auth-oauth.client-auth-private-key-jwt]
#[tokio::test]
async fn assertion_without_type_urn_is_rejected() {
    let (router, _pool, mock, client, issuer) = setup().await;
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let assertion = fresh_assertion(&mock, &issuer, &jti);
    // the assertion-type URN is REQUIRED (RFC 7523 2.2): missing -> 401
    let form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_assertion={assertion}",
        oauth::urlencode(&mock.redirect_uri)
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "invalid_client");
}

// [covers:auth-oauth.jwks-kid-refetch]
#[tokio::test]
async fn jwks_kid_mismatch_refetch_throttled_to_60s() {
    let (router, pool, mock, client, issuer) = setup().await;
    // warm both caches (CIMD + JWKS with kid k1)
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200);
    let fetches_after_warm = mock.jwks_fetches();

    // rotate the mock key; a fresh cache (<60s) refuses to refetch
    mock.rotate_kid("k2");
    let (verifier2, challenge2) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge2, None).await;
    let jti = oauth::b64url_of_random();
    let assertion = make_assertion(&mock.client_id, &issuer, Some("k2"), &jti, &[]);
    let form = exchange_form(&mock, &code, &verifier2, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "throttled refetch");
    assert_eq!(mock.jwks_fetches(), fetches_after_warm, "no refetch yet");

    // simulate 120s since the last fetch -> refetch happens, k2 works
    sqlx::query("UPDATE oauth_jwks_cache SET fetched_at = ?")
        .bind(budget_book::auth::session::now_ms() - 120_000)
        .execute(&pool)
        .await
        .unwrap();
    let (verifier3, challenge3) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge3, None).await;
    let jti = oauth::b64url_of_random();
    let assertion = make_assertion(&mock.client_id, &issuer, Some("k2"), &jti, &[]);
    let form = exchange_form(&mock, &code, &verifier3, Some(&assertion));
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "refetch after 60s");
    assert!(mock.jwks_fetches() > fetches_after_warm);
}

// [covers:auth-oauth.jwks-304-stale-window-recovery]
#[tokio::test]
async fn jwks_304_recovers_beyond_stale_window() {
    let (router, pool, mock, client, issuer) = setup().await;
    // warm both caches (CIMD + JWKS with kid k1)
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200);
    let fetches_after_warm = mock.jwks_fetches();

    // Age the JWKS row beyond the stale-if-error window (fetched and
    // expired 25h ago; the window closes 24h after expiry). The key set
    // has not changed, so the conditional GET is answered 304 — which
    // confirms the cached body and must serve the key anyway (this is
    // the 2026-11-27 ChatGPT outage shape: an untouched cache row whose
    // window had closed was rejected despite the 304).
    let past = budget_book::auth::session::now_ms() - 25 * 3_600_000;
    sqlx::query("UPDATE oauth_jwks_cache SET fetched_at = ?, expires_at = ?")
        .bind(past)
        .bind(past)
        .execute(&pool)
        .await
        .unwrap();

    let (verifier2, challenge2) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge2, None).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier2,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "304-confirmed cache must serve the key");
    assert_eq!(
        mock.jwks_fetches(),
        fetches_after_warm + 1,
        "one conditional GET"
    );

    // the 304 refreshed the row's lifetime: it is fresh again
    let expires_at: i64 = sqlx::query_scalar("SELECT expires_at FROM oauth_jwks_cache")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(expires_at > budget_book::auth::session::now_ms());
}

// [covers:auth-oauth.jwks-304-stale-window-recovery]
#[tokio::test]
async fn jwks_304_with_desynced_body_refetches_unconditionally() {
    let (router, pool, mock, client, issuer) = setup().await;
    // warm both caches (CIMD + JWKS with kid k1)
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge, None).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200);
    let fetches_after_warm = mock.jwks_fetches();

    // Desync the row: the stored etag still matches the server's (so the
    // conditional GET answers 304) but the stored body lost the key, and
    // the row is beyond the stale window too. Recovery is one
    // unconditional GET, which returns the full key set again.
    let past = budget_book::auth::session::now_ms() - 25 * 3_600_000;
    sqlx::query("UPDATE oauth_jwks_cache SET jwks_json = ?, fetched_at = ?, expires_at = ?")
        .bind(r#"{"keys":[]}"#)
        .bind(past)
        .bind(past)
        .execute(&pool)
        .await
        .unwrap();

    let (verifier2, challenge2) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge2, None).await;
    let jti = oauth::b64url_of_random();
    let form = exchange_form(
        &mock,
        &code,
        &verifier2,
        Some(&fresh_assertion(&mock, &issuer, &jti)),
    );
    let resp = post_form(&router, "/oauth/token", &form, &[]).await;
    assert_eq!(resp.status(), 200, "unconditional refetch must recover");
    assert_eq!(
        mock.jwks_fetches(),
        fetches_after_warm + 2,
        "conditional GET (304) + unconditional GET (200)"
    );
}

// [covers:auth-oauth.cimd-fetch-cache]
#[tokio::test]
async fn cimd_cached_within_ttl_and_304_keeps_document() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let _ = flow;
    let fetches = mock.cimd_fetches();
    assert!(fetches >= 1);
    // within the TTL another authorize does not refetch
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    let _ = req_id;
    assert_eq!(mock.cimd_fetches(), fetches, "cache hit");

    // expire the cache -> refetch (conditional GET with the stored etag; the
    // mock answers 304 -> the cached document is kept and reused)
    sqlx::query("UPDATE oauth_clients SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (_, challenge) = pkce_pair();
    let req_id = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    assert!(!req_id.is_empty());
    assert_eq!(mock.cimd_fetches(), fetches + 1, "refetch after expiry");
    // the 304 refreshed the cache: another authorize stays cached
    let (_, challenge) = pkce_pair();
    let _ = oauth::authorize(&router, &client, &mock, &challenge, None, None).await;
    assert_eq!(mock.cimd_fetches(), fetches + 1, "304 refreshed the ttl");
}

// [covers:auth-oauth.cimd-stale-if-error]
#[tokio::test]
async fn cimd_stale_if_error_window() {
    let (router, pool, mock, client, issuer) = setup().await;
    let _ = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // expire (recently, still inside the 24h stale window) + take the mock down
    sqlx::query("UPDATE oauth_clients SET expires_at = ?")
        .bind(budget_book::auth::session::now_ms() - 1_000)
        .execute(&pool)
        .await
        .unwrap();
    mock.set_mode(MockMode::Error);
    let (_, challenge) = pkce_pair();
    let resp = client
        .get(&router, &format!("/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
            oauth::urlencode(&mock.client_id), oauth::urlencode(&mock.redirect_uri)))
        .await;
    assert_eq!(
        resp.status(),
        302,
        "stale document serves the authorize flow"
    );

    // beyond 24h past expiry -> invalid client, error page
    sqlx::query("UPDATE oauth_clients SET expires_at = 1, fetched_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (_, challenge) = pkce_pair();
    let resp = client
        .get(&router, &format!("/oauth/authorize?response_type=code&client_id={}&redirect_uri={}&code_challenge={challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
            oauth::urlencode(&mock.client_id), oauth::urlencode(&mock.redirect_uri)))
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-oauth.safe-fetch-rules]
#[tokio::test]
async fn safe_fetch_refuses_redirects_and_oversize() {
    let mock = oauth::spawn_mock().await;
    let fetch = budget_book::auth::oauth::net::FetchClient::new(true);
    mock.set_mode(MockMode::Redirect);
    let res = fetch.fetch_json(&mock.client_id, None).await;
    assert!(matches!(
        res,
        Err(budget_book::auth::oauth::net::FetchError::Redirect)
    ));
    mock.set_mode(MockMode::Normal);
    let res = fetch
        .fetch_json(&format!("http://{}/huge", mock.addr), None)
        .await;
    assert!(matches!(
        res,
        Err(budget_book::auth::oauth::net::FetchError::TooLarge)
    ));
    // loopback http only with the dev switch
    let strict = budget_book::auth::oauth::net::FetchClient::new(false);
    let res = strict.fetch_json(&mock.client_id, None).await;
    assert!(matches!(
        res,
        Err(budget_book::auth::oauth::net::FetchError::ForbiddenHost(_))
    ));
}

// [covers:auth-oauth.revoke-endpoint]
#[tokio::test]
async fn revoke_revokes_grant_for_both_token_kinds() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;

    // no client authentication (client identifies itself but sends no
    // assertion while declaring private_key_jwt) -> 401
    let resp = post_form(
        &router,
        "/oauth/revoke",
        &format!(
            "token={}&client_id={}",
            flow.refresh_token,
            oauth::urlencode(&mock.client_id)
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // revoke with the refresh token -> grant gone
    let jti = oauth::b64url_of_random();
    let resp = post_form(
        &router,
        "/oauth/revoke",
        &format!(
            "token={}&client_assertion={}&client_assertion_type={ASSERTION_TYPE}",
            flow.refresh_token,
            fresh_assertion(&mock, &issuer, &jti)
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);
    let revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.is_some());
    // the access token no longer authenticates /mcp
    let resp = oauth::post_form(
        &router,
        "/mcp",
        "{}",
        &[("authorization", format!("Bearer {}", flow.access_token))],
    )
    .await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    // unknown token -> 200
    let jti = oauth::b64url_of_random();
    let resp = post_form(
        &router,
        "/oauth/revoke",
        &format!(
            "token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&client_assertion={}&client_assertion_type={ASSERTION_TYPE}",
            fresh_assertion(&mock, &issuer, &jti)
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);

    // access token also revokes the (new) grant
    let flow2 = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let jti = oauth::b64url_of_random();
    let resp = post_form(
        &router,
        "/oauth/revoke",
        &format!(
            "token={}&client_assertion={}&client_assertion_type={ASSERTION_TYPE}",
            flow2.access_token,
            fresh_assertion(&mock, &issuer, &jti)
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);
    let revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_grants WHERE id = ?")
            .bind(flow2.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.is_some());
}

// [covers:auth-oauth.jwks-key-selection]
#[tokio::test]
async fn jwks_rotation_es256_and_kty_mismatch() {
    let (router, _pool, mock, client, issuer) = setup().await;
    // rotation overlap: k0 and k1 published together, both accepted
    mock.set_extra_kids(&["k0"]);
    let exchange = |kid: &'static str, alg: jsonwebtoken::Algorithm| {
        let router = router.clone();
        let mock_client_id = mock.client_id.clone();
        let mock_redirect = mock.redirect_uri.clone();
        let issuer = issuer.clone();
        let client = &client;
        let mock = &mock;
        async move {
            let (verifier, challenge) = pkce_pair();
            let code = get_code(&router, client, mock, &challenge, None).await;
            let jti = oauth::b64url_of_random();
            let assertion = oauth::make_assertion_alg(alg, &mock_client_id, &issuer, kid, &jti);
            let form = format!(
                "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_assertion={assertion}&client_assertion_type={ASSERTION_TYPE}",
                oauth::urlencode(&mock_redirect)
            );
            post_form(&router, "/oauth/token", &form, &[])
                .await
                .status()
        }
    };
    use jsonwebtoken::Algorithm::{ES256, RS256};
    assert_eq!(exchange("k1", RS256).await, 200, "current RSA kid");
    assert_eq!(exchange("k0", RS256).await, 200, "overlapping RSA kid");
    // ES256 with the published P-256 key
    assert_eq!(exchange(oauth::EC_KID, ES256).await, 200, "ES256 accepted");
    // kty / alg mismatch: an RS256 header pointing at an EC key, an ES256
    // header pointing at an RSA key, and an EC key labelled alg RS256
    assert_eq!(
        exchange(oauth::EC_KID, RS256).await,
        StatusCode::UNAUTHORIZED,
        "RS256 must not use an EC key"
    );
    assert_eq!(
        exchange("k1", ES256).await,
        StatusCode::UNAUTHORIZED,
        "ES256 must not use an RSA key"
    );
    assert_eq!(
        exchange(oauth::MISMATCH_KID, ES256).await,
        StatusCode::UNAUTHORIZED,
        "a JWK whose alg contradicts the header is skipped"
    );
    assert_eq!(
        exchange(oauth::MISMATCH_KID, RS256).await,
        StatusCode::UNAUTHORIZED,
        "an EC key cannot serve RS256 even when labelled so"
    );
}
