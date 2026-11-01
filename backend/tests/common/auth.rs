//! Shared helpers for the TASK-10 Phase A auth tests: an in-memory app
//! router plus a cookie-keeping HTTP client backed by a software passkey
//! (webauthn-authenticator-rs SoftPasskey), so full WebAuthn ceremonies run
//! without a real authenticator.

use std::collections::HashMap;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response};
use budget_book::app::{self, AppState};
use budget_book::auth::invitation::{self, InvitationKind, NewInvitation};
use budget_book::auth::register_invitation;
use budget_book::auth::session::now_ms;
use budget_book::auth::tokens::{b64url_encode, sha256};
use budget_book::config::Config;
use budget_book::db;
use http_body_util::BodyExt;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use url::Url;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::*;

/// The public origin configured in configs/auth.toml ([auth.env.dev]).
pub const ORIGIN: &str = "http://localhost:40281";

pub async fn auth_setup() -> (Router, SqlitePool, Config) {
    let cfg = super::repo_config();
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, cfg)
}

/// Shared setup over a real (temp) SQLite FILE with the repo pool size
/// (max_connections = 5), so concurrent requests genuinely contend for the
/// SQLite write lock instead of being serialized behind a single connection.
/// Keep the returned TempDir alive for the pool's lifetime.
pub async fn auth_setup_file() -> (Router, SqlitePool, tempfile::TempDir) {
    let cfg = super::repo_config();
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = db::connect_file(&dir.path().join("race.sqlite"), &cfg.app.database)
        .await
        .expect("file db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, dir)
}

/// [`auth_setup_file`] with test hooks installed on the AppState (TASK-147:
/// deterministic interleaving of concurrent requests; the hook fields exist
/// only with the `test-hooks` feature that `mise run backend:test` enables).
pub async fn auth_setup_file_with_hooks(
    hooks: budget_book::test_hooks::TestHooks,
) -> (Router, SqlitePool, tempfile::TempDir) {
    let cfg = super::repo_config();
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = db::connect_file(&dir.path().join("race.sqlite"), &cfg.app.database)
        .await
        .expect("file db");
    let mut state = AppState::new(&cfg, pool.clone()).expect("app state");
    state.test_hooks = hooks;
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, dir)
}

/// Cookie-keeping client whose credentials live in a SoftPasskey.
pub struct Client {
    auth: WebauthnAuthenticator<SoftPasskey>,
    pub cookies: HashMap<String, String>,
    /// credential id -> the user handle from the registration challenge, i.e.
    /// what a real discoverable authenticator reports back at login. The soft
    /// token itself cannot do this, so `register` records it here and
    /// `authenticate_discoverable` replays it (falling back to the explicit
    /// argument for credentials seeded outside a challenge).
    challenge_handles: HashMap<Vec<u8>, Vec<u8>>,
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

impl Client {
    pub fn new() -> Self {
        Self {
            // falsify_uv: the soft token has no real user verification, but
            // the server always requires UV (spec_auth.md section 2-3).
            auth: WebauthnAuthenticator::new(SoftPasskey::new(true)),
            cookies: HashMap::new(),
            challenge_handles: HashMap::new(),
        }
    }

    fn cookie_header(&self) -> Option<String> {
        if self.cookies.is_empty() {
            None
        } else {
            Some(
                self.cookies
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        }
    }

    pub async fn post(
        &self,
        router: &Router,
        path: &str,
        body: impl serde::Serialize,
    ) -> Response<Body> {
        let json = serde_json::to_string(&body).unwrap();
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json")
            .header("origin", ORIGIN)
            .header("user-agent", "test-agent Chrome/130.0");
        if let Some(cookies) = self.cookie_header() {
            builder = builder.header("cookie", cookies);
        }
        router
            .clone()
            .oneshot(builder.body(Body::from(json)).unwrap())
            .await
            .unwrap()
    }

    pub async fn get(&self, router: &Router, path: &str) -> Response<Body> {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(cookies) = self.cookie_header() {
            builder = builder.header("cookie", cookies);
        }
        router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    pub async fn put(
        &self,
        router: &Router,
        path: &str,
        body: impl serde::Serialize,
    ) -> Response<Body> {
        let json = serde_json::to_string(&body).unwrap();
        let mut builder = Request::builder()
            .method("PUT")
            .uri(path)
            .header("content-type", "application/json")
            .header("origin", ORIGIN);
        if let Some(cookies) = self.cookie_header() {
            builder = builder.header("cookie", cookies);
        }
        router
            .clone()
            .oneshot(builder.body(Body::from(json)).unwrap())
            .await
            .unwrap()
    }

    pub async fn patch(
        &self,
        router: &Router,
        path: &str,
        body: impl serde::Serialize,
    ) -> Response<Body> {
        let json = serde_json::to_string(&body).unwrap();
        let mut builder = Request::builder()
            .method("PATCH")
            .uri(path)
            .header("content-type", "application/json")
            .header("origin", ORIGIN);
        if let Some(cookies) = self.cookie_header() {
            builder = builder.header("cookie", cookies);
        }
        router
            .clone()
            .oneshot(builder.body(Body::from(json)).unwrap())
            .await
            .unwrap()
    }

    pub async fn delete(&self, router: &Router, path: &str) -> Response<Body> {
        let mut builder = Request::builder()
            .method("DELETE")
            .uri(path)
            .header("origin", ORIGIN);
        if let Some(cookies) = self.cookie_header() {
            builder = builder.header("cookie", cookies);
        }
        router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    /// Raw POST with full header control (CSRF / content-type tests).
    pub async fn post_raw(
        router: &Router,
        path: &str,
        headers: &[(&'static str, String)],
        body: &'static str,
    ) -> Response<Body> {
        let mut builder = Request::builder().method("POST").uri(path);
        for (k, v) in headers {
            builder = builder.header(*k, v.as_str());
        }
        router
            .clone()
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap()
    }

    pub fn store_cookies(&mut self, resp: &Response<Body>) {
        for v in resp.headers().get_all(axum::http::header::SET_COOKIE) {
            let s = v.to_str().unwrap();
            let Some(pair) = s.split(';').next() else {
                continue;
            };
            if let Some((k, v)) = pair.split_once('=') {
                if v.is_empty() {
                    self.cookies.remove(k);
                } else {
                    self.cookies.insert(k.to_string(), v.to_string());
                }
            }
        }
    }

    pub fn register(&mut self, ccr: CreationChallengeResponse) -> RegisterPublicKeyCredential {
        let handle = ccr.public_key.user.id.to_vec();
        let cred = self
            .auth
            .do_registration(Url::parse(ORIGIN).unwrap(), ccr)
            .unwrap();
        self.challenge_handles.insert(cred.raw_id.to_vec(), handle);
        cred
    }

    pub fn authenticate(&mut self, rcr: RequestChallengeResponse) -> PublicKeyCredential {
        self.auth
            .do_authentication(Url::parse(ORIGIN).unwrap(), rcr)
            .unwrap()
    }

    /// Attempt an assertion; Err when this token holds no credential matching
    /// the request's allow list (e.g. another user's step-up challenge).
    pub fn try_authenticate(
        &mut self,
        rcr: RequestChallengeResponse,
    ) -> Result<PublicKeyCredential, String> {
        self.auth
            .do_authentication(Url::parse(ORIGIN).unwrap(), rcr)
            .map_err(|e| e.to_string())
    }

    /// Discoverable assertion: emulate what a resident-key authenticator
    /// does for an empty allow list — select one of the user's credentials
    /// and report the user handle bound to that credential at registration
    /// (the challenge handle, NOT the current DB handle; the soft token
    /// itself cannot, so `register` recorded it). `user_handle` is the
    /// fallback for credentials seeded outside a challenge.
    pub fn authenticate_discoverable(
        &mut self,
        mut rcr: RequestChallengeResponse,
        user_handle: &[u8],
        cred_ids: &[Vec<u8>],
    ) -> PublicKeyCredential {
        rcr.public_key.allow_credentials = cred_ids
            .iter()
            .map(|id| webauthn_rs_proto::AllowCredentials {
                type_: "public-key".to_string(),
                id: id.clone().into(),
                transports: None,
            })
            .collect();
        let mut cred = self
            .auth
            .do_authentication(Url::parse(ORIGIN).unwrap(), rcr)
            .unwrap();
        let handle = self
            .challenge_handles
            .get(cred.raw_id.as_slice())
            .cloned()
            .unwrap_or_else(|| user_handle.to_vec());
        cred.response.user_handle = Some(handle.into());
        cred
    }
}

pub async fn body_json(resp: Response<Body>) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

pub async fn body_text(resp: Response<Body>) -> String {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

// ---------------------------------------------------------------------------
// token / user fixtures

pub async fn issue_setup_token(pool: &SqlitePool, note: &str) -> String {
    invitation::issue(
        pool,
        &NewInvitation {
            kind: InvitationKind::Setup,
            operator_note: Some(note.to_string()),
            target_user_id: None,
            created_by: None,
            ledger_id: None,
            role: None,
            inviter_note: None,
            ttl_ms: 24 * 3_600_000,
        },
        now_ms(),
    )
    .await
    .unwrap()
}

pub async fn issue_invite_token(
    pool: &SqlitePool,
    created_by: i64,
    ledger_id: i64,
    role: &str,
    note: Option<&str>,
) -> String {
    invitation::issue(
        pool,
        &NewInvitation {
            kind: InvitationKind::Invite,
            operator_note: None,
            target_user_id: None,
            created_by: Some(created_by),
            ledger_id: Some(ledger_id),
            role: Some(role.to_string()),
            inviter_note: note.map(str::to_string),
            ttl_ms: 72 * 3_600_000,
        },
        now_ms(),
    )
    .await
    .unwrap()
}

pub async fn issue_recovery_token(pool: &SqlitePool, target: i64) -> String {
    invitation::issue(
        pool,
        &NewInvitation {
            kind: InvitationKind::Recovery,
            operator_note: None,
            target_user_id: Some(target),
            created_by: None,
            ledger_id: None,
            role: None,
            inviter_note: None,
            ttl_ms: 3_600_000,
        },
        now_ms(),
    )
    .await
    .unwrap()
}

/// Issue a register invitation token through the real issuance path
/// (TASK-32: `register_invitations`, web-issued registration-only tokens;
/// 24h TTL, one call per test — the per-issuer open limit is 5).
pub async fn issue_register_token(pool: &SqlitePool, created_by: i64, note: &str) -> String {
    register_invitation::issue(pool, created_by, note, 24 * 3_600_000, now_ms())
        .await
        .expect("register token issues")
}

/// Run register/start + finish with a setup token; returns the new user id.
/// Leaves the session cookie in `client`.
pub async fn register_setup_user(
    client: &mut Client,
    router: &Router,
    pool: &SqlitePool,
    display: &str,
) -> i64 {
    let token = issue_setup_token(pool, &format!("note for {display}")).await;
    register_with_token(client, router, pool, &token, Some(display), None).await
}

/// Full registration flow with any token kind (display_name and label optional).
pub async fn register_with_token(
    client: &mut Client,
    router: &Router,
    pool: &SqlitePool,
    token: &str,
    display: Option<&str>,
    label: Option<&str>,
) -> i64 {
    let mut body = serde_json::json!({ "token": token });
    if let Some(d) = display {
        body["display_name"] = serde_json::json!(d);
    }
    let resp = client
        .post(router, "/api/webauthn/register/start", body)
        .await;
    assert_eq!(resp.status(), 200, "register/start failed");
    client.store_cookies(&resp);
    let ccr: CreationChallengeResponse = serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let mut finish = serde_json::json!({ "credential": cred });
    if let Some(l) = label {
        finish["label"] = serde_json::json!(l);
    }
    let resp = client
        .post(router, "/api/webauthn/register/finish", finish)
        .await;
    assert_eq!(
        resp.status(),
        200,
        "register/finish failed: {}",
        body_text(resp).await
    );
    client.store_cookies(&resp);
    sqlx::query_scalar::<_, i64>("SELECT id FROM users WHERE display_name = ?")
        .bind(display.unwrap_or_default())
        .fetch_one(pool)
        .await
        .unwrap_or_default()
}

/// A user's webauthn handle and credential ids (for discoverable assertions).
pub async fn user_webauthn_ids(pool: &SqlitePool, user_id: i64) -> (Vec<u8>, Vec<Vec<u8>>) {
    let handle: Vec<u8> = sqlx::query_scalar("SELECT webauthn_user_handle FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
    let creds: Vec<Vec<u8>> =
        sqlx::query_scalar("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool)
            .await
            .unwrap();
    (handle, creds)
}

/// Discoverable login; leaves the new session cookie in `client`.
pub async fn login(client: &mut Client, router: &Router, pool: &SqlitePool, user_id: i64) {
    let resp = client
        .post(router, "/api/webauthn/login/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200, "login/start failed");
    client.store_cookies(&resp);
    let rcr: RequestChallengeResponse = serde_json::from_value(body_json(resp).await).unwrap();
    let (handle, creds) = user_webauthn_ids(pool, user_id).await;
    let cred = client.authenticate_discoverable(rcr, &handle, &creds);
    let resp = client
        .post(
            router,
            "/api/webauthn/login/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(
        resp.status(),
        200,
        "login/finish failed: {}",
        body_text(resp).await
    );
    client.store_cookies(&resp);
}

/// User's current session id_hash values (valid only).
pub async fn user_session_hashes(pool: &SqlitePool, user_id: i64) -> Vec<Vec<u8>> {
    sqlx::query_scalar::<_, Vec<u8>>(
        "SELECT id_hash FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// b64url of a session cookie value -> id_hash used in DB.
pub fn cookie_hash(cookie_value: &str) -> Vec<u8> {
    let raw: [u8; 32] = budget_book::auth::tokens::b64url_decode(cookie_value)
        .unwrap()
        .try_into()
        .unwrap();
    sha256(&raw).to_vec()
}

/// Create a user row directly (CLI tests don't need WebAuthn).
pub async fn create_user_direct(pool: &SqlitePool, display: &str, admin_note: Option<&str>) -> i64 {
    let handle: Vec<u8> = uuid::Uuid::new_v4().into_bytes().to_vec();
    let account = format!("BB-{:04}-{:04}", rand_u32() % 10000, rand_u32() % 10000);
    let user_id: i64 = sqlx::query_scalar(
        "INSERT INTO users (webauthn_user_handle, account_number, display_name, admin_note, invited_via_kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'setup', 0, 0) RETURNING id",
    )
    .bind(handle)
    .bind(&account)
    .bind(display)
    .bind(admin_note)
    .fetch_one(pool)
    .await
    .unwrap();
    let ledger_id: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES (?, 0, 0) RETURNING id",
    )
    .bind(format!("{display}の家計簿"))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)")
        .bind(ledger_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(ledger_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    user_id
}

fn rand_u32() -> u32 {
    let mut b = [0u8; 4];
    getrandom::fill(&mut b).unwrap();
    u32::from_be_bytes(b)
}

/// b64url encode helper for comparing credential ids.
pub fn b64(bytes: &[u8]) -> String {
    b64url_encode(bytes)
}
