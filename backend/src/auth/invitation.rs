//! Setup / invite / recovery tokens stored in `invitations`
//! (spec_auth.md sections 2-1, 2-8, 9): 256-bit random value, DB keeps the
//! SHA-256 hash, the plaintext is shown exactly once by the issuing surface.

use sqlx::sqlite::SqliteConnection;
use sqlx::{Connection, SqlitePool};

use super::tokens::{b64url_encode, random_token, sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationKind {
    Setup,
    Invite,
    Recovery,
}

impl InvitationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Invite => "invite",
            Self::Recovery => "recovery",
        }
    }
}

/// A row of `invitations` (plus the recovery target display name for checks).
#[derive(Debug, Clone)]
pub struct InvitationRow {
    pub token_hash: Vec<u8>,
    pub kind: InvitationKind,
    pub created_by: Option<i64>,
    pub target_user_id: Option<i64>,
    pub ledger_id: Option<i64>,
    pub role: Option<String>,
    pub operator_note: Option<String>,
    pub inviter_note: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub used_by: Option<i64>,
}

fn kind_from(s: &str) -> Option<InvitationKind> {
    match s {
        "setup" => Some(InvitationKind::Setup),
        "invite" => Some(InvitationKind::Invite),
        "recovery" => Some(InvitationKind::Recovery),
        _ => None,
    }
}

/// Parse a token string (base64url, 43 chars) into raw bytes.
pub fn parse_token(token: &str) -> Option<[u8; 32]> {
    super::tokens::b64url_decode(token)?.try_into().ok()
}

/// Look up a token; None when the hash is unknown.
pub async fn find_by_token(
    conn: &mut SqliteConnection,
    token: &[u8; 32],
) -> sqlx::Result<Option<InvitationRow>> {
    find_by_hash(conn, &sha256(token)).await
}

/// Column projection of `invitations` rows (token_hash, kind, created_by,
/// target_user_id, ledger_id, role, operator_note, inviter_note, created_at,
/// expires_at, used_at, used_by).
type InvitationCols = (
    Vec<u8>,
    String,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
);

/// Look up by the stored token hash.
pub async fn find_by_hash(
    conn: &mut SqliteConnection,
    hash: &[u8],
) -> sqlx::Result<Option<InvitationRow>> {
    let row: Option<InvitationCols> = sqlx::query_as(
        "SELECT token_hash, kind, created_by, target_user_id, ledger_id, role,
                operator_note, inviter_note, created_at, expires_at, used_at, used_by
         FROM invitations WHERE token_hash = ?",
    )
    .bind(hash)
    .fetch_optional(conn)
    .await?;
    Ok(row.and_then(
        |(
            token_hash,
            kind,
            created_by,
            target_user_id,
            ledger_id,
            role,
            operator_note,
            inviter_note,
            created_at,
            expires_at,
            used_at,
            used_by,
        )| {
            Some(InvitationRow {
                token_hash,
                kind: kind_from(&kind)?,
                created_by,
                target_user_id,
                ledger_id,
                role,
                operator_note,
                inviter_note,
                created_at,
                expires_at,
                used_at,
                used_by,
            })
        },
    ))
}

/// Whether the row is acceptable to start a registration with.
pub fn is_usable(row: &InvitationRow, now: i64) -> bool {
    row.used_at.is_none() && row.expires_at > now
}

/// Parameters for CLI / web issuance.
#[derive(Debug, Clone)]
pub struct NewInvitation {
    pub kind: InvitationKind,
    /// setup: required note. recovery: optional.
    pub operator_note: Option<String>,
    /// recovery target.
    pub target_user_id: Option<i64>,
    /// invite only.
    pub created_by: Option<i64>,
    pub ledger_id: Option<i64>,
    pub role: Option<String>,
    pub inviter_note: Option<String>,
    pub ttl_ms: i64,
}

/// Issue a token and return the plaintext (shown once). For recovery, the
/// user's existing unused tokens are deleted in the same transaction
/// (spec_auth.md section 2-1).
pub async fn issue(pool: &SqlitePool, new: &NewInvitation, now: i64) -> anyhow::Result<String> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    if new.kind == InvitationKind::Recovery {
        let Some(user) = new.target_user_id else {
            anyhow::bail!("recovery invitation requires target_user_id");
        };
        sqlx::query(
            "DELETE FROM invitations WHERE kind = 'recovery' AND target_user_id = ? AND used_at IS NULL",
        )
        .bind(user)
        .execute(&mut *tx)
        .await?;
    }
    // Loop only to survive the (astronomically unlikely) hash collision.
    let token = loop {
        let t = random_token();
        let res = sqlx::query(
            "INSERT INTO invitations (token_hash, kind, created_by, target_user_id, ledger_id,
                role, operator_note, inviter_note, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(sha256(&t).to_vec())
        .bind(new.kind.as_str())
        .bind(new.created_by)
        .bind(new.target_user_id)
        .bind(new.ledger_id)
        .bind(&new.role)
        .bind(&new.operator_note)
        .bind(&new.inviter_note)
        .bind(now)
        .bind(now + new.ttl_ms)
        .execute(&mut *tx)
        .await;
        match res {
            Ok(_) => break t,
            Err(sqlx::Error::Database(ref e))
                if e.message().contains("UNIQUE constraint failed") =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        }
    };
    tx.commit().await?;
    Ok(b64url_encode(&token))
}

/// Consume a token inside the caller's transaction: the conditional UPDATE
/// of `used_at` is what makes the token single-use (spec_auth.md section 2-3).
/// Returns false when the token was already used (invariant violation).
pub async fn mark_used(
    conn: &mut SqliteConnection,
    token_hash: &[u8],
    used_by: Option<i64>,
    now: i64,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE invitations SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL",
    )
    .bind(now)
    .bind(used_by)
    .bind(token_hash)
    .execute(conn)
    .await?
    .rows_affected();
    Ok(n == 1)
}

/// One row of the token list output.
#[derive(Debug, Clone)]
pub struct TokenListRow {
    pub token_hash: Vec<u8>,
    pub kind: InvitationKind,
    pub target_user_id: Option<i64>,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub operator_note: Option<String>,
}

/// Column projection for the token list (token_hash, kind, target_user_id,
/// created_at, expires_at, used_at, operator_note).
type InvitationListCols = (
    Vec<u8>,
    String,
    Option<i64>,
    i64,
    i64,
    Option<i64>,
    Option<String>,
);

/// List tokens (unused unless `include_used`), optionally filtered.
pub async fn list(
    pool: &SqlitePool,
    kind: Option<InvitationKind>,
    user: Option<i64>,
) -> anyhow::Result<Vec<TokenListRow>> {
    let rows: Vec<InvitationListCols> = sqlx::query_as(
        "SELECT token_hash, kind, target_user_id, created_at, expires_at, used_at, operator_note
             FROM invitations
             WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR target_user_id = ?)
             ORDER BY created_at DESC",
    )
    .bind(kind.map(|k| k.as_str()))
    .bind(kind.map(|k| k.as_str()))
    .bind(user)
    .bind(user)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(
            |(token_hash, kind, target_user_id, created_at, expires_at, used_at, operator_note)| {
                Some(TokenListRow {
                    token_hash,
                    kind: kind_from(&kind)?,
                    target_user_id,
                    created_at,
                    expires_at,
                    used_at,
                    operator_note,
                })
            },
        )
        .collect())
}

/// Hashes whose hex form starts with the (validated, upper-cased) prefix.
/// The caller (admin CLI) validates the prefix shape first; the token
/// revoke flow resolves prefixes across `invitations` and
/// `register_invitations` together (TASK-32).
pub async fn hashes_by_prefix(pool: &SqlitePool, prefix: &str) -> anyhow::Result<Vec<Vec<u8>>> {
    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT token_hash FROM invitations WHERE hex(token_hash) LIKE ?")
            .bind(format!("{prefix}%"))
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(h,)| h).collect())
}

/// Delete the token row with this exact hash in one transaction and audit
/// it. The caller (admin CLI) resolves the hash prefix and enforces
/// uniqueness across `invitations` and `register_invitations` together
/// (spec_auth.md section 9: tokens are identified by the first 8 hex chars
/// of the hash); deleting by the resolved hash keeps resolve and delete on
/// the same row without a second prefix SELECT.
pub async fn revoke_by_hash(pool: &SqlitePool, hash: &[u8], now: i64) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("DELETE FROM invitations WHERE token_hash = ?")
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    super::audit(
        &mut tx,
        "system",
        "invitation",
        0,
        "token_revoke",
        None,
        &serde_json::json!({
            "token_hash_prefix": super::tokens::to_hex(hash)[..8].to_string(),
            "os_user": os_user()
        }),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

/// OS user name recorded in CLI audit rows (spec_auth.md section 9).
pub fn os_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "unknown".into())
}
