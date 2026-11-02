//! `/oauth/token` and `/oauth/revoke` (spec_auth.md sections 4-4, 4-7, 4-9,
//! 4-10, 4-11, 11-4, 11-5): PKCE code exchange creating the grant (with
//! supersede + active-ledger inheritance), refresh rotation with the 60s
//! grace window, and RFC 7009 revocation. All fraud responses revoke inside
//! `BEGIN IMMEDIATE`, COMMIT, and only then return `invalid_grant`.

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use sqlx::{Connection, SqliteConnection};

use super::assertion::{self, AssertionError};
use super::authorize::{pkce_matches, valid_code_verifier};
use super::cimd::{self, ClientError};
use super::{OAuthError, pair, parse_pairs_exclusive, parse_requested_scope, scope_string};
use crate::auth::session::now_ms;
use crate::auth::tokens::{TOKEN_LEN, b64url_encode, random_token, sha256};

type State_ = super::super::api::AuthApiState;

const DAY_MS: i64 = 86_400_000;

/// Issued token pair returned inside the exchange transaction.
struct IssuedPair {
    access: [u8; TOKEN_LEN],
    refresh: [u8; TOKEN_LEN],
    access_expires_at: i64,
    #[allow(dead_code)] // kept for tests / future refresh-expiry exposure
    refresh_expires_at: i64,
}

/// The exchange / rotation outcome; revocations must survive the response
/// (spec_auth.md 4-10), so the caller commits before mapping to errors.
enum Outcome {
    Issued {
        pair: IssuedPair,
        scope: String,
    },
    /// grant revoked (reason) and already committed; respond invalid_grant
    /// (the reason is kept for tests to assert on)
    RejectedAfterCommit(#[allow(dead_code)] &'static str),
    /// plain rejection (transaction rolled back)
    Rejected(OAuthError),
    Error(OAuthError),
}

// ---------------------------------------------------------------------------
// POST /oauth/token

pub async fn token_post(
    State(state): State<State_>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let now = now_ms();
    let pairs = match parse_pairs_exclusive(&String::from_utf8_lossy(&body)) {
        Ok(p) => p,
        Err(_) => return OAuthError::invalid_request().into_response(),
    };
    let grant_type = pair(&pairs, "grant_type").unwrap_or_default();

    // Resolve the client (CIMD) first: client_id form param or assertion iss.
    let form_client_id = pair(&pairs, "client_id").map(str::to_string);
    let client_assertion = pair(&pairs, "client_assertion").map(str::to_string);
    let client_assertion_type = pair(&pairs, "client_assertion_type").map(str::to_string);
    let client_id = match &client_assertion {
        Some(a) => match assertion::assertion_issuer(a) {
            Some(iss) => iss,
            None => {
                return if form_client_id.is_some() {
                    OAuthError::invalid_client().into_response()
                } else {
                    OAuthError::invalid_request().into_response()
                };
            }
        },
        None => match &form_client_id {
            Some(c) => c.clone(),
            None => return OAuthError::invalid_request().into_response(),
        },
    };

    // before the client is authenticated, the limiter key is the client IP
    // (spec_auth.md 10-1); this also bounds CIMD / JWKS fetches per source
    if let Some(retry) = ip_limit(&state, &headers, &extensions, now) {
        return retry;
    }

    let record = match cimd::get_client(&state.db, &state.fetch, &state.auth, &client_id, now).await
    {
        Ok(r) => r,
        Err(ClientError::InvalidClientId(_)) => {
            return OAuthError::invalid_client().into_response();
        }
        Err(e) => {
            tracing::warn!(error = %e, client_id, "client metadata unavailable");
            return OAuthError::invalid_client().into_response();
        }
    };
    let client = match assertion::authenticate_client(
        &state.db,
        &state.fetch,
        &state.auth,
        &record,
        form_client_id.as_deref(),
        client_assertion.as_deref(),
        client_assertion_type.as_deref(),
        now,
    )
    .await
    {
        Ok(c) => c,
        Err(
            AssertionError::Invalid | AssertionError::Missing | AssertionError::MethodMismatch(_),
        ) => return OAuthError::invalid_client().into_response(),
        Err(AssertionError::Db(e)) => {
            tracing::error!(error = %e, "client authentication failed");
            return OAuthError::invalid_client().into_response();
        }
    };
    // authenticated: the limiter key becomes the verified client_id
    if let Some(retry) = client_limit(&state, &client.client_id, now) {
        return retry;
    }

    let outcome = match grant_type {
        "authorization_code" => code_exchange(&state, &pairs, &client.client_id, now).await,
        "refresh_token" => refresh(&state, &pairs, &client.client_id, now).await,
        _ => Outcome::Error(OAuthError::unsupported_grant_type()),
    };
    match outcome {
        Outcome::Issued { pair, scope } => {
            let expires_in = (pair.access_expires_at - now).max(0) / 1000;
            let mut resp = axum::Json(json!({
                "access_token": b64url_encode(&pair.access),
                "token_type": "Bearer",
                "expires_in": expires_in,
                "refresh_token": b64url_encode(&pair.refresh),
                "scope": scope,
            }))
            .into_response();
            resp.headers_mut().insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-store"),
            );
            resp.headers_mut().insert(
                axum::http::header::PRAGMA,
                axum::http::HeaderValue::from_static("no-cache"),
            );
            resp
        }
        Outcome::RejectedAfterCommit(_) => OAuthError::invalid_grant().into_response(),
        Outcome::Rejected(e) | Outcome::Error(e) => e.into_response(),
    }
}

/// Consume the code (mark used) inside its own transaction; used when a
/// parameter-level failure happens before the main exchange (spec 4-5: the
/// code counts as consumed on verifier shape violations too).
async fn consume_code(pool: &sqlx::SqlitePool, code_hash: &[u8], now: i64) {
    let Ok(mut conn) = pool.acquire().await else {
        return;
    };
    let Ok(mut tx) = conn.begin_with("BEGIN IMMEDIATE").await else {
        return;
    };
    let _ = sqlx::query(
        "UPDATE oauth_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    )
    .bind(now)
    .bind(code_hash)
    .execute(&mut *tx)
    .await;
    let _ = tx.commit().await;
}

/// oauth_auth_codes columns: (used_at, expires_at, client_id, redirect_uri,
/// resource, code_challenge, scope, user_id, grant_id).
type CodeRow = (
    Option<i64>,
    i64,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<i64>,
);

/// Mark the code used inside the caller's transaction and COMMIT, then the
/// caller returns invalid_grant (spec 4-7).
async fn consume_and_reject(
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    code_hash: &[u8],
    now: i64,
) {
    let _ = sqlx::query(
        "UPDATE oauth_auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL",
    )
    .bind(now)
    .bind(code_hash)
    .execute(&mut *tx)
    .await;
    let _ = tx.commit().await;
}

async fn code_exchange(
    state: &State_,
    pairs: &[(String, String)],
    client_id: &str,
    now: i64,
) -> Outcome {
    let Some(code) = pair(pairs, "code") else {
        return Outcome::Error(OAuthError::invalid_request());
    };
    let Some(redirect_uri) = pair(pairs, "redirect_uri") else {
        return Outcome::Error(OAuthError::invalid_request());
    };
    let code_hash = match decode_token_param(code) {
        Some(h) => h,
        None => return Outcome::Error(OAuthError::invalid_grant()),
    };
    let Some(verifier) = pair(pairs, "code_verifier") else {
        return Outcome::Error(OAuthError::invalid_request());
    };
    if !valid_code_verifier(verifier) {
        // the code counts as consumed (spec_auth.md 4-5)
        consume_code(&state.db, &code_hash, now).await;
        return Outcome::Error(OAuthError::invalid_grant());
    }
    let requested_resource = pair(pairs, "resource").map(str::to_string);
    let requested_scope = pair(pairs, "scope").map(str::to_string);

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return db_error(e),
    };
    let mut tx = match conn.begin_with("BEGIN IMMEDIATE").await {
        Ok(t) => t,
        Err(e) => return db_error(e),
    };

    // (used_at, expires_at, client_id, redirect_uri, resource, code_challenge, scope, user_id, grant_id)
    let row: Option<CodeRow> = match sqlx::query_as(
        "SELECT used_at, expires_at, client_id, redirect_uri, resource, code_challenge, scope,
                user_id, grant_id
         FROM oauth_auth_codes WHERE code_hash = ?",
    )
    .bind(&code_hash)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "auth code lookup failed");
            None
        }
    };
    let Some((
        used_at,
        expires_at,
        code_client,
        code_redirect,
        code_resource,
        code_challenge,
        code_scope,
        user_id,
        code_grant_id,
    )) = row
    else {
        return Outcome::Rejected(OAuthError::invalid_grant());
    };

    // replay: revoke the issued grant, COMMIT, then reject (spec 4-7)
    if used_at.is_some() {
        if let Some(grant_id) = code_grant_id {
            let _ = sqlx::query(
                "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'code_reuse'
                 WHERE id = ? AND revoked_at IS NULL",
            )
            .bind(now)
            .bind(grant_id)
            .execute(&mut *tx)
            .await;
        }
        if let Err(e) = tx.commit().await {
            return db_error(e);
        }
        return Outcome::RejectedAfterCommit("code_reuse");
    }

    // consume-and-reject path (spec 4-7): mark used, COMMIT, invalid_grant
    if expires_at <= now
        || code_client != client_id
        || code_redirect != redirect_uri
        || requested_resource
            .as_deref()
            .is_some_and(|r| r != code_resource)
    {
        consume_and_reject(tx, &code_hash, now).await;
        return Outcome::Rejected(OAuthError::invalid_grant());
    }
    if !pkce_matches(verifier, &code_challenge) {
        consume_and_reject(tx, &code_hash, now).await;
        return Outcome::Rejected(OAuthError::invalid_grant());
    }
    // scope on the exchange: absent = code scope; must be a subset of it
    let scope = match &requested_scope {
        Some(req) => {
            let granted: std::collections::BTreeSet<&str> = code_scope.split_whitespace().collect();
            let wanted = match parse_requested_scope(Some(req)) {
                Ok(Some(list)) => list,
                _ => {
                    consume_and_reject(tx, &code_hash, now).await;
                    return Outcome::Rejected(OAuthError::invalid_scope());
                }
            };
            if wanted.iter().any(|w| !granted.contains(w.as_str())) {
                consume_and_reject(tx, &code_hash, now).await;
                return Outcome::Rejected(OAuthError::invalid_scope());
            }
            if wanted.is_empty() {
                code_scope.clone()
            } else {
                scope_string(&wanted)
            }
        }
        None => code_scope.clone(),
    };
    // user must still be enabled
    let enabled: Option<i64> = match sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "auth code user lookup failed");
            None
        }
    };
    if enabled.is_none() {
        consume_and_reject(tx, &code_hash, now).await;
        return Outcome::Rejected(OAuthError::invalid_grant());
    }

    // grant creation (spec 4-7 + 6-1): initial ledger from the newest valid
    // old grant, else default_ledger_id (each with a membership check).
    let active_ledger_id =
        super::authorize::initial_active_ledger(&mut tx, user_id, client_id, &code_resource, now)
            .await;
    let absolute_expires_at = now + state.auth.oauth.grant_absolute_days * DAY_MS;
    let grant_id: i64 = match sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id,
             created_at, absolute_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(client_id)
    .bind(&scope)
    .bind(&code_resource)
    .bind(active_ledger_id)
    .bind(now)
    .bind(absolute_expires_at)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(id) => id,
        Err(e) => return db_error(e),
    };
    // supersede older valid grants of the same (user, client, resource)
    let _ = sqlx::query(
        "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'superseded'
         WHERE user_id = ? AND client_id = ? AND resource = ? AND revoked_at IS NULL AND id <> ?",
    )
    .bind(now)
    .bind(user_id)
    .bind(client_id)
    .bind(&code_resource)
    .bind(grant_id)
    .execute(&mut *tx)
    .await;
    let _ =
        sqlx::query("UPDATE oauth_auth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ?")
            .bind(now)
            .bind(grant_id)
            .bind(&code_hash)
            .execute(&mut *tx)
            .await;
    let pair = match issue_pair(&mut tx, grant_id, now, absolute_expires_at, &state.auth).await {
        Ok(p) => p,
        Err(e) => return db_error(e),
    };
    let _ = crate::auth::audit(
        &mut tx,
        "client",
        "oauth_grant",
        grant_id,
        "grant_create",
        Some(user_id),
        &json!({
            "client_id": client_id,
            "scope": scope,
            "resource": code_resource,
            "active_ledger_id": active_ledger_id,
        }),
        now,
    )
    .await;
    if let Err(e) = tx.commit().await {
        return db_error(e);
    }
    Outcome::Issued {
        pair,
        scope: scope.clone(),
    }
}

async fn refresh(state: &State_, pairs: &[(String, String)], client_id: &str, now: i64) -> Outcome {
    let Some(token) = pair(pairs, "refresh_token") else {
        return Outcome::Error(OAuthError::invalid_request());
    };
    let token_hash = match decode_token_param(token) {
        Some(h) => h,
        None => return Outcome::Error(OAuthError::invalid_grant()),
    };
    let requested_resource = pair(pairs, "resource").map(str::to_string);
    let requested_scope = pair(pairs, "scope").map(str::to_string);

    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return db_error(e),
    };
    let mut tx = match conn.begin_with("BEGIN IMMEDIATE").await {
        Ok(t) => t,
        Err(e) => return db_error(e),
    };

    // (used_at, child_hash, grant_id, revoked_at, expires_at) of the token;
    // then grant + user state. A failing SELECT is a rejection (fail closed).
    let row: Option<RefreshRow> = match sqlx::query_as(
        "SELECT used_at, child_hash, grant_id, revoked_at, expires_at
         FROM oauth_refresh_tokens WHERE token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "refresh token lookup failed");
            None
        }
    };
    let Some((used_at, child_hash, grant_id, t_revoked, t_expires)) = row else {
        return Outcome::Rejected(OAuthError::invalid_grant());
    };
    let grant: Option<GrantRow> = match sqlx::query_as(
        "SELECT g.user_id, g.scope, g.resource, g.absolute_expires_at, g.revoked_at,
                    g.client_id, g.created_at, g.active_ledger_id
             FROM oauth_grants g WHERE g.id = ?",
    )
    .bind(grant_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(error = %e, "refresh grant lookup failed");
            None
        }
    };
    let Some((g_user, g_scope, g_resource, g_absolute, g_revoked, g_client, _g_created, _g_active)) =
        grant
    else {
        return Outcome::Rejected(OAuthError::invalid_grant());
    };
    let user_enabled: Option<i64> =
        match sqlx::query_scalar("SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL")
            .bind(g_user)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                // fail closed: an unreadable user state rejects the refresh
                tracing::error!(error = %e, "refresh user lookup failed");
                None
            }
        };

    // step 1 (spec_auth.md 4-9, spec_data-model.md section 14). Order:
    // expiry of a non-revoked row / grant revoked / grant expired / user
    // disabled -> resource mismatch -> client mismatch -> revoked token
    // (reuse) -> scope. A revoked row is checked before its expiry (an
    // expired superseded child is still reuse while the grant is valid).
    let token_expired = t_revoked.is_none() && t_expires <= now;
    if token_expired || g_revoked.is_some() || g_absolute <= now || user_enabled.is_none() {
        return Outcome::Rejected(OAuthError::invalid_grant());
    }
    if let Some(res) = &requested_resource
        && res != &g_resource
    {
        return Outcome::Rejected(OAuthError::invalid_grant());
    }
    if g_client != client_id {
        // revoke the grant, COMMIT, then reject
        if let Err(e) = revoke_grant(&mut tx, grant_id, now, "client_mismatch").await {
            return db_error(e);
        }
        if let Err(e) = tx.commit().await {
            return db_error(e);
        }
        return Outcome::RejectedAfterCommit("client_mismatch");
    }
    if t_revoked.is_some() {
        // only step 3 sets oauth_refresh_tokens.revoked_at: this is a child
        // superseded by a grace reissue -> theft signal, revoke the family
        return revoke_for_reuse(tx, grant_id, client_id, now, "superseded_child").await;
    }
    // scope must narrow (spec 4-9 / 4-8)
    let new_scope = match &requested_scope {
        Some(req) => {
            let granted: std::collections::BTreeSet<&str> = g_scope.split_whitespace().collect();
            let wanted = match parse_requested_scope(Some(req)) {
                Ok(Some(list)) => list,
                _ => return Outcome::Rejected(OAuthError::invalid_scope()),
            };
            if wanted.iter().any(|w| !granted.contains(w.as_str())) {
                return Outcome::Rejected(OAuthError::invalid_scope());
            }
            if wanted.is_empty() {
                g_scope.clone()
            } else {
                scope_string(&wanted)
            }
        }
        None => g_scope.clone(),
    };

    let grace_ms = state.auth.oauth.rotation_grace_secs * 1000;
    match used_at {
        // step 2: first use -> child refresh + access
        None => {
            let pair = match issue_pair(&mut tx, grant_id, now, g_absolute, &state.auth).await {
                Ok(p) => p,
                Err(e) => return db_error(e),
            };
            let upd = sqlx::query(
                "UPDATE oauth_refresh_tokens SET used_at = ?, child_hash = ? WHERE token_hash = ? AND used_at IS NULL",
            )
            .bind(now)
            .bind(sha256(&pair.refresh).to_vec())
            .bind(&token_hash)
            .execute(&mut *tx)
            .await
            .map(|r| r.rows_affected())
            .unwrap_or(0);
            if upd != 1 {
                return db_error(sqlx::Error::RowNotFound);
            }
            if let Err(e) = tx.commit().await {
                return db_error(e);
            }
            Outcome::Issued {
                pair,
                scope: new_scope,
            }
        }
        Some(used_at_ms) if now - used_at_ms <= grace_ms => {
            // step 3: within grace and the current child unused -> reissue
            let Some(child) = child_hash else {
                return db_error(sqlx::Error::RowNotFound);
            };
            let child_ok: Option<i64> = match sqlx::query_scalar(
                "SELECT 1 FROM oauth_refresh_tokens
                 WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL",
            )
            .bind(&child)
            .fetch_optional(&mut *tx)
            .await
            {
                Ok(r) => r,
                Err(e) => return db_error(e),
            };
            if child_ok.is_none() {
                // the child was already used: theft signal (step 4)
                return revoke_for_reuse(tx, grant_id, client_id, now, "child_used").await;
            }
            // supersede the old child: revoke its access tokens and its own
            // refresh row (only live child per family; presenting it later is
            // reuse, step 1), then reissue
            if let Err(e) = sqlx::query(
                "UPDATE oauth_access_tokens SET revoked_at = ? WHERE refresh_hash = ? AND revoked_at IS NULL",
            )
            .bind(now)
            .bind(&child)
            .execute(&mut *tx)
            .await
            {
                return db_error(e);
            }
            match sqlx::query(
                "UPDATE oauth_refresh_tokens SET revoked_at = ?
                 WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL",
            )
            .bind(now)
            .bind(&child)
            .execute(&mut *tx)
            .await
            {
                Ok(r) if r.rows_affected() == 1 => {}
                Ok(_) => return db_error(sqlx::Error::RowNotFound),
                Err(e) => return db_error(e),
            }
            let pair = match issue_pair(&mut tx, grant_id, now, g_absolute, &state.auth).await {
                Ok(p) => p,
                Err(e) => return db_error(e),
            };
            // replace child_hash; used_at keeps the original rotation time
            let upd = sqlx::query(
                "UPDATE oauth_refresh_tokens SET child_hash = ? WHERE token_hash = ? AND used_at IS NOT NULL",
            )
            .bind(sha256(&pair.refresh).to_vec())
            .bind(&token_hash)
            .execute(&mut *tx)
            .await
            .map(|r| r.rows_affected())
            .unwrap_or(0);
            if upd != 1 {
                return db_error(sqlx::Error::RowNotFound);
            }
            if let Err(e) = tx.commit().await {
                return db_error(e);
            }
            Outcome::Issued {
                pair,
                scope: new_scope,
            }
        }
        Some(_) => {
            // step 4: grace exceeded -> revoke the family
            revoke_for_reuse(tx, grant_id, client_id, now, "grace_exceeded").await
        }
    }
}

/// Revoke a grant (`revoked_reason = reason`) inside the caller's
/// transaction. A failing UPDATE is returned to the caller (fail closed:
/// never commit a rejection whose revocation did not happen).
async fn revoke_grant(
    conn: &mut SqliteConnection,
    grant_id: i64,
    now: i64,
    reason: &'static str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = ?
         WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(reason)
    .bind(grant_id)
    .execute(conn)
    .await
    .map(|_| ())
}

/// Theft signal in refresh(): revoke the family with `refresh_reuse`, COMMIT,
/// then reject (spec_auth.md 4-10). `kind` tells the paths apart in the WARN
/// line (grace_exceeded / child_used / superseded_child); only grant_id and
/// client_id are logged, never a token, its hash or the client assertion.
async fn revoke_for_reuse(
    mut tx: sqlx::Transaction<'_, sqlx::Sqlite>,
    grant_id: i64,
    client_id: &str,
    now: i64,
    kind: &'static str,
) -> Outcome {
    if let Err(e) = revoke_grant(&mut tx, grant_id, now, "refresh_reuse").await {
        return db_error(e);
    }
    if let Err(e) = tx.commit().await {
        return db_error(e);
    }
    tracing::warn!(kind, grant_id, client_id, "refresh_reuse: grant revoked");
    Outcome::RejectedAfterCommit("refresh_reuse")
}

/// oauth_grants columns for the refresh flow: (user_id, scope, resource,
/// absolute_expires_at, revoked_at, client_id, created_at, active_ledger_id).
type GrantRow = (
    i64,
    String,
    String,
    i64,
    Option<i64>,
    String,
    i64,
    Option<i64>,
);

/// oauth_refresh_tokens columns: (used_at, child_hash, grant_id, revoked_at,
/// expires_at).
type RefreshRow = (Option<i64>, Option<Vec<u8>>, i64, Option<i64>, i64);

/// Insert an access + refresh token pair for a grant.
async fn issue_pair(
    conn: &mut SqliteConnection,
    grant_id: i64,
    now: i64,
    grant_absolute_expires_at: i64,
    cfg: &crate::config::ResolvedAuth,
) -> anyhow::Result<IssuedPair> {
    let access = random_token();
    let refresh = random_token();
    let access_expires_at =
        (now + cfg.oauth.access_token_ttl_secs * 1000).min(grant_absolute_expires_at);
    let refresh_expires_at =
        (now + cfg.oauth.refresh_sliding_days * DAY_MS).min(grant_absolute_expires_at);
    sqlx::query(
        "INSERT INTO oauth_access_tokens (token_hash, grant_id, refresh_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(sha256(&access).to_vec())
    .bind(grant_id)
    .bind(sha256(&refresh).to_vec())
    .bind(now)
    .bind(access_expires_at)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, parent_hash, created_at, expires_at)
         VALUES (?, ?, NULL, ?, ?)",
    )
    .bind(sha256(&refresh).to_vec())
    .bind(grant_id)
    .bind(now)
    .bind(refresh_expires_at)
    .execute(&mut *conn)
    .await?;
    Ok(IssuedPair {
        access,
        refresh,
        access_expires_at,
        refresh_expires_at,
    })
}

fn db_error(e: impl Into<anyhow::Error>) -> Outcome {
    let e = e.into();
    tracing::error!(error = %e, "token endpoint db failure");
    Outcome::Error(OAuthError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "server_error",
        description: "internal error",
    })
}

fn decode_token_param(param: &str) -> Option<Vec<u8>> {
    let raw = crate::auth::tokens::b64url_decode(param)?;
    let arr: [u8; TOKEN_LEN] = raw.try_into().ok()?;
    Some(sha256(&arr).to_vec())
}

// ---------------------------------------------------------------------------
// POST /oauth/revoke (spec_auth.md 4-11, RFC 7009)

pub async fn revoke_post(
    State(state): State<State_>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let now = now_ms();
    let pairs = match parse_pairs_exclusive(&String::from_utf8_lossy(&body)) {
        Ok(p) => p,
        Err(_) => return OAuthError::invalid_request().into_response(),
    };
    let Some(token) = pair(&pairs, "token") else {
        return OAuthError::invalid_request().into_response();
    };
    let form_client_id = pair(&pairs, "client_id").map(str::to_string);
    let client_assertion = pair(&pairs, "client_assertion").map(str::to_string);
    let client_assertion_type = pair(&pairs, "client_assertion_type").map(str::to_string);
    let client_id = match &client_assertion {
        Some(a) => match assertion::assertion_issuer(a) {
            Some(iss) => iss,
            None => return OAuthError::invalid_client().into_response(),
        },
        None => match &form_client_id {
            Some(c) => c.clone(),
            None => return OAuthError::invalid_request().into_response(),
        },
    };
    if let Some(retry) = ip_limit(&state, &headers, &extensions, now) {
        return retry;
    }
    let record = match cimd::get_client(&state.db, &state.fetch, &state.auth, &client_id, now).await
    {
        Ok(r) => r,
        Err(_) => return OAuthError::invalid_client().into_response(),
    };
    let auth = assertion::authenticate_client(
        &state.db,
        &state.fetch,
        &state.auth,
        &record,
        form_client_id.as_deref(),
        client_assertion.as_deref(),
        client_assertion_type.as_deref(),
        now,
    )
    .await;
    let client = match auth {
        Ok(c) => c,
        Err(_) => return OAuthError::invalid_client().into_response(),
    };
    if let Some(retry) = client_limit(&state, &client.client_id, now) {
        return retry;
    }

    // refresh or access token: find the grant, revoke the family
    if let Some(hash) = decode_token_param(token) {
        let grant_id: Option<i64> =
            sqlx::query_scalar("SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ?")
                .bind(&hash)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        let grant_id = match grant_id {
            Some(g) => Some(g),
            None => sqlx::query_scalar::<_, i64>(
                "SELECT grant_id FROM oauth_access_tokens WHERE token_hash = ?",
            )
            .bind(&hash)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten(),
        };
        if let Some(grant_id) = grant_id {
            let owner: Option<String> =
                sqlx::query_scalar("SELECT client_id FROM oauth_grants WHERE id = ?")
                    .bind(grant_id)
                    .fetch_optional(&state.db)
                    .await
                    .ok()
                    .flatten();
            // RFC 7009: only the owning client may revoke; others get 200
            if owner.as_deref() == Some(client.client_id.as_str()) {
                let mut conn = match state.db.acquire().await {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::error!(error = %e, "revoke db failure");
                        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                    }
                };
                let Ok(mut tx) = conn.begin_with("BEGIN IMMEDIATE").await else {
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                };
                let _ = sqlx::query(
                    "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'client'
                     WHERE id = ? AND revoked_at IS NULL",
                )
                .bind(now)
                .bind(grant_id)
                .execute(&mut *tx)
                .await;
                let _ = crate::auth::audit(
                    &mut tx,
                    "client",
                    "oauth_grant",
                    grant_id,
                    "grant_revoke",
                    None,
                    &json!({ "via": "client", "client_id": client.client_id }),
                    now,
                )
                .await;
                let _ = tx.commit().await;
            }
        }
    }
    // unknown tokens and foreign tokens alike: 200 (RFC 7009)
    StatusCode::OK.into_response()
}

/// Pre-authentication limiter keyed by client IP (spec_auth.md 10-1).
fn ip_limit(
    state: &State_,
    headers: &HeaderMap,
    extensions: &axum::http::Extensions,
    now: i64,
) -> Option<Response> {
    let ip = crate::ratelimit::client_ip(
        headers,
        extensions.get::<axum::extract::ConnectInfo<std::net::SocketAddr>>(),
        state.auth.rate_limit.trust_cf_connecting_ip,
    );
    let key = format!("ip:{ip}");
    state
        .limits
        .check(crate::ratelimit::Class::TokenEndpoint, &key, now)
        .map(|retry| {
            crate::ratelimit::warn_limited(crate::ratelimit::Class::TokenEndpoint, &key, retry);
            crate::ratelimit::too_many_requests(retry)
        })
}

/// Post-authentication limiter keyed by the verified client_id.
fn client_limit(state: &State_, client_id: &str, now: i64) -> Option<Response> {
    let key = format!("client:{client_id}");
    state
        .limits
        .check(crate::ratelimit::Class::TokenEndpoint, &key, now)
        .map(|retry| {
            crate::ratelimit::warn_limited(crate::ratelimit::Class::TokenEndpoint, &key, retry);
            crate::ratelimit::too_many_requests(retry)
        })
}
