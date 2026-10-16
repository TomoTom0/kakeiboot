//! Web sessions (spec_auth.md section 3): server-side rows keyed by the
//! SHA-256 hash of a 256-bit cookie value, `__Host-bb_session` cookie
//! attributes, idle / absolute expiry, step-up (`auth_at`) and logout.

use axum::http::HeaderMap;
use sqlx::sqlite::SqliteConnection;
use sqlx::{Connection, SqlitePool};

use super::tokens::{TOKEN_LEN, b64url_decode, b64url_encode, random_token, sha256};
use crate::config::SessionSettings;

pub const COOKIE_SESSION: &str = "__Host-bb_session";
pub const COOKIE_CEREMONY: &str = "__Host-bb_ceremony";

const DAY_MS: i64 = 86_400_000;

/// Current unix time in milliseconds.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before the unix epoch")
        .as_millis() as i64
}

/// A validated session (the users JOIN already checked `disabled_at IS NULL`).
#[derive(Debug, Clone)]
pub struct ValidSession {
    pub id_hash: Vec<u8>,
    pub user_id: i64,
    pub auth_at: i64,
    pub last_seen_at: i64,
    pub display_name: String,
    pub account_number: String,
}

/// Create a session row and return the raw cookie value.
pub async fn create_session(
    pool: &SqlitePool,
    user_id: i64,
    user_agent: Option<&str>,
    now: i64,
    cfg: &SessionSettings,
) -> anyhow::Result<[u8; TOKEN_LEN]> {
    let token = random_token();
    let hash = sha256(&token).to_vec();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query(
        "INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at,
            idle_expires_at, absolute_expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&hash)
    .bind(user_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now + cfg.idle_days * DAY_MS)
    .bind(now + cfg.absolute_days * DAY_MS)
    .bind(user_agent)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(token)
}

/// Validate a session cookie value. Returns None for unknown / expired /
/// revoked sessions or disabled users. Updates `last_seen_at` /
/// `idle_expires_at` only when 5 minutes (config) have elapsed.
pub async fn validate_session(
    pool: &SqlitePool,
    token: &[u8; TOKEN_LEN],
    now: i64,
    cfg: &SessionSettings,
) -> anyhow::Result<Option<ValidSession>> {
    let hash = sha256(token).to_vec();
    let mut conn = pool.acquire().await?;
    let Some(s) = fetch_session(&mut conn, &hash, now).await? else {
        return Ok(None);
    };
    if now - s.last_seen_at >= cfg.last_seen_update_secs * 1000 {
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "UPDATE web_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?",
        )
        .bind(now)
        .bind(now + cfg.idle_days * DAY_MS)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(Some(s))
}

/// The validation SELECT (spec_auth.md section 3: `users.disabled_at IS NULL`
/// is part of the join condition).
async fn fetch_session(
    conn: &mut SqliteConnection,
    hash: &[u8],
    now: i64,
) -> anyhow::Result<Option<ValidSession>> {
    let row: Option<(Vec<u8>, i64, i64, i64, String, String)> = sqlx::query_as(
        "SELECT s.id_hash, s.user_id, s.auth_at, s.last_seen_at, u.display_name, u.account_number
         FROM web_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.revoked_at IS NULL
           AND s.idle_expires_at > ? AND s.absolute_expires_at > ?
           AND u.disabled_at IS NULL",
    )
    .bind(hash)
    .bind(now)
    .bind(now)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(
        |(id_hash, user_id, auth_at, last_seen_at, display_name, account_number)| ValidSession {
            id_hash,
            user_id,
            auth_at,
            last_seen_at,
            display_name,
            account_number,
        },
    ))
}

/// Whether the session satisfies the step-up requirement (passkey
/// authentication within the last `step_up_secs`).
pub fn step_up_ok(s: &ValidSession, now: i64, cfg: &SessionSettings) -> bool {
    now - s.auth_at <= cfg.step_up_secs * 1000
}

/// Revoke one session by cookie value (logout).
pub async fn revoke_session(
    pool: &SqlitePool,
    token: &[u8; TOKEN_LEN],
    now: i64,
) -> anyhow::Result<()> {
    let hash = sha256(token).to_vec();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Revoke every session of a user (logout-all, recovery, disable).
pub async fn revoke_user_sessions(
    conn: &mut SqliteConnection,
    user_id: i64,
    now: i64,
) -> sqlx::Result<u64> {
    sqlx::query("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .bind(now)
        .bind(user_id)
        .execute(conn)
        .await
        .map(|r| r.rows_affected())
}

/// Update `auth_at` after a successful step-up (same session row,
/// spec_auth.md section 2-6).
pub async fn touch_auth_at(pool: &SqlitePool, hash: &[u8], now: i64) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE web_sessions SET auth_at = ? WHERE id_hash = ?")
        .bind(now)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// cookie helpers

/// `Set-Cookie` for a newly issued session (spec_auth.md section 3).
pub fn session_cookie(value: &[u8; TOKEN_LEN], absolute_expires_at: i64, now: i64) -> String {
    let max_age = (absolute_expires_at - now).max(0) / 1000;
    format!(
        "{COOKIE_SESSION}={}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={max_age}",
        b64url_encode(value)
    )
}

/// `Set-Cookie` clearing a session cookie (Lax).
pub fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0")
}

/// `Set-Cookie` clearing the ceremony cookie (Strict, matching its issue).
pub fn clear_cookie_strict(name: &str) -> String {
    format!("{name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0")
}

/// `Set-Cookie` for the one-time ceremony ID (spec_auth.md section 2-5).
pub fn ceremony_cookie(value: &[u8; TOKEN_LEN], max_age_secs: i64) -> String {
    format!(
        "{COOKIE_CEREMONY}={}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={max_age_secs}",
        b64url_encode(value)
    )
}

/// Read a cookie value from the `Cookie` header (first occurrence wins).
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let part = part.trim();
        let rest = part.strip_prefix(name)?;
        let value = rest.strip_prefix('=')?;
        Some(value.to_string())
    })
}

/// Decode a cookie value into a 256-bit token.
pub fn cookie_token(headers: &HeaderMap, name: &str) -> Option<[u8; TOKEN_LEN]> {
    let value = cookie_value(headers, name)?;
    let bytes = b64url_decode(&value)?;
    bytes.try_into().ok()
}
