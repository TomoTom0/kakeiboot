//! MCP resource server (spec_auth.md sections 5-1, 5-3, 11-6): Bearer
//! validation on `/mcp`, `AuthContext` handed to tool handlers through the
//! request extensions, and the ledger / scope helpers tools use.
//!
//! The anonymous `request_recovery` exception (5-2) is implementation-gated
//! on TASK-7 item 17 and intentionally absent: requests without a Bearer
//! token are rejected.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rmcp::RoleServer;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::service::RequestContext;
use serde_json::json;
use sqlx::SqlitePool;

use crate::auth::ledger::LedgerRole;
use crate::auth::oauth::{Scope, ScopeSet, protected_resource_metadata_url};
use crate::auth::session::now_ms;
use crate::auth::tokens::{TOKEN_LEN, b64url_decode, sha256};
use crate::config::ResolvedAuth;

/// `oauth_grants.last_used_at` refresh interval (spec_auth.md 4-11).
const LAST_USED_INTERVAL_MS: i64 = 5 * 60_000;

/// The validated request identity tool handlers receive (spec_auth.md 5-3).
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user_id: i64,
    /// None = no active ledger (unselected or no longer a member)
    pub ledger: Option<ActiveLedger>,
    pub scopes: ScopeSet,
    pub client_id: String,
    pub grant_id: i64,
}

#[derive(Debug, Clone)]
pub struct ActiveLedger {
    pub ledger_id: i64,
    pub name: String,
    pub role: LedgerRole,
}

impl AuthContext {
    pub fn has_scope(&self, needed: Scope) -> bool {
        self.scopes.allows(needed)
    }
}

/// Read the `AuthContext` out of an rmcp request context
/// (spec_auth.md 5-3: injected as `http::request::Parts` extensions).
pub fn auth(ctx: &RequestContext<RoleServer>) -> Result<&AuthContext, rmcp::ErrorData> {
    let missing = || {
        rmcp::ErrorData::internal_error(
            "AuthContext missing: requests must arrive through the auth middleware",
            None,
        )
    };
    let parts = ctx
        .extensions
        .get::<http::request::Parts>()
        .ok_or_else(missing)?;
    parts.extensions.get::<AuthContext>().ok_or_else(missing)
}

/// The fixed invalid-token description (spec_auth.md 5-1).
const INVALID_TOKEN_DESC: &str = "the access token is invalid, expired or revoked";

/// 401 with the WWW-Authenticate challenge (spec_auth.md 5-1).
fn unauthorized(auth: &ResolvedAuth, invalid: bool) -> Response {
    let prm = protected_resource_metadata_url(auth);
    let challenge = if invalid {
        format!(
            "Bearer error=\"invalid_token\", error_description=\"{INVALID_TOKEN_DESC}\", \
             resource_metadata=\"{prm}\", scope=\"ledger.read ledger.write\""
        )
    } else {
        format!("Bearer resource_metadata=\"{prm}\", scope=\"ledger.read ledger.write\"")
    };
    let mut resp = (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({ "error": "unauthorized" })),
    )
        .into_response();
    if let Ok(v) = challenge.parse() {
        resp.headers_mut().insert(header::WWW_AUTHENTICATE, v);
    }
    resp
}

/// The `_meta["mcp/www_authenticate"]` value for scope errors (5-1).
pub fn insufficient_scope_challenge(scope: Scope, auth: &ResolvedAuth) -> String {
    format!(
        "Bearer error=\"insufficient_scope\", scope=\"{}\", resource_metadata=\"{}\"",
        scope.as_str(),
        protected_resource_metadata_url(auth)
    )
}

/// Scope check at tool level: the error is a tool result (isError), not an
/// HTTP error, so ChatGPT can react in-conversation (spec_auth.md 5-1).
pub fn require_scope(a: &AuthContext, s: Scope, auth: &ResolvedAuth) -> Result<(), CallToolResult> {
    if a.has_scope(s) {
        return Ok(());
    }
    let mut result = CallToolResult::error(vec![ContentBlock::text(format!(
        "この操作には {} の権限が必要です。再接続時に許可してください。",
        s.as_str()
    ))]);
    let map = json!({ "mcp/www_authenticate": [insufficient_scope_challenge(s, auth)] })
        .as_object()
        .cloned()
        .unwrap_or_default();
    result.meta = Some(map.into());
    Err(result)
}

/// Which ledger a tool call targets (spec_auth.md 5-3 steps 6-8; the
/// draft-based resolution belongs to the draft tools in TASK-11).
#[derive(Debug, Clone)]
pub struct TargetLedger {
    pub ledger_id: i64,
    pub name: String,
    pub role: LedgerRole,
    pub source: LedgerSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LedgerSource {
    Active,
    Explicit,
}

impl TargetLedger {
    /// resolve_target_ledger error result (no active ledger).
    fn no_active_ledger_error() -> CallToolResult {
        CallToolResult::error(vec![ContentBlock::text(
            "選択中の家計簿にアクセスできなくなりました。list_ledgers で確認し switch_ledger で選び直してください。",
        )])
    }
}

/// Resolve the ledger a tool call operates on: an explicit `ledger_id`
/// argument (membership-checked) or the grant's active ledger
/// (spec_auth.md 5-3 steps 7-8). Unset / not-a-member are the same error.
pub async fn resolve_target_ledger(
    a: &AuthContext,
    arg: Option<i64>,
    db: &SqlitePool,
) -> Result<TargetLedger, CallToolResult> {
    let db_err = |e: sqlx::Error| {
        tracing::error!(error = %e, "ledger resolution failed");
        CallToolResult::error(vec![ContentBlock::text("内部エラーが発生しました。")])
    };
    if let Some(ledger_id) = arg {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT l.name, m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
             WHERE m.ledger_id = ? AND m.user_id = ?",
        )
        .bind(ledger_id)
        .bind(a.user_id)
        .fetch_optional(db)
        .await
        .map_err(db_err)?;
        return match row.and_then(|(name, role)| Some((name, LedgerRole::parse(&role)?))) {
            Some((name, role)) => Ok(TargetLedger {
                ledger_id,
                name,
                role,
                source: LedgerSource::Explicit,
            }),
            None => Err(CallToolResult::error(vec![ContentBlock::text(
                "指定された家計簿にはアクセスできません。list_ledgers で確認してください。",
            )])),
        };
    }
    match &a.ledger {
        Some(active) => Ok(TargetLedger {
            ledger_id: active.ledger_id,
            name: active.name.clone(),
            role: active.role,
            source: LedgerSource::Active,
        }),
        None => Err(TargetLedger::no_active_ledger_error()),
    }
}

/// Write tools need role >= editor on the target ledger (spec_auth.md 6-3).
pub fn require_writer(l: &TargetLedger) -> Result<(), CallToolResult> {
    if l.role >= LedgerRole::Editor {
        Ok(())
    } else {
        Err(CallToolResult::error(vec![ContentBlock::text(
            "この家計簿では編集権限がありません（閲覧のみです）。",
        )]))
    }
}

/// The Bearer validation SQL (spec_data-model.md section 14): access token ->
/// grant -> user with `disabled_at IS NULL`, then the active-ledger
/// membership. `None` = invalid token (401 invalid_token).
#[allow(clippy::type_complexity)]
async fn validate_bearer(
    db: &SqlitePool,
    token: &[u8; TOKEN_LEN],
    cfg: &ResolvedAuth,
    now: i64,
) -> anyhow::Result<Option<AuthContext>> {
    let row: Option<(
        i64,         // grant_id
        i64,         // user_id
        String,      // scope
        String,      // resource
        String,      // client_id
        Option<i64>, // active_ledger_id (via members)
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT g.id, g.user_id, g.scope, g.resource, g.client_id,
                m.ledger_id, l.name, m.role
         FROM oauth_access_tokens t
         JOIN oauth_grants g ON g.id = t.grant_id
         JOIN users u ON u.id = g.user_id
         LEFT JOIN ledger_members m ON m.ledger_id = g.active_ledger_id AND m.user_id = g.user_id
         LEFT JOIN ledgers l ON l.id = m.ledger_id
         WHERE t.token_hash = ? AND t.revoked_at IS NULL AND t.expires_at > ?
           AND g.revoked_at IS NULL AND g.absolute_expires_at > ?
           AND u.disabled_at IS NULL",
    )
    .bind(sha256(token).to_vec())
    .bind(now)
    .bind(now)
    .fetch_optional(db)
    .await?;
    let Some((grant_id, user_id, scope, resource, client_id, ledger_id, name, role)) = row else {
        return Ok(None);
    };
    if resource != cfg.resource {
        return Ok(None);
    }
    let scopes = ScopeSet::from_space_separated(&scope);
    let ledger = match (ledger_id, name, role.as_deref().and_then(LedgerRole::parse)) {
        (Some(id), Some(name), Some(role)) => Some(ActiveLedger {
            ledger_id: id,
            name,
            role,
        }),
        _ => None, // unselected or no longer a member (5-1: not an HTTP error)
    };
    // last_used_at at most every 5 minutes (spec_auth.md 4-11)
    sqlx::query(
        "UPDATE oauth_grants SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)",
    )
    .bind(now)
    .bind(grant_id)
    .bind(now - LAST_USED_INTERVAL_MS)
    .execute(db)
    .await?;
    Ok(Some(AuthContext {
        user_id,
        ledger,
        scopes,
        client_id,
        grant_id,
    }))
}

/// Extract exactly one Bearer token (spec_auth.md 5-1). Multiple
/// Authorization headers, other schemes, query `access_token` are rejected.
fn bearer_token(headers: &HeaderMap) -> Option<[u8; TOKEN_LEN]> {
    let values = headers.get_all(header::AUTHORIZATION);
    if values.iter().count() != 1 {
        return None;
    }
    let value = values.iter().next()?.to_str().ok()?;
    let (scheme, rest) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") || rest.is_empty() {
        return None;
    }
    let bytes = b64url_decode(rest)?;
    bytes.try_into().ok()
}

/// `/mcp` auth middleware (spec_auth.md 5-1, 5-3): 401 challenges before
/// rmcp, AuthContext into the request extensions after. Also applies the
/// per-user rate limit (spec_auth.md 10-1).
pub async fn auth_layer(
    State(state): State<crate::auth::api::AuthApiState>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let now = now_ms();
    // every 401 path also counts against a loose per-IP limiter (spec_auth.md
    // 10-1 spirit: token guessing / unauthenticated floods get 429)
    let ip = crate::ratelimit::client_ip(
        req.headers(),
        req.extensions()
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>(),
        state.auth.rate_limit.trust_cf_connecting_ip,
    );
    let reject = |invalid: bool| -> Response {
        if let Some(retry) = state.limits.check(
            crate::ratelimit::Class::McpUnauthenticated,
            &format!("ip:{ip}"),
            now,
        ) {
            return crate::ratelimit::too_many_requests(retry);
        }
        unauthorized(&state.auth, invalid)
    };
    // reject `?access_token=` per RFC 6750 avoidance (spec_auth.md 5-1)
    if req.uri().query().is_some_and(|q| {
        q.split('&')
            .any(|kv| kv.split('=').next() == Some("access_token"))
    }) {
        return reject(false);
    }
    // an Authorization header that fails to parse counts as an invalid
    // token (error="invalid_token"); only its absence is the plain challenge
    let has_authz = req.headers().contains_key(header::AUTHORIZATION);
    let Some(token) = bearer_token(req.headers()) else {
        return reject(has_authz);
    };
    let ctx = match validate_bearer(&state.db, &token, &state.auth, now).await {
        Ok(Some(ctx)) => ctx,
        Ok(None) => return reject(true),
        Err(e) => {
            tracing::error!(error = %e, "bearer validation failed");
            return reject(true);
        }
    };
    if let Some(retry) = state.limits.check(
        crate::ratelimit::Class::Mcp,
        &format!("user:{}", ctx.user_id),
        now,
    ) {
        return crate::ratelimit::too_many_requests(retry);
    }
    req.extensions_mut().insert(ctx);
    next.run(req).await
}

/// Whether a request context carries an `AuthContext`; used by the
/// defense-in-depth check in `ServerHandler::call_tool` (spec_auth.md 5-2).
pub fn has_auth_context(ctx: &RequestContext<RoleServer>) -> bool {
    auth(ctx).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-mcp.bearer-header-parsing]
    #[test]
    fn bearer_header_strictness() {
        fn token_header(value: &str) -> HeaderMap {
            let mut h = HeaderMap::new();
            h.insert(header::AUTHORIZATION, value.parse().unwrap());
            h
        }
        let token = [7u8; 32];
        let encoded = crate::auth::tokens::b64url_encode(&token);
        assert_eq!(
            bearer_token(&token_header(&format!("Bearer {encoded}"))),
            Some(token)
        );
        // scheme is case-insensitive, but must be followed by the token
        assert_eq!(
            bearer_token(&token_header(&format!("bearer {encoded}"))),
            Some(token)
        );
        assert_eq!(bearer_token(&token_header("Bearer")), None);
        assert_eq!(bearer_token(&token_header("Bearer  ")), None);
        assert_eq!(bearer_token(&token_header("Basic abc")), None);
        // wrong length / invalid chars
        assert_eq!(
            bearer_token(&token_header(&format!("Bearer {}", &encoded[..10]))),
            None
        );
        assert_eq!(bearer_token(&token_header("Bearer ***")), None);
        // two Authorization headers are rejected
        let mut h = HeaderMap::new();
        h.append(
            header::AUTHORIZATION,
            format!("Bearer {encoded}").parse().unwrap(),
        );
        h.append(
            header::AUTHORIZATION,
            format!("Bearer {encoded}").parse().unwrap(),
        );
        assert_eq!(bearer_token(&h), None);
    }

    fn test_auth_ctx(scopes: ScopeSet) -> AuthContext {
        AuthContext {
            user_id: 1,
            ledger: None,
            scopes,
            client_id: "https://chatgpt.com/clients/x".into(),
            grant_id: 1,
        }
    }

    fn resolved() -> ResolvedAuth {
        crate::config::test_resolved_auth()
    }

    // [covers:auth-mcp.scope-check-tool-result]
    #[test]
    fn require_scope_returns_meta_challenge() {
        let auth = resolved();
        // write implies read
        let both = test_auth_ctx(ScopeSet {
            read: false,
            write: true,
        });
        assert!(require_scope(&both, Scope::LedgerRead, &auth).is_ok());
        assert!(require_scope(&both, Scope::LedgerWrite, &auth).is_ok());
        // read-only grant: write tool gets isError + mcp/www_authenticate
        let read_only = test_auth_ctx(ScopeSet {
            read: true,
            write: false,
        });
        assert!(require_scope(&read_only, Scope::LedgerRead, &auth).is_ok());
        let err =
            require_scope(&read_only, Scope::LedgerWrite, &auth).expect_err("write scope missing");
        assert_eq!(err.is_error, Some(true));
        let meta = err.meta.expect("meta present");
        let challenge = meta
            .get("mcp/www_authenticate")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .expect("challenge string");
        assert!(challenge.contains("insufficient_scope"), "{challenge}");
        assert!(challenge.contains("ledger.write"), "{challenge}");
        assert!(challenge.contains("resource_metadata"), "{challenge}");
        // neither scope: everything fails
        let none = test_auth_ctx(ScopeSet::default());
        assert!(require_scope(&none, Scope::LedgerRead, &auth).is_err());
    }

    // [covers:auth-mcp.www-authenticate-header-shape]
    #[test]
    fn unauthorized_header_shape() {
        let auth = resolved();
        let resp = unauthorized(&auth, false);
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        let h = resp
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .unwrap()
            .to_string();
        assert!(h.starts_with("Bearer "), "{h}");
        assert!(
            h.contains("resource_metadata=\"http://localhost:40281/.well-known/oauth-protected-resource/mcp\""),
            "{h}"
        );
        assert!(h.contains("scope=\"ledger.read ledger.write\""), "{h}");
        assert!(!h.contains("error="), "{h}");
        let resp = unauthorized(&auth, true);
        let h = resp
            .headers()
            .get(header::WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .unwrap()
            .to_string();
        assert!(h.contains("error=\"invalid_token\""), "{h}");
    }
}
