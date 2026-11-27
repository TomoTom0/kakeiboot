//! Web-issued registration-only invitation tokens stored in
//! `register_invitations` (spec_auth.md sections 2-1, 3-2): 256-bit random
//! value, DB keeps the SHA-256 hash, the plaintext is shown exactly once.
//! Fully separate from `invitations` (setup / invite / recovery): issuing an
//! account never joins a ledger. Any active user may issue (step-up + a
//! mandatory note); unused tokens are capped per issuer.

use sqlx::sqlite::SqliteConnection;
use sqlx::{Connection, SqlitePool};

use super::invitation::{self, InvitationKind, InvitationRow};
use super::tokens::{b64url_encode, random_token, sha256};

/// Per-issuer cap on open (unused, unexpired) register invitations.
pub const OPEN_LIMIT: i64 = 5;

/// A row of `register_invitations`.
#[derive(Debug, Clone)]
pub struct RegisterInvitationRow {
    pub token_hash: Vec<u8>,
    pub created_by: i64,
    pub inviter_note: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
    pub used_by: Option<i64>,
}

/// Column projection of `register_invitations` rows (token_hash, created_by,
/// inviter_note, created_at, expires_at, used_at, used_by).
type RegisterCols = (Vec<u8>, i64, String, i64, i64, Option<i64>, Option<i64>);

fn row_of(
    (token_hash, created_by, inviter_note, created_at, expires_at, used_at, used_by): RegisterCols,
) -> RegisterInvitationRow {
    RegisterInvitationRow {
        token_hash,
        created_by,
        inviter_note,
        created_at,
        expires_at,
        used_at,
        used_by,
    }
}

/// Look up a token; None when the hash is unknown.
pub async fn find_by_token(
    conn: &mut SqliteConnection,
    token: &[u8; 32],
) -> sqlx::Result<Option<RegisterInvitationRow>> {
    find_by_hash(conn, &sha256(token)).await
}

/// Look up by the stored token hash.
pub async fn find_by_hash(
    conn: &mut SqliteConnection,
    hash: &[u8],
) -> sqlx::Result<Option<RegisterInvitationRow>> {
    let row: Option<RegisterCols> = sqlx::query_as(
        "SELECT token_hash, created_by, inviter_note, created_at, expires_at, used_at, used_by
         FROM register_invitations WHERE token_hash = ?",
    )
    .bind(hash)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(row_of))
}

/// Whether the row is acceptable to start a registration with (same rule as
/// invitations: the kind plays no role).
pub fn is_usable(row: &RegisterInvitationRow, now: i64) -> bool {
    row.used_at.is_none() && row.expires_at > now
}

/// Unused and unexpired register invitations issued by one user. Rows that
/// expired but were not swept yet do not count (the sweep runs daily).
/// Uses the partial index `register_invitations_issuer_open`.
pub async fn count_open(
    conn: &mut SqliteConnection,
    created_by: i64,
    now: i64,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM register_invitations
         WHERE created_by = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(created_by)
    .bind(now)
    .fetch_one(conn)
    .await
}

#[derive(Debug, thiserror::Error)]
pub enum IssueRegisterError {
    #[error("open register invitation limit reached")]
    OpenLimit,
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

/// Issue a register token and return the plaintext (shown once). The limit
/// check and the INSERT run inside one BEGIN IMMEDIATE transaction so that
/// concurrent issuance cannot both pass the count (mirrors
/// invitation::issue).
pub async fn issue(
    pool: &SqlitePool,
    created_by: i64,
    inviter_note: &str,
    ttl_ms: i64,
    now: i64,
) -> Result<String, IssueRegisterError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|e| IssueRegisterError::Db(e.into()))?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|e| IssueRegisterError::Db(e.into()))?;
    let open = count_open(&mut tx, created_by, now)
        .await
        .map_err(|e| IssueRegisterError::Db(e.into()))?;
    if open >= OPEN_LIMIT {
        return Err(IssueRegisterError::OpenLimit);
    }
    // Loop only to survive the (astronomically unlikely) hash collision.
    let token = loop {
        let t = random_token();
        let res = sqlx::query(
            "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(sha256(&t).to_vec())
        .bind(created_by)
        .bind(inviter_note)
        .bind(now)
        .bind(now + ttl_ms)
        .execute(&mut *tx)
        .await;
        match res {
            Ok(_) => break t,
            Err(sqlx::Error::Database(ref e))
                if e.message().contains("UNIQUE constraint failed") =>
            {
                continue;
            }
            Err(e) => return Err(IssueRegisterError::Db(e.into())),
        }
    };
    tx.commit()
        .await
        .map_err(|e| IssueRegisterError::Db(e.into()))?;
    Ok(b64url_encode(&token))
}

/// Consume a token inside the caller's transaction: the conditional UPDATE
/// of `used_at` is what makes the token single-use (same invariant as
/// invitation::mark_used). Returns false when already used.
pub async fn mark_used(
    conn: &mut SqliteConnection,
    token_hash: &[u8],
    used_by: Option<i64>,
    now: i64,
) -> sqlx::Result<bool> {
    let n = sqlx::query(
        "UPDATE register_invitations SET used_at = ?, used_by = ?
         WHERE token_hash = ? AND used_at IS NULL",
    )
    .bind(now)
    .bind(used_by)
    .bind(token_hash)
    .execute(conn)
    .await?
    .rows_affected();
    Ok(n == 1)
}

/// One row of the merged CLI token list output.
#[derive(Debug, Clone)]
pub struct TokenListRow {
    pub token_hash: Vec<u8>,
    pub created_by: i64,
    pub inviter_note: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub used_at: Option<i64>,
}

/// List register tokens, newest first (the CLI merges with
/// invitation::list output).
pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<TokenListRow>> {
    let rows: Vec<RegisterCols> = sqlx::query_as(
        "SELECT token_hash, created_by, inviter_note, created_at, expires_at, used_at, used_by
         FROM register_invitations ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(token_hash, created_by, inviter_note, created_at, expires_at, used_at, _used_by)| {
                TokenListRow {
                    token_hash,
                    created_by,
                    inviter_note,
                    created_at,
                    expires_at,
                    used_at,
                }
            },
        )
        .collect())
}

/// Hashes whose hex form starts with the (validated, upper-cased) prefix.
/// The caller (admin CLI) validates the prefix shape first.
pub async fn hashes_by_prefix(pool: &SqlitePool, prefix: &str) -> anyhow::Result<Vec<Vec<u8>>> {
    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT token_hash FROM register_invitations WHERE hex(token_hash) LIKE ?")
            .bind(format!("{prefix}%"))
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(h,)| h).collect())
}

/// Delete the token row with this exact hash in one transaction and audit
/// it — symmetric to invitation::revoke_by_hash (the only difference is the
/// audited entity_type). Prefix resolution and the uniqueness decision live
/// in the admin CLI, which passes the resolved hash here.
pub async fn revoke_by_hash(pool: &SqlitePool, hash: &[u8], now: i64) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("DELETE FROM register_invitations WHERE token_hash = ?")
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    super::audit(
        &mut tx,
        "system",
        "register_invitation",
        0,
        "token_revoke",
        None,
        &serde_json::json!({
            "token_hash_prefix": super::tokens::to_hex(hash)[..8].to_string(),
            "os_user": invitation::os_user()
        }),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// registration-token resolution across both tables

/// A registration token resolved across `invitations` (setup / recovery;
/// legacy invite rows are excluded) and `register_invitations` (register).
/// Tokens are 256-bit
/// random values, so a hash matches at most one row in one table; the fixed
/// lookup order (invitations first) makes the resolution deterministic.
#[derive(Debug, Clone)]
pub enum RegistrationToken {
    Invitation(InvitationRow),
    Register(RegisterInvitationRow),
}

impl RegistrationToken {
    /// Recovery targets an existing user; every other kind creates a new one.
    pub fn is_recovery(&self) -> bool {
        matches!(
            self,
            Self::Invitation(inv) if inv.kind == InvitationKind::Recovery
        )
    }

    /// 'setup' | 'recovery' | 'register' (audit / info 用). Legacy invite
    /// rows never resolve into a RegistrationToken (see `is_accepted`).
    pub fn kind_str(&self) -> &'static str {
        match self {
            Self::Invitation(inv) => inv.kind.as_str(),
            Self::Register(_) => "register",
        }
    }

    pub fn token_hash(&self) -> &[u8] {
        match self {
            Self::Invitation(inv) => &inv.token_hash,
            Self::Register(r) => &r.token_hash,
        }
    }

    /// Same usability rule for every kind: unused and unexpired.
    pub fn is_usable(&self, now: i64) -> bool {
        match self {
            Self::Invitation(inv) => invitation::is_usable(inv, now),
            Self::Register(r) => is_usable(r, now),
        }
    }

    /// Conditional UPDATE on the owning table (single use).
    pub async fn mark_used(
        &self,
        conn: &mut SqliteConnection,
        used_by: Option<i64>,
        now: i64,
    ) -> sqlx::Result<bool> {
        match self {
            Self::Invitation(inv) => {
                invitation::mark_used(conn, &inv.token_hash, used_by, now).await
            }
            Self::Register(r) => mark_used(conn, &r.token_hash, used_by, now).await,
        }
    }

    /// Lineage for user creation.
    pub fn user_origin(&self) -> UserOrigin {
        match self {
            Self::Invitation(inv) => match inv.kind {
                InvitationKind::Setup => UserOrigin {
                    admin_note: inv.operator_note.clone(),
                    invite_note: None,
                    invited_by: None,
                    via_kind: "setup",
                },
                // Legacy invite rows are filtered out during token
                // resolution (share design section 9-4, T8), so this arm
                // never runs; kept total over InvitationKind with the
                // no-lineage shape.
                InvitationKind::Invite => UserOrigin {
                    admin_note: None,
                    invite_note: None,
                    invited_by: None,
                    via_kind: "invite",
                },
                // recovery never creates a user (register_finish branches on
                // is_recovery first); kept unreachable-shaped for totality.
                InvitationKind::Recovery => UserOrigin {
                    admin_note: None,
                    invite_note: None,
                    invited_by: None,
                    via_kind: "recovery",
                },
            },
            Self::Register(r) => UserOrigin {
                admin_note: None,
                invite_note: Some(r.inviter_note.clone()),
                invited_by: Some(r.created_by),
                via_kind: "register",
            },
        }
    }
}

/// Lineage carried into user creation (spec_auth.md section 7-3). User
/// creation never joins a ledger: membership is granted only by accepting
/// a share ticket (share design section 2-1).
#[derive(Debug, Clone)]
pub struct UserOrigin {
    /// users.admin_note (setup の CLI --note のみ。register は None).
    pub admin_note: Option<String>,
    /// users.invite_note (register の必須メモ。setup は None).
    pub invite_note: Option<String>,
    /// users.invited_by (setup は None).
    pub invited_by: Option<i64>,
    /// users.invited_via_kind ('setup' | 'register').
    pub via_kind: &'static str,
}

/// Whether an `invitations` row is still accepted as a registration token.
/// Legacy invite rows (kind='invite') stopped being accepted when the
/// migration window ended (share design section 9-4, T8): the row stays in
/// the table for the sweep and for CLI list / revoke, but it no longer
/// resolves as a registration token.
fn is_accepted(inv: &InvitationRow) -> bool {
    inv.kind != InvitationKind::Invite
}

/// Look up a token: `invitations` first, then `register_invitations`.
/// None when the hash is unknown in both tables (or names a legacy invite
/// row, which is no longer accepted).
pub async fn find_registration_token(
    conn: &mut SqliteConnection,
    token: &[u8; 32],
) -> sqlx::Result<Option<RegistrationToken>> {
    if let Some(inv) = invitation::find_by_token(conn, token)
        .await?
        .filter(is_accepted)
    {
        return Ok(Some(RegistrationToken::Invitation(inv)));
    }
    let reg = find_by_token(conn, token).await?;
    Ok(reg.map(RegistrationToken::Register))
}

/// Same resolution by the stored hash (register_finish re-resolution).
pub async fn find_registration_by_hash(
    conn: &mut SqliteConnection,
    hash: &[u8],
) -> sqlx::Result<Option<RegistrationToken>> {
    if let Some(inv) = invitation::find_by_hash(conn, hash)
        .await?
        .filter(is_accepted)
    {
        return Ok(Some(RegistrationToken::Invitation(inv)));
    }
    let reg = find_by_hash(conn, hash).await?;
    Ok(reg.map(RegistrationToken::Register))
}
