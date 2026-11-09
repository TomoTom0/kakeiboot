//! Passkey management and step-up tests (spec_auth.md sections 2-6, 2-7,
//! 3-2): list / add / rename / delete, reauth flow, web invitation issue.

mod common;

use axum::http::StatusCode;
use common::auth::*;
use sqlx::{Connection, SqlitePool};

async fn setup() -> (axum::Router, SqlitePool) {
    let (router, pool, _cfg) = auth_setup().await;
    (router, pool)
}

fn stale_auth_at(
    pool: &SqlitePool,
    user_id: i64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>> {
    Box::pin(async move {
        let now = budget_book::auth::session::now_ms();
        sqlx::query("UPDATE web_sessions SET auth_at = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(now - 11 * 60_000)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
    })
}

// [covers:auth-passkey.list-requires-session]
#[tokio::test]
async fn passkey_list_requires_session() {
    let (router, _pool) = setup().await;
    let resp = Client::new().get(&router, "/api/passkeys").await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// [covers:auth-passkey.add-without-stepup]
#[tokio::test]
async fn passkey_add_works_without_step_up() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "adder").await;

    // TASK-46: passkey add no longer demands step-up — a session whose
    // auth_at is well past the 10-minute window still starts and finishes.
    stale_auth_at(&pool, user).await;
    let resp = client
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), StatusCode::OK, "{}", body_text(resp).await);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred, "label": "second key" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK, "{}", body_text(resp).await);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 2, "the add completed without any reauth");
}

// [covers:auth-reauth.renews-auth-at]
// [covers:auth-passkey.add-finish-inserts-credential]
#[tokio::test]
async fn reauth_renews_auth_at_and_unlocks_passkey_delete() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "stepper").await;
    stale_auth_at(&pool, user).await;

    // step-up via non-discoverable reauth
    let resp = client
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.authenticate(rcr);
    let resp = client
        .post(
            &router,
            "/api/webauthn/reauth/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let auth_at: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        budget_book::auth::session::now_ms() - auth_at < 60_000,
        "auth_at renewed"
    );

    // passkey add needs no step-up anymore (TASK-46): the second credential
    // lands on the renewed session all the same (same client = second
    // credential on the soft token)
    let resp = client
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({
                "credential": cred, "label": "second key"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);

    let creds: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, label FROM webauthn_credentials WHERE user_id = ? ORDER BY id")
            .bind(user)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(creds.len(), 2, "two credentials for the user");
    assert_eq!(creds[1].1.as_deref(), Some("second key"));
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'webauthn_credential' AND action = 'create' AND user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 1, "passkey add audited");

    // the step-up gate now guards deletion only (TASK-46): the renewed
    // auth_at lets the delete through — the gated operation is unlocked
    let resp = client
        .delete(&router, &format!("/api/passkeys/{}", creds[0].0))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1);
}

// [covers:auth-reauth.rejects-other-user-and-ceremony-mismatch]
#[tokio::test]
async fn reauth_rejects_other_user_and_mismatched_ceremony() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "reauth-a").await;
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "reauth-b").await;
    stale_auth_at(&pool, a_user).await;

    // (1) A's ceremony only allows A's credentials: B's token cannot even
    // produce an assertion for it (server-side allow list in the challenge).
    let resp = a
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    assert!(
        b.try_authenticate(rcr).is_err(),
        "another user's passkey cannot sign this challenge"
    );

    // (2) ceremony of B finished with A's session -> 403, ceremony consumed
    let resp = b
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    b.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let b_ceremony = b.cookies.get("__Host-bb_ceremony").cloned().unwrap();
    let b_cred = b.authenticate(rcr);
    // a's session cookie + b's ceremony cookie
    a.cookies
        .insert("__Host-bb_ceremony".into(), b_ceremony.clone());
    let resp = a
        .post(
            &router,
            "/api/webauthn/reauth/finish",
            serde_json::json!({ "credential": b_cred }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_ceremonies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 1,
        "mismatched ceremony deleted, A's unused one remains"
    );
    let auth_at: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(a_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        budget_book::auth::session::now_ms() - auth_at > 5 * 60_000,
        "A's auth_at untouched"
    );
}

// ---------------------------------------------------------------------------
// TASK-154: step-up re-authentication counter freshness and the out-of-tx
// credential update (design tmp/tasks/tm-154/design_reauth-counter.md 5-3).
// The SoftPasskey counter advances in signing order, so every case signs the
// reauth assertion FIRST and any competing-login assertion after it. The
// competing login runs in a fresh browser context (no cookies at all):
// carrying the reauth session would revoke it in login_finish (spec 2-4) and
// the 401 would never reach the counter check. Finishes always send the
// session and ceremony cookies explicitly (the TASK-147 cookie-separation
// premise). ~6 /api/webauthn/* requests per case (IP limit 20/min, spec 10-1).

/// The value of a cookie from a Set-Cookie header.
fn set_cookie_value(resp: &axum::response::Response<axum::body::Body>, name: &str) -> String {
    use axum::http::header;
    resp.headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .find(|c| c.starts_with(name) && c.trim_start_matches(name).starts_with('='))
        .unwrap_or_else(|| panic!("{name} cookie set"))
        .split_once('=')
        .unwrap()
        .1
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

fn cred_value(cred: &webauthn_rs::prelude::PublicKeyCredential) -> serde_json::Value {
    serde_json::to_value(cred).unwrap()
}

/// The stored `$.cred.counter` of the single credential.
async fn stored_counter(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar(
        "SELECT json_extract(passkey_json, '$.cred.counter') FROM webauthn_credentials",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// POST carrying exactly the given cookies (and no others); `&[]` sends no
/// cookie header at all (a fresh browser context).
async fn post_with_cookies(
    router: axum::Router,
    path: &str,
    cookies: &[(&str, String)],
    body: serde_json::Value,
) -> axum::response::Response<axum::body::Body> {
    use tower::ServiceExt;
    let mut builder = axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("origin", ORIGIN)
        .header("user-agent", "test-agent Chrome/130.0");
    if !cookies.is_empty() {
        builder = builder.header(
            "cookie",
            cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; "),
        );
    }
    router
        .oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

/// reauth/start over the client's session; returns the challenge and the
/// ceremony cookie pair (finishes send it explicitly).
async fn reauth_start_raw(
    client: &mut Client,
    router: &axum::Router,
) -> (webauthn_rs::prelude::RequestChallengeResponse, String) {
    let resp = client
        .post(router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let ceremony = set_cookie_value(&resp, "__Host-bb_ceremony");
    client.store_cookies(&resp);
    (
        serde_json::from_value(body_json(resp).await).unwrap(),
        ceremony,
    )
}

/// reauth/finish carrying exactly the reauth session and ceremony cookies.
/// Takes them owned: the request future must be `'static` to be spawned into
/// the test-hook park.
async fn reauth_finish_raw(
    router: axum::Router,
    session: String,
    ceremony: String,
    cred: serde_json::Value,
) -> axum::response::Response<axum::body::Body> {
    post_with_cookies(
        router,
        "/api/webauthn/reauth/finish",
        &[
            ("__Host-bb_session", session),
            ("__Host-bb_ceremony", ceremony),
        ],
        serde_json::json!({ "credential": cred }),
    )
    .await
}

/// A competing login from a fresh browser context (no cookies — carrying the
/// reauth session would revoke it, spec 2-4) signed by the same soft token
/// AFTER the reauth assertion (its counter is the larger one). Returns the
/// stored counter once the login has completed.
async fn competing_login_advances_counter(
    router: &axum::Router,
    pool: &SqlitePool,
    client: &mut Client,
    user: i64,
) -> i64 {
    let resp = post_with_cookies(
        router.clone(),
        "/api/webauthn/login/start",
        &[],
        serde_json::json!({}),
    )
    .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let ceremony = set_cookie_value(&resp, "__Host-bb_ceremony");
    let rcr = serde_json::from_value(body_json(resp).await).unwrap();
    let (handle, ids) = user_webauthn_ids(pool, user).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &ids);
    let resp = post_with_cookies(
        router.clone(),
        "/api/webauthn/login/finish",
        &[("__Host-bb_ceremony", ceremony)],
        serde_json::json!({ "credential": cred_value(&cred) }),
    )
    .await;
    assert_eq!(
        resp.status(),
        200,
        "competing login completes: {}",
        body_text(resp).await
    );
    stored_counter(pool).await
}

/// Test hook that parks the first armed reauth_finish immediately before its
/// BEGIN IMMEDIATE until released (later requests pass through). Until
/// reauth_finish is instrumented (TASK-154 implementation pending) the hook
/// is never awaited, so [`ReauthPark::park`] also returns when the request
/// simply runs to completion — the test proceeds linearly, which keeps the
/// pre-fix behavior deterministic.
#[cfg(feature = "test-hooks")]
struct ReauthPark {
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    reached: std::sync::Arc<tokio::sync::Notify>,
    release: std::sync::Arc<tokio::sync::Notify>,
}

#[cfg(feature = "test-hooks")]
enum Stepped<Out> {
    /// The request is parked at the hook; release() then await the handle.
    Parked(tokio::task::JoinHandle<Out>),
    /// The request finished without ever reaching the hook (pre-fix).
    Done(Out),
}

#[cfg(feature = "test-hooks")]
impl ReauthPark {
    fn new() -> Self {
        Self {
            armed: Default::default(),
            reached: Default::default(),
            release: Default::default(),
        }
    }

    fn hooks(&self) -> budget_book::test_hooks::TestHooks {
        use std::sync::atomic::Ordering;
        let (armed, reached, release) = (
            self.armed.clone(),
            self.reached.clone(),
            self.release.clone(),
        );
        let hook: budget_book::test_hooks::Hook = std::sync::Arc::new(move || {
            let (armed, reached, release) = (armed.clone(), reached.clone(), release.clone());
            Box::pin(async move {
                if armed.swap(false, Ordering::SeqCst) {
                    reached.notify_one();
                    release.notified().await;
                }
            })
        });
        budget_book::test_hooks::TestHooks {
            reauth_before_write_lock: Some(hook),
            ..Default::default()
        }
    }

    /// Arm, spawn `fut` and wait until it parks at the hook or completes.
    async fn park<F>(&self, fut: F) -> Stepped<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        use std::sync::atomic::Ordering;
        self.armed.store(true, Ordering::SeqCst);
        let mut handle = tokio::spawn(fut);
        tokio::select! {
            _ = self.reached.notified() => Stepped::Parked(handle),
            out = &mut handle => Stepped::Done(out.expect("reauth finish task panicked")),
        }
    }

    fn release(&self) {
        self.release.notify_one();
    }
}

// [covers:auth-reauth.concurrent-counter-monotonic]
// The reauth assertion R (c+1, signed first) is parked just before the write
// lock while a cookie-less competing login (c+2, signed after R) completes.
// The stored counter must not roll back to R's value and R must be rejected
// against the fresh stored value (401, WARN only — step-up failures write no
// audit row). Pre-fix the hook is never called, so R completes at spawn time
// and is accepted under the stale snapshot (red).
#[cfg(feature = "test-hooks")]
#[tokio::test]
async fn concurrent_reauth_parked_assertion_cannot_roll_back_counter() {
    let park = ReauthPark::new();
    let (router, pool, _dir) = auth_setup_file_with_hooks(park.hooks()).await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "reauth-racer").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();

    let (rcr, ceremony) = reauth_start_raw(&mut client, &router).await;
    let reauth_cred = cred_value(&client.authenticate(rcr)); // counter c+1
    let audits_before: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'counter_regression'")
            .fetch_one(&pool)
            .await
            .unwrap();

    let stepped = park
        .park(reauth_finish_raw(
            router.clone(),
            session.clone(),
            ceremony.clone(),
            reauth_cred,
        ))
        .await;

    let before_login = stored_counter(&pool).await;
    let counter_after_login =
        competing_login_advances_counter(&router, &pool, &mut client, user).await;
    assert!(
        counter_after_login > before_login,
        "premise: the competing login advances the stored counter past the reauth snapshot"
    );

    let resp = match stepped {
        Stepped::Parked(task) => {
            park.release();
            task.await.unwrap()
        }
        Stepped::Done(resp) => resp,
    };
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "the parked older assertion loses to the newer stored counter"
    );
    assert_eq!(
        stored_counter(&pool).await,
        counter_after_login,
        "the stored counter never rolls back to the parked reauth assertion"
    );
    let audits: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'counter_regression'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        audits - audits_before,
        0,
        "step-up failures log WARN only, no audit_events row"
    );
}

// [covers:auth-reauth.delayed-assertion-rejected]
// Direct TTL-window reproduction, no hook: the reauth ceremony snapshots
// counter c at start; a cookie-less login then advances the stored counter;
// the assertion R (c+1) still satisfies the stale snapshot (pre-fix:
// accepted, red) but regresses against the fresh stored value and must be
// rejected without touching auth_at or the stored counter.
#[tokio::test]
async fn delayed_reauth_assertion_after_login_is_rejected() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "reauth-delayed").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();
    let auth_at_before: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();

    let (rcr, ceremony) = reauth_start_raw(&mut client, &router).await;
    let reauth_cred = cred_value(&client.authenticate(rcr)); // c+1 vs snapshot c

    let counter_after_login =
        competing_login_advances_counter(&router, &pool, &mut client, user).await;

    // pin the final read to session A's row: the cookie-less competing login
    // issued a second live session for the same user, and fetch_one over the
    // id_hash-keyed table picks an arbitrary one
    let session_hash = cookie_hash(&session);
    let resp = reauth_finish_raw(router.clone(), session, ceremony, reauth_cred).await;
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "an assertion behind the stored counter is rejected even inside the ceremony TTL"
    );
    assert_eq!(
        stored_counter(&pool).await,
        counter_after_login,
        "the stored counter stays at the login value"
    );
    let auth_at: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE id_hash = ? AND revoked_at IS NULL",
    )
    .bind(&session_hash)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(auth_at, auth_at_before, "auth_at is not renewed on the 401");
}

// [covers:auth-reauth.sequential-both-succeed]
// Arrivals in signing order never hit the fresh-counter rule: two reauth
// rounds on one session both succeed, the stored counter only moves forward
// and the same session row's auth_at is renewed (no false rejections; a
// counter-0-fixed authenticator passes the rule as received=0/stored=0 and
// cannot be produced by the soft token — recorded as a rule, not a case).
#[tokio::test]
async fn sequential_reauths_in_generation_order_both_succeed() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "reauth-seq").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();
    // pin every session read to session A's row (id_hash-keyed table)
    let session_hash = cookie_hash(&session);

    let mut last = stored_counter(&pool).await;
    for round in 0..2 {
        // age the step-up freshness first: registration leaves auth_at inside
        // the freshness window, so without aging a missing renewal would
        // still satisfy the assertion below
        stale_auth_at(&pool, user).await;
        let (rcr, ceremony) = reauth_start_raw(&mut client, &router).await;
        let cred = cred_value(&client.authenticate(rcr));
        let resp = reauth_finish_raw(router.clone(), session.clone(), ceremony, cred).await;
        assert_eq!(
            resp.status(),
            200,
            "round {round}: {}",
            body_text(resp).await
        );
        let counter = stored_counter(&pool).await;
        assert!(
            counter > last,
            "round {round}: the stored counter only moves forward"
        );
        last = counter;
        let auth_at: i64 = sqlx::query_scalar(
            "SELECT auth_at FROM web_sessions WHERE id_hash = ? AND revoked_at IS NULL",
        )
        .bind(&session_hash)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(
            budget_book::auth::session::now_ms() - auth_at < 60_000,
            "round {round}: auth_at renewed on the same session row"
        );
    }
}

// [covers:auth-reauth.atomic-rollback-on-session-vanish]
// The session row vanishing between the handler's session check and the
// reauth write must fail the whole step-up: the auth_at UPDATE touching 0
// rows rolls the credential update (counter, last_used_at) back with it. A
// partial fix that only adds the counter re-check but keeps autocommit
// writes would advance the stored counter — caught here too. Pre-fix the
// request completes at spawn time (200, writes already landed): red.
#[cfg(feature = "test-hooks")]
#[tokio::test]
async fn reauth_rolls_back_when_session_row_vanishes_under_park() {
    let park = ReauthPark::new();
    let (router, pool, _dir) = auth_setup_file_with_hooks(park.hooks()).await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "reauth-vanish").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();
    let counter_before = stored_counter(&pool).await;

    let (rcr, ceremony) = reauth_start_raw(&mut client, &router).await;
    let cred = cred_value(&client.authenticate(rcr)); // generation order

    let stepped = park
        .park(reauth_finish_raw(
            router.clone(),
            session.clone(),
            ceremony.clone(),
            cred,
        ))
        .await;

    // the session row disappears while the finish is in flight
    sqlx::query("DELETE FROM web_sessions WHERE id_hash = ?")
        .bind(cookie_hash(&session))
        .execute(&pool)
        .await
        .unwrap();

    let resp = match stepped {
        Stepped::Parked(task) => {
            park.release();
            task.await.unwrap()
        }
        Stepped::Done(resp) => resp,
    };
    assert_eq!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "0 updated session rows fail the step-up instead of silently succeeding"
    );
    assert_eq!(
        stored_counter(&pool).await,
        counter_before,
        "the credential update rolls back with the failed auth_at update"
    );
    let last_used: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM webauthn_credentials")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        last_used, None,
        "last_used_at rolls back in the same transaction"
    );
}

// [covers:auth-reauth.ceremony-single-consume]
// One ceremony accepts exactly one submission: while the first finish is
// parked mid-flight (post-fix: past the atomic ceremony consumption, before
// the write lock), the same ceremony + assertion submitted again is rejected
// as ceremony_invalid, and only the released first request succeeds. Pre-fix
// (no hook call) the first request completes at spawn time, so the
// re-submission degenerates to the sequential case with the same outcome —
// the assertion holds before and after the fix (green pinning).
#[cfg(feature = "test-hooks")]
#[tokio::test]
async fn reauth_ceremony_is_consumed_exactly_once() {
    let park = ReauthPark::new();
    let (router, pool, _dir) = auth_setup_file_with_hooks(park.hooks()).await;
    let mut client = Client::new();
    register_setup_user(&mut client, &router, &pool, "reauth-once").await;
    let session = client.cookies.get("__Host-bb_session").cloned().unwrap();

    let (rcr, ceremony) = reauth_start_raw(&mut client, &router).await;
    let cred = cred_value(&client.authenticate(rcr));

    let stepped = park
        .park(reauth_finish_raw(
            router.clone(),
            session.clone(),
            ceremony.clone(),
            cred.clone(),
        ))
        .await;

    // the same ceremony + assertion again while the first finish is in flight
    let resp2 = reauth_finish_raw(router.clone(), session, ceremony, cred).await;
    assert_eq!(resp2.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp2).await["error"], "ceremony_invalid");

    let resp1 = match stepped {
        Stepped::Parked(task) => {
            park.release();
            task.await.unwrap()
        }
        Stepped::Done(resp) => resp,
    };
    assert_eq!(
        resp1.status(),
        StatusCode::OK,
        "exactly one submission of the ceremony succeeds: {}",
        body_text(resp1).await
    );
    // the ceremony row is gone (consumed by the successful submission only —
    // no residue for a third attempt either)
    let ceremonies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_ceremonies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(ceremonies, 0, "the ceremony row is consumed exactly once");
}

// [covers:auth-passkey.rename-label]
#[tokio::test]
async fn rename_own_passkey_only() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    register_setup_user(&mut a, &router, &pool, "renamer").await;
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "other").await;

    let a_cred_id: i64 = sqlx::query_scalar(
        "SELECT c.id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'renamer'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let b_cred_id: i64 = sqlx::query_scalar(
        "SELECT c.id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'other'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{a_cred_id}"),
            serde_json::json!({ "label": "renamed" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let label: String = sqlx::query_scalar("SELECT label FROM webauthn_credentials WHERE id = ?")
        .bind(a_cred_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(label, "renamed");

    let resp = b
        .patch(
            &router,
            &format!("/api/passkeys/{a_cred_id}"),
            serde_json::json!({ "label": "steal" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let _ = b_cred_id;
}

// [covers:auth-passkey.rename-label]
#[tokio::test]
async fn rename_label_cap_counts_characters_not_bytes() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "labeler").await;
    let cred_id: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // 100 multibyte characters = 300 bytes: accepted (the cap counts chars)
    let label = "あ".repeat(100);
    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{cred_id}"),
            serde_json::json!({ "label": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let stored: String = sqlx::query_scalar("SELECT label FROM webauthn_credentials WHERE id = ?")
        .bind(cred_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored.chars().count(), 100);

    // 101 characters (303 bytes): rejected
    let label = "あ".repeat(101);
    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{cred_id}"),
            serde_json::json!({ "label": label }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "invalid_label");
}

// [covers:auth-passkey.delete-last-one-409]
#[tokio::test]
async fn deleting_last_passkey_conflicts() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "single").await;
    let only: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);

    // add a second one, then deletion succeeds (auth_at is fresh from login)
    login(&mut a, &router, &pool, user).await;
    let resp = a
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = a.register(ccr);
    let resp = a
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1);
}

// [covers:auth-passkey.delete-last-one-409]
#[tokio::test]
async fn concurrent_deletes_cannot_remove_the_last_passkey() {
    // A real file DB with a multi-connection pool: concurrent requests use
    // separate connections and actually contend for the SQLite write lock
    // (the in-memory setup has max_connections = 1 and serializes everything).
    let (router, pool, _dir) = auth_setup_file().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "racer").await;
    // second credential so two ids can be targeted concurrently
    let resp = a
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = a.register(ccr);
    let resp = a
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ? ORDER BY id")
            .bind(user)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ids.len(), 2);

    // Barrier: a third connection holds the SQLite write lock so both DELETE
    // requests run concurrently, pile up on their BEGIN IMMEDIATE and only
    // proceed once the gate releases -- their count checks genuinely overlap
    // the same write window.
    let gate_pool = pool.clone();
    let gate = tokio::spawn(async move {
        let mut conn = gate_pool.acquire().await.unwrap();
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("SELECT COUNT(*) FROM webauthn_credentials")
            .execute(&mut *tx)
            .await
            .unwrap();
        // hold the write lock long enough for both requests to reach their
        // BEGIN IMMEDIATE and wait (busy_timeout = 5s in the repo config)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        tx.commit().await.unwrap();
    });
    let path0 = format!("/api/passkeys/{}", ids[0]);
    let path1 = format!("/api/passkeys/{}", ids[1]);
    let (r1, r2) = tokio::join!(a.delete(&router, &path0), a.delete(&router, &path1));
    gate.await.unwrap();
    let statuses = [r1.status(), r2.status()];
    assert!(
        !statuses.contains(&StatusCode::INTERNAL_SERVER_ERROR),
        "both requests must survive the lock contention: {statuses:?}"
    );
    assert!(statuses.contains(&StatusCode::NO_CONTENT), "{statuses:?}");
    assert!(
        statuses.contains(&StatusCode::CONFLICT),
        "one delete must hit the last-passkey conflict: {statuses:?}"
    );
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1, "the last passkey survives concurrent deletes");
}

// [covers:auth-passkey.delete-requires-stepup]
#[tokio::test]
async fn passkey_delete_requires_step_up() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "del-step").await;
    let only: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    stale_auth_at(&pool, user).await;
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_json(resp).await["error"], "reauth_required");
}

// [covers:auth-invitation.web-issue-owner]
// [covers:auth-invitation.web-issue-ledger]
// [covers:auth-invitation.invite-ttl-config]
#[tokio::test]
async fn web_invitation_issue_owner_and_ledger_choice() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "inv-Owner").await;
    let a_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(a_user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // no ledger_id: the default ledger (legacy shape). The invite TTL is
    // 168 hours since TASK-46 (was 72).
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": "hi" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://localhost:40281/register?token="),
        "{url}"
    );
    let now = budget_book::auth::session::now_ms();
    let expires_at = body["expires_at"].as_i64().unwrap();
    assert!(
        expires_at > now + 167 * 3_600_000 && expires_at <= now + 169 * 3_600_000,
        "168h ttl: {expires_at}"
    );

    // issuance no longer requires step-up (TASK-46): a stale auth_at issues
    let mut stale = Client::new();
    let stale_user = register_setup_user(&mut stale, &router, &pool, "inv-stale").await;
    stale_auth_at(&pool, stale_user).await;
    let resp = stale
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );

    // viewer of someone else's ledger as the default -> forbidden
    let mut viewer = Client::new();
    let viewer_user = register_setup_user(&mut viewer, &router, &pool, "inv-viewer").await;
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)")
        .bind(a_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(a_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = viewer
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["error"], "owner_required");

    // TASK-78: an explicit ledger_id targets a ledger the issuer owns
    let second: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('別荘', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)")
        .bind(second)
        .bind(a_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "viewer", "ledger_id": second }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let invited: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT role, inviter_note FROM invitations WHERE kind = 'invite' AND ledger_id = ?",
    )
    .bind(second)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        invited,
        vec![("viewer".to_string(), None)],
        "the invitation joins the chosen ledger with the chosen role"
    );

    // an editor membership of the target is not enough (owner only)
    let mut b = Client::new();
    let b_user = register_setup_user(&mut b, &router, &pool, "inv-editor-target").await;
    let b_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(b_user)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'editor', 0)")
        .bind(b_ledger)
        .bind(a_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "ledger_id": b_ledger }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["error"], "owner_required");

    // a ledger the issuer does not belong to and an unknown id look the same
    let mut c = Client::new();
    let c_user = register_setup_user(&mut c, &router, &pool, "inv-outsider").await;
    let c_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(c_user)
        .fetch_one(&pool)
        .await
        .unwrap();
    for unknown in [c_ledger, 999_999] {
        let resp = a
            .post(
                &router,
                "/api/invitations",
                serde_json::json!({ "role": "editor", "ledger_id": unknown }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "ledger {unknown}");
        assert_eq!(body_json(resp).await["error"], "not_found");
    }

    // invalid role
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "owner" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // inviter_note is capped at 200 characters (chars, not bytes)
    let long_note = "あ".repeat(201);
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": long_note }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "inviter_note_too_long");
    // exactly 200 multibyte characters is fine (the cap counts characters)
    let ok_note = "あ".repeat(200);
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": ok_note }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
}

// [covers:auth-invitation.web-issue-register]
#[tokio::test]
async fn web_register_invitation_issue_for_any_active_user() {
    let (router, pool) = setup().await;

    // a viewer of someone else's ledger (not a default-ledger owner) issues
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "ri-owner").await;
    let owner_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut viewer = Client::new();
    let viewer_user = register_setup_user(&mut viewer, &router, &pool, "ri-viewer").await;
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)",
    )
    .bind(owner_ledger)
    .bind(viewer_user)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(owner_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();

    // a user without any default ledger issues too (registration-only
    // invitations need no ledger at all)
    let mut ledgerless = Client::new();
    let ledgerless_user = register_setup_user(&mut ledgerless, &router, &pool, "ri-noledger").await;
    sqlx::query("UPDATE users SET default_ledger_id = NULL WHERE id = ?")
        .bind(ledgerless_user)
        .execute(&pool)
        .await
        .unwrap();

    // issue: 201 { url, expires_at } with the 168h register TTL (TASK-46)
    let resp = viewer
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "妹" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://localhost:40281/register?token="),
        "{url}"
    );
    let now = budget_book::auth::session::now_ms();
    let expires_at = body["expires_at"].as_i64().unwrap();
    assert!(
        expires_at > now + 167 * 3_600_000 && expires_at <= now + 169 * 3_600_000,
        "168h ttl: {expires_at}"
    );

    // issuance audited as register_invitation / create by the issuer
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events
         WHERE actor_kind = 'web' AND entity_type = 'register_invitation'
           AND action = 'create' AND user_id = ?",
    )
    .bind(viewer_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // the issued URL resolves on register/info as a register token
    let token = url.rsplit("token=").next().unwrap();
    let resp = Client::new()
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let info = body_json(resp).await;
    assert_eq!(info["kind"], "register");
    assert_eq!(info["needs_display_name"], true);

    // the ledgerless user can issue as well
    let resp = ledgerless
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "n" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // TASK-46: issuance no longer requires step-up — a stale auth_at issues
    stale_auth_at(&pool, viewer_user).await;
    let resp = viewer
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "x" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );

    // note validation: required, and
    // capped at 200 characters (chars, not bytes)
    for (note, code) in [
        ("", "inviter_note_required"),
        ("   ", "inviter_note_required"),
        (&"あ".repeat(201), "inviter_note_too_long"),
    ] {
        let resp = owner
            .post(
                &router,
                "/api/register-invitations",
                serde_json::json!({ "inviter_note": note }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "note {code}");
        assert_eq!(body_json(resp).await["error"], code);
    }
    // exactly 200 multibyte characters is fine
    let resp = owner
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "あ".repeat(200) }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
}

// [covers:auth-invitation.register-open-limit]
#[tokio::test]
async fn register_invitation_open_limit() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "limit-a").await;

    // five open register tokens
    for i in 0..5 {
        let resp = a
            .post(
                &router,
                "/api/register-invitations",
                serde_json::json!({ "inviter_note": format!("note {i}") }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::CREATED, "open token {i}");
    }
    // the sixth open token is rejected
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "sixth" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "register_open_limit");

    // another user's budget is independent
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "limit-b").await;
    let resp = b
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "other user" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // using one token frees a slot
    let hash: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM register_invitations WHERE created_by = ? AND used_at IS NULL LIMIT 1",
    )
    .bind(a_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE register_invitations SET used_at = 1 WHERE token_hash = ?")
        .bind(&hash)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "refill" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // expired-but-unswept rows do not count against the limit
    sqlx::query(
        "UPDATE register_invitations SET expires_at = 1 WHERE created_by = ? AND used_at IS NULL",
    )
    .bind(a_user)
    .execute(&pool)
    .await
    .unwrap();
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "after expiry" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "expired rows are outside the open count"
    );
}
