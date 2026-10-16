//! Authentication module (TASK-10): passkeys (WebAuthn), web sessions,
//! setup / invite / recovery tokens, the OAuth 2.1 authorization server and
//! the /api endpoints around them (spec_auth.md sections 1-10).

pub mod api;
pub mod ceremony;
pub mod invitation;
pub mod ledger;
pub mod oauth;
pub mod session;
pub mod tokens;

/// Insert an audit row (spec_auth.md section 3-2 / 9). `entity_id` has no
/// meaningful integer for hash-keyed rows (invitations); use 0 and keep the
/// hash prefix inside `after_json`.
#[allow(clippy::too_many_arguments)]
pub async fn audit(
    conn: &mut sqlx::sqlite::SqliteConnection,
    actor_kind: &str,
    entity_type: &str,
    entity_id: i64,
    action: &str,
    user_id: Option<i64>,
    after: &serde_json::Value,
    now: i64,
) -> sqlx::Result<()> {
    let after = serde_json::to_string(after).unwrap_or_else(|_| "{}".into());
    sqlx::query(
        "INSERT INTO audit_events (user_id, actor_kind, entity_type, entity_id, action,
            before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)",
    )
    .bind(user_id)
    .bind(actor_kind)
    .bind(entity_type)
    .bind(entity_id)
    .bind(action)
    .bind(&after)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}
