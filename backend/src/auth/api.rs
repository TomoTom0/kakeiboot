//! HTTP API for passkeys, sessions and invitations (spec_auth.md sections
//! 3-1, 3-2): JSON only, Origin-checked state changes, `application/json`
//! bodies only. The frontend is wired later; no HTML is served here.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use sqlx::{Connection, SqlitePool};
use webauthn_rs::prelude::{PublicKeyCredential, Webauthn};
use webauthn_rs_proto::RegisterPublicKeyCredential;

use super::ceremony;
use super::invitation::{self, InvitationKind};
use super::ledger;
use super::register_invitation::{self, RegistrationToken};
use super::session::{self, ValidSession};
use super::tokens::TOKEN_LEN;
use crate::config::ResolvedAuth;

/// Shared application state for the auth endpoints (owned by app.rs).
#[derive(Clone)]
pub struct AuthApiState {
    pub db: SqlitePool,
    pub webauthn: Arc<Webauthn>,
    pub auth: ResolvedAuth,
    /// CIMD / JWKS HTTP client (safe_fetch rules).
    pub fetch: super::oauth::net::FetchClient,
    /// In-memory rate limiters (spec_auth.md 10-1).
    pub limits: Arc<crate::ratelimit::RateLimits>,
    /// Shared size / limit settings (configs/mcp.toml) for the web data API.
    pub tools: Arc<crate::config::McpToolsConfig>,
    /// TASK-58 export / import caps (configs/<env>/app.toml [data_io]).
    pub data_io: Arc<crate::config::DataIoConfig>,
    /// Image storage root (app.toml [maintenance]; export reads and import
    /// writes image files here, like /media does).
    pub image_root: std::path::PathBuf,
    /// Test-only injection points (empty unless the `test-hooks` feature is
    /// enabled; see [`crate::test_hooks`]).
    pub test_hooks: crate::test_hooks::TestHooks,
}

/// Error shape: `{"error": "<code>"}` with a status code.
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    fn bad_request(code: &'static str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code)
    }
    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized")
    }
    fn reauth_required() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "reauth_required")
    }
    fn internal(err: anyhow::Error) -> Self {
        tracing::error!(error = %err, "auth api failure");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal")
    }
    fn sqlx(err: sqlx::Error) -> Self {
        Self::internal(err.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.code }))).into_response()
    }
}

impl From<ceremony::RegisterStartError> for ApiError {
    fn from(e: ceremony::RegisterStartError) -> Self {
        use ceremony::RegisterStartError as E;
        match e {
            E::InvalidToken => ApiError::bad_request("invalid_token"),
            E::DisplayNameRequired => ApiError::bad_request("display_name_required"),
            E::DisplayNameNotAllowed => ApiError::bad_request("display_name_not_allowed"),
            E::Webauthn(err) => ApiError::internal(anyhow::anyhow!(err)),
            E::Db(err) => ApiError::internal(err),
        }
    }
}

impl From<ceremony::RegisterFinishError> for ApiError {
    fn from(e: ceremony::RegisterFinishError) -> Self {
        use ceremony::RegisterFinishError as E;
        match e {
            E::CeremonyInvalid | E::Invariant => ApiError::bad_request("ceremony_invalid"),
            E::RegistrationFailed(err) => {
                tracing::warn!(error = %err, "register/finish rejected");
                ApiError::bad_request("registration_failed")
            }
            E::TokenInvalid => ApiError::bad_request("invalid_token"),
            E::Db(err) => ApiError::internal(err),
        }
    }
}

impl From<ceremony::LoginStartError> for ApiError {
    fn from(e: ceremony::LoginStartError) -> Self {
        use ceremony::LoginStartError as E;
        match e {
            E::InvalidReq => ApiError::bad_request("invalid_request"),
            E::Webauthn(err) => ApiError::internal(anyhow::anyhow!(err)),
            E::Db(err) => ApiError::internal(err),
        }
    }
}

impl From<ceremony::LoginFinishError> for ApiError {
    fn from(e: ceremony::LoginFinishError) -> Self {
        use ceremony::LoginFinishError as E;
        match e {
            E::CeremonyInvalid => ApiError::bad_request("ceremony_invalid"),
            E::Mismatch | E::Authentication => ApiError::unauthorized(),
            E::Db(err) => ApiError::internal(err),
        }
    }
}

impl From<ceremony::ReauthError> for ApiError {
    fn from(e: ceremony::ReauthError) -> Self {
        use ceremony::ReauthError as E;
        match e {
            E::NoCredentials => ApiError::bad_request("no_passkeys"),
            E::CeremonyInvalid => ApiError::bad_request("ceremony_invalid"),
            E::UserMismatch => ApiError::new(StatusCode::FORBIDDEN, "ceremony_user_mismatch"),
            E::Authentication => ApiError::unauthorized(),
            E::Webauthn(err) => ApiError::internal(anyhow::anyhow!(err)),
            E::Db(err) => ApiError::internal(err),
        }
    }
}

/// Token acceptance failure (spec_auth.md 10-5, TASK-15): WARN with the
/// endpoint, a coarse reason and the token hash prefix so failed register
/// URLs are diagnosable from the journal. The prefix matches the DB token
/// hash when the token parses (the raw string is hashed otherwise); the
/// token itself is never logged. `None` when the raw token is not at hand
/// (register/finish: the token was consumed at start).
fn warn_token_rejected(endpoint: &str, reason: &str, token_str: Option<&str>) {
    let prefix = token_str.map(|t| match invitation::parse_token(t) {
        Some(bytes) => crate::auth::tokens::sha256(&bytes),
        None => crate::auth::tokens::sha256(t.as_bytes()),
    });
    let prefix = prefix.map(|h| crate::auth::tokens::to_hex(&h)[..8].to_string());
    match prefix {
        Some(p) => tracing::warn!(
            endpoint = %endpoint,
            reason = %reason,
            token_hash_prefix = %p,
            "token rejected"
        ),
        None => tracing::warn!(endpoint = %endpoint, reason = %reason, "token rejected"),
    }
}

/// All /api routes of the auth module (state applied by the caller). The
/// Origin / JSON guard runs first, then the rate limit guard
/// (spec_auth.md 3-1, 10-1).
pub fn routes(state: AuthApiState) -> Router {
    Router::new()
        .route("/api/webauthn/register/info", post(register_info))
        .route("/api/webauthn/register/start", post(register_start))
        .route("/api/webauthn/register/finish", post(register_finish))
        .route("/api/webauthn/login/start", post(login_start))
        .route("/api/webauthn/login/finish", post(login_finish))
        .route("/api/webauthn/reauth/start", post(reauth_start))
        .route("/api/webauthn/reauth/finish", post(reauth_finish))
        .route("/api/passkeys/start", post(passkey_start))
        .route("/api/passkeys/finish", post(passkey_finish))
        .route("/api/passkeys", get(list_passkeys))
        .route(
            "/api/passkeys/{id}",
            axum::routing::patch(rename_passkey).delete(delete_passkey),
        )
        .route("/api/invitations", post(create_invitation))
        .route(
            "/api/register-invitations",
            post(create_register_invitation),
        )
        .route("/api/auth/me", get(me))
        .route(
            "/api/auth/me/default-ledger",
            axum::routing::put(set_default_ledger),
        )
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/logout-all", post(logout_all))
        .merge(super::oauth::authorize::api_routes())
        .merge(super::oauth::grants::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            api_guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::ratelimit::api_limit_guard,
        ))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// middleware (spec_auth.md section 3-1)

/// Origin exact-match for state-changing requests and JSON-only bodies on
/// /api/*. `__Host-` cookies make CSRF the concern; the same-origin frontend
/// always sends `Origin` on mutations.
pub(crate) async fn api_guard(
    State(state): State<AuthApiState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let is_mutation = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if is_mutation {
        let origin_ok = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|o| o == state.auth.public_origin);
        if !origin_ok {
            return ApiError::new(StatusCode::FORBIDDEN, "origin_mismatch").into_response();
        }
        let has_body = req
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|len| len > 0)
            || req.headers().contains_key(header::TRANSFER_ENCODING);
        if has_body {
            let json_ok = req
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|ct| {
                    let ct = ct
                        .split(';')
                        .next()
                        .unwrap_or("")
                        .trim()
                        .to_ascii_lowercase();
                    ct == "application/json"
                });
            if !json_ok {
                return ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_only")
                    .into_response();
            }
        }
    }
    next.run(req).await
}

// ---------------------------------------------------------------------------
// session helpers

/// Validate the session cookie; returns the session and the raw cookie token
/// (needed by logout).
pub(crate) async fn require_session(
    state: &AuthApiState,
    headers: &HeaderMap,
) -> Result<(ValidSession, [u8; TOKEN_LEN]), ApiError> {
    let now = session::now_ms();
    let Some(token) = session::cookie_token(headers, session::COOKIE_SESSION) else {
        return Err(ApiError::unauthorized());
    };
    let s = session::validate_session(&state.db, &token, now, &state.auth.session)
        .await
        .map_err(ApiError::internal)?
        .ok_or_else(ApiError::unauthorized)?;
    Ok((s, token))
}

fn require_step_up(s: &ValidSession, state: &AuthApiState) -> Result<(), ApiError> {
    if session::step_up_ok(s, session::now_ms(), &state.auth.session) {
        Ok(())
    } else {
        Err(ApiError::reauth_required())
    }
}

fn set_cookie(headers: &mut HeaderMap, value: String) {
    // append (not insert): a finish response carries both the new session
    // cookie and the consumed-ceremony clearing cookie.
    headers.append(
        header::SET_COOKIE,
        HeaderValue::from_str(&value).expect("cookie header is ascii"),
    );
}

fn with_ceremony_cookie(mut resp: Response, ceremony: &[u8; TOKEN_LEN], ttl_secs: i64) -> Response {
    set_cookie(
        resp.headers_mut(),
        session::ceremony_cookie(ceremony, ttl_secs),
    );
    resp
}

fn with_session_cookie(
    mut resp: Response,
    token: &[u8; TOKEN_LEN],
    absolute_expires_at: i64,
) -> Response {
    set_cookie(
        resp.headers_mut(),
        session::session_cookie(token, absolute_expires_at, session::now_ms()),
    );
    resp
}

/// Finish responses consume the ceremony: clear its cookie (Max-Age=0).
fn with_ceremony_cleared(mut resp: Response) -> Response {
    set_cookie(
        resp.headers_mut(),
        session::clear_cookie_strict(session::COOKIE_CEREMONY),
    );
    resp
}

// ---------------------------------------------------------------------------
// registration (spec_auth.md sections 2-1, 2-3, 3-2)

#[derive(Deserialize)]
struct RegisterInfoReq {
    token: String,
}

/// Minimal token introspection for the registration landing form: the kind
/// and the bits the form needs to render (display name input, invited ledger,
/// recovery target). Tokens travel in the POST body, not the URL. The token
/// resolves across `invitations` (setup / invite / recovery) and
/// `register_invitations` (register).
async fn register_info(
    State(state): State<AuthApiState>,
    Json(req): Json<RegisterInfoReq>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let now = session::now_ms();
    let Some(token) = invitation::parse_token(&req.token) else {
        warn_token_rejected("register/info", "parse_failed", Some(&req.token));
        return Err(ApiError::bad_request("invalid_token"));
    };
    let mut conn = state.db.acquire().await.map_err(ApiError::sqlx)?;
    let reg = register_invitation::find_registration_token(&mut conn, &token)
        .await
        .map_err(ApiError::sqlx)?
        .ok_or_else(|| {
            warn_token_rejected("register/info", "unknown_token", Some(&req.token));
            ApiError::bad_request("invalid_token")
        })?;
    if !reg.is_usable(now) {
        warn_token_rejected("register/info", "expired_or_used", Some(&req.token));
        return Err(ApiError::bad_request("invalid_token"));
    }
    let body = match &reg {
        RegistrationToken::Invitation(inv) => match inv.kind {
            InvitationKind::Setup => json!({ "kind": "setup", "needs_display_name": true }),
            InvitationKind::Invite => {
                let ledger: Option<String> =
                    sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
                        .bind(inv.ledger_id)
                        .fetch_optional(&mut *conn)
                        .await
                        .map_err(ApiError::sqlx)?;
                json!({
                    "kind": "invite",
                    "needs_display_name": true,
                    "ledger_name": ledger,
                    "role": inv.role,
                })
            }
            InvitationKind::Recovery => {
                let display: Option<String> = sqlx::query_scalar(
                    "SELECT display_name FROM users WHERE id = ? AND disabled_at IS NULL",
                )
                .bind(inv.target_user_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(ApiError::sqlx)?;
                if display.is_none() {
                    return Err(ApiError::bad_request("invalid_token"));
                }
                json!({
                    "kind": "recovery",
                    "needs_display_name": false,
                    "user_display_name": display,
                })
            }
        },
        RegistrationToken::Register(_) => {
            json!({ "kind": "register", "needs_display_name": true })
        }
    };
    Ok(Json(body))
}

#[derive(Deserialize)]
struct RegisterStartReq {
    token: String,
    #[serde(default)]
    display_name: Option<String>,
}

async fn register_start(
    State(state): State<AuthApiState>,
    Json(req): Json<RegisterStartReq>,
) -> Result<Response, ApiError> {
    let now = session::now_ms();
    let outcome = match ceremony::register_start(
        &state.db,
        &state.webauthn,
        &state.auth,
        &req.token,
        req.display_name.as_deref(),
        now,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            if matches!(e, ceremony::RegisterStartError::InvalidToken) {
                warn_token_rejected("register/start", "invalid_token", Some(&req.token));
            }
            return Err(e.into());
        }
    };
    let resp = Json(outcome.ccr).into_response();
    Ok(with_ceremony_cookie(
        resp,
        &outcome.ceremony,
        outcome.ttl_secs,
    ))
}

#[derive(Deserialize)]
struct RegisterFinishReq {
    credential: RegisterPublicKeyCredential,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    use_invited_ledger_as_default: Option<bool>,
}

async fn register_finish(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<RegisterFinishReq>,
) -> Result<Response, ApiError> {
    let now = session::now_ms();
    let Some(ceremony_token) = session::cookie_token(&headers, session::COOKIE_CEREMONY) else {
        return Err(ApiError::bad_request("ceremony_invalid"));
    };
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let outcome = match ceremony::register_finish(
        &state.db,
        &state.webauthn,
        &state.auth,
        &ceremony_token,
        &req.credential,
        req.label.as_deref(),
        req.use_invited_ledger_as_default.unwrap_or(false),
        user_agent.as_deref(),
        state.tools.limits.max_ledger_name_chars,
        now,
    )
    .await
    {
        Ok(o) => o,
        Err(e) => {
            if matches!(e, ceremony::RegisterFinishError::TokenInvalid) {
                warn_token_rejected("register/finish", "invalid_token", None);
            }
            return Err(e.into());
        }
    };
    let resp = Json(json!({})).into_response();
    let resp = with_session_cookie(resp, &outcome.session, outcome.absolute_expires_at);
    Ok(with_ceremony_cleared(resp))
}

// ---------------------------------------------------------------------------
// login (spec_auth.md sections 2-4, 3-2)

#[derive(Deserialize)]
struct LoginStartReq {
    #[serde(default)]
    req: Option<String>,
}

async fn login_start(
    State(state): State<AuthApiState>,
    Json(body): Json<LoginStartReq>,
) -> Result<Response, ApiError> {
    let now = session::now_ms();
    let outcome = ceremony::login_start(
        &state.db,
        &state.webauthn,
        &state.auth,
        body.req.as_deref(),
        now,
    )
    .await?;
    let resp = Json(outcome.rcr).into_response();
    Ok(with_ceremony_cookie(
        resp,
        &outcome.ceremony,
        outcome.ttl_secs,
    ))
}

#[derive(Deserialize)]
struct LoginFinishReq {
    credential: PublicKeyCredential,
}

async fn login_finish(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<LoginFinishReq>,
) -> Result<Response, ApiError> {
    let now = session::now_ms();
    let Some(ceremony_token) = session::cookie_token(&headers, session::COOKIE_CEREMONY) else {
        return Err(ApiError::bad_request("ceremony_invalid"));
    };
    let old = session::cookie_token(&headers, session::COOKIE_SESSION);
    let outcome = ceremony::login_finish(
        &state.db,
        &state.webauthn,
        &state.auth,
        &ceremony_token,
        &req.credential,
        old.as_ref(),
        now,
        &state.test_hooks,
    )
    .await?;
    let resp = Json(json!({ "next": outcome.next })).into_response();
    let resp = with_session_cookie(resp, &outcome.session, outcome.absolute_expires_at);
    Ok(with_ceremony_cleared(resp))
}

// ---------------------------------------------------------------------------
// step-up re-authentication (spec_auth.md sections 2-6, 3-2)

async fn reauth_start(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let outcome =
        ceremony::reauth_start(&state.db, &state.webauthn, &state.auth, s.user_id, now).await?;
    let resp = Json(outcome.rcr).into_response();
    Ok(with_ceremony_cookie(
        resp,
        &outcome.ceremony,
        outcome.ttl_secs,
    ))
}

async fn reauth_finish(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<LoginFinishReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let Some(ceremony_token) = session::cookie_token(&headers, session::COOKIE_CEREMONY) else {
        return Err(ApiError::bad_request("ceremony_invalid"));
    };
    ceremony::reauth_finish(
        &state.db,
        &state.webauthn,
        &s,
        &ceremony_token,
        &req.credential,
        now,
    )
    .await?;
    Ok(with_ceremony_cleared(Json(json!({})).into_response()))
}

// ---------------------------------------------------------------------------
// passkey management (spec_auth.md sections 2-7, 3-2)

async fn passkey_start(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let outcome =
        ceremony::passkey_add_start(&state.db, &state.webauthn, &state.auth, &s, now).await?;
    let resp = Json(outcome.ccr).into_response();
    Ok(with_ceremony_cookie(
        resp,
        &outcome.ceremony,
        outcome.ttl_secs,
    ))
}

async fn passkey_finish(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<RegisterFinishReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let Some(ceremony_token) = session::cookie_token(&headers, session::COOKIE_CEREMONY) else {
        return Err(ApiError::bad_request("ceremony_invalid"));
    };
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    ceremony::passkey_add_finish(
        &state.db,
        &state.webauthn,
        &s,
        &ceremony_token,
        &req.credential,
        req.label.as_deref(),
        user_agent.as_deref(),
        now,
    )
    .await?;
    Ok(with_ceremony_cleared(Json(json!({})).into_response()))
}

async fn list_passkeys(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let rows: Vec<PasskeyCols> = sqlx::query_as(
        "SELECT id, label, created_at, last_used_at, passkey_json
         FROM webauthn_credentials WHERE user_id = ? ORDER BY id",
    )
    .bind(s.user_id)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::sqlx)?;
    let list: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, label, created_at, last_used_at, passkey_json)| {
            json!({
                "id": id,
                "label": label,
                "created_at": created_at,
                "last_used_at": last_used_at,
                "backup_state": passkey_backup_state(&passkey_json),
            })
        })
        .collect();
    Ok(Json(json!(list)))
}

/// Passkey list columns (id, label, created_at, last_used_at, passkey_json).
type PasskeyCols = (i64, Option<String>, i64, Option<i64>, String);

/// Read `backup_state` out of the serialized `Passkey` for display
/// (spec 2-4: synced / on-device indicator). Tolerant of shape changes.
fn passkey_backup_state(passkey_json: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(passkey_json).ok()?;
    v.get("backup_state")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| {
            v.get("cred")
                .and_then(|c| c.get("backup_state"))
                .and_then(serde_json::Value::as_bool)
        })
}

#[derive(Deserialize)]
struct RenameReq {
    label: String,
}

async fn rename_passkey(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(req): Json<RenameReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let label = req.label.trim().to_string();
    // 100 characters (not bytes), matching the display_name rule (spec 3-2).
    if label.is_empty() || label.chars().count() > 100 {
        return Err(ApiError::bad_request("invalid_label"));
    }
    let now = session::now_ms();
    let n = sqlx::query(
        "UPDATE webauthn_credentials SET label = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .bind(&label)
    .bind(now)
    .bind(id)
    .bind(s.user_id)
    .execute(&state.db)
    .await
    .map_err(ApiError::sqlx)?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    Ok(Json(json!({})).into_response())
}

async fn delete_passkey(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    require_step_up(&s, &state)?;
    let now = session::now_ms();
    // count check + delete + audit in one BEGIN IMMEDIATE transaction so two
    // concurrent deletes cannot both pass the last-passkey check (spec 2-7).
    let mut conn = state.db.acquire().await.map_err(ApiError::sqlx)?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(ApiError::sqlx)?;
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(s.user_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::sqlx)?;
    if count <= 1 {
        // the web UI never removes the last passkey (spec 2-7).
        return Err(ApiError::new(StatusCode::CONFLICT, "last_passkey"));
    }
    let n = sqlx::query("DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(s.user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::sqlx)?
        .rows_affected();
    if n == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
    }
    super::audit(
        &mut tx,
        "web",
        "webauthn_credential",
        id,
        "delete",
        Some(s.user_id),
        &json!({}),
        now,
    )
    .await
    .map_err(ApiError::sqlx)?;
    tx.commit().await.map_err(ApiError::sqlx)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------
// invitations from the web (spec_auth.md sections 2-1, 3-2)

#[derive(Deserialize)]
struct CreateInvitationReq {
    role: String,
    /// Target ledger (TASK-78): the issuer must own it. Absent = the
    /// issuer's default ledger (the pre-TASK-78 shape).
    #[serde(default)]
    ledger_id: Option<i64>,
    #[serde(default)]
    inviter_note: Option<String>,
}

async fn create_invitation(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<CreateInvitationReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    if !matches!(req.role.as_str(), "editor" | "viewer") {
        return Err(ApiError::bad_request("invalid_role"));
    }
    if let Some(note) = req.inviter_note.as_deref()
        && note.trim().chars().count() > 200
    {
        return Err(ApiError::bad_request("inviter_note_too_long"));
    }
    let now = session::now_ms();
    // Resolve the target ledger: an explicit ledger_id the issuer must own
    // (TASK-78; membership and ownership distinguish 404 from 403 — a
    // non-member ledger is indistinguishable from a missing one), else the
    // inviter's default ledger (owner only, the pre-TASK-78 shape).
    let ledger_id = match req.ledger_id {
        Some(explicit) => {
            let membership: Option<String> = sqlx::query_scalar(
                "SELECT m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
                 WHERE m.ledger_id = ? AND m.user_id = ?",
            )
            .bind(explicit)
            .bind(s.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::sqlx)?;
            match membership.as_deref() {
                None => return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found")),
                Some("owner") => explicit,
                Some(_) => return Err(ApiError::new(StatusCode::FORBIDDEN, "owner_required")),
            }
        }
        None => {
            let default_ledger: Option<Option<i64>> = sqlx::query_scalar(
                "SELECT default_ledger_id FROM users WHERE id = ? AND disabled_at IS NULL",
            )
            .bind(s.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::sqlx)?;
            let Some(Some(ledger_id)) = default_ledger else {
                return Err(ApiError::bad_request("no_default_ledger"));
            };
            let role: Option<String> = sqlx::query_scalar(
                "SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?",
            )
            .bind(ledger_id)
            .bind(s.user_id)
            .fetch_one(&state.db)
            .await
            .map_err(ApiError::sqlx)?;
            if role.as_deref() != Some("owner") {
                return Err(ApiError::new(StatusCode::FORBIDDEN, "owner_required"));
            }
            ledger_id
        }
    };
    let ttl = state.auth.invitation.invite_ttl_hours * 3_600_000;
    let expires_at = now + ttl;
    let token = invitation::issue(
        &state.db,
        &invitation::NewInvitation {
            kind: InvitationKind::Invite,
            operator_note: None,
            target_user_id: None,
            created_by: Some(s.user_id),
            ledger_id: Some(ledger_id),
            role: Some(req.role.clone()),
            inviter_note: req.inviter_note,
            ttl_ms: ttl,
        },
        now,
    )
    .await
    .map_err(ApiError::internal)?;
    let mut conn = state.db.acquire().await.map_err(ApiError::sqlx)?;
    super::audit(
        &mut conn,
        "web",
        "invitation",
        0,
        "create",
        Some(s.user_id),
        &json!({ "ledger_id": ledger_id, "role": req.role }),
        now,
    )
    .await
    .map_err(ApiError::sqlx)?;
    let url = format!("{}/register?token={token}", state.auth.public_origin);
    let mut resp = Json(json!({ "url": url, "expires_at": expires_at })).into_response();
    *resp.status_mut() = StatusCode::CREATED;
    Ok(resp)
}

// ---------------------------------------------------------------------------
// register invitations from the web (TASK-32, spec_auth.md sections 2-1, 3-2)

#[derive(Deserialize)]
struct CreateRegisterInvitationReq {
    // serde 必須. A missing field is rejected by axum's JsonRejection (a 400
    // without an error code) before the handler runs.
    inviter_note: String,
}

/// Issue a registration-only invitation URL. Any active user may issue
/// (session + step-up, no ledger ownership); the note is mandatory and
/// capped at 200 characters, and unused tokens are capped per issuer
/// (register_invitation::OPEN_LIMIT).
async fn create_register_invitation(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<CreateRegisterInvitationReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let note = req.inviter_note.trim();
    if note.is_empty() {
        return Err(ApiError::bad_request("inviter_note_required"));
    }
    if note.chars().count() > 200 {
        return Err(ApiError::bad_request("inviter_note_too_long"));
    }
    let now = session::now_ms();
    let ttl = state.auth.invitation.register_ttl_hours * 3_600_000;
    let expires_at = now + ttl;
    let token = match register_invitation::issue(&state.db, s.user_id, note, ttl, now).await {
        Ok(token) => token,
        Err(register_invitation::IssueRegisterError::OpenLimit) => {
            return Err(ApiError::bad_request("register_open_limit"));
        }
        Err(e) => return Err(ApiError::internal(anyhow::Error::new(e))),
    };
    let mut conn = state.db.acquire().await.map_err(ApiError::sqlx)?;
    super::audit(
        &mut conn,
        "web",
        "register_invitation",
        0,
        "create",
        Some(s.user_id),
        &json!({ "kind": "register" }),
        now,
    )
    .await
    .map_err(ApiError::sqlx)?;
    let url = format!("{}/register?token={token}", state.auth.public_origin);
    let mut resp = Json(json!({ "url": url, "expires_at": expires_at })).into_response();
    *resp.status_mut() = StatusCode::CREATED;
    Ok(resp)
}

// ---------------------------------------------------------------------------
// me / logout (spec_auth.md section 3-2)

async fn me(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let ledgers: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT l.id, l.name, m.role, m.color FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? ORDER BY l.id",
    )
    .bind(s.user_id)
    .fetch_all(&state.db)
    .await
    .map_err(ApiError::sqlx)?;
    let default_ledger_id: Option<i64> =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(s.user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(ApiError::sqlx)?
            .flatten();
    // only a ledger the user still belongs to (spec_auth.md 3-2)
    let default_ledger_id = default_ledger_id.filter(|d| ledgers.iter().any(|(id, ..)| id == d));
    let ledgers: Vec<serde_json::Value> = ledgers
        .into_iter()
        .map(|(id, name, role, color)| {
            json!({ "id": id, "name": name, "role": role, "color": color })
        })
        .collect();
    Ok(Json(json!({
        "user_id": s.user_id,
        "account_number": s.account_number,
        "display_name": s.display_name,
        "default_ledger_id": default_ledger_id,
        "ledgers": ledgers,
        "auth_at": s.auth_at,
    })))
}

// ---------------------------------------------------------------------------
// default ledger (TASK-13, spec_auth.md sections 3-2, 6-1)

#[derive(Deserialize)]
struct SetDefaultLedgerReq {
    ledger_id: i64,
}

/// `PUT /api/auth/me/default-ledger {ledger_id}` — change the session user's
/// own `users.default_ledger_id` (the web screens' initial selection and the
/// initial active ledger of future grants). Memberships only; the grant
/// selection itself is untouched (the settings-screen variant of
/// `switch_ledger`, which stays per-grant).
async fn set_default_ledger(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
    Json(req): Json<SetDefaultLedgerReq>,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let out = crate::auth::ledger::set_default_ledger(&state.db, s.user_id, req.ledger_id, now)
        .await
        .map_err(|e| match e {
            ledger::DefaultLedgerError::NotFound => {
                ApiError::new(StatusCode::NOT_FOUND, "not_found")
            }
            ledger::DefaultLedgerError::Db(err) => ApiError::internal(err),
        })?;
    Ok(Json(json!({
        "ledger": { "id": out.ledger_id, "name": out.name, "role": out.role.as_str() },
    }))
    .into_response())
}

async fn logout(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (_, token) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    session::revoke_session(&state.db, &token, now)
        .await
        .map_err(ApiError::internal)?;
    let mut resp = StatusCode::NO_CONTENT.into_response();
    set_cookie(
        resp.headers_mut(),
        session::clear_cookie(session::COOKIE_SESSION),
    );
    Ok(resp)
}

async fn logout_all(
    State(state): State<AuthApiState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (s, _) = require_session(&state, &headers).await?;
    let now = session::now_ms();
    let mut conn = state.db.acquire().await.map_err(ApiError::sqlx)?;
    session::revoke_user_sessions(&mut conn, s.user_id, now)
        .await
        .map_err(ApiError::sqlx)?;
    let mut resp = StatusCode::NO_CONTENT.into_response();
    set_cookie(
        resp.headers_mut(),
        session::clear_cookie(session::COOKIE_SESSION),
    );
    Ok(resp)
}
