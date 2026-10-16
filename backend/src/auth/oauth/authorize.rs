//! `/oauth/authorize`, the consent screen API and the decision POST
//! (spec_auth.md sections 4-2, 4-5, 4-6, 11-3). Validated parameters are
//! persisted in `oauth_authorization_requests` (10 min TTL, id 256-bit, DB
//! stores the hash) and tied to the web session at consent view time.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::Connection;

use super::cimd::{self, ClientError};
use super::{pair, parse_pairs_exclusive, parse_requested_scope, scope_string};
use crate::auth::session::{self, ValidSession};
use crate::auth::tokens::{TOKEN_LEN, b64url_encode, random_token, sha256};
use crate::config::ResolvedAuth;

pub type State_ = super::super::api::AuthApiState;

/// Routes mounted under the /oauth router (the decision POST carries its own
/// Origin check, spec_auth.md 3-1); state is applied by the mounting router.
pub fn routes() -> Router<State_> {
    Router::new().route("/oauth/authorize/decision", post(decision))
}

/// The /api routes mounted into the auth /api router (Origin / JSON guarded
/// and rate limited there); state is applied by the mounting router.
pub fn api_routes() -> Router<State_> {
    Router::new().route("/api/oauth/requests/{req_id}", get(consent_info))
}

// ---------------------------------------------------------------------------
// GET /oauth/authorize

/// Minimal 400 error page for failures before the redirect URI is validated
/// (spec_auth.md 4-2 / 10-4: never redirect with an unvalidated client).
fn authorize_error_page(detail: &str) -> Response {
    let body = format!(
        "<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\"><title>budget-book - 接続エラー</title>\
         <style>body{{font-family:sans-serif;padding:2rem;max-width:40rem}}</style>\
         <h1>接続を開始できません</h1><p>接続元アプリの設定が正しくないため、この接続は開始できませんでした。({detail})</p>"
    );
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_SECURITY_POLICY, "frame-ancestors 'none'")],
        [(header::X_FRAME_OPTIONS, "DENY")],
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

/// Build the redirect URL back to the client with query params.
fn redirect_url(redirect_uri: &str, params: &[(&str, String)]) -> String {
    let sep = if redirect_uri.contains('?') { '&' } else { '?' };
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{redirect_uri}{sep}{query}")
}

/// Build the redirect back to the client with `error` (+ state + iss).
fn redirect_error(redirect_uri: &str, error: &str, state: Option<&str>, issuer: &str) -> Response {
    let mut params = vec![("error", error.to_string()), ("iss", issuer.to_string())];
    if let Some(st) = state {
        params.push(("state", st.to_string()));
    }
    redirect_response(redirect_url(redirect_uri, &params))
}

fn redirect_response(location: String) -> Response {
    (
        StatusCode::FOUND,
        [(header::LOCATION, location)],
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response()
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub async fn authorize_get(
    State(state): State<State_>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
    headers: HeaderMap,
) -> Response {
    let now = session::now_ms();
    let Some(query) = query else {
        return authorize_error_page("missing parameters");
    };
    let pairs = match parse_pairs_exclusive(&query) {
        Ok(p) => p,
        Err(_) => return authorize_error_page("duplicate parameters"),
    };
    let Some(client_id) = pair(&pairs, "client_id") else {
        return authorize_error_page("client_id missing");
    };
    let Some(redirect_uri) = pair(&pairs, "redirect_uri") else {
        return authorize_error_page("redirect_uri missing");
    };
    let req_state = pair(&pairs, "state").map(str::to_string);
    let issuer = state.auth.issuer.clone();

    // 1. client_id static validation (no redirect on failure)
    if cimd::validate_client_id_url(client_id, &state.auth).is_err() {
        return authorize_error_page("unsupported client");
    }
    // 2. CIMD fetch / cache (invalid client: error page, never a redirect)
    let record = match cimd::get_client(&state.db, &state.fetch, &state.auth, client_id, now).await
    {
        Ok(r) => r,
        Err(ClientError::InvalidClientId) => return authorize_error_page("unsupported client"),
        Err(e) => {
            tracing::warn!(error = %e, "CIMD unavailable");
            return authorize_error_page("client metadata unavailable");
        }
    };
    // 3. redirect URI double allowlist (no redirect on failure)
    if !cimd::redirect_uri_allowed(&record, redirect_uri, &state.auth) {
        return authorize_error_page("redirect_uri not registered");
    }

    // 4. from here on, errors redirect (spec_auth.md 4-2)
    let macro_redirect =
        |error: &str| redirect_error(redirect_uri, error, req_state.as_deref(), &issuer);
    // state: at most 512 characters (spec_auth.md 4-5); an oversized value is
    // not echoed back
    if req_state
        .as_deref()
        .is_some_and(|st| st.chars().count() > 512)
    {
        return redirect_error(redirect_uri, "invalid_request", None, &issuer);
    }
    let Some(response_type) = pair(&pairs, "response_type") else {
        return macro_redirect("invalid_request");
    };
    if response_type != "code" {
        return macro_redirect("unsupported_response_type");
    }
    let Some(resource) = pair(&pairs, "resource") else {
        return macro_redirect("invalid_request");
    };
    // absolute URL without a fragment (spec_auth.md 4-5), then exact match
    let parsed: Option<url::Url> = resource.parse().ok();
    match parsed {
        Some(u) if u.has_host() && u.fragment().is_none() => {}
        _ => return macro_redirect("invalid_request"),
    }
    if resource != state.auth.resource {
        return macro_redirect("invalid_target");
    }
    let Some(code_challenge) = pair(&pairs, "code_challenge") else {
        return macro_redirect("invalid_request");
    };
    if !valid_code_challenge(code_challenge) {
        return macro_redirect("invalid_request");
    }
    if pair(&pairs, "code_challenge_method") != Some("S256") {
        return macro_redirect("invalid_request");
    }
    let requested_scope = match parse_requested_scope(pair(&pairs, "scope")) {
        Ok(s) => s,
        Err(_) => return macro_redirect("invalid_scope"),
    };
    let scope = scope_string(&super::effective_scope(
        requested_scope,
        &state.auth.oauth.default_scopes,
    ));

    // 5. persist the authorization request (10 min TTL)
    let id = random_token();
    let insert = sqlx::query(
        "INSERT INTO oauth_authorization_requests
            (id_hash, client_id, redirect_uri, state, code_challenge, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&id).to_vec())
    .bind(client_id)
    .bind(redirect_uri)
    .bind(&req_state)
    .bind(code_challenge)
    .bind(&scope)
    .bind(resource)
    .bind(now)
    .bind(now + state.auth.oauth.authz_request_ttl_secs * 1000)
    .execute(&state.db)
    .await;
    if let Err(e) = insert {
        tracing::error!(error = %e, "authorization request insert failed");
        return authorize_error_page("internal error");
    }

    // 6. logged in? -> consent; else -> login carrying the request id
    let req_id = b64url_encode(&id);
    let logged_in = match session::cookie_token(&headers, session::COOKIE_SESSION) {
        Some(tok) => matches!(
            session::validate_session(&state.db, &tok, now, &state.auth.session).await,
            Ok(Some(_))
        ),
        None => false,
    };
    let location = if logged_in {
        format!("/oauth/consent?req={req_id}")
    } else {
        format!("/login?req={req_id}")
    };
    redirect_response(location)
}

/// `code_challenge`: 43 chars of the base64url alphabet, no padding
/// (spec_auth.md 4-5).
fn valid_code_challenge(challenge: &str) -> bool {
    challenge.len() == 43
        && challenge
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Validate a `code_verifier` shape (43..128 chars, RFC 7636 unreserved).
pub fn valid_code_verifier(verifier: &str) -> bool {
    (43..=128).contains(&verifier.len())
        && verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

/// Constant-time PKCE comparison (spec_auth.md 4-5 / 10-4).
pub fn pkce_matches(verifier: &str, challenge: &str) -> bool {
    use subtle::ConstantTimeEq;
    let digest = sha256(verifier.as_bytes());
    let encoded = b64url_encode(&digest);
    let a = encoded.as_bytes();
    let b = challenge.as_bytes();
    a.len() == b.len() && a.ct_eq(b).into()
}

// ---------------------------------------------------------------------------
// consent info (spec_auth.md 4-2, 4-6)

fn unauthorized_boxed() -> Response {
    let boxed: Box<Response> = Box::new(
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "unauthorized"})),
        )
            .into_response(),
    );
    *boxed
}

async fn require_api_session(
    state: &State_,
    headers: &HeaderMap,
) -> Result<ValidSession, Box<Response>> {
    let now = session::now_ms();
    let Some(token) = session::cookie_token(headers, session::COOKIE_SESSION) else {
        return Err(Box::new(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized"})),
            )
                .into_response(),
        ));
    };
    match session::validate_session(&state.db, &token, now, &state.auth.session).await {
        Ok(Some(s)) => Ok(s),
        Ok(None) => Err(Box::new(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error": "unauthorized"})),
            )
                .into_response(),
        )),
        Err(e) => {
            tracing::error!(error = %e, "session validation failed");
            Err(Box::new(
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "internal"})),
                )
                    .into_response(),
            ))
        }
    }
}

/// The initial active ledger for a new grant (spec_auth.md 6-1): the newest
/// still-valid grant of the same (user, client, resource), else
/// `users.default_ledger_id`, else None — each only with a current membership.
pub async fn initial_active_ledger(
    conn: &mut sqlx::SqliteConnection,
    user_id: i64,
    client_id: &str,
    resource: &str,
    now: i64,
) -> Option<i64> {
    let from_old_grant: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT active_ledger_id FROM oauth_grants
         WHERE user_id = ? AND client_id = ? AND resource = ?
           AND revoked_at IS NULL AND absolute_expires_at > ?
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(client_id)
    .bind(resource)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await
    .ok()
    .flatten();
    if let Some(ledger_id) = from_old_grant.flatten()
        && is_member(conn, user_id, ledger_id).await
    {
        return Some(ledger_id);
    }
    let default: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT default_ledger_id FROM users WHERE id = ? AND disabled_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await
    .ok()
    .flatten();
    if let Some(ledger_id) = default.flatten()
        && is_member(conn, user_id, ledger_id).await
    {
        return Some(ledger_id);
    }
    None
}

async fn is_member(conn: &mut sqlx::SqliteConnection, user_id: i64, ledger_id: i64) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT 1 FROM ledger_members WHERE user_id = ? AND ledger_id = ?")
        .bind(user_id)
        .bind(ledger_id)
        .fetch_optional(conn)
        .await
        .ok()
        .flatten()
        .is_some()
}

async fn consent_info(
    State(state): State<State_>,
    headers: HeaderMap,
    Path(req_id): Path<String>,
) -> Response {
    let Ok(s) = require_api_session(&state, &headers).await else {
        return unauthorized_boxed();
    };
    let now = session::now_ms();
    let Some(id_bytes) = decode_req_id(&req_id) else {
        return not_found();
    };
    let hash = sha256(&id_bytes).to_vec();
    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    // bind the request to this session's user (spec_auth.md 4-2)
    let bound = sqlx::query(
        "UPDATE oauth_authorization_requests SET user_id = ?
         WHERE id_hash = ? AND expires_at > ? AND user_id IS NULL",
    )
    .bind(s.user_id)
    .bind(&hash)
    .bind(now)
    .execute(&mut *conn)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if bound == 0 {
        // expired, unknown, or already bound to another user
        return not_found();
    }
    let row: Option<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT client_id, resource, state, scope FROM oauth_authorization_requests WHERE id_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&mut *conn)
    .await
    .unwrap_or(None);
    let Some((client_id, resource, _state_param, scope)) = row else {
        return not_found();
    };
    // the client record must still resolve for the consent view (release the
    // single test connection first: the CIMD path acquires its own)
    drop(conn);
    if cimd::get_client(&state.db, &state.fetch, &state.auth, &client_id, now)
        .await
        .is_err()
    {
        return not_found();
    }
    let host = client_host_of(&client_id);
    let scopes: Vec<serde_json::Value> = scope
        .split_whitespace()
        .map(|name| {
            json!({
                "name": name,
                "description": super::scope_description(name),
            })
        })
        .collect();
    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let initial = initial_active_ledger(&mut conn, s.user_id, &client_id, &resource, now).await;
    let ledger_name: Option<String> = match initial {
        Some(lid) => sqlx::query_scalar::<_, String>("SELECT name FROM ledgers WHERE id = ?")
            .bind(lid)
            .fetch_optional(&mut *conn)
            .await
            .unwrap_or(None),
        None => None,
    };
    Json(json!({
        "client_display": super::client_display_for_host(&host),
        "client_id": client_id,
        "scopes": scopes,
        "ledger_name": ledger_name,
        "user_display_name": s.display_name,
    }))
    .into_response()
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"}))).into_response()
}

fn internal(e: sqlx::Error) -> Response {
    tracing::error!(error = %e, "oauth api failure");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal"})),
    )
        .into_response()
}

fn decode_req_id(req_id: &str) -> Option<[u8; TOKEN_LEN]> {
    crate::auth::tokens::b64url_decode(req_id).and_then(|b| b.try_into().ok())
}

// ---------------------------------------------------------------------------
// POST /oauth/authorize/decision (spec_auth.md 4-2, 4-6, 3-1)

#[derive(serde::Deserialize)]
struct DecisionReq {
    req: String,
    decision: String,
}

async fn decision(
    State(state): State<State_>,
    headers: HeaderMap,
    axum::Json(body): axum::Json<DecisionReq>,
) -> Response {
    // Origin check (spec_auth.md 3-1: the decision POST is CSRF-guarded)
    if !origin_ok(&headers, &state.auth) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "origin_mismatch"})),
        )
            .into_response();
    }
    let Ok(s) = require_api_session(&state, &headers).await else {
        return unauthorized_boxed();
    };
    if body.decision != "allow" && body.decision != "deny" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_decision"})),
        )
            .into_response();
    }
    let Some(id_bytes) = decode_req_id(&body.req) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_request"})),
        )
            .into_response();
    };
    let hash = sha256(&id_bytes).to_vec();
    let now = session::now_ms();

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let mut tx = match conn.begin_with("BEGIN IMMEDIATE").await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    // the request must exist, be live, and belong to this session's user
    let row: Option<(String, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT client_id, redirect_uri, state, scope, code_challenge
         FROM oauth_authorization_requests
         WHERE id_hash = ? AND expires_at > ? AND user_id = ?",
    )
    .bind(&hash)
    .bind(now)
    .bind(s.user_id)
    .fetch_optional(&mut *tx)
    .await
    .unwrap_or(None);
    let Some((client_id, redirect_uri, req_state, scope, code_challenge)) = row else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_request"})),
        )
            .into_response();
    };
    let deleted = sqlx::query("DELETE FROM oauth_authorization_requests WHERE id_hash = ?")
        .bind(&hash)
        .execute(&mut *tx)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
    if deleted != 1 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_request"})),
        )
            .into_response();
    }

    let redirect_to = if body.decision == "allow" {
        // issue the one-time code (grant_id stays NULL until exchange,
        // spec_auth.md 4-6)
        let code = random_token();
        let resource = state.auth.resource.clone();
        let inserted = sqlx::query(
            "INSERT INTO oauth_auth_codes
                (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource,
                 created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(sha256(&code).to_vec())
        .bind(s.user_id)
        .bind(&client_id)
        .bind(&redirect_uri)
        .bind(&code_challenge)
        .bind(&scope)
        .bind(&resource)
        .bind(now)
        .bind(now + state.auth.oauth.code_ttl_secs * 1000)
        .execute(&mut *tx)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
        if inserted != 1 {
            return internal(sqlx::Error::RowNotFound);
        }
        let mut url_params: Vec<(&str, String)> = vec![
            ("code", b64url_encode(&code)),
            ("iss", state.auth.issuer.clone()),
        ];
        if let Some(st) = &req_state {
            url_params.push(("state", st.clone()));
        }
        let url = redirect_url(&redirect_uri, &url_params);
        crate::auth::audit(
            &mut tx,
            "web",
            "user",
            s.user_id,
            "consent",
            Some(s.user_id),
            &json!({ "client_id": client_id, "scope": scope, "decision": "allow" }),
            now,
        )
        .await
        .ok();
        url
    } else {
        crate::auth::audit(
            &mut tx,
            "web",
            "user",
            s.user_id,
            "consent",
            Some(s.user_id),
            &json!({ "client_id": client_id, "scope": scope, "decision": "deny" }),
            now,
        )
        .await
        .ok();
        let mut deny_params = vec![
            ("error", "access_denied".to_string()),
            ("iss", state.auth.issuer.clone()),
        ];
        if let Some(st) = &req_state {
            deny_params.push(("state", st.clone()));
        }
        redirect_url(&redirect_uri, &deny_params)
    };
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    Json(json!({ "redirect_to": redirect_to })).into_response()
}

fn origin_ok(headers: &HeaderMap, cfg: &ResolvedAuth) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|o| o == cfg.public_origin)
}

/// Host portion of a client_id URL (no port / path) for the fixed display
/// name (spec_auth.md 4-6).
pub fn client_host_of(client_id: &str) -> String {
    client_id
        .parse::<url::Url>()
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_default()
}
