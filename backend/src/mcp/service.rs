//! `ServerHandler` and the Streamable HTTP service mounted under `mcp.path`.
//!
//! Every request passes `mcp::auth::auth_layer` (Bearer -> AuthContext);
//! `call_tool` additionally rejects calls without an AuthContext as defense
//! in depth (spec_auth.md 5-2: the anonymous `request_recovery` exception is
//! gated on TASK-7 item 17 and not implemented).
//!
//! The registry tools (spec_mcp-tools.md 2) are mounted as dynamic routes
//! on the rmcp `ToolRouter` next to the connectivity `ping`; the widget
//! template resource is served from `tools::env.widget` (spec 11-1).

use std::sync::Arc;

use rmcp::{
    ErrorData, RoleServer, ServerHandler,
    handler::server::router::tool::{ToolRoute, ToolRouter},
    handler::server::tool::ToolCallContext,
    model::{
        CallToolRequestParams, CallToolResponse, ListResourcesResult, PaginatedRequestParams,
        ReadResourceRequestParams, ReadResourceResponse, ReadResourceResult, ServerCapabilities,
        ServerConfig,
    },
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
    },
};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

use super::auth::{AuthContext, auth};
use super::registry::{self, ToolDef};
use super::tools::{self, ToolEnv};
use super::widget_resource::WidgetResource;
use crate::auth::oauth::assertion as oauth_assertion;
use crate::auth::session::now_ms;
use crate::config::Config;

/// Reply text of the `ping` tool.
pub const PING_REPLY: &str = "pong";

#[derive(Debug, Clone)]
pub struct BudgetBookMcp {
    tool_router: ToolRouter<Self>,
    env: Arc<ToolEnv>,
}

impl BudgetBookMcp {
    pub fn new(env: Arc<ToolEnv>) -> Self {
        let mut tool_router = Self::tool_router(); // the `ping` route
        for def in registry::defs() {
            let route = dynamic_route(&env, def, &env.widget.uri);
            tool_router.add_route(route);
        }
        Self { tool_router, env }
    }
}

/// One registry tool as a dynamic rmcp route: descriptor from the registry,
/// dispatch through `tools::call` (scope check + handler).
fn dynamic_route(env: &Arc<ToolEnv>, def: ToolDef, uri: &str) -> ToolRoute<BudgetBookMcp> {
    let env = Arc::clone(env);
    let tool = registry::descriptor(&def, uri, &env.cfg.limits);
    ToolRoute::new_dyn(tool, move |tcc: ToolCallContext<'_, BudgetBookMcp>| {
        let env = Arc::clone(&env);
        Box::pin(async move {
            let Ok(auth_context) = auth(&tcc.request_context) else {
                // The auth middleware guarantees an AuthContext; reaching
                // here means the route was called outside `/mcp`.
                return Err(ErrorData::internal_error(
                    "AuthContext missing: requests must arrive through the auth middleware",
                    None,
                ));
            };
            let auth_context = auth_context.clone();
            let args = tcc.arguments.clone().unwrap_or_default();
            let now = now_ms();
            match tools::call(&env, &auth_context, tcc.name.as_ref(), args, now).await {
                Some(r) => Ok(r.into()),
                None => Err(ErrorData::internal_error(
                    format!("tool {} routed but unknown", tcc.name),
                    None,
                )),
            }
        })
    })
}

#[tool_router]
impl BudgetBookMcp {
    /// Connectivity check. Reports the authenticated user and selected
    /// ledger so tests (and operators) can see the AuthContext wiring
    /// (spec_auth.md 5-3).
    #[tool(
        description = "Connectivity check. Returns \"pong\" with the caller's user id and selected ledger."
    )]
    async fn ping(&self, ctx: RequestContext<RoleServer>) -> Result<String, ErrorData> {
        let a: &AuthContext = auth(&ctx)?;
        let ledger = match &a.ledger {
            Some(l) => format!("{}(id={})", l.name, l.ledger_id),
            None => "none".to_string(),
        };
        Ok(format!(
            "{PING_REPLY} user_id={} ledger={ledger}",
            a.user_id
        ))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for BudgetBookMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_instructions("budget-book MCP server")
    }

    /// Defense in depth (spec_auth.md 5-2): no AuthContext, no tool. The
    /// anonymous exception is intentionally absent until TASK-7 item 17.
    /// Also records the `openai/subject` hash (spec_auth.md 7-4) after the
    /// tool completes, independent of its outcome.
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let auth_context = auth(&context)?.clone();
        // `openai/subject` travels in params._meta (spec_auth.md 7-4); the
        // request-level meta is checked as well for future transports
        let subject = request
            .meta
            .as_ref()
            .and_then(|m| m.0.get("openai/subject"))
            .or_else(|| context.meta.0.get("openai/subject"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        // tool-call log (spec_auth.md 10-5, TASK-15): name, actor and
        // outcome only — arguments and result contents are never logged.
        let tool = request.name.to_string();
        let start = std::time::Instant::now();
        let result = {
            let tcc = ToolCallContext::new(self, request, context);
            self.tool_router.call(tcc).await
        };
        let latency_ms = start.elapsed().as_millis() as u64;
        match &result {
            Ok(resp) => {
                let is_error = matches!(
                    resp,
                    CallToolResponse::Complete(r) if r.is_error.unwrap_or(false)
                );
                tracing::info!(
                    tool = %tool,
                    user_id = auth_context.user_id,
                    client_id = %auth_context.client_id,
                    is_error,
                    latency_ms,
                    "tool call"
                );
            }
            Err(e) => {
                tracing::warn!(
                    tool = %tool,
                    user_id = auth_context.user_id,
                    client_id = %auth_context.client_id,
                    error = %e,
                    latency_ms,
                    "tool call failed"
                );
            }
        }
        if let Some(subject) = subject {
            let hash = oauth_assertion::subject_hash(&subject);
            let now = now_ms();
            match self.env.db.acquire().await {
                Ok(mut conn) => {
                    oauth_assertion::record_subject_hash(
                        &mut conn,
                        &hash,
                        auth_context.user_id,
                        now,
                    )
                    .await;
                }
                Err(e) => tracing::warn!(error = %e, "subject hash: no connection"),
            }
        }
        result
    }

    /// The single widget template resource (spec_mcp-tools.md 11-1).
    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, ErrorData> {
        serde_json::from_value(self.env.widget.list_json())
            .map_err(|e| ErrorData::internal_error(format!("widget resource: {e}"), None))
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, ErrorData> {
        if request.uri.as_str() != self.env.widget.uri.as_str() {
            return Err(ErrorData::invalid_params(
                format!("unknown resource {}", request.uri),
                None,
            ));
        }
        let result: ReadResourceResult = serde_json::from_value(self.env.widget.read_json())
            .map_err(|e| ErrorData::internal_error(format!("widget resource: {e}"), None))?;
        Ok(ReadResourceResponse::Complete(result))
    }
}

pub type McpService = StreamableHttpService<BudgetBookMcp, NeverSessionManager>;

/// Build the tool environment from the loaded config.
pub fn tool_env(cfg: &Config, db: SqlitePool) -> Arc<ToolEnv> {
    let widget = WidgetResource::load(&cfg.widget_html_path(), &cfg.auth.public_origin);
    Arc::new(ToolEnv {
        db,
        auth_cfg: Arc::new(cfg.auth.clone()),
        cfg: Arc::new(cfg.tools.clone()),
        image_root: cfg.image_root(),
        http: crate::domain::images::http_client(),
        decode_gate: crate::domain::images::DecodeGate::new(
            cfg.tools.image.decode_concurrency,
            cfg.tools.image.batch_decode_concurrency,
        ),
        widget: Arc::new(widget),
    })
}

/// Build the stateless Streamable HTTP service (spec_auth.md 5-4).
pub fn build_service(cfg: &Config, db: SqlitePool, ct: CancellationToken) -> McpService {
    let env = tool_env(cfg, db);
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_allowed_hosts(cfg.app.mcp.allowed_hosts.clone())
        .with_max_request_body_bytes(cfg.app.mcp.max_request_body_bytes)
        .with_cancellation_token(ct);
    StreamableHttpService::new(
        move || Ok(BudgetBookMcp::new(Arc::clone(&env))),
        Arc::new(NeverSessionManager::default()),
        config,
    )
}
