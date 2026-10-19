//! Ledger selection on grants (spec_auth.md sections 6, 6-2): the service
//! layer shared by the web API and the MCP tools (`list_ledgers`,
//! `switch_ledger`, `whoami`). `active_ledger_id` is per-grant state,
//! independent of `users.default_ledger_id`.

use serde_json::json;
use sqlx::{Connection, SqliteConnection, SqlitePool};

use super::tokens::random_crockford8;
use crate::domain::actor::Actor;

/// Role rank for write checks (spec_auth.md 6-3: editor or above).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LedgerRole {
    Viewer = 1,
    Editor = 2,
    Owner = 3,
}

impl LedgerRole {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Self::Viewer),
            "editor" => Some(Self::Editor),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Owner => "owner",
        }
    }
}

/// One ledger of a user (list_ledgers view, spec_mcp-tools.md 7-17).
#[derive(Debug, Clone)]
pub struct LedgerView {
    pub ledger_id: i64,
    pub name: String,
    pub role: LedgerRole,
    pub is_active: bool,
}

/// All ledgers the user belongs to, with the grant's selection marked.
pub async fn list_ledgers(
    conn: &mut SqliteConnection,
    user_id: i64,
    active_ledger_id: Option<i64>,
) -> anyhow::Result<Vec<LedgerView>> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT l.id, l.name, m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? ORDER BY l.id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(ledger_id, name, role)| {
            Some(LedgerView {
                ledger_id,
                name,
                role: LedgerRole::parse(&role)?,
                is_active: Some(ledger_id) == active_ledger_id,
            })
        })
        .collect())
}

#[derive(Debug, thiserror::Error)]
pub enum SwitchError {
    /// not a member or no such ledger (indistinguishable by design,
    /// spec_auth.md 6-2)
    #[error("ledger not selectable")]
    NotSelectable,
    #[error("grant not found for user")]
    GrantNotFound,
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

impl From<sqlx::Error> for SwitchError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e.into())
    }
}

pub struct SwitchOutcome {
    pub ledger_id: i64,
    pub name: String,
    pub role: LedgerRole,
    pub previous_ledger_id: Option<i64>,
    pub previous_name: Option<String>,
}

/// Switch the grant's active ledger in one BEGIN IMMEDIATE transaction:
/// membership check, conditional UPDATE and an audit row
/// (spec_auth.md 6-2). `actor_kind` is "mcp" for the tool path and "web"
/// for the settings screen.
pub async fn switch_ledger(
    pool: &SqlitePool,
    grant_id: i64,
    user_id: i64,
    ledger_id: i64,
    actor_kind: &str,
    client_id: Option<&str>,
    now: i64,
) -> Result<SwitchOutcome, SwitchError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    // grant must belong to the user and be live
    let grant: Option<(Option<i64>, String)> = sqlx::query_as(
        "SELECT active_ledger_id, client_id FROM oauth_grants
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND absolute_expires_at > ?",
    )
    .bind(grant_id)
    .bind(user_id)
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((previous_ledger_id, g_client)) = grant else {
        return Err(SwitchError::GrantNotFound);
    };
    // membership (missing ledger and non-member look the same)
    let member: Option<String> = sqlx::query_scalar(
        "SELECT m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.ledger_id = ? AND m.user_id = ?",
    )
    .bind(ledger_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(role_str) = member else {
        return Err(SwitchError::NotSelectable);
    };
    let Some(role) = LedgerRole::parse(&role_str) else {
        return Err(SwitchError::NotSelectable);
    };
    let name: String = sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
        .bind(ledger_id)
        .fetch_one(&mut *tx)
        .await?;
    let updated = sqlx::query(
        "UPDATE oauth_grants SET active_ledger_id = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(ledger_id)
    .bind(grant_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated != 1 {
        return Err(SwitchError::GrantNotFound);
    }
    let previous_name = match previous_ledger_id {
        Some(prev) => {
            sqlx::query_scalar::<_, String>("SELECT name FROM ledgers WHERE id = ?")
                .bind(prev)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => None,
    };
    super::audit(
        &mut tx,
        actor_kind,
        "oauth_grant",
        grant_id,
        "switch_ledger",
        Some(user_id),
        &json!({
            "before_ledger_id": previous_ledger_id,
            "after_ledger_id": ledger_id,
            "client_id": client_id.unwrap_or(&g_client),
        }),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(SwitchOutcome {
        ledger_id,
        name,
        role,
        previous_ledger_id,
        previous_name,
    })
}

/// Rename failures (TASK-20, spec_mcp-tools.md 7-24): membership / role /
/// input validation and the within-user duplicate, in the `SwitchError`
/// style — the web adapter and the MCP handler map each variant themselves.
#[derive(Debug, thiserror::Error)]
pub enum RenameLedgerError {
    /// not a member or no such ledger (indistinguishable by design,
    /// spec_mcp-tools.md 4)
    #[error("ledger not found")]
    NotFound,
    #[error("viewer cannot rename")]
    Forbidden,
    #[error("{0}")]
    Invalid(String),
    #[error("duplicate ledger name within the user's memberships")]
    Conflict,
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

impl From<sqlx::Error> for RenameLedgerError {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e.into())
    }
}

pub struct RenameOutcome {
    pub ledger_id: i64,
    pub before_name: String,
    pub after_name: String,
}

/// Rename a ledger in one BEGIN IMMEDIATE transaction (TASK-20,
/// spec_mcp-tools.md 7-24 / 12): membership and role re-checked inside the
/// tx (editor or above), trim / length validated against `max_chars`, the
/// same name is a no-op success (no audit, no `updated_at` bump), a
/// duplicate within the *same user's* memberships is a conflict (another
/// user's same-name ledger does not block), then UPDATE + one audit row.
/// The name is ledger-wide state shared by every member.
pub async fn rename_ledger(
    pool: &SqlitePool,
    user_id: i64,
    ledger_id: i64,
    new_name: &str,
    actor: &Actor,
    max_chars: usize,
    now: i64,
) -> Result<RenameOutcome, RenameLedgerError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    // membership + role re-check inside the tx (the switch_ledger flow)
    let role_str: Option<String> = sqlx::query_scalar(
        "SELECT m.role FROM ledger_members m WHERE m.ledger_id = ? AND m.user_id = ?",
    )
    .bind(ledger_id)
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(role) = role_str.as_deref().and_then(LedgerRole::parse) else {
        return Err(RenameLedgerError::NotFound);
    };
    if role < LedgerRole::Editor {
        return Err(RenameLedgerError::Forbidden);
    }
    let before_name: String = sqlx::query_scalar("SELECT name FROM ledgers WHERE id = ?")
        .bind(ledger_id)
        .fetch_one(&mut *tx)
        .await?;
    // names are saved-value constraints: trim first, then count chars
    let name = new_name.trim();
    if name.is_empty() || name.chars().count() > max_chars {
        return Err(RenameLedgerError::Invalid(format!(
            "家計簿名は1〜{max_chars}字で入力してください"
        )));
    }
    if name == before_name {
        // no-op success: no audit, no updated_at bump, nothing to commit
        return Ok(RenameOutcome {
            ledger_id,
            before_name,
            after_name: name.to_string(),
        });
    }
    // duplicate within this user's own memberships (another user's same-name
    // ledger is naturally allowed by the m.user_id filter)
    let dup: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM ledgers l JOIN ledger_members m ON m.ledger_id = l.id
         WHERE m.user_id = ? AND l.name = ? AND l.id <> ? LIMIT 1",
    )
    .bind(user_id)
    .bind(name)
    .bind(ledger_id)
    .fetch_optional(&mut *tx)
    .await?;
    if dup.is_some() {
        return Err(RenameLedgerError::Conflict);
    }
    let updated = sqlx::query("UPDATE ledgers SET name = ?, updated_at = ? WHERE id = ?")
        .bind(name)
        .bind(now)
        .bind(ledger_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if updated != 1 {
        return Err(RenameLedgerError::Db(anyhow::anyhow!(
            "ledger {ledger_id} vanished during rename"
        )));
    }
    crate::domain::catalog::audit(
        &mut tx,
        ledger_id,
        actor,
        "ledger",
        ledger_id,
        "rename_ledger",
        Some(&json!({ "name": before_name })),
        Some(&json!({ "name": name })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(RenameOutcome {
        ledger_id,
        before_name,
        after_name: name.to_string(),
    })
}

/// The `whoami` view (spec_auth.md 7-1, spec_mcp-tools.md 7-16).
pub struct Whoami {
    pub account_number: String,
    pub display_name: String,
    pub active_ledger: Option<(i64, String, LedgerRole)>,
}

pub async fn whoami(
    conn: &mut SqliteConnection,
    user_id: i64,
    active_ledger: Option<(i64, String, LedgerRole)>,
) -> anyhow::Result<Whoami> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT account_number, display_name FROM users WHERE id = ? AND disabled_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(conn)
    .await?;
    let Some((account_number, display_name)) = row else {
        anyhow::bail!("user {user_id} vanished");
    };
    Ok(Whoami {
        account_number,
        display_name,
        active_ledger,
    })
}

/// A random `R-XXXX` recovery request number (Crockford base32 4 chars,
/// spec_data-model.md 10-2). Regenerated on collision by the caller.
pub fn candidate_request_number() -> String {
    format!("R-{}", &random_crockford8()[..4])
}
