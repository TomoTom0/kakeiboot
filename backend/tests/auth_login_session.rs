//! Login, session, CSRF tests (spec_auth.md sections 2-4, 2-5, 3, 11-2).

mod common;

use axum::http::{StatusCode, header};
use common::auth::*;
use sqlx::SqlitePool;
use webauthn_rs::prelude::RequestChallengeResponse;

async fn setup() -> (axum::Router, SqlitePool) {
    let (router, pool, _cfg) = auth_setup().await;
    (router, pool)
}

/// login/start returning the parsed challenge and the ceremony Set-Cookie
/// header (attribute checks).
async fn login_start_raw(
    client: &mut Client,
    router: &axum::Router,
) -> (RequestChallengeResponse, String) {
    let resp = client
        .post(router, "/api/webauthn/login/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    let ceremony = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .find(|c| c.starts_with("__Host-bb_ceremony="))
        .expect("ceremony cookie set");
    client.store_cookies(&resp);
    (
        serde_json::from_value(body_json(resp).await).unwrap(),
        ceremony,
    )
}

async fn login_finish_raw(
    client: &mut Client,
    router: &axum::Router,
    cred: &serde_json::Value,
) -> axum::response::Response<axum::body::Body> {
    client
        .post(
            router,
            "/api/webauthn/login/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await
}

fn cred_value(cred: &webauthn_rs::prelude::PublicKeyCredential) -> serde_json::Value {
    serde_json::to_value(cred).unwrap()
}

/// The single user in a test DB (login helper lookups).
async fn only_user(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT id FROM users")
        .fetch_one(pool)
        .await
        .unwrap()
}

// [covers:auth-login.success-issues-session]
// [covers:auth-session.cookie-attributes]
#[tokio::test]
async fn login_success_issues_session_with_host_cookie() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "loginer").await;

    // register/start response already set a ceremony cookie; check its shape
    // (done below via a fresh start); here: login flow
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM web_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    let (rcr, ceremony_cookie) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);

    // session cookie attributes (spec section 3)
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    let session_cookie = set_cookies
        .iter()
        .find(|c| c.starts_with("__Host-bb_session="))
        .expect("session cookie set");
    for attr in ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"] {
        assert!(
            session_cookie.contains(attr),
            "{attr} missing in {session_cookie}"
        );
    }
    let value = session_cookie.split(';').next().unwrap();
    assert_eq!(value.trim().len(), "__Host-bb_session=".len() + 43);

    // ceremony cookie attributes (spec section 2-5)
    assert!(ceremony_cookie.starts_with("__Host-bb_ceremony="));
    for attr in [
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Strict",
        "Max-Age=300",
    ] {
        assert!(
            ceremony_cookie.contains(attr),
            "{attr} missing in {ceremony_cookie}"
        );
    }
    let body = body_json(resp).await;
    assert_eq!(body["next"], serde_json::Value::Null);

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM web_sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, before + 1, "new session row per login");
    let (auth_at, created_at): (i64, i64) = sqlx::query_as(
        "SELECT auth_at, created_at FROM web_sessions ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(auth_at, created_at, "auth_at = created_at at login");
}

// [covers:auth-login.mismatch-uniform-401-audited]
#[tokio::test]
async fn login_mismatch_is_uniform_401_and_audited() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "gone").await;
    let (handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    // user handle known, credential row removed -> mismatch
    sqlx::query("DELETE FROM webauthn_credentials")
        .execute(&pool)
        .await
        .unwrap();

    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let body = body_json(resp).await;
    assert_eq!(body["error"], "unauthorized");

    let mismatches: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'login_mismatch' AND actor_kind = 'web'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mismatches, 1);
    // only the registration session remains; the failed login issued none
    let sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM web_sessions WHERE revoked_at IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sessions, 1, "no session issued on mismatch");
}

// [covers:auth-login.resolves-by-credential-id]
// Legacy compat (2026-10-17 prod incident): credentials created before the
// challenge handle was persisted present the challenge handle at login while
// users.webauthn_user_handle holds a different uuid. Login resolves the
// owner by credential id (UNIQUE) and must still succeed.
#[tokio::test]
async fn login_succeeds_when_presented_handle_differs_from_stored() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "legacy").await;

    // reproduce the pre-fix row: the stored handle is NOT the challenge
    // handle the credential answers with
    sqlx::query("UPDATE users SET webauthn_user_handle = ?")
        .bind(uuid::Uuid::new_v4().as_bytes().as_slice())
        .execute(&pool)
        .await
        .unwrap();

    // authenticate_discoverable replays the recorded CHALLENGE handle, so
    // the assertion presents a handle != stored handle
    let (stored_handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &stored_handle, &ids);
    assert_ne!(
        cred.response.user_handle.as_ref().unwrap().as_slice(),
        stored_handle.as_slice(),
        "premise: presented handle differs from the stored one"
    );
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), 200);

    // the divergence stays visible in the login audit
    let flagged: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'login'
         AND after_json LIKE '%user_handle_match%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(flagged, 1);
}

// [covers:auth-login.disabled-user-rejected]
#[tokio::test]
async fn login_rejects_disabled_user() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "dis").await;
    sqlx::query("UPDATE users SET disabled_at = 1 WHERE id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();

    let (handle, ids) = user_webauthn_ids(&pool, user).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// [covers:auth-login.counter-regression-rejected-audited]
#[tokio::test]
async fn counter_regression_rejected_and_audited() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "replay").await;

    // one successful login advances the stored counter
    let (handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), 200);

    // a counter at or below the stored value is a regression: bump the
    // stored counter past what the soft token will report next, then sign a
    // fresh challenge (a replayed assertion would fail on the challenge
    // before ever reaching the counter check).
    let pk_json: String = sqlx::query_scalar("SELECT passkey_json FROM webauthn_credentials")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut pk: serde_json::Value = serde_json::from_str(&pk_json).unwrap();
    pk["cred"]["counter"] = serde_json::json!(1_000);
    sqlx::query("UPDATE webauthn_credentials SET passkey_json = ?")
        .bind(pk.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let (handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let regressions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'counter_regression' AND entity_type = 'webauthn_credential'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(regressions, 1);

    // a tampered signature is a non-counter verification failure: 401 with
    // the distinct login_failed audit action.
    let (handle, ids) = user_webauthn_ids(&pool, only_user(&pool).await).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let mut tampered = cred_value(&cred);
    let sig = tampered["response"]["signature"]
        .as_str()
        .unwrap()
        .to_string();
    let mut chars = sig.chars();
    let first = chars.next().unwrap();
    let flipped = format!("{}{}", if first == 'A' { 'B' } else { 'A' }, chars.as_str());
    tampered["response"]["signature"] = serde_json::json!(flipped);
    let resp = login_finish_raw(&mut client, &router, &tampered).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let failed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'login_failed' AND entity_type = 'webauthn_credential'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(failed, 1, "non-counter failures audit as login_failed");
}

// [covers:auth-login.updates-passkey-json-and-last-used]
#[tokio::test]
async fn login_updates_passkey_json_and_last_used() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "updater").await;
    let before: (String, Option<i64>) = sqlx::query_as(
        "SELECT passkey_json, last_used_at FROM webauthn_credentials WHERE user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(before.1, None, "no last_used_at yet");

    let (handle, ids) = user_webauthn_ids(&pool, user).await;
    let (rcr, _) = login_start_raw(&mut client, &router).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = login_finish_raw(&mut client, &router, &cred_value(&cred)).await;
    assert_eq!(resp.status(), 200);

    let after: (String, Option<i64>) = sqlx::query_as(
        "SELECT passkey_json, last_used_at FROM webauthn_credentials WHERE user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(after.0, before.0, "passkey_json updated (counter)");
    assert!(after.1.is_some(), "last_used_at set");
}

// [covers:auth-login.revokes-carried-session-cookie]
#[tokio::test]
async fn login_revokes_carried_session_cookie() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user_a = register_setup_user(&mut a, &router, &pool, "carry-a").await;
    let a_session = a.cookies.get("__Host-bb_session").cloned().unwrap();

    let mut b = Client::new();
    let user_b = register_setup_user(&mut b, &router, &pool, "carry-b").await;

    // b's client carries a's session cookie while logging in as b
    b.cookies
        .insert("__Host-bb_session".into(), a_session.clone());
    login(&mut b, &router, &pool, user_b).await;

    let revoked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE id_hash = ? AND revoked_at IS NOT NULL",
    )
    .bind(cookie_hash(&a_session))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(revoked, 1, "carried session revoked regardless of user");
    let valid_b: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user_b)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        valid_b, 2,
        "b's register session and the fresh login session"
    );
    let _ = user_a;
}

// [covers:auth-login.stores-authz-request-hash]
#[tokio::test]
async fn login_start_stores_authz_request_hash() {
    let (router, pool) = setup().await;
    // oauth_clients + authorization request row (Phase B creates these)
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES ('https://chatgpt.com/x', '{}', '[]', 'none', 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let req_id = budget_book::auth::tokens::random_token();
    let req_str = b64(&req_id);
    let req_hash = budget_book::auth::tokens::sha256(&req_id).to_vec();
    sqlx::query(
        "INSERT INTO oauth_authorization_requests (id_hash, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (?, 'https://chatgpt.com/x', 'https://chatgpt.com/x/cb', 'ccccccccccccccccccccccccccccccccccccccccccc', 'ledger.read', 'https://localhost/mcp', 0, 99999999999999)",
    )
    .bind(&req_hash)
    .execute(&pool)
    .await
    .unwrap();

    let mut client = Client::new();
    let resp = client
        .post(
            &router,
            "/api/webauthn/login/start",
            serde_json::json!({ "req": req_str }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let stored: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT authz_request_hash FROM webauthn_ceremonies ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, Some(req_hash));

    // unknown req is rejected
    let resp = client
        .post(
            &router,
            "/api/webauthn/login/start",
            serde_json::json!({
                "req": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-session.validation-rejects-stale]
#[tokio::test]
async fn session_validation_rejects_stale_sessions() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "stale").await;
    let mut tokens = vec![client.cookies.get("__Host-bb_session").cloned().unwrap()];
    for _ in 0..3 {
        // do not carry the previous session: a carried cookie is revoked on login
        client.cookies.remove("__Host-bb_session");
        login(&mut client, &router, &pool, user).await;
        tokens.push(client.cookies.get("__Host-bb_session").cloned().unwrap());
    }
    assert_eq!(tokens.len(), 4);

    let now = budget_book::auth::session::now_ms();
    let take = |tokens: &mut Vec<String>| tokens.pop().unwrap();
    let mut c = Client::new();

    // idle expired
    let t = take(&mut tokens);
    sqlx::query("UPDATE web_sessions SET idle_expires_at = ? WHERE id_hash = ?")
        .bind(now - 1000)
        .bind(cookie_hash(&t))
        .execute(&pool)
        .await
        .unwrap();
    c.cookies.insert("__Host-bb_session".into(), t);
    assert_eq!(
        c.get(&router, "/api/auth/me").await.status(),
        StatusCode::UNAUTHORIZED
    );

    // absolute expired
    c.cookies.remove("__Host-bb_session");
    let t = take(&mut tokens);
    sqlx::query("UPDATE web_sessions SET absolute_expires_at = ? WHERE id_hash = ?")
        .bind(now - 1000)
        .bind(cookie_hash(&t))
        .execute(&pool)
        .await
        .unwrap();
    c.cookies.insert("__Host-bb_session".into(), t);
    assert_eq!(
        c.get(&router, "/api/auth/me").await.status(),
        StatusCode::UNAUTHORIZED
    );

    // revoked
    c.cookies.remove("__Host-bb_session");
    let t = take(&mut tokens);
    sqlx::query("UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ?")
        .bind(now - 1000)
        .bind(cookie_hash(&t))
        .execute(&pool)
        .await
        .unwrap();
    c.cookies.insert("__Host-bb_session".into(), t);
    assert_eq!(
        c.get(&router, "/api/auth/me").await.status(),
        StatusCode::UNAUTHORIZED
    );

    // user disabled after the fact
    let t = take(&mut tokens);
    sqlx::query("UPDATE users SET disabled_at = ? WHERE id = ?")
        .bind(now)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    c.cookies.insert("__Host-bb_session".into(), t);
    assert_eq!(
        c.get(&router, "/api/auth/me").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

// [covers:auth-session.last-seen-update-throttled]
#[tokio::test]
async fn last_seen_update_is_throttled() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "throttle").await;
    let token = client.cookies.get("__Host-bb_session").cloned().unwrap();
    let hash = cookie_hash(&token);
    let now = budget_book::auth::session::now_ms();

    // fresh: within the 5-minute window -> no write
    let resp = client.get(&router, "/api/auth/me").await;
    assert_eq!(resp.status(), 200);
    let seen: i64 = sqlx::query_scalar("SELECT last_seen_at FROM web_sessions WHERE id_hash = ?")
        .bind(&hash)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        now - seen < 60_000,
        "recently seen, not rewritten immediately"
    );

    // 6 minutes old -> rewritten together with idle_expires_at
    sqlx::query("UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ?")
        .bind(now - 6 * 60_000)
        .bind(&hash)
        .execute(&pool)
        .await
        .unwrap();
    let idle_before: i64 =
        sqlx::query_scalar("SELECT idle_expires_at FROM web_sessions WHERE id_hash = ?")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    let resp = client.get(&router, "/api/auth/me").await;
    assert_eq!(resp.status(), 200);
    let (seen2, idle2): (i64, i64) =
        sqlx::query_as("SELECT last_seen_at, idle_expires_at FROM web_sessions WHERE id_hash = ?")
            .bind(&hash)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(seen2 > now - 60_000, "last_seen_at refreshed");
    assert!(idle2 > idle_before, "idle_expires_at renewed");
}

// [covers:auth-session.me-returns-user-info]
#[tokio::test]
async fn me_returns_user_info() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "me-user").await;
    let resp = client.get(&router, "/api/auth/me").await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["user_id"].as_i64(), Some(user));
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(body["account_number"].as_str().unwrap(), account);
    assert_eq!(body["display_name"], "me-user");
    let ledgers = body["ledgers"].as_array().unwrap();
    assert_eq!(ledgers.len(), 1);
    // TASK-16: auto-created ledger name, per-user color and default_ledger_id
    assert_eq!(ledgers[0]["name"], "default book");
    assert_eq!(ledgers[0]["role"], "owner");
    assert_eq!(ledgers[0]["color"], "teal");
    assert!(ledgers[0]["id"].is_i64());
    assert_eq!(body["default_ledger_id"], ledgers[0]["id"]);
    assert!(body["auth_at"].is_i64());

    // TASK-16: a default_ledger_id pointing outside the memberships (the
    // user left that ledger) is filtered to null in the me response
    let stranger_ledger = 9101;
    common::insert_ledger(&pool, stranger_ledger).await;
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(stranger_ledger)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = client.get(&router, "/api/auth/me").await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert!(body["default_ledger_id"].is_null());
}

// [covers:auth-session.logout-clears-cookie]
#[tokio::test]
async fn logout_revokes_only_that_session_and_clears_cookie() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "bye").await;
    client.cookies.remove("__Host-bb_session");
    login(&mut client, &router, &pool, user).await;
    assert_eq!(user_session_hashes(&pool, user).await.len(), 2);

    let resp = client
        .post(&router, "/api/auth/logout", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert!(
        set_cookies
            .iter()
            .any(|c| c.starts_with("__Host-bb_session=;") && c.contains("Max-Age=0")),
        "cookie cleared: {set_cookies:?}"
    );
    assert_eq!(
        user_session_hashes(&pool, user).await.len(),
        1,
        "other session survives"
    );
}

// [covers:auth-session.logout-all-revokes-user-sessions]
#[tokio::test]
async fn logout_all_revokes_every_session() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "bye-all").await;
    for _ in 0..2 {
        client.cookies.remove("__Host-bb_session");
        login(&mut client, &router, &pool, user).await;
    }
    assert_eq!(user_session_hashes(&pool, user).await.len(), 3);

    let resp = client
        .post(&router, "/api/auth/logout-all", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    assert_eq!(user_session_hashes(&pool, user).await.len(), 0);
}

// [covers:auth-csrf.origin-enforced-on-mutations]
#[tokio::test]
async fn origin_is_enforced_on_mutations() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "csrf").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();

    // no origin -> 403
    let resp = Client::post_raw(
        &router,
        "/api/auth/logout",
        &[("content-type", "application/json".to_string())],
        "{}",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // wrong origin -> 403
    let resp = Client::post_raw(
        &router,
        "/api/auth/logout",
        &[
            ("content-type", "application/json".to_string()),
            ("origin", "http://evil.example".to_string()),
            ("cookie", format!("__Host-bb_session={session}")),
        ],
        "{}",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // matching origin -> reaches the handler (204 with a valid session)
    let resp = Client::post_raw(
        &router,
        "/api/auth/logout",
        &[
            ("content-type", "application/json".to_string()),
            ("origin", ORIGIN.to_string()),
            ("cookie", format!("__Host-bb_session={session}")),
        ],
        "{}",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

// [covers:auth-csrf.json-only-content-type]
#[tokio::test]
async fn api_accepts_json_content_type_only() {
    let (router, _pool) = setup().await;
    let resp = Client::post_raw(
        &router,
        "/api/webauthn/login/start",
        &[
            ("content-type", "text/plain".to_string()),
            ("origin", ORIGIN.to_string()),
        ],
        "{}",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

    // charset parameter is accepted
    let resp = Client::post_raw(
        &router,
        "/api/webauthn/login/start",
        &[
            (
                "content-type",
                "application/json; charset=utf-8".to_string(),
            ),
            ("origin", ORIGIN.to_string()),
        ],
        "{}",
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
}
