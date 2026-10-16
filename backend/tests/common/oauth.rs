//! Shared helpers for the TASK-10 Phase B tests: a local CIMD / JWKS mock
//! server (plain HTTP on loopback, allowed via `[auth.oauth.dev]`), an RSA
//! client-assertion signer, PKCE helpers, direct DB grant/token fixtures and
//! a full authorize->consent->decision->token flow runner.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use budget_book::app::{self, AppState};
use budget_book::auth::session::now_ms;
use budget_book::auth::tokens::{TOKEN_LEN, b64url_encode, random_token, sha256};
use budget_book::config::Config;
use budget_book::db;
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use serde_json::json;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;
use url::Url;

use super::auth::Client;

// ---------------------------------------------------------------------------
// RSA signer (one key per test binary)

pub struct TestRsa {
    pub encoding: EncodingKey,
    n: Vec<u8>,
    e: Vec<u8>,
}

pub fn test_rsa() -> &'static TestRsa {
    static KEY: OnceLock<TestRsa> = OnceLock::new();
    KEY.get_or_init(|| {
        let mut rng = rsa::rand_core::OsRng;
        use rsa::traits::PublicKeyParts;
        let private = rsa::RsaPrivateKey::new(&mut rng, 2048).expect("rsa keygen");
        use rsa::pkcs1::EncodeRsaPrivateKey;
        // jsonwebtoken's from_rsa_der wants the PKCS#1 RSAPrivateKey DER
        let der = private.to_pkcs1_der().expect("pkcs1 der");
        TestRsa {
            encoding: EncodingKey::from_rsa_der(der.as_bytes()),
            n: private.n().to_bytes_be(),
            e: private.e().to_bytes_be(),
        }
    })
}

/// The JWKS document exposed by the mock (single RSA key, given kid).
pub fn jwks_json(kid: &str) -> String {
    jwks_json_multi(&[kid])
}

/// Kid of the ES256 (P-256) key always present in the mock JWKS.
pub const EC_KID: &str = "ec1";
/// Kid of an EC key published with an RSA `alg` (kty / alg mismatch).
pub const MISMATCH_KID: &str = "ec-claims-rs256";

/// JWKS with one RSA entry per kid (same key material: rotation overlap),
/// the ES256 key, and a deliberately inconsistent entry (EC key labelled
/// alg RS256) that must never be used.
pub fn jwks_json_multi(rsa_kids: &[&str]) -> String {
    let rsa = test_rsa();
    let ec = test_ec();
    let mut keys: Vec<serde_json::Value> = rsa_kids
        .iter()
        .map(|kid| {
            json!({
                "kty": "RSA",
                "use": "sig",
                "alg": "RS256",
                "kid": kid,
                "n": b64url_encode(&rsa.n),
                "e": b64url_encode(&rsa.e),
            })
        })
        .collect();
    keys.push(json!({
        "kty": "EC",
        "crv": "P-256",
        "use": "sig",
        "alg": "ES256",
        "kid": EC_KID,
        "x": b64url_encode(&ec.x),
        "y": b64url_encode(&ec.y),
    }));
    keys.push(json!({
        "kty": "EC",
        "crv": "P-256",
        "use": "sig",
        "alg": "RS256",
        "kid": MISMATCH_KID,
        "x": b64url_encode(&ec.x),
        "y": b64url_encode(&ec.y),
    }));
    json!({ "keys": keys }).to_string()
}

/// ES256 (P-256) signer for client assertions.
pub struct TestEc {
    pub encoding: EncodingKey,
    x: Vec<u8>,
    y: Vec<u8>,
}

pub fn test_ec() -> &'static TestEc {
    static KEY: OnceLock<TestEc> = OnceLock::new();
    KEY.get_or_init(|| {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        use p256::pkcs8::EncodePrivateKey;
        let secret = p256::SecretKey::random(&mut rsa::rand_core::OsRng);
        let der = secret.to_pkcs8_der().expect("pkcs8 der");
        let point = secret.public_key().to_encoded_point(false);
        TestEc {
            encoding: EncodingKey::from_ec_der(der.as_bytes()),
            x: point.x().expect("x").to_vec(),
            y: point.y().expect("y").to_vec(),
        }
    })
}

/// Build a client assertion signed with the given alg (RS256 uses the RSA
/// key, ES256 the P-256 key), for kid / kty mismatch tests.
pub fn make_assertion_alg(
    alg: Algorithm,
    client_id: &str,
    issuer: &str,
    kid: &str,
    jti: &str,
) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let claims = json!({
        "iss": client_id, "sub": client_id, "aud": issuer,
        "exp": now + 300, "iat": now, "jti": jti,
    });
    let mut header = Header::new(alg);
    header.kid = Some(kid.to_string());
    let key = match alg {
        Algorithm::ES256 => &test_ec().encoding,
        _ => &test_rsa().encoding,
    };
    encode(&header, &claims, key).unwrap()
}

/// Build a client assertion (RS256). Overrides replace claim values.
#[allow(clippy::too_many_arguments)]
pub fn make_assertion(
    client_id: &str,
    issuer: &str,
    kid: Option<&str>,
    jti: &str,
    overrides: &[(&str, serde_json::Value)],
) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let mut claims = json!({
        "iss": client_id,
        "sub": client_id,
        "aud": issuer,
        "exp": now + 300,
        "iat": now,
        "jti": jti,
    });
    for (k, v) in overrides {
        // a JSON null override removes the claim entirely
        if v.is_null() {
            claims.as_object_mut().unwrap().remove(*k);
        } else {
            claims[*k] = v.clone();
        }
    }
    let mut header = Header::new(Algorithm::RS256);
    header.kid = kid.map(str::to_string);
    encode(&header, &claims, &test_rsa().encoding).unwrap()
}

/// Corrupt a signed assertion's signature (signature-verification failure).
pub fn tamper_signature(assertion: &str) -> String {
    let mut parts: Vec<String> = assertion.split('.').map(str::to_string).collect();
    let sig = parts.pop().unwrap();
    let mut bytes: Vec<char> = sig.chars().collect();
    let last = bytes.pop().unwrap();
    bytes.push(if last == 'A' { 'B' } else { 'A' });
    parts.push(bytes.into_iter().collect());
    parts.join(".")
}

// ---------------------------------------------------------------------------
// PKCE

/// A valid (verifier, S256 challenge) pair.
pub fn pkce_pair() -> (String, String) {
    let verifier = b64url_encode(&random_token());
    let challenge = b64url_encode(&sha256(verifier.as_bytes()));
    (verifier, challenge)
}

/// A random unique string (fresh jti values).
pub fn b64url_of_random() -> String {
    b64url_encode(&random_token())
}

// ---------------------------------------------------------------------------
// mock CIMD / JWKS server

#[derive(Debug, Clone, PartialEq)]
pub enum MockMode {
    Normal,
    /// 302 redirect (safe_fetch must refuse)
    Redirect,
    /// body over 64 KiB
    Oversize,
    /// HTTP 500
    Error,
}

#[derive(Debug)]
pub struct MockState {
    pub cimd_fetches: usize,
    pub jwks_fetches: usize,
    pub mode: MockMode,
    /// `token_endpoint_auth_method` in the served document (None omits it).
    pub auth_method: Option<&'static str>,
    pub jwks_kid: String,
    /// additional RSA kids published next to `jwks_kid` (rotation overlap)
    pub extra_kids: Vec<String>,
    pub max_age: u64,
    pub etag: String,
}

pub struct MockIds {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<MockState>>,
    pub client_id: String,
    pub jwks_uri: String,
    pub redirect_uri: String,
}

impl MockIds {
    pub fn cimd_fetches(&self) -> usize {
        self.state.lock().unwrap().cimd_fetches
    }
    pub fn jwks_fetches(&self) -> usize {
        self.state.lock().unwrap().jwks_fetches
    }
    pub fn set_mode(&self, mode: MockMode) {
        self.state.lock().unwrap().mode = mode;
    }
    pub fn set_auth_method(&self, method: Option<&'static str>) {
        self.state.lock().unwrap().auth_method = method;
    }
    /// Publish additional RSA kids alongside the current one.
    pub fn set_extra_kids(&self, kids: &[&str]) {
        self.state.lock().unwrap().extra_kids = kids.iter().map(|k| k.to_string()).collect();
    }
    pub fn rotate_kid(&self, kid: &str) {
        self.state.lock().unwrap().jwks_kid = kid.to_string();
    }
}

async fn cimd_handler(State(state): State<Arc<Mutex<MockState>>>, req: Request) -> Response {
    {
        let mut s = state.lock().unwrap();
        s.cimd_fetches += 1;
    }
    let s = state.lock().unwrap();
    match s.mode {
        MockMode::Redirect => {
            return (
                [(header::LOCATION, "https://example.com/elsewhere")],
                StatusCode::SEE_OTHER,
            )
                .into_response();
        }
        MockMode::Error => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        _ => {}
    }
    let addr_host = "127.0.0.1"; // the mock always listens on loopback
    let mut doc = json!({
        "client_id": format!("http://{addr_host}:{}/cimd", port_of(&req)),
        "client_name": "ChatGPT Test Client",
        "redirect_uris": [format!("http://{addr_host}:{}/cb", port_of(&req))],
    });
    if let Some(method) = s.auth_method {
        doc["token_endpoint_auth_method"] = json!(method);
        doc["jwks_uri"] = json!(format!("http://{addr_host}:{}/jwks", port_of(&req)));
    }
    let etag = format!("\"{}\"", s.etag);
    if req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag),
                (header::CACHE_CONTROL, format!("max-age={}", s.max_age)),
            ],
        )
            .into_response();
    }
    (
        StatusCode::OK,
        [
            (header::ETAG, etag),
            (header::CACHE_CONTROL, format!("max-age={}", s.max_age)),
        ],
        axum::Json(doc),
    )
        .into_response()
}

fn port_of(req: &Request) -> u16 {
    req.headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.rsplit(':').next())
        .and_then(|p| p.parse().ok())
        .unwrap_or(0)
}

async fn jwks_handler(State(state): State<Arc<Mutex<MockState>>>, req: Request) -> Response {
    {
        let mut s = state.lock().unwrap();
        s.jwks_fetches += 1;
    }
    let s = state.lock().unwrap();
    if s.mode == MockMode::Redirect {
        return (
            [(header::LOCATION, "https://example.com/elsewhere")],
            StatusCode::SEE_OTHER,
        )
            .into_response();
    }
    let etag = format!("\"jwks-{}\"", s.jwks_kid);
    if req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    (
        StatusCode::OK,
        [
            (header::ETAG, etag),
            (header::CACHE_CONTROL, "max-age=300".to_string()),
        ],
        {
            let mut kids: Vec<&str> = vec![s.jwks_kid.as_str()];
            kids.extend(s.extra_kids.iter().map(String::as_str));
            jwks_json_multi(&kids)
        },
    )
        .into_response()
}

async fn huge_handler() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        "x".repeat(100 * 1024),
    )
        .into_response()
}

/// Spawn the mock server; returns its address and shared state.
pub async fn spawn_mock() -> MockIds {
    let state = Arc::new(Mutex::new(MockState {
        cimd_fetches: 0,
        jwks_fetches: 0,
        mode: MockMode::Normal,
        auth_method: Some("private_key_jwt"),
        jwks_kid: "k1".into(),
        extra_kids: Vec::new(),
        max_age: 300,
        etag: "v1".into(),
    }));
    let router = Router::new()
        .route("/cimd", axum::routing::get(cimd_handler))
        .route("/jwks", axum::routing::get(jwks_handler))
        .route("/huge", axum::routing::get(huge_handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    MockIds {
        client_id: format!("http://{addr}/cimd"),
        jwks_uri: format!("http://{addr}/jwks"),
        redirect_uri: format!("http://{addr}/cb"),
        addr,
        state,
    }
}

// ---------------------------------------------------------------------------
// config / router setup

/// Repo config adjusted for the mock server: loopback http CIMD allowed,
/// the mock callback registered, generous rate limits for flow tests.
pub fn oauth_config(mock: &MockIds, limiter_override: Option<&dyn Fn(&mut Config)>) -> Config {
    let mut cfg = super::repo_config();
    cfg.auth.oauth.cimd_allowed_hosts = vec!["127.0.0.1".into()];
    cfg.auth.oauth.redirect_uri_allowlist = vec![mock.redirect_uri.clone()];
    cfg.auth.oauth.dev.allow_insecure_loopback = true;
    cfg.auth.rate_limit.webauthn_per_minute = 10_000;
    cfg.auth.rate_limit.token_accept_per_minute = 10_000;
    cfg.auth.rate_limit.authorize_per_minute = 10_000;
    cfg.auth.rate_limit.token_endpoint_per_minute = 10_000;
    cfg.auth.rate_limit.mcp_per_minute = 10_000;
    if let Some(f) = limiter_override {
        f(&mut cfg);
    }
    cfg
}

/// Like [`oauth_setup`] over a temp SQLite FILE with the repo pool size
/// (max_connections = 5), so concurrent requests contend for the write lock.
/// Keep the TempDir alive for the pool's lifetime.
pub async fn oauth_setup_file(mock: &MockIds) -> (Router, SqlitePool, Config, tempfile::TempDir) {
    let cfg = oauth_config(mock, None);
    let dir = tempfile::tempdir().expect("tempdir");
    let pool = db::connect_file(&dir.path().join("oauth-race.sqlite"), &cfg.app.database)
        .await
        .expect("file db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, cfg, dir)
}

pub async fn oauth_setup(mock: &MockIds) -> (Router, SqlitePool, Config) {
    let cfg = oauth_config(mock, None);
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, cfg)
}

// ---------------------------------------------------------------------------
// raw request helpers (form posts / arbitrary headers / no cookies)

pub async fn post_form(
    router: &Router,
    path: &str,
    form: &str,
    headers: &[(&'static str, String)],
) -> Response<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/x-www-form-urlencoded");
    for (k, v) in headers {
        builder = builder.header(*k, v.as_str());
    }
    router
        .clone()
        .oneshot(builder.body(Body::from(form.to_string())).unwrap())
        .await
        .unwrap()
}

pub async fn get(
    router: &Router,
    path: &str,
    headers: &[(&'static str, String)],
) -> Response<Body> {
    let mut builder = Request::builder().method("GET").uri(path);
    for (k, v) in headers {
        builder = builder.header(*k, v.as_str());
    }
    router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

pub async fn post_json_raw(
    router: &Router,
    path: &str,
    body: String,
    headers: &[(&'static str, String)],
) -> Response<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        builder = builder.header(*k, v.as_str());
    }
    router
        .clone()
        .oneshot(builder.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}

pub async fn put_json(
    router: &Router,
    path: &str,
    body: serde_json::Value,
    headers: &[(&'static str, String)],
) -> Response<Body> {
    let mut builder = Request::builder()
        .method("PUT")
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        builder = builder.header(*k, v.as_str());
    }
    router
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

pub async fn delete(
    router: &Router,
    path: &str,
    headers: &[(&'static str, String)],
) -> Response<Body> {
    let mut builder = Request::builder().method("DELETE").uri(path);
    for (k, v) in headers {
        builder = builder.header(*k, v.as_str());
    }
    router
        .clone()
        .oneshot(builder.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

pub async fn body_json(resp: Response<Body>) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

pub async fn body_text(resp: Response<Body>) -> String {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    String::from_utf8(bytes.to_vec()).unwrap()
}

// ---------------------------------------------------------------------------
// DB fixtures for grants / tokens

pub async fn insert_grant(
    pool: &SqlitePool,
    user_id: i64,
    client_id: &str,
    scope: &str,
    active_ledger_id: Option<i64>,
) -> i64 {
    let now = now_ms();
    // ensure the client row exists (FK target)
    sqlx::query(
        "INSERT OR IGNORE INTO oauth_clients (client_id, metadata_json, redirect_uris_json,
             token_endpoint_auth_method, fetched_at, expires_at)
         VALUES (?, '{}', '[]', 'none', ?, ?)",
    )
    .bind(client_id)
    .bind(now)
    .bind(now + 3_600_000)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id,
             created_at, absolute_expires_at)
         VALUES (?, ?, ?, 'http://localhost:40281/mcp', ?, ?, ?) RETURNING id",
    )
    .bind(user_id)
    .bind(client_id)
    .bind(scope)
    .bind(active_ledger_id)
    .bind(now)
    .bind(now + 90 * 86_400_000)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Insert an access token row; returns the plaintext b64url token.
pub async fn insert_access_token(pool: &SqlitePool, grant_id: i64) -> String {
    let token = random_token();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO oauth_access_tokens (token_hash, grant_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(sha256(&token).to_vec())
    .bind(grant_id)
    .bind(now)
    .bind(now + 3_600_000)
    .execute(pool)
    .await
    .unwrap();
    b64url_encode(&token)
}

/// Insert a refresh token row; returns the plaintext b64url token.
pub async fn insert_refresh_token(
    pool: &SqlitePool,
    grant_id: i64,
    used_at: Option<i64>,
    child_hash: Option<Vec<u8>>,
) -> String {
    let token = random_token();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, used_at, child_hash,
             created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256(&token).to_vec())
    .bind(grant_id)
    .bind(used_at)
    .bind(&child_hash)
    .bind(now)
    .bind(now + 30 * 86_400_000)
    .execute(pool)
    .await
    .unwrap();
    b64url_encode(&token)
}

/// The hash of a plaintext token string (to look rows up in tests).
pub fn token_hash(token: &str) -> Vec<u8> {
    let raw: [u8; TOKEN_LEN] = b64url(token);
    sha256(&raw).to_vec()
}

fn b64url(s: &str) -> [u8; TOKEN_LEN] {
    budget_book::auth::tokens::b64url_decode(s)
        .and_then(|b| b.try_into().ok())
        .expect("token b64url")
}

// ---------------------------------------------------------------------------
// full flow runner

pub struct FlowResult {
    pub access_token: String,
    pub refresh_token: String,
    pub scope: String,
    pub grant_id: i64,
    pub code: String,
}

/// Run authorize -> consent view -> decision allow -> code exchange for a
/// logged-in `client` (its cookies are the session). Uses a fresh PKCE pair
/// and a valid client assertion against the mock JWKS.
pub async fn run_full_flow(
    router: &Router,
    pool: &SqlitePool,
    client: &Client,
    mock: &MockIds,
    issuer: &str,
    scope: Option<&str>,
) -> FlowResult {
    let (verifier, challenge) = pkce_pair();
    let req_id = authorize(router, client, mock, &challenge, scope, None).await;
    // consent info binds the request to the session user
    let resp = client
        .get(router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200, "consent info failed");
    // decision
    let resp = client
        .post(
            router,
            "/oauth/authorize/decision",
            json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "decision failed");
    let body = body_json(resp).await;
    let redirect_to = body["redirect_to"].as_str().unwrap().to_string();
    let code = extract_query_param(&redirect_to, "code").expect("code in redirect_to");
    // exchange (fresh jti: single use per assertion)
    let jti = b64url_encode(&random_token());
    let assertion = make_assertion(&mock.client_id, issuer, Some("k1"), &jti, &[]);
    let mut form = format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_assertion={assertion}&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer",
        mock.redirect_uri
    );
    if let Some(s) = scope {
        form.push_str(&format!("&scope={}", s.replace(' ', "%20")));
    }
    let resp = post_form(router, "/oauth/token", &form, &[]).await;
    if resp.status() != 200 {
        let status = resp.status();
        panic!("token exchange failed: {status} {}", body_text(resp).await);
    }
    let body = body_json(resp).await;
    let access_token = body["access_token"].as_str().unwrap().to_string();
    let refresh_token = body["refresh_token"].as_str().unwrap().to_string();
    let scope_out = body["scope"].as_str().unwrap().to_string();
    let grant_id: i64 = sqlx::query_scalar(
        "SELECT g.id FROM oauth_grants g JOIN oauth_access_tokens t ON t.grant_id = g.id
         WHERE t.token_hash = ?",
    )
    .bind(token_hash(&access_token))
    .fetch_one(pool)
    .await
    .unwrap();
    FlowResult {
        access_token,
        refresh_token,
        scope: scope_out,
        grant_id,
        code,
    }
}

/// GET /oauth/authorize with the session cookies in `client`; returns the
/// plaintext request id (R) extracted from the redirect Location.
pub async fn authorize(
    router: &Router,
    client: &Client,
    mock: &MockIds,
    code_challenge: &str,
    scope: Option<&str>,
    state: Option<&str>,
) -> String {
    let mut query = format!(
        "response_type=code&client_id={}&redirect_uri={}&code_challenge={code_challenge}&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A40281%2Fmcp",
        urlencode(&mock.client_id),
        urlencode(&mock.redirect_uri)
    );
    if let Some(s) = scope {
        query.push_str(&format!("&scope={}", urlencode(s)));
    }
    if let Some(st) = state {
        query.push_str(&format!("&state={}", urlencode(st)));
    }
    let resp = client
        .get(router, &format!("/oauth/authorize?{query}"))
        .await;
    assert_eq!(resp.status(), 302, "authorize not a redirect");
    let location = resp
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .expect("Location header")
        .to_string();
    assert!(
        location.starts_with("/oauth/consent?req=") || location.starts_with("/login?req="),
        "unexpected authorize redirect: {location}"
    );
    location
        .split("req=")
        .nth(1)
        .expect("req param")
        .split('&')
        .next()
        .unwrap()
        .to_string()
}

pub fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn extract_query_param(url: &str, key: &str) -> Option<String> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

/// HeaderValue helper for dynamic header values in tests.
pub fn hv(s: &str) -> HeaderValue {
    s.parse().unwrap()
}

/// A URL type alias import guard (Url is used by softpasskey helpers).
#[allow(dead_code)]
fn _url_used(u: Option<Url>) -> Option<Url> {
    u
}
