//! Client authentication for `/oauth/token` and `/oauth/revoke`
//! (spec_auth.md section 4-4): `private_key_jwt` client assertions verified
//! against the client's JWKS (cached in `oauth_jwks_cache` with stale-if-error
//! and a kid-mismatch refetch throttle), and single-use `jti` registration in
//! `oauth_client_assertion_jtis` before the token transaction.

use jsonwebtoken::jwk::{
    AlgorithmParameters, CommonParameters, EllipticCurve, EllipticCurveKeyParameters, Jwk, JwkSet,
    KeyAlgorithm,
};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection, SqlitePool};

use super::cimd::{AuthMethod, ClientRecord};
use super::net::{FetchClient, clamp_max_age};
use crate::config::ResolvedAuth;

pub const ASSERTION_TYPE: &str = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/// Claims the server reads itself (iss/sub/jti/iat/exp checks beyond what
/// `jsonwebtoken`'s Validation covers, spec_auth.md 4-4).
#[derive(Debug, Deserialize)]
struct AssertionClaims {
    iss: String,
    sub: String,
    exp: i64,
    iat: i64,
    /// verified by the library's Validation (validate_nbf)
    #[serde(default)]
    #[allow(dead_code)]
    nbf: Option<i64>,
    jti: String,
}

#[derive(Debug, thiserror::Error)]
pub enum AssertionError {
    #[error("invalid_client")]
    Invalid,
    #[error("assertion required but missing")]
    Missing,
    #[error("method mismatch: {0}")]
    MethodMismatch(&'static str),
    #[error(transparent)]
    Db(#[from] anyhow::Error),
}

/// Authenticated client identity for a token / revoke request.
pub struct AuthenticatedClient {
    pub client_id: String,
}

/// Why a client authentication attempt was rejected, logged at warn level
/// with a stable `reason` tag. Every rejection otherwise collapses into a
/// bare `invalid_client` response, which made a run of token-endpoint 401s
/// (2026-11-27, ChatGPT refresh + code exchange) impossible to attribute to
/// a specific check. Only non-secret material is logged: the header alg/kid,
/// the client_id (a public CIMD URL), and — on decode failure — the
/// *unverified* claims' iss/sub/aud/exp/iat values plus the jti's presence.
/// The signature, the jti value, and the assertion itself are never logged.
fn warn_rejected(reason: &'static str, client_id: &str) {
    tracing::warn!(reason, client_id, "client assertion rejected");
}

/// The unverified claims of an assertion, for rejection diagnostics only
/// (see `warn_rejected`). Parsed from the payload without any verification;
/// never used for an authentication decision.
struct UnverifiedClaims {
    iss: Option<String>,
    sub: Option<String>,
    aud: Option<String>,
    exp: Option<i64>,
    iat: Option<i64>,
    jti_present: bool,
}

fn unverified_claims(assertion: &str) -> Option<UnverifiedClaims> {
    let mut parts = assertion.split('.');
    let (_h, p) = (parts.next()?, parts.next()?);
    let payload = crate::auth::tokens::b64url_decode(p)?;
    let value: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    let aud = match value.get("aud") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(a)) => Some(
            a.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    };
    Some(UnverifiedClaims {
        iss: value
            .get("iss")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        sub: value
            .get("sub")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        aud,
        exp: value.get("exp").and_then(|v| v.as_i64()),
        iat: value.get("iat").and_then(|v| v.as_i64()),
        jti_present: value
            .get("jti")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty()),
    })
}

/// Verify client authentication per the CIMD-declared method.
///
/// * `method == none`: `client_id` form parameter only (PKCE carries the rest).
/// * `method == private_key_jwt`: a valid, single-use client assertion whose
///   `iss == sub == client_id`.
///
/// The `client_id` parameter (when present) must match the assertion issuer.
#[allow(clippy::too_many_arguments)] // mirrors the token request parameters
pub async fn authenticate_client(
    pool: &SqlitePool,
    fetch: &FetchClient,
    cfg: &ResolvedAuth,
    record: &ClientRecord,
    form_client_id: Option<&str>,
    client_assertion: Option<&str>,
    client_assertion_type: Option<&str>,
    now: i64,
) -> Result<AuthenticatedClient, AssertionError> {
    match record.auth_method {
        AuthMethod::None => {
            if client_assertion.is_some() {
                // a client declaring `none` must not send assertions
                warn_rejected("assertion_unexpected_for_none", &record.client_id);
                return Err(AssertionError::MethodMismatch(
                    "client_assertion sent but the client declares token_endpoint_auth_method=none",
                ));
            }
            let Some(client_id) = form_client_id else {
                warn_rejected("client_id_missing", &record.client_id);
                return Err(AssertionError::Invalid);
            };
            if client_id != record.client_id {
                warn_rejected("client_id_mismatch", &record.client_id);
                return Err(AssertionError::Invalid);
            }
            Ok(AuthenticatedClient {
                client_id: client_id.to_string(),
            })
        }
        AuthMethod::PrivateKeyJwt => {
            let Some(assertion) = client_assertion else {
                warn_rejected("assertion_missing", &record.client_id);
                return Err(AssertionError::Missing);
            };
            // the URN is REQUIRED (RFC 7523 2.2): absent and mismatched values
            // are both rejected
            if client_assertion_type != Some(ASSERTION_TYPE) {
                tracing::warn!(
                    reason = "assertion_type_mismatch",
                    client_id = record.client_id,
                    assertion_type = client_assertion_type.unwrap_or("<absent>"),
                    "client assertion rejected"
                );
                return Err(AssertionError::Invalid);
            }
            if let Some(cid) = form_client_id
                && cid != record.client_id
            {
                warn_rejected("client_id_mismatch", &record.client_id);
                return Err(AssertionError::Invalid);
            }
            let claims = verify_assertion(pool, fetch, cfg, record, assertion, now).await?;
            if claims.iss != record.client_id || claims.sub != record.client_id {
                tracing::warn!(
                    reason = "iss_sub_mismatch",
                    client_id = record.client_id,
                    iss = claims.iss,
                    sub = claims.sub,
                    "client assertion rejected"
                );
                return Err(AssertionError::Invalid);
            }
            register_jti(pool, &record.client_id, &claims.jti, claims.exp).await?;
            Ok(AuthenticatedClient {
                client_id: record.client_id.clone(),
            })
        }
    }
}

/// Extract the assertion issuer without verifying (needed to locate the CIMD
/// document when the form carries no client_id).
pub fn assertion_issuer(assertion: &str) -> Option<String> {
    let mut parts = assertion.split('.');
    let (_h, p) = (parts.next()?, parts.next()?);
    let payload = crate::auth::tokens::b64url_decode(p)?;
    let value: serde_json::Value = serde_json::from_slice(&payload).ok()?;
    value.get("iss")?.as_str().map(str::to_string)
}

async fn verify_assertion(
    pool: &SqlitePool,
    fetch: &FetchClient,
    cfg: &ResolvedAuth,
    record: &ClientRecord,
    assertion: &str,
    now: i64,
) -> Result<AssertionClaims, AssertionError> {
    let header = match decode_header(assertion) {
        Ok(h) => h,
        Err(e) => {
            tracing::warn!(
                reason = "header_parse",
                client_id = record.client_id,
                error_kind = ?e.kind(),
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
    };
    let alg = match header.alg {
        Algorithm::RS256 | Algorithm::PS256 | Algorithm::ES256 => header.alg,
        other => {
            tracing::warn!(
                reason = "alg_rejected",
                client_id = record.client_id,
                alg = ?other,
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
    };
    let Some(kid) = header.kid else {
        tracing::warn!(
            reason = "kid_missing",
            client_id = record.client_id,
            alg = ?alg,
            "client assertion rejected"
        );
        return Err(AssertionError::Invalid);
    };

    let jwk = select_jwk(pool, fetch, cfg, record, alg, &kid, now).await?;
    let key = match DecodingKey::from_jwk(&jwk) {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!(
                reason = "jwk_decode_failed",
                client_id = record.client_id,
                alg = ?alg,
                kid,
                error_kind = ?e.kind(),
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
    };

    // Validation for exactly this alg; aud covers issuer and token endpoint;
    // leeway = clock_skew_secs; required claims verified by the lib.
    let mut validation = Validation::new(alg);
    validation.leeway = cfg.oauth.clock_skew_secs.max(0) as u64;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.set_audience(&[cfg.issuer.clone(), format!("{}/oauth/token", cfg.issuer)]);
    validation.set_issuer(std::slice::from_ref(&record.client_id));
    validation.sub = Some(record.client_id.clone());
    // aud must be present (a missing aud is not "any audience")
    validation.set_required_spec_claims(&["exp", "aud", "iss", "sub"]);

    // On failure the error kind discriminates the cause (InvalidSignature,
    // InvalidAudience, InvalidIssuer, InvalidSubject, ExpiredSignature,
    // ImmatureSignature, MissingRequiredClaim, ...); the unverified claims
    // are logged alongside so e.g. an audience mismatch is visible directly.
    let data = match decode::<AssertionClaims>(assertion, &key, &validation) {
        Ok(d) => d,
        Err(e) => {
            let peek = unverified_claims(assertion);
            tracing::warn!(
                reason = "signature_or_claims",
                client_id = record.client_id,
                alg = ?alg,
                kid,
                error_kind = ?e.kind(),
                iss = peek.as_ref().and_then(|p| p.iss.as_deref()).unwrap_or("<absent>"),
                sub = peek.as_ref().and_then(|p| p.sub.as_deref()).unwrap_or("<absent>"),
                aud = peek.as_ref().and_then(|p| p.aud.as_deref()).unwrap_or("<absent>"),
                exp = ?peek.as_ref().and_then(|p| p.exp),
                iat = ?peek.as_ref().and_then(|p| p.iat),
                jti_present = peek.as_ref().is_some_and(|p| p.jti_present),
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
    };
    let claims = data.claims;

    // manual checks beyond the library (spec_auth.md 4-4)
    if claims.exp - claims.iat > 300 {
        tracing::warn!(
            reason = "exp_iat_window",
            client_id = record.client_id,
            exp = claims.exp,
            iat = claims.iat,
            "client assertion rejected"
        );
        return Err(AssertionError::Invalid);
    }
    // iat must not be more than 60s in the future
    if claims.iat > now / 1000 + cfg.oauth.clock_skew_secs {
        tracing::warn!(
            reason = "iat_future",
            client_id = record.client_id,
            iat = claims.iat,
            now_secs = now / 1000,
            "client assertion rejected"
        );
        return Err(AssertionError::Invalid);
    }
    if claims.jti.is_empty() || claims.jti.len() > 256 {
        tracing::warn!(
            reason = "jti_shape",
            client_id = record.client_id,
            jti_len = claims.jti.len(),
            "client assertion rejected"
        );
        return Err(AssertionError::Invalid);
    }
    Ok(claims)
}

/// Find the JWK for (alg, kid), honoring the jwks cache: kid mismatch triggers
/// an immediate refetch at most once per 60 seconds (spec_auth.md 4-4).
async fn select_jwk(
    pool: &SqlitePool,
    fetch: &FetchClient,
    _cfg: &ResolvedAuth,
    record: &ClientRecord,
    alg: Algorithm,
    kid: &str,
    now: i64,
) -> Result<Jwk, AssertionError> {
    let source: String = match (&record.jwks_uri, &record.jwks_inline) {
        (Some(uri), _) => uri.clone(),
        (None, Some(_)) => super::cimd::inline_jwks_cache_key(&record.client_id),
        _ => {
            tracing::warn!(
                reason = "jwks_source_missing",
                client_id = record.client_id,
                alg = ?alg,
                kid,
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
    };

    let load = |jwks_json: &str| -> Option<Jwk> {
        let set: JwkSet = serde_json::from_str(jwks_json).ok()?;
        set.keys.into_iter().find(|k| key_matches(k, alg, kid))
    };

    // (jwks_json, etag, fetched_at, expires_at)
    let row: Option<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT jwks_json, etag, fetched_at, expires_at FROM oauth_jwks_cache WHERE jwks_uri = ?",
    )
    .bind(&source)
    .fetch_optional(pool)
    .await
    .map_err(anyhow::Error::from)?;

    if let Some((jwks_json, etag, fetched_at, expires_at)) = &row
        && *expires_at > now
    {
        if let Some(k) = load(jwks_json) {
            return Ok(k);
        }
        // fresh cache without the kid: refetch only after 60 seconds
        if now - fetched_at < 60_000 {
            tracing::warn!(
                reason = "jwks_kid_not_found",
                client_id = record.client_id,
                alg = ?alg,
                kid,
                detail = "fresh_cache_refetch_throttled",
                "client assertion rejected"
            );
            return Err(AssertionError::Invalid);
        }
        return match refetch(pool, fetch, &source, etag.clone(), now).await? {
            Some(json) => match load(&json) {
                Some(k) => Ok(k),
                None => {
                    tracing::warn!(
                        reason = "jwks_kid_not_found",
                        client_id = record.client_id,
                        alg = ?alg,
                        kid,
                        detail = "after_refetch",
                        "client assertion rejected"
                    );
                    Err(AssertionError::Invalid)
                }
            },
            None => {
                tracing::warn!(
                    reason = "jwks_kid_not_found",
                    client_id = record.client_id,
                    alg = ?alg,
                    kid,
                    detail = "refetch_no_change",
                    "client assertion rejected"
                );
                Err(AssertionError::Invalid)
            }
        };
    }

    // missing or expired cache: normal fetch (or stale-if-error fallback)
    match refetch(
        pool,
        fetch,
        &source,
        row.as_ref().and_then(|r| r.1.clone()),
        now,
    )
    .await?
    {
        Some(json) => match load(&json) {
            Some(k) => Ok(k),
            None => {
                tracing::warn!(
                    reason = "jwks_kid_not_found",
                    client_id = record.client_id,
                    alg = ?alg,
                    kid,
                    detail = "after_fetch",
                    "client assertion rejected"
                );
                Err(AssertionError::Invalid)
            }
        },
        None => {
            if let Some((jwks_json, _, _, expires_at)) = &row
                && expires_at + 24 * 86_400_000 > now
                && let Some(k) = load(jwks_json)
            {
                return Ok(k);
            }
            tracing::warn!(
                reason = "jwks_unavailable",
                client_id = record.client_id,
                alg = ?alg,
                kid,
                detail = "fetch_failed_or_not_modified_and_no_usable_stale_cache",
                "client assertion rejected"
            );
            Err(AssertionError::Invalid)
        }
    }
}

/// Whether a JWK may serve (alg, kid): kid equal, kty consistent with the
/// algorithm, `use` sig (or absent), `alg` (when present) equal.
fn key_matches(jwk: &Jwk, alg: Algorithm, kid: &str) -> bool {
    let CommonParameters {
        key_id,
        public_key_use,
        key_algorithm,
        ..
    } = &jwk.common;
    if key_id.as_deref() != Some(kid) {
        return false;
    }
    if let Some(use_) = public_key_use
        && !matches!(use_, jsonwebtoken::jwk::PublicKeyUse::Signature)
    {
        return false;
    }
    if let Some(ka) = key_algorithm
        && jwk_alg_to_algorithm(*ka) != Some(alg)
    {
        return false;
    }
    match (&jwk.algorithm, alg) {
        (AlgorithmParameters::RSA(_), Algorithm::RS256 | Algorithm::PS256) => true,
        (
            AlgorithmParameters::EllipticCurve(EllipticCurveKeyParameters { curve, .. }),
            Algorithm::ES256,
        ) => matches!(curve, EllipticCurve::P256),
        _ => false,
    }
}

fn jwk_alg_to_algorithm(ka: KeyAlgorithm) -> Option<Algorithm> {
    match ka {
        KeyAlgorithm::RS256 => Some(Algorithm::RS256),
        KeyAlgorithm::PS256 => Some(Algorithm::PS256),
        KeyAlgorithm::ES256 => Some(Algorithm::ES256),
        _ => None,
    }
}

/// Refetch the JWKS and refresh the cache; None on 304 without changes.
/// Errors are mapped to `None` (stale-if-error is handled by the caller).
async fn refetch(
    pool: &SqlitePool,
    fetch: &FetchClient,
    jwks_uri: &str,
    etag: Option<String>,
    now: i64,
) -> Result<Option<String>, AssertionError> {
    // The inline cache row is never fetched over HTTP.
    if jwks_uri.ends_with("#jwks") {
        return Ok(None);
    }
    match fetch.fetch_json(jwks_uri, etag.as_deref()).await {
        Ok(Some(fetched)) => {
            let ttl_ms = clamp_max_age(fetched.max_age) * 1000;
            let body = String::from_utf8_lossy(&fetched.body).to_string();
            sqlx::query(
                "INSERT INTO oauth_jwks_cache (jwks_uri, jwks_json, etag, fetched_at, expires_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (jwks_uri) DO UPDATE SET
                     jwks_json = excluded.jwks_json, etag = excluded.etag,
                     fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
            )
            .bind(jwks_uri)
            .bind(&body)
            .bind(&fetched.etag)
            .bind(now)
            .bind(now + ttl_ms)
            .execute(pool)
            .await
            .map_err(anyhow::Error::from)?;
            Ok(Some(body))
        }
        Ok(None) => Ok(None),
        Err(e) => {
            tracing::warn!(
                reason = "jwks_fetch_failed",
                jwks_uri,
                error = %e,
                "JWKS fetch failed; falling back to the stale cache if usable"
            );
            Ok(None)
        }
    }
}

/// Single-use jti registration in its own transaction, before the token tx
/// (spec_auth.md 4-4). PK conflict = replay = invalid_client.
async fn register_jti(
    pool: &SqlitePool,
    client_id: &str,
    jti: &str,
    exp_secs: i64,
) -> Result<(), AssertionError> {
    let mut conn = pool.acquire().await.map_err(anyhow::Error::from)?;
    let mut tx = conn
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(anyhow::Error::from)?;
    let res = sqlx::query(
        "INSERT INTO oauth_client_assertion_jtis (client_id, jti, expires_at) VALUES (?, ?, ?)",
    )
    .bind(client_id)
    .bind(jti)
    .bind(exp_secs * 1000 + 60_000)
    .execute(&mut *tx)
    .await;
    match res {
        Ok(_) => {
            tx.commit().await.map_err(anyhow::Error::from)?;
            Ok(())
        }
        Err(sqlx::Error::Database(ref e)) if e.is_unique_violation() => {
            tracing::warn!(
                reason = "jti_replay",
                client_id,
                jti_len = jti.len(),
                "client assertion rejected"
            );
            Err(AssertionError::Invalid)
        }
        Err(e) => Err(anyhow::Error::from(e).into()),
    }
}

/// Subject hash recording (spec_auth.md section 7-4, v1 unkeyed SHA-256).
pub fn subject_hash(subject: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"budget-book/openai-subject/v1:");
    h.update(subject.as_bytes());
    h.finalize().into()
}

/// Record (or refresh) a subject hash for a user. `last_seen_at` updates only
/// after an hour; failures are logged, not propagated (the tool result is
/// independent of the recording).
pub async fn record_subject_hash(conn: &mut SqliteConnection, hash: &[u8], user_id: i64, now: i64) {
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT last_seen_at FROM user_subject_hashes WHERE subject_hash = ? AND user_id = ?",
    )
    .bind(hash)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await
    .unwrap_or(None);
    let res = match existing {
        None => {
            sqlx::query(
                "INSERT INTO user_subject_hashes (subject_hash, user_id, issuer, first_seen_at, last_seen_at)
                 VALUES (?, ?, 'openai', ?, ?)",
            )
            .bind(hash)
            .bind(user_id)
            .bind(now)
            .bind(now)
            .execute(conn)
            .await
            .map(|_| ())
        }
        Some(last_seen) if now - last_seen >= 3_600_000 => {
            sqlx::query(
                "UPDATE user_subject_hashes SET last_seen_at = ? WHERE subject_hash = ? AND user_id = ?",
            )
            .bind(now)
            .bind(hash)
            .bind(user_id)
            .execute(conn)
            .await
            .map(|_| ())
        }
        Some(_) => Ok(()),
    };
    if let Err(e) = res {
        tracing::warn!(error = %e, "subject hash recording failed");
    }
}
