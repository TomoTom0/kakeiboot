//! In-memory application rate limiter (spec_auth.md section 10-1): a GCRA
//! (generic cell rate algorithm, the scheme governor implements) per
//! (class, key) with a sustained rate of N/minute and a burst of at most N,
//! so there is no 2x burst at a window boundary; 429 + `Retry-After`; plus
//! the failure-block for token acceptance endpoints. The client IP comes from
//! `CF-Connecting-IP` only when trusting the local cloudflared hop.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::config::RateLimitSettings;

const MIN_MS: i64 = 60_000;

/// Limiter route classes (spec_auth.md 10-1 table rows).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Class {
    /// `/api/webauthn/*` per IP
    Webauthn,
    /// invitation / recovery / setup token acceptance per IP (with block)
    TokenAccept,
    /// `/oauth/authorize` + decision per IP
    Authorize,
    /// `/oauth/token` + `/oauth/revoke` per client
    TokenEndpoint,
    /// `/mcp` per user
    Mcp,
    /// anonymous `request_recovery` per IP (settings only until the gate
    /// opens, spec_auth.md 8-2)
    RecoveryAnonymous,
    /// `/mcp` requests that end in 401, per IP (a loose cap on token
    /// guessing / unauthenticated floods; uses the `/mcp` per-minute value)
    McpUnauthenticated,
    /// `/media/img/<token>` per IP (spec_mcp-tools.md 11-5: "user / IP";
    /// the token itself is the bearer, so the key is the IP; spec_auth.md
    /// 10-1 has no dedicated row — shares the `/mcp` per-minute value like
    /// `McpUnauthenticated`)
    Media,
}

impl Class {
    /// Stable label for logs (spec_auth.md 10-5, TASK-15).
    pub fn as_str(self) -> &'static str {
        match self {
            Class::Webauthn => "webauthn",
            Class::TokenAccept => "token_accept",
            Class::Authorize => "authorize",
            Class::TokenEndpoint => "token_endpoint",
            Class::Mcp => "mcp",
            Class::RecoveryAnonymous => "recovery_anonymous",
            Class::McpUnauthenticated => "mcp_unauthenticated",
            Class::Media => "media",
        }
    }
}

/// WARN one fired limiter (spec_auth.md 10-5, TASK-15): which class fired
/// and for which key. Keys are identifiers only (IP or `user:<id>` /
/// `client:<client_id>` labels); no secrets are involved.
pub fn warn_limited(class: Class, key: &str, retry_after_secs: u32) {
    tracing::warn!(
        class = %class.as_str(),
        key = %key,
        retry_after_secs,
        "rate limited"
    );
}

/// GCRA state: the theoretical arrival time (unix ms) of the next request.
struct Cell {
    tat: i64,
}

#[derive(Default)]
struct FailEntry {
    fails: u32,
    blocked_until: i64,
}

/// Shared limiter state; cheap to clone through `Arc`.
#[derive(Clone)]
pub struct RateLimits {
    cfg: RateLimitSettings,
    cells: Arc<Mutex<HashMap<(Class, String), Cell>>>,
    fails: Arc<Mutex<HashMap<String, FailEntry>>>,
}

impl RateLimits {
    pub fn new(cfg: RateLimitSettings) -> Self {
        Self {
            cfg,
            cells: Arc::new(Mutex::new(HashMap::new())),
            fails: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn limit_for(&self, class: Class) -> u32 {
        match class {
            Class::Webauthn => self.cfg.webauthn_per_minute,
            Class::TokenAccept => self.cfg.token_accept_per_minute,
            Class::Authorize => self.cfg.authorize_per_minute,
            Class::TokenEndpoint => self.cfg.token_endpoint_per_minute,
            Class::Mcp => self.cfg.mcp_per_minute,
            Class::RecoveryAnonymous => self.cfg.recovery_anonymous_per_minute,
            Class::McpUnauthenticated => self.cfg.mcp_per_minute,
            Class::Media => self.cfg.mcp_per_minute,
        }
    }

    /// Count one request; `Some(retry_after_secs)` when over the limit.
    ///
    /// GCRA: emission interval `T = 60s / N`, tolerance `tau = T * (N - 1)`.
    /// A request at `now` is allowed when `max(tat, now) - now <= tau`, and
    /// then `tat` advances by `T`. At most N requests pass back to back, and
    /// afterwards one per `T`.
    pub fn check(&self, class: Class, key: &str, now: i64) -> Option<u32> {
        let limit = self.limit_for(class).max(1) as i64;
        let interval = MIN_MS / limit;
        let tolerance = interval * (limit - 1);
        let mut cells = self.cells.lock().expect("rate limit lock");
        let cell = cells
            .entry((class, key.to_string()))
            .or_insert(Cell { tat: now });
        let tat = cell.tat.max(now);
        if tat - now > tolerance {
            let wait_ms = tat - tolerance - now;
            return Some(((wait_ms + 999) / 1000).max(1) as u32);
        }
        cell.tat = tat + interval;
        // opportunistic sweep so the map does not grow without bound
        if cells.len() > 4096 {
            cells.retain(|_, c| c.tat > now);
        }
        None
    }

    /// Is the key inside the token-acceptance failure block?
    pub fn is_blocked(&self, key: &str, now: i64) -> bool {
        let fails = self.fails.lock().expect("rate limit lock");
        fails.get(key).is_some_and(|e| e.blocked_until > now)
    }

    /// Record the outcome of a token acceptance (4xx = failure). 10 failures
    /// block the key for the configured minutes; success resets the counter.
    pub fn register_token_result(&self, key: &str, ok: bool, now: i64) {
        let block_ms = self.cfg.token_accept_block_minutes as i64 * MIN_MS;
        let threshold = self.cfg.token_accept_fail_block;
        let mut fails = self.fails.lock().expect("rate limit lock");
        let entry = fails.entry(key.to_string()).or_default();
        if entry.blocked_until > now {
            return;
        }
        if ok {
            entry.fails = 0;
            return;
        }
        entry.fails += 1;
        if entry.fails >= threshold {
            entry.blocked_until = now + block_ms;
            entry.fails = 0;
        }
    }
}

/// 429 with `Retry-After` (spec_auth.md 10-1).
pub fn too_many_requests(retry_after_secs: u32) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        axum::Json(json!({ "error": "rate_limited" })),
    )
        .into_response();
    if let Ok(v) = retry_after_secs.to_string().parse() {
        resp.headers_mut().insert(header::RETRY_AFTER, v);
    }
    resp
}

/// The client IP key: `CF-Connecting-IP` only when the flag is on (traffic
/// arrives through the local cloudflared hop); otherwise the peer address,
/// or `local` when no peer info exists (router-level tests).
pub fn client_ip(
    headers: &HeaderMap,
    peer: Option<&axum::extract::ConnectInfo<SocketAddr>>,
    trust_cf: bool,
) -> String {
    if trust_cf {
        let peer_loopback = peer.is_none_or(|p| p.0.ip().is_loopback());
        if peer_loopback
            && let Some(v) = headers.get("cf-connecting-ip")
            && let Ok(s) = v.to_str()
            && !s.is_empty()
        {
            return s.to_string();
        }
    }
    peer.map(|p| p.0.to_string())
        .unwrap_or_else(|| "local".into())
}

// ---------------------------------------------------------------------------
// /api middleware (spec_auth.md 10-1): webauthn class on /api/webauthn/*,
// token-accept class + failure block on the register endpoints.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::middleware::Next;

pub async fn api_limit_guard(
    State(state): State<crate::auth::api::AuthApiState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let now = crate::auth::session::now_ms();
    // Share-ticket acceptance (share design section 6-11) joins the
    // token-acceptance frame without the webauthn class: info / accept are
    // token-bearing endpoints, not WebAuthn ceremonies.
    let share_token = path == "/api/share/info" || path == "/api/share/accept";
    if !path.starts_with("/api/webauthn/") && !share_token {
        return next.run(req).await;
    }
    let ip = client_ip(
        req.headers(),
        req.extensions()
            .get::<axum::extract::ConnectInfo<SocketAddr>>(),
        state.auth.rate_limit.trust_cf_connecting_ip,
    );
    if state.limits.is_blocked(&ip, now) {
        warn_limited(
            Class::TokenAccept,
            &ip,
            state.auth.rate_limit.token_accept_block_minutes * 60,
        );
        return too_many_requests(state.auth.rate_limit.token_accept_block_minutes * 60);
    }
    if !share_token && let Some(retry) = state.limits.check(Class::Webauthn, &ip, now) {
        warn_limited(Class::Webauthn, &ip, retry);
        return too_many_requests(retry);
    }
    let token_accept = share_token
        || path == "/api/webauthn/register/info"
        || path == "/api/webauthn/register/start"
        || path == "/api/webauthn/register/finish";
    if token_accept && let Some(retry) = state.limits.check(Class::TokenAccept, &ip, now) {
        warn_limited(Class::TokenAccept, &ip, retry);
        return too_many_requests(retry);
    }
    let resp = next.run(req).await;
    if token_accept {
        let ok = !resp.status().is_client_error() && !resp.status().is_server_error();
        state.limits.register_token_result(&ip, ok, now);
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RateLimitSettings {
        RateLimitSettings {
            webauthn_per_minute: 20,
            token_accept_per_minute: 10,
            token_accept_fail_block: 10,
            token_accept_block_minutes: 15,
            authorize_per_minute: 30,
            token_endpoint_per_minute: 60,
            mcp_per_minute: 120,
            recovery_anonymous_per_minute: 5,
            trust_cf_connecting_ip: false,
        }
    }

    // [covers:auth-ratelimit.fixed-window-per-key]
    #[test]
    fn window_limits_and_retry_after() {
        let limits = RateLimits::new(cfg());
        let t0 = 10 * MIN_MS;
        for i in 0..20 {
            assert!(
                limits.check(Class::Webauthn, "ip1", t0 + i).is_none(),
                "request {i} should pass"
            );
        }
        // 20/min = one per 3s once the burst of 20 is spent
        let retry = limits
            .check(Class::Webauthn, "ip1", t0 + 20)
            .expect("21st request is over the limit");
        assert_eq!(retry, 3, "retry-after is one emission interval");
        // other keys and other classes are independent
        assert!(limits.check(Class::Webauthn, "ip2", t0).is_none());
        assert!(limits.check(Class::Authorize, "ip1", t0).is_none());
        // after one interval exactly one more request passes
        assert!(limits.check(Class::Webauthn, "ip1", t0 + 3_020).is_none());
        assert!(limits.check(Class::Webauthn, "ip1", t0 + 3_021).is_some());
        // after a full minute idle the whole burst is back
        let later = t0 + 2 * MIN_MS;
        for i in 0..20 {
            assert!(
                limits.check(Class::Webauthn, "ip1", later + i).is_none(),
                "{i}"
            );
        }
    }

    // [covers:auth-ratelimit.no-boundary-double-burst]
    #[test]
    fn no_double_burst_across_minute_boundary() {
        // a fixed-window limiter would allow 20 just before and 20 just after
        // the boundary; GCRA allows the 20 burst and then only the refill
        let limits = RateLimits::new(cfg());
        let boundary = 7 * MIN_MS;
        for i in 0..20 {
            assert!(
                limits
                    .check(Class::Webauthn, "ip", boundary - 20 + i)
                    .is_none()
            );
        }
        let mut passed_after = 0;
        for i in 0..20 {
            if limits
                .check(Class::Webauthn, "ip", boundary + 1 + i)
                .is_none()
            {
                passed_after += 1;
            }
        }
        assert_eq!(passed_after, 0, "no second burst right after the boundary");
    }

    // [covers:auth-ratelimit.token-accept-failure-block]
    #[test]
    fn token_accept_failure_block() {
        let limits = RateLimits::new(cfg());
        let t0 = 5 * MIN_MS;
        for i in 0..9 {
            limits.register_token_result("ip1", false, t0 + i);
            assert!(!limits.is_blocked("ip1", t0 + i));
        }
        // a success resets the failure counter
        limits.register_token_result("ip1", true, t0 + 100);
        limits.register_token_result("ip1", false, t0 + 101);
        assert!(!limits.is_blocked("ip1", t0 + 101));
        // 10 consecutive failures block for 15 minutes
        for i in 0..10 {
            limits.register_token_result("ip2", false, t0 + i);
        }
        assert!(limits.is_blocked("ip2", t0 + 20));
        // the block anchors at the 10th failure (t0 + 9)
        assert!(limits.is_blocked("ip2", t0 + 15 * MIN_MS));
        assert!(!limits.is_blocked("ip2", t0 + 16 * MIN_MS));
    }

    // [covers:auth-ratelimit.cf-connecting-ip-trust]
    #[test]
    fn cf_connecting_ip_only_when_trusted() {
        use axum::extract::ConnectInfo;
        let mut headers = HeaderMap::new();
        headers.insert("cf-connecting-ip", "203.0.113.9".parse().unwrap());
        let loopback = ConnectInfo("127.0.0.1:40000".parse().unwrap());
        let remote = ConnectInfo("203.0.113.1:5000".parse().unwrap());
        // untrusted: peer address wins
        assert_eq!(
            client_ip(&headers, Some(&loopback), false),
            "127.0.0.1:40000"
        );
        // trusted + loopback peer: header wins
        assert_eq!(client_ip(&headers, Some(&loopback), true), "203.0.113.9");
        // trusted but the peer is remote: header is not trusted
        assert_eq!(client_ip(&headers, Some(&remote), true), "203.0.113.1:5000");
        // no peer info (router tests): header wins when trusted
        assert_eq!(client_ip(&headers, None, true), "203.0.113.9");
        assert_eq!(client_ip(&headers, None, false), "local");
    }
}
