//! Ledger share tickets stored in `ledger_share_tickets` (share design
//! sections 3, 6, 7): 256-bit random value, DB keeps the SHA-256 hash, the
//! plaintext is shown exactly once by the issuing surface. A ticket grants
//! membership only: acceptance requires a logged-in session and adds (or
//! upgrades, never downgrades) a `ledger_members` row. It never creates a
//! user and never touches `default_ledger_id` / grant `active_ledger_id`.

use serde_json::json;
use sqlx::sqlite::SqliteConnection;
use sqlx::{Connection, SqlitePool};

use super::invitation;
use super::ledger::LedgerRole;
use super::tokens::{self, b64url_encode, random_token, sha256, to_hex};
use crate::store;

/// A row of `ledger_share_tickets`.
#[derive(Debug, Clone)]
pub struct ShareTicketRow {
    pub token_hash: Vec<u8>,
    pub ledger_id: i64,
    pub role: String,
    pub created_by: i64,
    pub inviter_note: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub accepted_at: Option<i64>,
    pub accepted_by: Option<i64>,
}

/// Column projection of `ledger_share_tickets` rows (token_hash, ledger_id,
/// role, created_by, inviter_note, created_at, expires_at, accepted_at,
/// accepted_by).
type ShareTicketCols = (
    Vec<u8>,
    i64,
    String,
    i64,
    Option<String>,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
);

fn row_of(
    (
        token_hash,
        ledger_id,
        role,
        created_by,
        inviter_note,
        created_at,
        expires_at,
        accepted_at,
        accepted_by,
    ): ShareTicketCols,
) -> ShareTicketRow {
    ShareTicketRow {
        token_hash,
        ledger_id,
        role,
        created_by,
        inviter_note,
        created_at,
        expires_at,
        accepted_at,
        accepted_by,
    }
}

const COLS: &str = "token_hash, ledger_id, role, created_by, inviter_note, created_at, expires_at, accepted_at, accepted_by";

/// Look up a token; None when the hash is unknown.
pub async fn find_by_token(
    conn: &mut SqliteConnection,
    token: &[u8; 32],
) -> sqlx::Result<Option<ShareTicketRow>> {
    find_by_hash(conn, &sha256(token)).await
}

/// Look up by the stored token hash.
pub async fn find_by_hash(
    conn: &mut SqliteConnection,
    hash: &[u8],
) -> sqlx::Result<Option<ShareTicketRow>> {
    let sql = format!("SELECT {COLS} FROM ledger_share_tickets WHERE token_hash = ?");
    let row: Option<ShareTicketCols> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(hash)
        .fetch_optional(conn)
        .await?;
    Ok(row.map(row_of))
}

/// Whether the ticket can still be accepted: not yet accepted and not
/// expired (share design section 3-1; the state is derived from columns).
pub fn is_usable(row: &ShareTicketRow, now: i64) -> bool {
    row.accepted_at.is_none() && row.expires_at > now
}

/// Short reference for a ticket: the first 8 hex chars of the token hash
/// (the same convention the operator CLI uses across token tables). Used
/// for list / revoke addressing only, never as a credential.
pub fn ticket_ref(row: &ShareTicketRow) -> String {
    to_hex(&row.token_hash)[..8].to_string()
}

/// Issue a ticket and return the plaintext (shown once). Mirrors
/// `invitation::issue`: the INSERT runs in a BEGIN IMMEDIATE transaction
/// and the loop only survives the (astronomically unlikely) hash collision.
pub async fn issue(
    pool: &SqlitePool,
    created_by: i64,
    ledger_id: i64,
    role: &str,
    inviter_note: Option<&str>,
    ttl_ms: i64,
    now: i64,
) -> anyhow::Result<String> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let token = loop {
        let t = random_token();
        let res = sqlx::query(
            "INSERT INTO ledger_share_tickets (token_hash, ledger_id, role, created_by,
                inviter_note, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(sha256(&t).to_vec())
        .bind(ledger_id)
        .bind(role)
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
            Err(e) => return Err(e.into()),
        }
    };
    tx.commit().await?;
    Ok(b64url_encode(&token))
}

/// One open ticket of an issuer, with the target ledger's name.
#[derive(Debug, Clone)]
pub struct OpenTicket {
    pub row: ShareTicketRow,
    pub ledger_name: String,
}

/// Open (unaccepted, unexpired) tickets issued by one user, newest first.
/// Uses the partial index `ledger_share_tickets_issuer_open`.
pub async fn list_open_by_issuer(
    conn: &mut SqliteConnection,
    created_by: i64,
    now: i64,
) -> sqlx::Result<Vec<OpenTicket>> {
    let sql = format!(
        "SELECT {COLS}, l.name FROM ledger_share_tickets t
         JOIN ledgers l ON l.id = t.ledger_id
         WHERE t.created_by = ? AND t.accepted_at IS NULL AND t.expires_at > ?
         ORDER BY t.created_at DESC, t.token_hash",
        COLS = COLS
            .split(", ")
            .map(|c| format!("t.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    type OpenCols = (
        Vec<u8>,
        i64,
        String,
        i64,
        Option<String>,
        i64,
        i64,
        Option<i64>,
        Option<i64>,
        String,
    );
    let rows: Vec<OpenCols> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(created_by)
        .bind(now)
        .fetch_all(conn)
        .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                token_hash,
                ledger_id,
                role,
                created_by,
                inviter_note,
                created_at,
                expires_at,
                accepted_at,
                accepted_by,
                ledger_name,
            )| {
                OpenTicket {
                    row: ShareTicketRow {
                        token_hash,
                        ledger_id,
                        role,
                        created_by,
                        inviter_note,
                        created_at,
                        expires_at,
                        accepted_at,
                        accepted_by,
                    },
                    ledger_name,
                }
            },
        )
        .collect())
}

/// Resolve a `ticket_ref` among one issuer's own tickets (any state).
/// Returns None when no ticket of this issuer carries the ref.
pub async fn find_by_ref_for_issuer(
    conn: &mut SqliteConnection,
    created_by: i64,
    ref_: &str,
) -> sqlx::Result<Option<ShareTicketRow>> {
    let sql = format!(
        "SELECT {COLS} FROM ledger_share_tickets
         WHERE created_by = ? AND hex(token_hash) LIKE ?"
    );
    let rows: Vec<ShareTicketCols> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(created_by)
        .bind(format!("{}%", ref_.trim().to_ascii_uppercase()))
        .fetch_all(conn)
        .await?;
    let want = ref_.trim().to_ascii_lowercase();
    Ok(rows.into_iter().map(row_of).find(|r| ticket_ref(r) == want))
}

/// Delete one ticket row by hash (issuer revoke / CLI revoke share this).
pub async fn delete_by_hash(conn: &mut SqliteConnection, hash: &[u8]) -> sqlx::Result<bool> {
    let n = sqlx::query("DELETE FROM ledger_share_tickets WHERE token_hash = ?")
        .bind(hash)
        .execute(conn)
        .await?
        .rows_affected();
    Ok(n == 1)
}

/// Outcome of a successful acceptance (share design section 6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptOutcome {
    Joined,
    AlreadyMember,
}

impl AcceptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Joined => "joined",
            Self::AlreadyMember => "already_member",
        }
    }
}

/// Result of a successful acceptance: the target ledger and the caller's
/// effective role after the grant.
#[derive(Debug, Clone)]
pub struct Accepted {
    pub ledger_id: i64,
    pub ledger_name: String,
    pub role: LedgerRole,
    pub outcome: AcceptOutcome,
}

/// Accept a ticket inside the caller's BEGIN IMMEDIATE transaction (share
/// design sections 3-1, 6). The conditional UPDATE on
/// `accepted_at IS NULL AND expires_at > now` decides the single winner;
/// membership converges to "the user is a member of the target ledger":
///
/// - no membership yet: INSERT with the ticket role (`joined`),
/// - existing role weaker than the ticket role: upgrade only (`joined`),
/// - existing role at least the ticket role: unchanged (`already_member`),
///   but the ticket is still consumed,
/// - retry of one's own acceptance (`accepted_by = user` and already a
///   member): `already_member` without consuming anything further.
///
/// Returns None when the ticket is not open and the idempotent retry does
/// not apply (unknown / expired / accepted by someone else) — the caller
/// maps that to the uniform `invalid_token`. The audit row
/// (`share_ticket` / `share_accept`) is written in the same transaction.
pub async fn accept(
    conn: &mut SqliteConnection,
    token_hash: &[u8],
    user_id: i64,
    now: i64,
) -> anyhow::Result<Option<Accepted>> {
    let Some(row) = find_by_hash(conn, token_hash).await? else {
        return Ok(None);
    };
    let ledger_name: Option<String> = sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
        .bind(row.ledger_id)
        .fetch_optional(&mut *conn)
        .await?;
    // The ledger row is CASCADE-protected: a missing ledger means the
    // ticket row is gone too, so this is unreachable for a live row; keep
    // it total instead of unwrapping.
    let Some(ledger_name) = ledger_name else {
        return Ok(None);
    };
    let existing: Option<String> =
        sqlx::query_scalar("SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
            .bind(row.ledger_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    let existing_role = existing.as_deref().and_then(LedgerRole::parse);

    if !is_usable(&row, now) {
        // Idempotent retry (section 6-9): this user already accepted this
        // ticket and is still a member.
        if row.accepted_by == Some(user_id)
            && let Some(role) = existing_role
        {
            audit_accept(conn, &row, user_id, AcceptOutcome::AlreadyMember, now).await?;
            return Ok(Some(Accepted {
                ledger_id: row.ledger_id,
                ledger_name,
                role,
                outcome: AcceptOutcome::AlreadyMember,
            }));
        }
        return Ok(None);
    }

    // Consume: the conditional UPDATE is the single-winner decision.
    let n = sqlx::query(
        "UPDATE ledger_share_tickets SET accepted_at = ?, accepted_by = ?
         WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?",
    )
    .bind(now)
    .bind(user_id)
    .bind(token_hash)
    .bind(now)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if n != 1 {
        // Lost a concurrent accept race (section 6-8): re-read and fall
        // back to the idempotent-retry rule only.
        let fresh = find_by_hash(conn, token_hash).await?;
        return match fresh {
            Some(fresh) if fresh.accepted_by == Some(user_id) && existing_role.is_some() => {
                audit_accept(conn, &fresh, user_id, AcceptOutcome::AlreadyMember, now).await?;
                Ok(Some(Accepted {
                    ledger_id: row.ledger_id,
                    ledger_name,
                    role: existing_role.expect("checked is_some"),
                    outcome: AcceptOutcome::AlreadyMember,
                }))
            }
            _ => Ok(None),
        };
    }

    let ticket_role = LedgerRole::parse(&row.role);
    let (effective, outcome) = match (existing_role, ticket_role) {
        (None, Some(tr)) => {
            let color = store::assign_member_color(conn, user_id).await?;
            sqlx::query(
                "INSERT INTO ledger_members (ledger_id, user_id, role, created_at, color)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(row.ledger_id)
            .bind(user_id)
            .bind(tr.as_str())
            .bind(now)
            .bind(color)
            .execute(&mut *conn)
            .await?;
            (tr, AcceptOutcome::Joined)
        }
        (Some(er), Some(tr)) if tr > er => {
            // Upgrade only (section 6-2, D-J2). `role` is not a PK column,
            // so the ledger_members_no_pk_update trigger (UPDATE OF
            // ledger_id, user_id) does not fire: a plain UPDATE is the
            // established form here.
            sqlx::query("UPDATE ledger_members SET role = ? WHERE ledger_id = ? AND user_id = ?")
                .bind(tr.as_str())
                .bind(row.ledger_id)
                .bind(user_id)
                .execute(&mut *conn)
                .await?;
            (tr, AcceptOutcome::Joined)
        }
        (Some(er), _) => (er, AcceptOutcome::AlreadyMember),
        // A ticket role outside the enum cannot be issued through the API;
        // treat a corrupt row as unusable rather than granting anything.
        (None, None) => return Ok(None),
    };
    audit_accept(conn, &row, user_id, outcome, now).await?;
    Ok(Some(Accepted {
        ledger_id: row.ledger_id,
        ledger_name,
        role: effective,
        outcome,
    }))
}

async fn audit_accept(
    conn: &mut SqliteConnection,
    row: &ShareTicketRow,
    user_id: i64,
    outcome: AcceptOutcome,
    now: i64,
) -> anyhow::Result<()> {
    Ok(super::audit(
        conn,
        "web",
        "share_ticket",
        0,
        "share_accept",
        Some(user_id),
        &json!({
            "ledger_id": row.ledger_id,
            "role": row.role,
            "outcome": outcome.as_str(),
            "token_hash_prefix": ticket_ref(row),
        }),
        now,
    )
    .await?)
}

/// One row of the merged CLI token list output.
#[derive(Debug, Clone)]
pub struct TokenListRow {
    pub token_hash: Vec<u8>,
    pub ledger_id: i64,
    pub role: String,
    pub created_by: i64,
    pub inviter_note: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub accepted_at: Option<i64>,
}

/// List share tickets, newest first (the CLI merges with the invitation
/// and register-invitation outputs).
pub async fn list(pool: &SqlitePool) -> anyhow::Result<Vec<TokenListRow>> {
    let sql = format!("SELECT {COLS} FROM ledger_share_tickets ORDER BY created_at DESC");
    let rows: Vec<ShareTicketCols> = sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str()))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|cols| {
            let r = row_of(cols);
            TokenListRow {
                token_hash: r.token_hash,
                ledger_id: r.ledger_id,
                role: r.role,
                created_by: r.created_by,
                inviter_note: r.inviter_note,
                created_at: r.created_at,
                expires_at: r.expires_at,
                accepted_at: r.accepted_at,
            }
        })
        .collect())
}

/// Hashes whose hex form starts with the (validated, upper-cased) prefix.
/// The caller (admin CLI) validates the prefix shape first.
pub async fn hashes_by_prefix(pool: &SqlitePool, prefix: &str) -> anyhow::Result<Vec<Vec<u8>>> {
    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT token_hash FROM ledger_share_tickets WHERE hex(token_hash) LIKE ?")
            .bind(format!("{prefix}%"))
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(h,)| h).collect())
}

/// Delete the ticket row with this exact hash in one transaction and audit
/// it — symmetric to `invitation::revoke_by_hash` (entity_type differs).
pub async fn revoke_by_hash(pool: &SqlitePool, hash: &[u8], now: i64) -> anyhow::Result<()> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("DELETE FROM ledger_share_tickets WHERE token_hash = ?")
        .bind(hash)
        .execute(&mut *tx)
        .await?;
    super::audit(
        &mut tx,
        "system",
        "share_ticket",
        0,
        "token_revoke",
        None,
        &json!({
            "token_hash_prefix": tokens::to_hex(hash)[..8].to_string(),
            "os_user": invitation::os_user()
        }),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
