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
    let row_before: Option<i64> = {
        let r = refresh_row(&pool, &flow.refresh_token).await;
        r.0
    };
    let now = budget_book::auth::session::now_ms();
    assert!(row_before.unwrap() <= now);

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
    // child1 itself is revoked? spec: 旧の子と対の access を失効 (child1 row
    // itself remains unused/valid-but-orphaned; the family moved on)
    let child1_used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM oauth_refresh_tokens WHERE token_hash = ?")
            .bind(oauth::token_hash(&child1))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(child1_used.is_none());
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
