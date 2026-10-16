//! Widget image delivery `GET /media/img/<token>` (spec_mcp-tools.md 11-5).
//! The token in the URL is the only credential: every request re-runs the
//! single-query recheck (`domain::images::resolve_token` — token hash +
//! expiry + user not disabled + still a ledger member + live receipt or
//! pending draft reference) and reads the WebP from the image root. Any
//! failure is a plain 404 without distinguishing the reason. Logs never
//! contain the token: paths are recorded as `/media/img/<redacted>`
//! (spec_auth.md 10-2).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;
use sqlx::SqlitePool;

use crate::app::AppState;
use crate::auth::session::now_ms;
use crate::domain::images::resolve_token;
use crate::ratelimit::{Class, RateLimits, client_ip, too_many_requests};

/// Redacted path used in every log line touching a media URL.
const REDACTED: &str = "/media/img/<redacted>";

#[derive(Clone)]
struct MediaState {
    db: SqlitePool,
    limits: Arc<RateLimits>,
    trust_cf: bool,
    root: PathBuf,
}

/// `/media/img/{token}`. Anonymous route: no session, no Origin guard —
/// the token authorizes one image (spec_mcp-tools.md 11-5).
pub fn routes(state: AppState, image_root: PathBuf) -> Router {
    Router::new()
        .route("/media/img/{token}", get(img))
        .with_state(MediaState {
            db: state.db,
            limits: state.limits,
            trust_cf: state.auth.rate_limit.trust_cf_connecting_ip,
            root: image_root,
        })
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response()
}

async fn img(State(st): State<MediaState>, req: Request) -> Response {
    // rate limit first, per IP (spec 11-5 "user / IP"; token is the only
    // credential so the IP is the available key)
    let now = now_ms();
    let ip = client_ip(
        req.headers(),
        req.extensions().get::<ConnectInfo<SocketAddr>>(),
        st.trust_cf,
    );
    if let Some(retry) = st.limits.check(Class::Media, &ip, now) {
        return too_many_requests(retry);
    }

    // b64url tokens need no percent-decoding; anything else is a plain 404
    let Some(token) = req.uri().path().strip_prefix("/media/img/") else {
        return not_found();
    };
    if token.is_empty() || token.contains('/') {
        return not_found();
    }

    // recheck + fetch the storage path (one query; None -> 404, reason
    // never distinguished)
    let (rel, expires_at) = match resolve_token(&st.db, token, now).await {
        Ok(Some(v)) => v,
        Ok(None) => {
            tracing::debug!(path = REDACTED, "media token rejected");
            return not_found();
        }
        Err(e) => {
            tracing::error!(error = %e, path = REDACTED, "media recheck failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "internal" })),
            )
                .into_response();
        }
    };

    // storage_path is DB-owned (never client input); the traversal check is
    // a cheap defense in depth so a corrupted row cannot escape the root
    let abs = st.root.join(&rel);
    if !abs.starts_with(&st.root)
        || std::path::Path::new(&rel)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        tracing::warn!(path = REDACTED, "media storage path rejected");
        return not_found();
    }
    let bytes = match tokio::fs::read(&abs).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, path = REDACTED, "media file missing");
            return not_found();
        }
    };

    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/webp"));
    let remaining = ((expires_at - now) / 1000).max(0);
    if let Ok(v) = HeaderValue::from_str(&format!("private, max-age={remaining}")) {
        h.insert(header::CACHE_CONTROL, v);
    }
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    tracing::debug!(path = REDACTED, remaining_secs = remaining, "media served");
    resp
}
