//! CIMD (Client ID Metadata Document) client registration
//! (spec_auth.md section 4-3): static client_id URL validation, document
//! fetch via safe_fetch with the `oauth_clients` cache, stale-if-error and
//! the redirect URI double allowlist.

use serde::Deserialize;
use serde_json::Value;
use sqlx::SqlitePool;

use super::net::{FetchClient, clamp_max_age};
use crate::config::ResolvedAuth;

/// Parsed / validated CIMD document.
#[derive(Debug, Clone)]
pub struct ClientRecord {
    pub client_id: String,
    pub client_name: Option<String>,
    pub redirect_uris: Vec<String>,
    pub auth_method: AuthMethod,
    pub jwks_uri: Option<String>,
    /// inline `jwks` document when the client embeds keys
    pub jwks_inline: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMethod {
    None,
    PrivateKeyJwt,
}

impl AuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::PrivateKeyJwt => "private_key_jwt",
        }
    }
}

/// Raw document shape for validation (unknown fields are ignored).
#[derive(Debug, Deserialize)]
struct RawCimd {
    client_id: String,
    client_name: Option<String>,
    redirect_uris: Option<Vec<String>>,
    token_endpoint_auth_method: Option<String>,
    jwks_uri: Option<String>,
    jwks: Option<Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// the client_id URL fails static validation
    #[error("invalid client_id URL")]
    InvalidClientId,
    /// fetch / cache / document validation failed entirely
    #[error("client metadata unavailable: {0}")]
    Unavailable(String),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

const CLIENT_ID_MAX_LEN: usize = 512;

/// Static client_id URL validation before any fetch (spec_auth.md 4-3):
/// https scheme (http loopback only with the dev switch), allowlisted host,
/// no port / userinfo / fragment / query, path other than `/` without dot
/// segments or `//`, and exact re-serialization.
pub fn validate_client_id_url(
    client_id: &str,
    cfg: &ResolvedAuth,
) -> Result<url::Url, ClientError> {
    let err = || ClientError::InvalidClientId;
    if client_id.len() > CLIENT_ID_MAX_LEN || client_id.chars().any(|c| c.is_control()) {
        return Err(err());
    }
    let url: url::Url = client_id.parse().map_err(|_| err())?;
    if url.as_str() != client_id {
        // non-canonical serialization (default port, uppercase escapes, ...)
        return Err(err());
    }
    let https_ok = url.scheme() == "https";
    let http_loopback = url.scheme() == "http"
        && cfg.oauth.dev.allow_insecure_loopback
        && (matches!(url.host(), Some(url::Host::Domain(d)) if d == "localhost")
            || matches!(url.host(), Some(url::Host::Ipv4(v)) if v.is_loopback()));
    if !https_ok && !http_loopback {
        return Err(err());
    }
    let host = url.host_str().ok_or_else(err)?;
    if !cfg.oauth.cimd_allowed_hosts.iter().any(|h| h == host) {
        return Err(err());
    }
    if url.port().is_some() {
        // an explicit port is rejected; the dev/test switch permits loopback
        // hosts (mock servers bind random ports).
        let loopback_port = cfg.oauth.dev.allow_insecure_loopback
            && (matches!(url.host(), Some(url::Host::Ipv4(v)) if v.is_loopback())
                || matches!(url.host(), Some(url::Host::Domain(d)) if d == "localhost"));
        if !loopback_port {
            return Err(err());
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(err());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(err());
    }
    let path = url.path();
    if path == "/" || path.is_empty() {
        return Err(err());
    }
    for seg in path.split('/') {
        if seg == "." || seg == ".." {
            return Err(err());
        }
        let lower = seg.to_ascii_lowercase();
        if lower.contains("%2e") {
            return Err(err());
        }
    }
    if path.contains("//") {
        return Err(err());
    }
    Ok(url)
}

/// Validate a fetched document (spec_auth.md 4-3). `raw_value` is the whole
/// JSON object (the typed view ignores unknown fields; the client_secret
/// scan needs the raw keys).
fn validate_document(
    raw: &RawCimd,
    raw_value: &Value,
    client_id: &str,
    cfg: &ResolvedAuth,
) -> Result<ClientRecord, ClientError> {
    if contains_client_secret(raw_value) {
        return Err(ClientError::Unavailable(
            "client_secret fields are not accepted".into(),
        ));
    }
    if raw.client_id != client_id {
        return Err(ClientError::Unavailable(
            "document client_id mismatch".into(),
        ));
    }
    if raw
        .client_name
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Err(ClientError::Unavailable("client_name missing".into()));
    }
    let Some(redirect_uris) = &raw.redirect_uris else {
        return Err(ClientError::Unavailable("redirect_uris missing".into()));
    };
    if redirect_uris.is_empty() {
        return Err(ClientError::Unavailable("redirect_uris empty".into()));
    }
    for uri in redirect_uris {
        let parsed: url::Url = uri
            .parse()
            .map_err(|_| ClientError::Unavailable("bad redirect_uri".into()))?;
        let https = parsed.scheme() == "https";
        let http_loopback = parsed.scheme() == "http"
            && cfg.oauth.dev.allow_insecure_loopback
            && (matches!(parsed.host(), Some(url::Host::Domain(d)) if d == "localhost")
                || matches!(parsed.host(), Some(url::Host::Ipv4(v)) if v.is_loopback()));
        if !https && !http_loopback {
            return Err(ClientError::Unavailable(
                "redirect_uri must be https".into(),
            ));
        }
    }
    let auth_method = match raw.token_endpoint_auth_method.as_deref() {
        None => AuthMethod::None,
        Some("none") => AuthMethod::None,
        Some("private_key_jwt") => AuthMethod::PrivateKeyJwt,
        Some(other) => {
            return Err(ClientError::Unavailable(format!(
                "unsupported token_endpoint_auth_method {other}"
            )));
        }
    };
    let mut jwks_inline = None;
    let mut jwks_uri = None;
    if auth_method == AuthMethod::PrivateKeyJwt {
        if let Some(uri) = &raw.jwks_uri {
            let parsed: url::Url = uri
                .parse()
                .map_err(|_| ClientError::Unavailable("bad jwks_uri".into()))?;
            let host = parsed.host_str().unwrap_or_default();
            if !cfg.oauth.cimd_allowed_hosts.iter().any(|h| h == host) {
                return Err(ClientError::Unavailable(
                    "jwks_uri host not allowlisted".into(),
                ));
            }
            let https = parsed.scheme() == "https";
            let http_loopback = parsed.scheme() == "http"
                && cfg.oauth.dev.allow_insecure_loopback
                && (matches!(parsed.host(), Some(url::Host::Domain(d)) if d == "localhost")
                    || matches!(parsed.host(), Some(url::Host::Ipv4(v)) if v.is_loopback()));
            if !https && !http_loopback {
                return Err(ClientError::Unavailable("jwks_uri must be https".into()));
            }
            jwks_uri = Some(uri.clone());
        } else if let Some(jwks) = &raw.jwks {
            if !jwks.is_object() || jwks.get("keys").and_then(Value::as_array).is_none() {
                return Err(ClientError::Unavailable("inline jwks has no keys".into()));
            }
            jwks_inline = Some(jwks.to_string());
        } else {
            return Err(ClientError::Unavailable(
                "private_key_jwt requires jwks_uri or jwks".into(),
            ));
        }
    }
    Ok(ClientRecord {
        client_id: client_id.to_string(),
        client_name: raw.client_name.clone(),
        redirect_uris: redirect_uris.clone(),
        auth_method,
        jwks_uri,
        jwks_inline,
    })
}

/// Row shape of `oauth_clients` minus the raw json blobs.
type ClientRow = (
    Option<String>, // client_name
    String,         // redirect_uris_json
    String,         // token_endpoint_auth_method
    Option<String>, // jwks_uri
    Option<String>, // etag
    i64,            // fetched_at
    i64,            // expires_at
);

fn row_into_record(row: ClientRow, client_id: &str) -> Result<ClientRecord, ClientError> {
    let (client_name, redirect_uris_json, method, jwks_uri, _etag, _fetched_at, _expires_at) = row;
    let redirect_uris: Vec<String> = serde_json::from_str(&redirect_uris_json)
        .map_err(|e| ClientError::Unavailable(e.to_string()))?;
    let auth_method = match method.as_str() {
        "none" => AuthMethod::None,
        "private_key_jwt" => AuthMethod::PrivateKeyJwt,
        other => {
            return Err(ClientError::Unavailable(format!(
                "cached auth method {other}"
            )));
        }
    };
    Ok(ClientRecord {
        client_id: client_id.to_string(),
        client_name,
        redirect_uris,
        auth_method,
        jwks_uri,
        jwks_inline: None,
    })
}

/// The client_id URL the JWKS cache row uses for inline `jwks` documents.
pub fn inline_jwks_cache_key(client_id: &str) -> String {
    format!("{client_id}#jwks")
}

/// Load the CIMD record for `client_id`, fetching and caching when expired
/// (stale-if-error for 24h past expiry, spec_auth.md 4-3).
pub async fn get_client(
    pool: &SqlitePool,
    fetch: &FetchClient,
    cfg: &ResolvedAuth,
    client_id: &str,
    now: i64,
) -> Result<ClientRecord, ClientError> {
    validate_client_id_url(client_id, cfg)?;
    let row: Option<ClientRow> = sqlx::query_as(
        "SELECT client_name, redirect_uris_json, token_endpoint_auth_method, jwks_uri,
                etag, fetched_at, expires_at
         FROM oauth_clients WHERE client_id = ?",
    )
    .bind(client_id)
    .fetch_optional(pool)
    .await
    .map_err(anyhow::Error::from)?;

    let fresh = row.as_ref().is_some_and(|r| r.6 > now);
    if fresh {
        return row_into_record(row.expect("checked fresh"), client_id);
    }

    // fetch (or refetch); etag enables a conditional GET
    let etag = row.as_ref().and_then(|r| r.4.clone());
    match fetch.fetch_json(client_id, etag.as_deref()).await {
        Ok(Some(fetched)) => {
            let raw: RawCimd = serde_json::from_slice(&fetched.body)
                .map_err(|e| ClientError::Unavailable(format!("document parse: {e}")))?;
            let raw_value: Value = serde_json::from_slice(&fetched.body)
                .map_err(|e| ClientError::Unavailable(format!("document parse: {e}")))?;
            let record = validate_document(&raw, &raw_value, client_id, cfg)?;
            let ttl_ms = clamp_max_age(fetched.max_age) * 1000;
            sqlx::query(
                "INSERT INTO oauth_clients (client_id, metadata_json, client_name,
                     redirect_uris_json, token_endpoint_auth_method, jwks_uri, etag,
                     fetched_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (client_id) DO UPDATE SET
                     metadata_json = excluded.metadata_json,
                     client_name = excluded.client_name,
                     redirect_uris_json = excluded.redirect_uris_json,
                     token_endpoint_auth_method = excluded.token_endpoint_auth_method,
                     jwks_uri = excluded.jwks_uri,
                     etag = excluded.etag,
                     fetched_at = excluded.fetched_at,
                     expires_at = excluded.expires_at",
            )
            .bind(client_id)
            .bind(String::from_utf8_lossy(&fetched.body).to_string())
            .bind(&record.client_name)
            .bind(serde_json::to_string(&record.redirect_uris).expect("serialize urls"))
            .bind(record.auth_method.as_str())
            .bind(&record.jwks_uri)
            .bind(&fetched.etag)
            .bind(now)
            .bind(now + ttl_ms)
            .execute(pool)
            .await
            .map_err(anyhow::Error::from)?;
            // persist an inline jwks document as a jwks cache row too
            if let Some(inline) = &record.jwks_inline {
                let key = inline_jwks_cache_key(client_id);
                sqlx::query(
                    "INSERT INTO oauth_jwks_cache (jwks_uri, jwks_json, etag, fetched_at, expires_at)
                     VALUES (?, ?, NULL, ?, ?)
                     ON CONFLICT (jwks_uri) DO UPDATE SET
                         jwks_json = excluded.jwks_json, fetched_at = excluded.fetched_at,
                         expires_at = excluded.expires_at",
                )
                .bind(&key)
                .bind(inline)
                .bind(now)
                .bind(now + ttl_ms)
                .execute(pool)
                .await
                .map_err(anyhow::Error::from)?;
            }
            Ok(record)
        }
        Ok(None) => {
            // 304: refresh the cache lifetime, keep the body
            if let Some(row) = row {
                let ttl_ms = clamp_max_age(None) * 1000;
                sqlx::query(
                    "UPDATE oauth_clients SET fetched_at = ?, expires_at = ? WHERE client_id = ?",
                )
                .bind(now)
                .bind(now + ttl_ms)
                .bind(client_id)
                .execute(pool)
                .await
                .map_err(anyhow::Error::from)?;
                return row_into_record(row, client_id);
            }
            Err(ClientError::Unavailable("304 without cache".into()))
        }
        Err(e) => {
            // stale-if-error: expires_at .. +24h
            if let Some(row) = row
                && row.6 + 24 * 86_400_000 > now
            {
                return row_into_record(row, client_id);
            }
            Err(ClientError::Unavailable(e.to_string()))
        }
    }
}

/// Whether a redirect URI passes both allowlists (CIMD document and config).
pub fn redirect_uri_allowed(record: &ClientRecord, uri: &str, cfg: &ResolvedAuth) -> bool {
    record.redirect_uris.iter().any(|u| u == uri)
        && cfg.oauth.redirect_uri_allowlist.iter().any(|u| u == uri)
}

/// The fetch error category for diagnostics (never leaks secrets).
pub fn is_fetch_error(e: &ClientError) -> bool {
    matches!(
        e,
        ClientError::Unavailable(m)
            if m.starts_with("fetch failed")
                || m.starts_with("redirect refused")
                || m.starts_with("response too large")
    )
}

/// Any `client_secret*` field in the raw document refuses the client
/// (spec_auth.md 4-3).
pub fn contains_client_secret(doc: &Value) -> bool {
    doc.as_object()
        .is_some_and(|o| o.keys().any(|k| k.starts_with("client_secret")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ResolvedAuth {
        crate::config::test_resolved_auth()
    }

    fn accept(client_id: &str) -> bool {
        validate_client_id_url(client_id, &cfg()).is_ok()
    }

    // [covers:auth-oauth.cimd-client-id-static-validation]
    #[test]
    fn client_id_static_validation() {
        assert!(accept("https://chatgpt.com/clients/abc"));
        assert!(accept(
            "https://chatgpt.com/.well-known/oauth-authorization-server"
        ));
        for bad in [
            "https://chatgpt.com/",         // path must not be "/"
            "https://chatgpt.com",          // no path
            "https://evil.chatgpt.com/c",   // subdomain
            "https://example.com/c",        // host not allowlisted
            "https://chatgpt.com:8443/c",   // explicit port
            "https://user@chatgpt.com/c",   // userinfo
            "https://chatgpt.com/c?x=1",    // query
            "https://chatgpt.com/c#f",      // fragment
            "https://chatgpt.com/c/../d",   // dot segment
            "https://chatgpt.com/c/./d",    // dot segment
            "https://chatgpt.com/%2e%2e/c", // encoded dot segment
            "https://chatgpt.com//c",       // empty segment
            "http://chatgpt.com/c",         // plain http
            "https://chatgpt.com/c ",       // trailing space (no reparse match)
            "HTTPS://chatgpt.com/c",        // uppercase scheme (non-canonical)
            "https://chatgpt.com/с",        // non-ascii (percent-encoded on reparse)
        ] {
            assert!(!accept(bad), "{bad:?} should be rejected");
        }
    }

    // [covers:auth-oauth.cimd-client-id-static-validation]
    #[test]
    fn client_id_dev_loopback_relaxation() {
        let mut c = cfg();
        c.oauth.dev.allow_insecure_loopback = true;
        c.oauth.cimd_allowed_hosts = vec!["127.0.0.1".into(), "localhost".into()];
        for ok in ["http://127.0.0.1:39123/cimd", "http://localhost:39123/cimd"] {
            assert!(
                validate_client_id_url(ok, &c).is_ok(),
                "{ok} should pass with the dev switch"
            );
        }
        // still strict about the host allowlist and other rules
        for bad in [
            "http://192.168.1.4:1/cimd",
            "http://chatgpt.com/c",
            "http://127.0.0.1:1/",
        ] {
            assert!(validate_client_id_url(bad, &c).is_err(), "{bad}");
        }
    }

    // [covers:auth-oauth.cimd-document-validation]
    #[test]
    fn document_validation() {
        let c = cfg();
        let doc = |json: &str| -> Result<ClientRecord, ClientError> {
            let raw: RawCimd = serde_json::from_str(json).unwrap();
            let value: Value = serde_json::from_str(json).unwrap();
            validate_document(&raw, &value, "https://chatgpt.com/clients/a", &c)
        };
        let ok = doc(
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"ChatGPT",
                "redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method":"private_key_jwt",
                "jwks_uri":"https://chatgpt.com/.well-known/jwks.json"}"#,
        )
        .expect("valid");
        assert_eq!(ok.auth_method, AuthMethod::PrivateKeyJwt);
        assert_eq!(
            ok.jwks_uri.as_deref(),
            Some("https://chatgpt.com/.well-known/jwks.json")
        );

        // default auth method is none
        let none_doc = doc(
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"ChatGPT",
                "redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}"#,
        )
        .expect("valid");
        assert_eq!(none_doc.auth_method, AuthMethod::None);
        assert!(none_doc.jwks_uri.is_none());

        // inline jwks is accepted
        let inline = doc(
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"ChatGPT",
                "redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],
                "token_endpoint_auth_method":"private_key_jwt","jwks":{"keys":[]}}"#,
        )
        .expect("valid");
        assert!(inline.jwks_inline.is_some());

        for bad in [
            // client_id mismatch
            r#"{"client_id":"https://chatgpt.com/other","client_name":"x","redirect_uris":["https://chatgpt.com/r"]}"#,
            // missing name
            r#"{"client_id":"https://chatgpt.com/clients/a","redirect_uris":["https://chatgpt.com/r"]}"#,
            // missing redirect_uris
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x"}"#,
            // empty redirect_uris
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":[]}"#,
            // http redirect_uri
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":["http://chatgpt.com/r"]}"#,
            // client_secret present
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":["https://chatgpt.com/r"],"client_secret":"s"}"#,
            // unsupported auth method
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":["https://chatgpt.com/r"],"token_endpoint_auth_method":"client_secret_basic"}"#,
            // private_key_jwt without keys
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":["https://chatgpt.com/r"],"token_endpoint_auth_method":"private_key_jwt"}"#,
            // jwks_uri on foreign host
            r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x","redirect_uris":["https://chatgpt.com/r"],"token_endpoint_auth_method":"private_key_jwt","jwks_uri":"https://keys.example.com/jwks"}"#,
        ] {
            assert!(doc(bad).is_err(), "{bad} should be rejected");
        }
    }

    // [covers:auth-oauth.cimd-document-validation]
    #[test]
    fn client_secret_fields_rejected() {
        // any client_secret* key is refused (serde: capture unknown fields)
        let json = r#"{"client_id":"https://chatgpt.com/clients/a","client_name":"x",
            "redirect_uris":["https://chatgpt.com/r"],"token_endpoint_auth_method":"none",
            "client_secret_expires_at":0}"#;
        let value: Value = serde_json::from_str(json).unwrap();
        let has_secret = value
            .as_object()
            .unwrap()
            .keys()
            .any(|k| k.starts_with("client_secret"));
        assert!(has_secret);
        // enforced by scanning the raw object in validate_document callers;
        // here we assert the detection helper sees it
        assert!(contains_client_secret(&value));
    }

    #[test]
    fn contains_client_secret_detection() {
        let v: Value = serde_json::from_str(r#"{"a":1}"#).unwrap();
        assert!(!contains_client_secret(&v));
    }
}
