//! Static frontend serving and the SPA fallback (TASK-11 integration 7).
//! The built SPA (`frontend/dist/web.html` + `assets/`) is served by the
//! backend; every HTML response carries the clickjacking guard
//! (spec_auth.md 4-6: `Content-Security-Policy: frame-ancestors 'none'` +
//! `X-Frame-Options: DENY`) — the login and consent screens are routes of
//! this SPA. The widget entry (`widget.html`) is served through the MCP
//! widget resource, not from here.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::Router;
use axum::extract::{Path as AxumPath, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde_json::json;

/// Paths the API owns; the SPA fallback never answers under these.
const RESERVED_PREFIXES: &[&str] = &[
    "/api",
    "/oauth",
    "/.well-known",
    "/mcp",
    "/media",
    "/healthz",
];

/// The SPA entry inside the static root (Vite multi-entry build output).
const INDEX_FILE: &str = "web.html";

#[derive(Clone)]
struct StaticState {
    root: PathBuf,
}

/// `/` and `/index.html` (+ hashed `/assets/*`) from the static root.
/// `/oauth/consent` is the consent screen (a SPA route the authorization
/// endpoint redirects to, spec_auth.md 4-2); it lives under the reserved
/// `/oauth` prefix, so it is routed explicitly instead of via the fallback.
pub fn routes(root: PathBuf) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/oauth/consent", get(index))
        .route("/favicon.svg", get(favicon))
        .route("/assets/{*path}", get(asset))
        .with_state(StaticState { root })
}

/// SPA fallback for client-side routes: reserved API prefixes get a plain
/// 404, anything else gets the index page. Plain `root` argument so the app
/// router can install it as a closure-based fallback.
pub async fn spa_fallback(root: PathBuf, req: Request) -> Response {
    let path = req.uri().path();
    if RESERVED_PREFIXES.iter().any(|p| {
        path == p.trim_end_matches('/')
            || path.starts_with(&format!("{}/", p.trim_end_matches('/')))
    }) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not_found" }))).into_response();
    }
    match read_file(&root, INDEX_FILE).await {
        Ok((bytes, ctype)) => html_response(bytes, ctype),
        Err(_) => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
    }
}

async fn index(State(st): State<StaticState>) -> Response {
    match read_file(&st.root, INDEX_FILE).await {
        Ok((bytes, ctype)) => html_response(bytes, ctype),
        Err(_) => (StatusCode::NOT_FOUND, "frontend not built").into_response(),
    }
}

/// `/favicon.svg` from the static root (TASK-16). Unlike hashed assets its
/// name carries no content hash, so it is revalidated (no immutable cache);
/// it is an SVG document, not HTML, so the clickjacking guard does not apply.
async fn favicon(State(st): State<StaticState>) -> Response {
    match read_file(&st.root, "favicon.svg").await {
        Ok((bytes, ctype)) => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(ctype).expect("ascii content type"),
                ),
                (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn asset(State(st): State<StaticState>, AxumPath(path): AxumPath<String>) -> Response {
    // path-safety: the extractor already rejects "..", belt and suspenders
    if path
        .split('/')
        .any(|seg| seg == ".." || seg == "." || seg.is_empty())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    match read_file(&st.root.join("assets"), &path).await {
        // Vite asset names are content-hashed: immutable caching is safe.
        Ok((bytes, ctype)) => (
            StatusCode::OK,
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(ctype).expect("ascii content type"),
                ),
                (
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                ),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// HTML with the clickjacking guard (spec_auth.md 4-6) and no-cache (the
/// SPA shell must be revalidated; hashed assets carry the long cache).
fn html_response(bytes: Vec<u8>, content_type: &str) -> Response {
    (
        StatusCode::OK,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_str(content_type).expect("ascii content type"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("frame-ancestors 'none'"),
            ),
            (header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY")),
        ],
        bytes,
    )
        .into_response()
}

/// Read one file under `dir`, classifying the content type by extension.
/// Missing file / traversal attempts are `Err`.
async fn read_file(dir: &Path, name: &str) -> std::io::Result<(Vec<u8>, &'static str)> {
    let path = dir.join(name);
    // the joined path must stay inside dir (symlink-free project layout)
    if !path.starts_with(dir) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path escapes the static root",
        ));
    }
    let bytes = tokio::fs::read(&path).await?;
    Ok((bytes, content_type(name)))
}

fn content_type(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
