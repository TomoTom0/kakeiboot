//! OAuth 2.1 authorization server (spec_auth.md sections 4, 10-2, 11-3..11-5):
//! CIMD client registration, the authorize / consent flow, PKCE code exchange
//! with grant creation, refresh rotation, revocation and the metadata
//! endpoints. Opaque tokens are 256-bit random values stored as SHA-256
//! hashes; no signing keys exist.

pub mod assertion;
pub mod authorize;
pub mod cimd;
pub mod grants;
pub mod net;
pub mod token;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use serde_json::json;

use crate::config::ResolvedAuth;

/// grant / token scope values (spec_auth.md section 4-8).
pub const SCOPE_LEDGER_READ: &str = "ledger.read";
pub const SCOPE_LEDGER_WRITE: &str = "ledger.write";
/// accepted but silently dropped (refresh tokens are always issued).
pub const SCOPE_OFFLINE_ACCESS: &str = "offline_access";

/// A single required scope (spec_auth.md section 5-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    LedgerRead,
    LedgerWrite,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LedgerRead => SCOPE_LEDGER_READ,
            Self::LedgerWrite => SCOPE_LEDGER_WRITE,
        }
    }
}

/// Parsed, de-duplicated scope set of a grant / token.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeSet {
    pub read: bool,
    pub write: bool,
}

impl ScopeSet {
    pub fn from_space_separated(s: &str) -> Self {
        let mut set = Self::default();
        for part in s.split_whitespace() {
            match part {
                SCOPE_LEDGER_READ => set.read = true,
                SCOPE_LEDGER_WRITE => set.write = true,
                _ => {}
            }
        }
        set
    }

    /// `ledger.write` implies `ledger.read` (spec_auth.md section 4-8).
    pub fn allows(&self, needed: Scope) -> bool {
        match needed {
            Scope::LedgerRead => self.read || self.write,
            Scope::LedgerWrite => self.write,
        }
    }

    pub fn is_empty(&self) -> bool {
        !self.read && !self.write
    }
}

/// A malformed or unknown scope request (maps to `invalid_scope`).
#[derive(Debug)]
pub struct ScopeError;

/// Parse a requested `scope` parameter (authorize / refresh).
/// `None` means the parameter was absent (defaults apply). Unknown scopes
/// are rejected; `offline_access` is dropped; duplicates collapse.
pub fn parse_requested_scope(raw: Option<&str>) -> Result<Option<Vec<String>>, ScopeError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    if raw.chars().count() > 256 {
        return Err(ScopeError);
    }
    let mut out: Vec<String> = Vec::new();
    for part in raw.split_whitespace() {
        match part {
            SCOPE_OFFLINE_ACCESS => continue,
            SCOPE_LEDGER_READ | SCOPE_LEDGER_WRITE => {
                if !out.iter().any(|s| s == part) {
                    out.push(part.to_string());
                }
            }
            _ => return Err(ScopeError),
        }
    }
    Ok(Some(out))
}

/// The scope list a token carries: requested (or grant) scope, or the
/// defaults when nothing effective remains.
pub fn effective_scope(requested: Option<Vec<String>>, default_scopes: &str) -> Vec<String> {
    match requested {
        Some(list) if !list.is_empty() => list,
        _ => default_scopes
            .split_whitespace()
            .map(str::to_string)
            .collect(),
    }
}

pub fn scope_string(list: &[String]) -> String {
    list.join(" ")
}

/// Fixed client display name derived from the allowlisted client host
/// (spec_auth.md section 4-6: CIMD `client_name` is never the main label).
pub fn client_display_for_host(host: &str) -> String {
    match host {
        "chatgpt.com" => "ChatGPT".to_string(),
        other => other.to_string(),
    }
}

/// Japanese consent-screen description of a scope.
pub fn scope_description(scope: &str) -> &'static str {
    match scope {
        SCOPE_LEDGER_READ => {
            "家計簿の参照（レシートや下書きの検索・閲覧、集計、カテゴリや店の一覧の表示）"
        }
        SCOPE_LEDGER_WRITE => {
            "家計簿の変更（レシートの作成・修正・確定・削除、カテゴリや店の管理）"
        }
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// errors

/// RFC 6749 error responses for the token / revoke endpoints (JSON body,
/// `Cache-Control: no-store`).
#[derive(Debug)]
pub struct OAuthError {
    pub status: StatusCode,
    pub code: &'static str,
    pub description: &'static str,
}

impl OAuthError {
    pub fn invalid_request() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            description: "the request is missing a required parameter or is otherwise malformed",
        }
    }
    pub fn invalid_grant() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_grant",
            description: "the provided authorization grant or token is invalid or expired",
        }
    }
    pub fn invalid_client() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "invalid_client",
            description: "client authentication failed",
        }
    }
    pub fn invalid_scope() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_scope",
            description: "the requested scope is invalid or exceeds the granted scope",
        }
    }
    pub fn invalid_target() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_target",
            description: "the requested resource is invalid for this server",
        }
    }
    pub fn unsupported_grant_type() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "unsupported_grant_type",
            description: "the authorization grant type is not supported",
        }
    }
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut resp = (
            self.status,
            Json(json!({
                "error": self.code,
                "error_description": self.description,
            })),
        )
            .into_response();
        resp.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        resp.headers_mut()
            .insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
        if self.status == StatusCode::UNAUTHORIZED {
            // RFC 6749 section 5.2: 401 invalid_client must carry WWW-Authenticate
            // when the client attempted authentication.
            resp.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Basic realm=\"budget-book\""),
            );
        }
        resp
    }
}

// ---------------------------------------------------------------------------
// query / form parameter parsing (duplicate detection, spec_auth.md 4-5)

/// A parameter appeared more than once (each must appear exactly once).
#[derive(Debug)]
pub struct DuplicateParamError;

/// Parse `a=1&b=2` pairs into an ordered map; a key occurring twice is an
/// error (each parameter must appear exactly once).
pub fn parse_pairs_exclusive(input: &str) -> Result<Vec<(String, String)>, DuplicateParamError> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (k, v) in url::form_urlencoded::parse(input.as_bytes()) {
        let (k, v) = (k.into_owned(), v.into_owned());
        if out.iter().any(|(ek, _)| *ek == k) {
            return Err(DuplicateParamError);
        }
        out.push((k, v));
    }
    Ok(out)
}

/// Look up a key in parsed pairs.
pub fn pair<'a>(pairs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

// ---------------------------------------------------------------------------
// well-known metadata (spec_auth.md section 4-1)

fn cached_json(body: serde_json::Value) -> Response {
    let mut resp = Json(body).into_response();
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    resp
}

/// `/.well-known/oauth-protected-resource[/mcp]` document.
pub fn protected_resource_document(auth: &ResolvedAuth) -> serde_json::Value {
    json!({
        "resource": auth.resource,
        "authorization_servers": [auth.issuer],
        "scopes_supported": [SCOPE_LEDGER_READ, SCOPE_LEDGER_WRITE],
        "bearer_methods_supported": ["header"],
        "resource_name": "budget-book",
    })
}

/// `/.well-known/oauth-authorization-server` document.
pub fn authorization_server_document(auth: &ResolvedAuth) -> serde_json::Value {
    json!({
        "issuer": auth.issuer,
        "authorization_endpoint": format!("{}/oauth/authorize", auth.issuer),
        "token_endpoint": format!("{}/oauth/token", auth.issuer),
        "revocation_endpoint": format!("{}/oauth/revoke", auth.issuer),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["private_key_jwt", "none"],
        "token_endpoint_auth_signing_alg_values_supported": ["RS256", "PS256", "ES256"],
        "revocation_endpoint_auth_methods_supported": ["private_key_jwt", "none"],
        "revocation_endpoint_auth_signing_alg_values_supported": ["RS256", "PS256", "ES256"],
        "scopes_supported": [SCOPE_LEDGER_READ, SCOPE_LEDGER_WRITE],
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    })
}

/// The protected-resource metadata URL advertised in WWW-Authenticate
/// (`<issuer>/.well-known/oauth-protected-resource<mcp path>`).
pub fn protected_resource_metadata_url(auth: &ResolvedAuth) -> String {
    let mcp_path = auth.resource.strip_prefix(&auth.issuer).unwrap_or_default();
    format!(
        "{}/.well-known/oauth-protected-resource{mcp_path}",
        auth.issuer
    )
}

async fn wk_authorization_server(
    axum::extract::State(state): axum::extract::State<super::api::AuthApiState>,
) -> Response {
    cached_json(authorization_server_document(&state.auth))
}

async fn wk_protected_resource(
    axum::extract::State(state): axum::extract::State<super::api::AuthApiState>,
) -> Response {
    cached_json(protected_resource_document(&state.auth))
}

// ---------------------------------------------------------------------------
// router

/// All /oauth/* and /.well-known/* routes of the authorization server,
/// including the IP rate limit on the authorize endpoints (spec_auth.md
/// section 10-1).
pub fn routes(state: super::api::AuthApiState) -> Router {
    Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            axum::routing::get(wk_authorization_server),
        )
        .route(
            "/.well-known/oauth-protected-resource",
            axum::routing::get(wk_protected_resource),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            axum::routing::get(wk_protected_resource),
        )
        .route(
            "/oauth/authorize",
            axum::routing::get(authorize::authorize_get),
        )
        .route("/oauth/token", axum::routing::post(token::token_post))
        .route("/oauth/revoke", axum::routing::post(token::revoke_post))
        .merge(authorize::routes())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            authorize_limit_guard,
        ))
        .with_state(state)
}

/// IP rate limit for `/oauth/authorize` and the decision POST
/// (spec_auth.md section 10-1: 30/min per IP).
async fn authorize_limit_guard(
    axum::extract::State(state): axum::extract::State<super::api::AuthApiState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path();
    if path == "/oauth/authorize" || path == "/oauth/authorize/decision" {
        let ip = crate::ratelimit::client_ip(
            req.headers(),
            req.extensions()
                .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>(),
            state.auth.rate_limit.trust_cf_connecting_ip,
        );
        if let Some(retry) =
            state
                .limits
                .check(crate::ratelimit::Class::Authorize, &ip, session_now())
        {
            return crate::ratelimit::too_many_requests(retry);
        }
    }
    next.run(req).await
}

fn session_now() -> i64 {
    super::session::now_ms()
}
