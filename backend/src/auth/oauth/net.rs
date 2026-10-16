//! Outbound HTTP for CIMD / JWKS retrieval (spec_auth.md section 4-3):
//! rustls, no redirects, 3s connect / 5s total timeout, 64 KiB streaming body
//! cap, `Accept: application/json`, conditional GET via `If-None-Match`, and
//! a refusal to connect to private / loopback / link-local / CGNAT / ULA
//! addresses (unless the dev/test loopback switch is on).

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::http::HeaderValue;

/// Body size cap for fetched documents (64 KiB).
pub const MAX_BODY_BYTES: usize = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(5);

/// A fetched document: body plus cache directives.
pub struct Fetched {
    pub body: Vec<u8>,
    pub etag: Option<String>,
    /// `Cache-Control: max-age` seconds when cacheable, else None.
    pub max_age: Option<u64>,
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("fetch failed: {0}")]
    Transport(String),
    #[error("fetch target host is not allowed ({0})")]
    ForbiddenHost(String),
    #[error("redirect refused")]
    Redirect,
    #[error("response too large")]
    TooLarge,
}

/// Shared reqwest client with the safe_fetch transport guarantees.
#[derive(Clone)]
pub struct FetchClient {
    http: reqwest::Client,
    allow_private: bool,
}

/// DNS resolver that refuses to return private addresses (spec_auth.md 4-3:
/// resolved loopback / private / link-local / CGNAT / ULA never connect).
#[derive(Clone, Default)]
struct SafeResolver {
    allow_private: bool,
}

impl reqwest::dns::Resolve for SafeResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        let allow = self.allow_private;
        Box::pin(async move {
            let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| {
                    Box::new(std::io::Error::other(e.to_string()))
                        as Box<dyn std::error::Error + Send + Sync>
                })?
                .collect();
            let filtered: Vec<std::net::SocketAddr> = addrs
                .into_iter()
                .filter(|a| allow || !is_forbidden_ip(a.ip()))
                .collect();
            if filtered.is_empty() {
                return Err("no permitted address for host".into());
            }
            Ok(Box::new(filtered.into_iter())
                as Box<dyn Iterator<Item = std::net::SocketAddr> + Send>)
        })
    }
}

/// Private / loopback / link-local / CGNAT / ULA check (spec_auth.md 4-3).
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // 100.64.0.0/10 CGNAT
                || matches!(v4.octets(), [100, 64..=127, _, _])
        }
        IpAddr::V6(v6) => {
            // IPv4-mapped (::ffff:a.b.c.d) addresses are judged as IPv4
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_forbidden_ip(IpAddr::V4(v4));
            }
            v6.is_loopback() || v6.is_unspecified() || {
                let seg = v6.segments();
                // fc00::/7 ULA and fe80::/10 link-local
                (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80
            }
        }
    }
}

impl FetchClient {
    /// Build the client. `allow_private` is the dev/test loopback switch from
    /// `[auth.oauth.dev]`.
    pub fn new(allow_private: bool) -> Self {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .no_proxy()
            .dns_resolver(Arc::new(SafeResolver { allow_private }));
        if allow_private {
            builder = builder.danger_accept_invalid_certs(true);
        }
        Self {
            http: builder.build().expect("reqwest client builds"),
            allow_private,
        }
    }

    pub fn allows_private(&self) -> bool {
        self.allow_private
    }

    /// Reject URL hosts we never connect to: IP literals that are private,
    /// and non-https schemes unless the loopback dev switch is on.
    pub fn check_url(&self, url: &url::Url) -> Result<(), FetchError> {
        let host = url.host_str().unwrap_or_default().to_string();
        match url.scheme() {
            "https" => {}
            "http" => {
                let loopback = matches!(url.host(), Some(url::Host::Domain(d)) if d == "localhost")
                    || matches!(url.host(), Some(url::Host::Ipv4(v)) if v.is_loopback())
                    || matches!(url.host(), Some(url::Host::Ipv6(v)) if v.is_loopback());
                if !(self.allow_private && loopback) {
                    return Err(FetchError::ForbiddenHost(host));
                }
            }
            _ => return Err(FetchError::ForbiddenHost(host)),
        }
        if let Some(ip) = url.host().and_then(|h| match h {
            url::Host::Ipv4(v) => Some(IpAddr::V4(v)),
            url::Host::Ipv6(v) => Some(IpAddr::V6(v)),
            _ => None,
        }) && !self.allow_private
            && is_forbidden_ip(ip)
        {
            return Err(FetchError::ForbiddenHost(host));
        }
        Ok(())
    }

    /// GET a JSON document with the safe_fetch rules. Redirects are an error,
    /// bodies over 64 KiB are cut off as an error, and a 304 with
    /// `If-None-Match` is reported as `None` body.
    pub async fn fetch_json(
        &self,
        url: &str,
        if_none_match: Option<&str>,
    ) -> Result<Option<Fetched>, FetchError> {
        let parsed: url::Url = url
            .parse()
            .map_err(|_| FetchError::ForbiddenHost(url.to_string()))?;
        self.check_url(&parsed)?;
        let mut req = self.http.get(parsed).header(
            reqwest::header::ACCEPT,
            HeaderValue::from_static("application/json"),
        );
        if let Some(etag) = if_none_match {
            req = req.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        if resp.status().is_redirection() {
            return Err(FetchError::Redirect);
        }
        if !resp.status().is_success() {
            return Err(FetchError::Transport(format!("HTTP {}", resp.status())));
        }
        // stream the body with the size cap
        if let Some(len) = resp.content_length()
            && len as usize > MAX_BODY_BYTES
        {
            return Err(FetchError::TooLarge);
        }
        let etag = resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let cache_control = resp
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let max_age = cache_control.as_deref().and_then(parse_max_age);
        let mut resp = resp;
        let mut body: Vec<u8> = Vec::with_capacity(1024.min(MAX_BODY_BYTES));
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| FetchError::Transport(e.to_string()))?
        {
            if body.len() + chunk.len() > MAX_BODY_BYTES {
                return Err(FetchError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Some(Fetched {
            body,
            etag,
            max_age,
        }))
    }
}

/// `Cache-Control` max-age in seconds; `no-store` (or absence) yields None
/// (callers apply their default). Negative or absurd values are rejected by
/// the clamp on the caller side.
pub fn parse_max_age(cache_control: &str) -> Option<u64> {
    for directive in cache_control.split(',') {
        let directive = directive.trim();
        if directive.eq_ignore_ascii_case("no-store") {
            return None;
        }
        if let Some(value) = directive
            .strip_prefix("max-age=")
            .or_else(|| directive.strip_prefix("Max-Age="))
        {
            return value.trim().parse::<u64>().ok();
        }
    }
    None
}

/// clamp(max_age, 5min, 24h); None -> 5min (spec_auth.md section 4-3).
pub fn clamp_max_age(max_age: Option<u64>) -> i64 {
    const MIN: u64 = 300;
    const MAX: u64 = 86_400;
    match max_age {
        Some(v) => v.clamp(MIN, MAX) as i64,
        None => MIN as i64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:auth-oauth.cache-control-parsing]
    #[test]
    fn max_age_parsing_and_clamp() {
        assert_eq!(parse_max_age("public, max-age=1200"), Some(1200));
        assert_eq!(parse_max_age("max-age=0"), Some(0));
        assert_eq!(parse_max_age("no-store"), None);
        assert_eq!(parse_max_age("no-cache"), None);
        assert_eq!(parse_max_age(""), None);
        assert_eq!(parse_max_age("max-age=abc"), None);
        assert_eq!(clamp_max_age(Some(1200)), 1200);
        assert_eq!(clamp_max_age(Some(10)), 300); // below minimum
        assert_eq!(clamp_max_age(Some(1_000_000)), 86_400); // above maximum
        assert_eq!(clamp_max_age(None), 300); // default 5 minutes
    }

    // [covers:auth-oauth.private-ip-classification]
    #[test]
    fn forbidden_ip_classification() {
        for ok in [
            "8.8.8.8",
            "1.1.1.1",
            "::ffff:8.8.8.8",
            "2001:4860:4860::8888",
        ] {
            assert!(!is_forbidden_ip(ok.parse().unwrap()), "{ok}");
        }
        for bad in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:192.168.1.1",
            "::ffff:100.64.0.1",
        ] {
            assert!(is_forbidden_ip(bad.parse().unwrap()), "{bad}");
        }
    }

    // [covers:auth-oauth.private-ip-classification]
    #[test]
    fn url_host_gating() {
        let strict = FetchClient::new(false);
        let lenient = FetchClient::new(true);
        assert!(
            strict
                .check_url(&"https://chatgpt.com/x".parse().unwrap())
                .is_ok()
        );
        for bad in [
            "http://chatgpt.com/x",
            "http://127.0.0.1:9/x",
            "https://127.0.0.1/x",
            "https://10.0.0.1/x",
            "ftp://chatgpt.com/x",
        ] {
            assert!(
                strict.check_url(&bad.parse().unwrap()).is_err(),
                "{bad} should be refused"
            );
        }
        // the dev switch only opens loopback http(s), not other private hosts
        // over plain http
        assert!(
            lenient
                .check_url(&"http://127.0.0.1:9/x".parse().unwrap())
                .is_ok()
        );
        assert!(
            lenient
                .check_url(&"http://localhost:9/x".parse().unwrap())
                .is_ok()
        );
        assert!(
            lenient
                .check_url(&"http://192.168.1.5/x".parse().unwrap())
                .is_err()
        );
    }
}
