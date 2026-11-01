//! TASK-10 Phase B: refresh token rotation (spec_auth.md sections 4-9, 4-10,
//! 11-5; spec_data-model.md section 14 steps 1-4) — every branch, with the
//! fraud revocations committed before the error response.

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{self, body_json, make_assertion, post_form};

const ASSERTION_TYPE: &str = "urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer";

async fn setup() -> (
    axum::Router,
    sqlx::SqlitePool,
    oauth::MockIds,
    Client,
    String,
) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, cfg) = oauth::oauth_setup(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Refresh User").await;
    (router, pool, mock, client, cfg.auth.issuer.clone())
}

fn refresh_form(mock: &oauth::MockIds, issuer: &str, token: &str, extras: &str) -> String {
    let jti = oauth::b64url_of_random();
    let assertion = make_assertion(&mock.client_id, issuer, Some("k1"), &jti, &[]);
    format!(
        "grant_type=refresh_token&refresh_token={token}&client_assertion={assertion}&client_assertion_type={ASSERTION_TYPE}{extras}"
    )
}

/// (used_at, child_hash, revoked_at) of a refresh token row.
async fn refresh_row(
    pool: &sqlx::SqlitePool,
    token: &str,
) -> (Option<i64>, Option<Vec<u8>>, Option<i64>) {
    sqlx::query_as(
        "SELECT used_at, child_hash, revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?",
    )
    .bind(oauth::token_hash(token))
    .fetch_one(pool)
    .await
    .unwrap()
}

/// (revoked_at, revoked_reason) of a grant.
async fn grant_state(pool: &sqlx::SqlitePool, grant_id: i64) -> (Option<i64>, Option<String>) {
    sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
        .bind(grant_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// POST /oauth/token grant_type=refresh_token for `token` (+ extra params).
async fn rotate(
    router: &axum::Router,
    mock: &oauth::MockIds,
    issuer: &str,
    token: &str,
    extras: &str,
) -> (StatusCode, serde_json::Value) {
    let resp = post_form(
        router,
        "/oauth/token",
        &refresh_form(mock, issuer, token, extras),
        &[],
    )
    .await;
    let status = resp.status();
    (status, body_json(resp).await)
}

/// Rotation that must succeed: returns (access, refresh).
async fn rotate_ok(
    router: &axum::Router,
    mock: &oauth::MockIds,
    issuer: &str,
    token: &str,
) -> (String, String) {
    let (status, body) = rotate(router, mock, issuer, token, "").await;
    assert_eq!(status, 200, "rotation failed: {body}");
    (
        body["access_token"].as_str().unwrap().to_string(),
        body["refresh_token"].as_str().unwrap().to_string(),
    )
}

/// Bearer use of an access token on /mcp: 401 when the token is not valid
/// (a valid token reaches rmcp, which answers its own non-401 error).
async fn bearer_status(router: &axum::Router, access: &str) -> StatusCode {
    oauth::post_form(
        router,
        "/mcp",
        "{}",
        &[("authorization", format!("Bearer {access}"))],
    )
    .await
    .status()
}

/// Presenting `token` must fail as invalid_grant (400).
async fn assert_invalid_grant(
    router: &axum::Router,
    mock: &oauth::MockIds,
    issuer: &str,
    token: &str,
    extras: &str,
    what: &str,
) {
    let (status, body) = rotate(router, mock, issuer, token, extras).await;
    assert_eq!(status, 400, "{what}: {body}");
    assert_eq!(body["error"], "invalid_grant", "{what}: {body}");
}

// [covers:auth-oauth.refresh-first-rotation]
#[tokio::test]
async fn first_rotation_issues_child_pair() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // give the grant a second membership to observe ledger preservation
    let ledger2: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('R2', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let user: i64 = sqlx::query_scalar("SELECT user_id FROM oauth_grants WHERE id = ?")
        .bind(flow.grant_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'editor', 0)")
        .bind(ledger2)
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE oauth_grants SET active_ledger_id = ? WHERE id = ?")
        .bind(ledger2)
        .bind(flow.grant_id)
        .execute(&pool)
        .await
        .unwrap();

    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let new_access = body["access_token"].as_str().unwrap().to_string();
    let new_refresh = body["refresh_token"].as_str().unwrap().to_string();
    assert_eq!(body["scope"], "ledger.read ledger.write");

    let (used_at, child_hash, revoked) = refresh_row(&pool, &flow.refresh_token).await;
    assert!(used_at.is_some(), "used_at set");
    assert!(revoked.is_none());
    assert_eq!(
        child_hash.as_deref(),
        Some(oauth::token_hash(&new_refresh).as_slice())
    );
    // child row exists unused
    let child_used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM oauth_refresh_tokens WHERE token_hash = ?")
            .bind(oauth::token_hash(&new_refresh))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(child_used.is_none());
    // active ledger unchanged, grant not rotated away
    let active: Option<i64> =
        sqlx::query_scalar("SELECT active_ledger_id FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active, Some(ledger2));
    // the new access token authenticates on /mcp (not a 401; the body is not
    // valid JSON-RPC so rmcp answers with its own client error)
    let resp = oauth::post_form(
        &router,
        "/mcp",
        "{}",
        &[("authorization", format!("Bearer {new_access}"))],
    )
    .await;
    assert_ne!(
        resp.status(),
        StatusCode::UNAUTHORIZED,
        "new access token valid"
    );
}

// [covers:auth-oauth.refresh-grace-reissue]
#[tokio::test]
async fn grace_window_reissue_replaces_child() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // first rotation
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    let body = body_json(resp).await;
    let child1 = body["refresh_token"].as_str().unwrap().to_string();
    let access1 = body["access_token"].as_str().unwrap().to_string();
    let used_at_first = refresh_row(&pool, &flow.refresh_token).await.0;
    assert!(used_at_first.is_some());

    // immediate replay of the parent (within 60s grace, child unused)
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200, "grace reissue");
    let body = body_json(resp).await;
    let child2 = body["refresh_token"].as_str().unwrap().to_string();
    let access2 = body["access_token"].as_str().unwrap().to_string();
    assert_ne!(child1, child2);
    assert_ne!(access1, access2);

    // used_at keeps the original rotation time (not updated)
    assert_eq!(
        refresh_row(&pool, &flow.refresh_token).await.0,
        used_at_first,
        "parent used_at unchanged by the reissue"
    );

    // child_hash now points at child2
    let row = refresh_row(&pool, &flow.refresh_token).await;
    assert_eq!(
        row.1.as_deref(),
        Some(oauth::token_hash(&child2).as_slice())
    );

    // the access token paired with the old child was revoked
    let access1_revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_access_tokens WHERE token_hash = ?")
            .bind(oauth::token_hash(&access1))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        access1_revoked.is_some(),
        "old child's paired access revoked"
    );
    // access2 still live
    let access2_revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_access_tokens WHERE token_hash = ?")
            .bind(oauth::token_hash(&access2))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(access2_revoked.is_none());
    // TASK-140: the superseded child's refresh row itself is revoked too
    // (one live child per family, spec_auth.md 4-9 step 3); it was never
    // used, so used_at stays NULL
    let (child1_used, _, child1_revoked) = refresh_row(&pool, &child1).await;
    assert!(child1_used.is_none(), "old child never used");
    assert!(child1_revoked.is_some(), "old child's refresh row revoked");
    // child2 is the single live child; the grant stays valid
    let (child2_used, _, child2_revoked) = refresh_row(&pool, &child2).await;
    assert!(child2_used.is_none() && child2_revoked.is_none());
    assert_eq!(grant_state(&pool, flow.grant_id).await, (None, None));
}

// [covers:auth-oauth.refresh-reuse-beyond-grace]
#[tokio::test]
async fn reuse_beyond_grace_revokes_family() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // first rotation
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);

    // backdate used_at beyond the 60s grace, then replay the parent
    sqlx::query("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?")
        .bind(budget_book::auth::session::now_ms() - 120_000)
        .bind(oauth::token_hash(&flow.refresh_token))
        .execute(&pool)
        .await
        .unwrap();
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"], "invalid_grant");
    // the family is revoked (committed, observable after the response)
    let grant: (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(grant.0.is_some(), "grant revoked after the error response");
    assert_eq!(grant.1.as_deref(), Some("refresh_reuse"));
}

// [covers:auth-oauth.refresh-reuse-beyond-grace]
#[tokio::test]
async fn used_child_within_grace_is_theft_signal() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    // rotation 1 -> child1; rotation of child1 -> grandchild
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    let child1 = body_json(resp).await["refresh_token"]
        .as_str()
        .unwrap()
        .to_string();
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &child1, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200, "child1 rotation");

    // replay the parent while child1 is already used (within grace):
    // step 4 -> refresh_reuse
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);
    let grant: Option<String> =
        sqlx::query_scalar("SELECT revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(grant.as_deref(), Some("refresh_reuse"));
}

// [covers:auth-oauth.refresh-scope-narrowing]
#[tokio::test]
async fn refresh_scope_must_narrow() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;

    // narrowed scope is granted on the new token, grant unchanged
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, "&scope=ledger.read"),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["scope"], "ledger.read");
    let grant_scope: String = sqlx::query_scalar("SELECT scope FROM oauth_grants WHERE id = ?")
        .bind(flow.grant_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        grant_scope, "ledger.read ledger.write",
        "grant scope unchanged"
    );

    // superset / unknown scope -> invalid_scope
    for bad in [
        "ledger.read ledger.write extra",
        "ledger.admin",
        "offline_access",
    ] {
        // note: offline_access alone collapses to an empty request which
        // falls back to the grant scope; pair it with an unknown scope to
        // hit invalid_scope deterministically
        let scope_req = if bad == "offline_access" {
            "offline_access bogus"
        } else {
            bad
        };
        let resp = post_form(
            &router,
            "/oauth/token",
            &refresh_form(
                &mock,
                &issuer,
                &flow.refresh_token,
                &format!("&scope={}", scope_req.replace(' ', "%20")),
            ),
            &[],
        )
        .await;
        let status = resp.status();
        let body = body_json(resp).await;
        assert_eq!(status, 400, "{bad}: {body}");
        assert_eq!(body["error"], "invalid_scope", "{bad}");
    }

    // omitted scope -> same as grant
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    assert_eq!(body["scope"], "ledger.read ledger.write");
}

// [covers:auth-oauth.refresh-invalid-grants]
#[tokio::test]
async fn refresh_failure_modes() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;

    // unknown token
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(
            &mock,
            &issuer,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "",
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);

    // expired refresh
    sqlx::query("UPDATE oauth_refresh_tokens SET expires_at = 1 WHERE token_hash = ?")
        .bind(oauth::token_hash(&flow.refresh_token))
        .execute(&pool)
        .await
        .unwrap();
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);
    sqlx::query("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE token_hash = ?")
        .bind(budget_book::auth::session::now_ms() + 86_400_000)
        .bind(oauth::token_hash(&flow.refresh_token))
        .execute(&pool)
        .await
        .unwrap();

    // resource mismatch (explicit resource differing from the grant)
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(
            &mock,
            &issuer,
            &flow.refresh_token,
            "&resource=http%3A%2F%2Flocalhost%3A40281%2Fother",
        ),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);

    // disabled user
    sqlx::query("UPDATE users SET disabled_at = 1 WHERE id = (SELECT user_id FROM oauth_grants WHERE id = ?)")
        .bind(flow.grant_id)
        .execute(&pool)
        .await
        .unwrap();
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);
    sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = (SELECT user_id FROM oauth_grants WHERE id = ?)")
        .bind(flow.grant_id)
        .execute(&pool)
        .await
        .unwrap();

    // client mismatch: authenticate as the mock client while the grant
    // belongs to a different client -> grant revoked + invalid_grant
    sqlx::query(
        "INSERT OR IGNORE INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES ('https://chatgpt.com/clients/foreign', '{}', '[]', 'none', 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE oauth_grants SET client_id = 'https://chatgpt.com/clients/foreign' WHERE id = ?",
    )
    .bind(flow.grant_id)
    .execute(&pool)
    .await
    .unwrap();
    let resp = post_form(
        &router,
        "/oauth/token",
        &refresh_form(&mock, &issuer, &flow.refresh_token, ""),
        &[],
    )
    .await;
    assert_eq!(resp.status(), 400);
    let grant: (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(grant.0.is_some(), "client mismatch revokes the grant");
    assert_eq!(grant.1.as_deref(), Some("client_mismatch"));
}

// ---------------------------------------------------------------------------
// TASK-140: a child superseded by a grace-window reissue is revoked, and
// presenting it later is a theft signal that revokes the whole family
// (spec_auth.md 4-9 steps 1 and 3, 4-10; spec_data-model.md section 14).

// [covers:auth-oauth.refresh-superseded-child-reuse]
// S1: the attacker rotates the stolen R first (C1/A1); the legitimate client
// replays R within grace (C2/A2); the attacker then uses C1.
#[tokio::test]
async fn superseded_child_attacker_first_revokes_family() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (a2, c2) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    assert_eq!(
        bearer_status(&router, &a1).await,
        StatusCode::UNAUTHORIZED,
        "the attacker's A1 is already dead before C1 is presented"
    );

    assert_invalid_grant(&router, &mock, &issuer, &c1, "", "superseded C1").await;
    let (revoked_at, reason) = grant_state(&pool, flow.grant_id).await;
    assert!(
        revoked_at.is_some(),
        "grant revoked (committed before the response)"
    );
    assert_eq!(reason.as_deref(), Some("refresh_reuse"));
    // no second family survives: C2 and A2 die with the grant
    assert_invalid_grant(
        &router,
        &mock,
        &issuer,
        &c2,
        "",
        "C2 after family revocation",
    )
    .await;
    assert_eq!(bearer_status(&router, &a2).await, StatusCode::UNAUTHORIZED);
}

// [covers:auth-oauth.refresh-superseded-child-reuse]
// S2: the legitimate client rotates R first (C1); the attacker replays the
// stolen R within grace (C2/A2); the legitimate client then uses its C1.
#[tokio::test]
async fn superseded_child_legit_first_revokes_attacker_family() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (a2, c2) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;

    assert_invalid_grant(
        &router,
        &mock,
        &issuer,
        &c1,
        "",
        "legit client's superseded C1",
    )
    .await;
    let (revoked_at, reason) = grant_state(&pool, flow.grant_id).await;
    assert!(revoked_at.is_some());
    assert_eq!(reason.as_deref(), Some("refresh_reuse"));
    assert_invalid_grant(&router, &mock, &issuer, &c2, "", "attacker's C2").await;
    assert_eq!(bearer_status(&router, &a2).await, StatusCode::UNAUTHORIZED);
}

// [covers:auth-oauth.refresh-grace-retry-no-false-positive]
// The reason the grace window exists: R was sent but the response (C1) was
// lost, so the client re-sends R and continues with C2. It never holds C1,
// so the family survives.
#[tokio::test]
async fn grace_retry_then_new_child_keeps_family() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let _lost = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (_a2, c2) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (a3, _c3) = rotate_ok(&router, &mock, &issuer, &c2).await;
    assert_eq!(grant_state(&pool, flow.grant_id).await, (None, None));
    assert_ne!(bearer_status(&router, &a3).await, StatusCode::UNAUTHORIZED);
}

// [covers:auth-oauth.refresh-superseded-child-grandchild]
// R -> C1, R -> C2 (grace), C2 -> C3; then the superseded C1 is presented.
#[tokio::test]
async fn superseded_child_after_grandchild_revokes_family() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (_a2, c2) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (a3, c3) = rotate_ok(&router, &mock, &issuer, &c2).await;

    assert_invalid_grant(&router, &mock, &issuer, &c1, "", "superseded C1").await;
    assert_eq!(
        grant_state(&pool, flow.grant_id).await.1.as_deref(),
        Some("refresh_reuse")
    );
    assert_invalid_grant(&router, &mock, &issuer, &c3, "", "grandchild C3").await;
    assert_eq!(bearer_status(&router, &a3).await, StatusCode::UNAUTHORIZED);
}

// [covers:auth-oauth.refresh-grace-reissue-repeated]
// Three grace reissues of R: every superseded child (C1, C2) is revoked and
// only C3 stays live; presenting either superseded child revokes the family.
#[tokio::test]
async fn repeated_grace_reissue_revokes_every_superseded_child() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (_a2, c2) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let (_a3, c3) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    assert!(refresh_row(&pool, &c1).await.2.is_some(), "C1 revoked");
    assert!(refresh_row(&pool, &c2).await.2.is_some(), "C2 revoked");
    assert!(refresh_row(&pool, &c3).await.2.is_none(), "C3 live");
    assert_eq!(
        refresh_row(&pool, &flow.refresh_token).await.1.as_deref(),
        Some(oauth::token_hash(&c3).as_slice())
    );

    assert_invalid_grant(&router, &mock, &issuer, &c2, "", "superseded C2").await;
    assert_eq!(
        grant_state(&pool, flow.grant_id).await.1.as_deref(),
        Some("refresh_reuse")
    );
}

// [covers:auth-oauth.refresh-superseded-child-expired]
// The revoked check precedes the expiry check (design review L1): an expired
// superseded child is still a theft signal while the grant is valid.
#[tokio::test]
async fn expired_superseded_child_is_still_reuse() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let _ = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    sqlx::query("UPDATE oauth_refresh_tokens SET expires_at = 1 WHERE token_hash = ?")
        .bind(oauth::token_hash(&c1))
        .execute(&pool)
        .await
        .unwrap();

    assert_invalid_grant(&router, &mock, &issuer, &c1, "", "expired superseded C1").await;
    let (revoked_at, reason) = grant_state(&pool, flow.grant_id).await;
    assert!(
        revoked_at.is_some(),
        "expired superseded child revokes the family"
    );
    assert_eq!(reason.as_deref(), Some("refresh_reuse"));
}

// [covers:auth-oauth.refresh-superseded-child-survives-sweep]
// TASK-140 review MEDIUM-1: the maintenance sweep keeps a superseded
// (revoked) child past expiry + 1 day while the grant is live, so a late
// presentation is still reuse and revokes the family.
#[tokio::test]
async fn superseded_child_survives_sweep_and_is_reuse() {
    let (router, pool, mock, client, issuer) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let _ = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
    let now = budget_book::auth::session::now_ms();
    sqlx::query("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE token_hash = ?")
        .bind(now - 3 * 86_400_000)
        .bind(oauth::token_hash(&c1))
        .execute(&pool)
        .await
        .unwrap();
    budget_book::store::cleanup_expired(&pool, now, "2000-01-01", |_| Ok(()))
        .await
        .unwrap();
    assert!(
        refresh_row(&pool, &c1).await.2.is_some(),
        "the superseded child survives the sweep"
    );

    assert_invalid_grant(&router, &mock, &issuer, &c1, "", "swept-window C1").await;
    assert_eq!(
        grant_state(&pool, flow.grant_id).await.1.as_deref(),
        Some("refresh_reuse")
    );
}

// [covers:auth-oauth.refresh-superseded-child-check-order]
// Step 1 order (design review M3/L2/L6): expiry of a non-revoked row /
// grant revoked / grant expired / user disabled -> resource mismatch ->
// client mismatch -> revoked token (reuse) -> scope. Each case starts from a
// superseded C1 (R -> C1, R -> C2) in a fresh app.
#[tokio::test]
async fn superseded_child_check_order() {
    enum Case {
        GrantRevoked,
        UserDisabled,
        ResourceMismatch,
        ClientMismatch,
        BadScope,
    }
    for case in [
        Case::GrantRevoked,
        Case::UserDisabled,
        Case::ResourceMismatch,
        Case::ClientMismatch,
        Case::BadScope,
    ] {
        let (router, pool, mock, client, issuer) = setup().await;
        let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
        let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
        let _ = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
        let mut extras = "";
        let (label, want): (&str, (bool, Option<&str>)) = match case {
            Case::GrantRevoked => {
                sqlx::query(
                    "UPDATE oauth_grants SET revoked_at = 1, revoked_reason = 'user' WHERE id = ?",
                )
                .bind(flow.grant_id)
                .execute(&pool)
                .await
                .unwrap();
                (
                    "grant revoked: rollback, reason untouched",
                    (true, Some("user")),
                )
            }
            Case::UserDisabled => {
                sqlx::query(
                    "UPDATE users SET disabled_at = 1 WHERE id = (SELECT user_id FROM oauth_grants WHERE id = ?)",
                )
                .bind(flow.grant_id)
                .execute(&pool)
                .await
                .unwrap();
                ("user disabled: rollback, grant not revoked", (false, None))
            }
            Case::ResourceMismatch => {
                extras = "&resource=http%3A%2F%2Flocalhost%3A40281%2Fother";
                (
                    "resource mismatch: rollback, grant not revoked",
                    (false, None),
                )
            }
            Case::ClientMismatch => {
                sqlx::query(
                    "INSERT OR IGNORE INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
                     VALUES ('https://chatgpt.com/clients/foreign', '{}', '[]', 'none', 0, 0)",
                )
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query(
                    "UPDATE oauth_grants SET client_id = 'https://chatgpt.com/clients/foreign' WHERE id = ?",
                )
                .bind(flow.grant_id)
                .execute(&pool)
                .await
                .unwrap();
                (
                    "client mismatch wins over reuse",
                    (true, Some("client_mismatch")),
                )
            }
            Case::BadScope => {
                extras = "&scope=ledger.admin";
                ("reuse wins over scope", (true, Some("refresh_reuse")))
            }
        };
        assert_invalid_grant(&router, &mock, &issuer, &c1, extras, label).await;
        let (revoked_at, reason) = grant_state(&pool, flow.grant_id).await;
        assert_eq!((revoked_at.is_some(), reason.as_deref()), want, "{label}");
    }
}

// ---------------------------------------------------------------------------
// TASK-140 diagnostics (design review L4): every refresh_reuse revocation
// logs a WARN line with a `kind` field that tells the paths apart, plus
// grant_id and client_id, and never a token, its hash or an assertion.

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// [covers:auth-oauth.refresh-reuse-diagnostic-kind]
#[tokio::test]
async fn refresh_reuse_logs_diagnostic_kind() {
    // thread-local capture (common::logcap keeps a second dispatcher so a
    // parallel test cannot poison the callsite interest cache)
    let cap = common::logcap::LogCapture::new();

    let (router, pool, mock, client, issuer) = setup().await;
    let mut secrets: Vec<String> = Vec::new();

    // grace_exceeded: replay of R after the 60s grace
    let f1 = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (a, c) = rotate_ok(&router, &mock, &issuer, &f1.refresh_token).await;
    secrets.extend([f1.refresh_token.clone(), f1.access_token.clone(), a, c]);
    sqlx::query("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?")
        .bind(budget_book::auth::session::now_ms() - 120_000)
        .bind(oauth::token_hash(&f1.refresh_token))
        .execute(&pool)
        .await
        .unwrap();
    assert_invalid_grant(
        &router,
        &mock,
        &issuer,
        &f1.refresh_token,
        "",
        "grace exceeded",
    )
    .await;

    // child_used: replay of R within grace after its child was used
    let f2 = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (a, c1) = rotate_ok(&router, &mock, &issuer, &f2.refresh_token).await;
    let (a2, g) = rotate_ok(&router, &mock, &issuer, &c1).await;
    secrets.extend([
        f2.refresh_token.clone(),
        f2.access_token.clone(),
        a,
        c1,
        a2,
        g,
    ]);
    assert_invalid_grant(&router, &mock, &issuer, &f2.refresh_token, "", "child used").await;

    // superseded_child: the superseded C1 is presented
    let f3 = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let (a, c1) = rotate_ok(&router, &mock, &issuer, &f3.refresh_token).await;
    let (a2, c2) = rotate_ok(&router, &mock, &issuer, &f3.refresh_token).await;
    secrets.extend([
        f3.refresh_token.clone(),
        f3.access_token.clone(),
        a,
        a2,
        c2,
        c1.clone(),
    ]);
    assert_invalid_grant(&router, &mock, &issuer, &c1, "", "superseded child").await;

    let out = cap.output();
    for (kind, grant_id) in [
        ("grace_exceeded", f1.grant_id),
        ("child_used", f2.grant_id),
        ("superseded_child", f3.grant_id),
    ] {
        let line = out
            .lines()
            .find(|l| l.contains("WARN") && l.contains("kind=") && l.contains(kind))
            .unwrap_or_else(|| panic!("no WARN line with kind={kind}:\n{out}"));
        assert!(
            line.contains(&format!("grant_id={grant_id}")),
            "{kind}: grant_id field: {line}"
        );
        assert!(
            line.contains("client_id="),
            "{kind}: client_id field: {line}"
        );
    }
    for s in &secrets {
        assert!(
            !out.contains(s.as_str()),
            "a token value leaked into the log"
        );
        assert!(
            !out.contains(&hex(&oauth::token_hash(s))),
            "a token hash leaked into the log"
        );
    }
}

// ---------------------------------------------------------------------------
// TASK-140 fail-closed writes (design review L3): a failing revocation /
// access-revocation UPDATE inside refresh() is a server error (500, rolled
// back), never a silently committed invalid_grant or a reissued pair.

// [covers:auth-oauth.refresh-revoke-write-failure-db-error]
#[tokio::test]
async fn refresh_revocation_write_failure_is_server_error() {
    enum Case {
        GraceExceeded,
        ClientMismatch,
        GraceReissueAccessRevoke,
        GraceReissueChildRevoke,
    }
    for case in [
        Case::GraceExceeded,
        Case::ClientMismatch,
        Case::GraceReissueAccessRevoke,
        Case::GraceReissueChildRevoke,
    ] {
        let (router, pool, mock, client, issuer) = setup().await;
        let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
        let (_a1, c1) = rotate_ok(&router, &mock, &issuer, &flow.refresh_token).await;
        let label = match case {
            Case::GraceExceeded => {
                sqlx::query("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?")
                    .bind(budget_book::auth::session::now_ms() - 120_000)
                    .bind(oauth::token_hash(&flow.refresh_token))
                    .execute(&pool)
                    .await
                    .unwrap();
                sqlx::query(
                    "CREATE TRIGGER inject_fail BEFORE UPDATE OF revoked_at ON oauth_grants
                     BEGIN SELECT RAISE(ABORT, 'injected'); END",
                )
                .execute(&pool)
                .await
                .unwrap();
                "grace exceeded: grant revocation fails"
            }
            Case::ClientMismatch => {
                sqlx::query(
                    "INSERT OR IGNORE INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
                     VALUES ('https://chatgpt.com/clients/foreign', '{}', '[]', 'none', 0, 0)",
                )
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query(
                    "UPDATE oauth_grants SET client_id = 'https://chatgpt.com/clients/foreign' WHERE id = ?",
                )
                .bind(flow.grant_id)
                .execute(&pool)
                .await
                .unwrap();
                sqlx::query(
                    "CREATE TRIGGER inject_fail BEFORE UPDATE OF revoked_at ON oauth_grants
                     BEGIN SELECT RAISE(ABORT, 'injected'); END",
                )
                .execute(&pool)
                .await
                .unwrap();
                "client mismatch: grant revocation fails"
            }
            Case::GraceReissueAccessRevoke => {
                sqlx::query(
                    "CREATE TRIGGER inject_fail BEFORE UPDATE OF revoked_at ON oauth_access_tokens
                     BEGIN SELECT RAISE(ABORT, 'injected'); END",
                )
                .execute(&pool)
                .await
                .unwrap();
                "grace reissue: paired access revocation fails"
            }
            Case::GraceReissueChildRevoke => {
                sqlx::query(
                    "CREATE TRIGGER inject_fail BEFORE UPDATE OF revoked_at ON oauth_refresh_tokens
                     BEGIN SELECT RAISE(ABORT, 'injected'); END",
                )
                .execute(&pool)
                .await
                .unwrap();
                "grace reissue: superseded child revocation fails"
            }
        };
        let (status, body) = rotate(&router, &mock, &issuer, &flow.refresh_token, "").await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{label}: {body}");
        assert_eq!(body["error"], "server_error", "{label}");
        // rolled back: the grant is untouched and R still points at C1
        assert_eq!(grant_state(&pool, flow.grant_id).await.0, None, "{label}");
        assert_eq!(
            refresh_row(&pool, &flow.refresh_token).await.1.as_deref(),
            Some(oauth::token_hash(&c1).as_slice()),
            "{label}"
        );
    }
}
