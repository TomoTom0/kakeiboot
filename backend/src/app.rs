//! axum Router assembly and server startup.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::{Json, Router, extract::State, http::StatusCode, routing::get};
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use webauthn_rs::prelude::WebauthnBuilder;

use crate::auth::api::AuthApiState;
use crate::config::Config;
use crate::mcp::service::build_service;

/// Shared application state (DB pool, WebAuthn RP, resolved auth settings).
pub type AppState = AuthApiState;

impl AppState {
    /// Build the state including the WebAuthn Relying Party from the
    /// validated auth config.
    pub fn new(cfg: &Config, db: SqlitePool) -> anyhow::Result<Self> {
        let rp_origin: url::Url = cfg
            .auth
            .rp_origin
            .parse()
            .map_err(|e| anyhow::anyhow!("parsing auth.rp_origin: {e}"))?;
        let webauthn = WebauthnBuilder::new(&cfg.auth.rp_id, &rp_origin)
            .map_err(|e| anyhow::anyhow!("building WebAuthn RP: {e}"))?
            .rp_name("kakeiboot")
            .build()
            .map_err(|e| anyhow::anyhow!("building WebAuthn RP: {e}"))?;
        let fetch =
            crate::auth::oauth::net::FetchClient::new(cfg.auth.oauth.dev.allow_insecure_loopback);
        let limits = Arc::new(crate::ratelimit::RateLimits::new(
            cfg.auth.rate_limit.clone(),
        ));
        Ok(Self {
            db,
            webauthn: Arc::new(webauthn),
            auth: cfg.auth.clone(),
            fetch,
            limits,
            tools: Arc::new(cfg.tools.clone()),
        })
    }
}

#[derive(Debug, Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct Health {
    pub status: String,
    pub db: String,
}

/// Build the application router. `/mcp` is wrapped by the Bearer
/// authentication middleware (spec_auth.md section 5-1) before the rmcp
/// Streamable HTTP service; the web data API and the static frontend are
/// mounted alongside (TASK-11 integration 6-7).
pub fn router(cfg: &Config, state: AppState, ct: CancellationToken) -> Router {
    let mcp = build_service(cfg, state.db.clone(), ct);
    let mcp_router = Router::new()
        .route_service(cfg.app.mcp.path.as_str(), mcp)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::mcp::auth::auth_layer,
        ));
    let static_root = cfg.static_root();
    Router::new()
        .route("/healthz", get(healthz))
        .with_state(state.clone())
        .merge(mcp_router)
        .merge(crate::auth::oauth::routes(state.clone()))
        .merge(crate::auth::api::routes(state.clone()))
        .merge(crate::web::api::routes(state.clone()))
        .merge(crate::web::media::routes(state.clone(), cfg.image_root()))
        .merge(crate::web::static_files::routes(cfg.static_root()))
        .fallback(move |req: axum::extract::Request| {
            let root = static_root.clone();
            async move { crate::web::static_files::spa_fallback(root, req).await }
        })
}

async fn healthz(State(state): State<AppState>) -> (StatusCode, Json<Health>) {
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(Health {
                status: "ok".into(),
                db: "ok".into(),
            }),
        ),
        Err(e) => {
            tracing::warn!(error = %e, "healthz db check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(Health {
                    status: "degraded".into(),
                    db: "error".into(),
                }),
            )
        }
    }
}

/// Bind one listener per `[server]` host (port 0 = OS assigned). Loopback
/// configs list ["127.0.0.1", "::1"] so clients that resolve `localhost` to
/// either stack (e.g. cloudflared's Go resolver) reach the server.
pub async fn bind(cfg: &Config) -> std::io::Result<Vec<TcpListener>> {
    let mut out = Vec::with_capacity(cfg.app.server.hosts.len());
    for host in &cfg.app.server.hosts {
        out.push(TcpListener::bind((host.as_str(), cfg.app.server.port)).await?);
    }
    Ok(out)
}

/// Serve until `ct` is cancelled. Peer addresses are surfaced as
/// `ConnectInfo<SocketAddr>` for the rate limiters (spec_auth.md 10-1).
pub async fn serve(
    listener: TcpListener,
    app: Router,
    ct: CancellationToken,
) -> std::io::Result<()> {
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move { ct.cancelled_owned().await })
    .await
}

/// Log the bound address.
pub fn log_bound(addr: SocketAddr, mcp_path: &str) {
    tracing::info!(%addr, mcp_path, "listening");
}
