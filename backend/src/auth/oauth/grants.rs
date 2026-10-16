//! Connected-apps web API (spec_auth.md sections 4-2, 4-11, 6): grant list
//! with the selected ledger name, individual revocation, and the
//! active-ledger switch endpoint. All handlers require a web session and run
//! behind the shared /api Origin / JSON guard.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;
use sqlx::Connection;

use crate::auth::ledger;
use crate::auth::session::{self};

pub type State_ = super::super::api::AuthApiState;

/// Routes mounted into the /api router (guarded by api_guard there); state
/// is applied by the mounting router.
pub fn routes() -> Router<State_> {
    Router::new()
        .route("/api/oauth/grants", axum::routing::get(list_grants))
        .route(
            "/api/oauth/grants/{id}",
            axum::routing::delete(revoke_grant),
        )
        .route(
            "/api/oauth/grants/{id}/active-ledger",
            axum::routing::put(switch_active_ledger),
        )
}

async fn require_session(
    state: &State_,
    headers: &axum::http::HeaderMap,
) -> Option<session::ValidSession> {
    let now = session::now_ms();
    let token = session::cookie_token(headers, session::COOKIE_SESSION)?;
    session::validate_session(&state.db, &token, now, &state.auth.session)
        .await
        .ok()
        .flatten()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({"error": "unauthorized"})),
    )
        .into_response()
}

fn internal(e: sqlx::Error) -> Response {
    tracing::error!(error = %e, "oauth grants api failure");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal"})),
    )
        .into_response()
}

fn client_host(client_id: &str) -> String {
    super::authorize::client_host_of(client_id)
}

/// grant list columns: (id, client_id, scope, active_ledger_id, last_used_at,
/// created_at, active_ledger_name).
type GrantApiRow = (
    i64,
    String,
    String,
    Option<i64>,
    Option<i64>,
    i64,
    Option<String>,
);

/// `GET /api/oauth/grants` (spec_auth.md 4-2 / 4-11).
async fn list_grants(State(state): State<State_>, headers: axum::http::HeaderMap) -> Response {
    let Some(s) = require_session(&state, &headers).await else {
        return unauthorized();
    };
    let now = session::now_ms();
    let rows: Vec<GrantApiRow> = match sqlx::query_as(
        "SELECT g.id, g.client_id, g.scope, g.active_ledger_id, g.last_used_at, g.created_at,
                l.name
         FROM oauth_grants g
         LEFT JOIN ledger_members m ON m.ledger_id = g.active_ledger_id AND m.user_id = g.user_id
         LEFT JOIN ledgers l ON l.id = m.ledger_id
         WHERE g.user_id = ? AND g.revoked_at IS NULL AND g.absolute_expires_at > ?
         ORDER BY g.id",
    )
    .bind(s.user_id)
    .bind(now)
    .fetch_all(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let mut out = Vec::with_capacity(rows.len());
    for (id, client_id, scope, active_ledger_id, last_used_at, created_at, active_ledger_name) in
        rows
    {
        out.push(json!({
            "id": id,
            "client_display": super::client_display_for_host(&client_host(&client_id)),
            "client_id": client_id,
            "scope": scope,
            "active_ledger_id": active_ledger_id,
            "active_ledger_name": active_ledger_name,
            "created_at": created_at,
            "last_used_at": last_used_at,
        }));
    }
    Json(json!(out)).into_response()
}

/// `DELETE /api/oauth/grants/{id}` (spec_auth.md 4-11, reason `user`).
async fn revoke_grant(
    State(state): State<State_>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i64>,
) -> Response {
    let Some(s) = require_session(&state, &headers).await else {
        return unauthorized();
    };
    let now = session::now_ms();
    let mut conn = match state.db.acquire().await {
        Ok(c) => c,
        Err(e) => return internal(e),
    };
    let mut tx = match conn.begin_with("BEGIN IMMEDIATE").await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let n = sqlx::query(
        "UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'user'
         WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(id)
    .bind(s.user_id)
    .execute(&mut *tx)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if n != 1 {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"}))).into_response();
    }
    let _ = crate::auth::audit(
        &mut tx,
        "web",
        "oauth_grant",
        id,
        "grant_revoke",
        Some(s.user_id),
        &json!({ "via": "user", "reason": "user" }),
        now,
    )
    .await;
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    StatusCode::NO_CONTENT.into_response()
}

#[derive(serde::Deserialize)]
struct SwitchReq {
    ledger_id: i64,
}

/// `PUT /api/oauth/grants/{id}/active-ledger` — the settings-screen variant
/// of `switch_ledger` (spec_auth.md 6-2; the MCP tool arrives in TASK-11).
async fn switch_active_ledger(
    State(state): State<State_>,
    headers: axum::http::HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<SwitchReq>,
) -> Response {
    let Some(s) = require_session(&state, &headers).await else {
        return unauthorized();
    };
    let now = session::now_ms();
    match ledger::switch_ledger(&state.db, id, s.user_id, body.ledger_id, "web", None, now).await {
        Ok(o) => Json(json!({
            "ledger": { "id": o.ledger_id, "name": o.name, "role": o.role.as_str() },
            "previous": o.previous_ledger_id.map(|prev| json!({
                "id": prev,
                "name": o.previous_name,
            })),
        }))
        .into_response(),
        Err(ledger::SwitchError::NotSelectable) => (
            StatusCode::CONFLICT,
            Json(json!({"error": "ledger_not_selectable"})),
        )
            .into_response(),
        Err(ledger::SwitchError::GrantNotFound) => {
            (StatusCode::NOT_FOUND, Json(json!({"error": "not_found"}))).into_response()
        }
        Err(ledger::SwitchError::Db(e)) => internal_sqlx(e),
    }
}

fn internal_sqlx(e: anyhow::Error) -> Response {
    tracing::error!(error = %e, "switch ledger failure");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "internal"})),
    )
        .into_response()
}
