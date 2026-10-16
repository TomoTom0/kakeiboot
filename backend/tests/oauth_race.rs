//! TASK-10 Phase B: concurrency of the token endpoint over a real SQLite file
//! with a multi-connection pool (spec_auth.md sections 4-4, 4-7, 4-9, 4-10).
//! A third connection holds the write lock as a barrier so both requests
//! reach their BEGIN IMMEDIATE and genuinely contend.

mod common;

use axum::http::StatusCode;
use common::auth::{self, Client};
use common::oauth::{self, body_json, make_assertion, pkce_pair, post_form};
use sqlx::{Connection, SqlitePool};

const ASSERTION_TYPE: &str = "urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer";

/// Hold the SQLite write lock for a while so concurrent requests pile up.
fn spawn_gate(pool: &SqlitePool) -> tokio::task::JoinHandle<()> {
    let pool = pool.clone();
    tokio::spawn(async move {
        let mut conn = pool.acquire().await.unwrap();
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("SELECT COUNT(*) FROM oauth_grants")
            .execute(&mut *tx)
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tx.commit().await.unwrap();
    })
}

async fn setup() -> (
    axum::Router,
    SqlitePool,
    oauth::MockIds,
    Client,
    String,
    tempfile::TempDir,
) {
    let mock = oauth::spawn_mock().await;
    let (router, pool, cfg, dir) = oauth::oauth_setup_file(&mock).await;
    let mut client = Client::new();
    auth::register_setup_user(&mut client, &router, &pool, "Race User").await;
    (router, pool, mock, client, cfg.auth.issuer.clone(), dir)
}

async fn get_code(
    router: &axum::Router,
    client: &Client,
    mock: &oauth::MockIds,
    challenge: &str,
) -> String {
    let req_id = oauth::authorize(router, client, mock, challenge, None, None).await;
    let resp = client
        .get(router, &format!("/api/oauth/requests/{req_id}"))
        .await;
    assert_eq!(resp.status(), 200);
    let resp = client
        .post(
            router,
            "/oauth/authorize/decision",
            serde_json::json!({ "req": req_id, "decision": "allow" }),
        )
        .await;
    let body = body_json(resp).await;
    oauth::extract_query_param(body["redirect_to"].as_str().unwrap(), "code").unwrap()
}

fn exchange_form(mock: &oauth::MockIds, code: &str, verifier: &str, assertion: &str) -> String {
    format!(
        "grant_type=authorization_code&code={code}&redirect_uri={}&code_verifier={verifier}&client_assertion={assertion}&client_assertion_type={ASSERTION_TYPE}",
        oauth::urlencode(&mock.redirect_uri)
    )
}

// [covers:auth-oauth.race-code-exchange]
#[tokio::test]
async fn concurrent_exchange_of_one_code() {
    let (router, pool, mock, client, issuer, _dir) = setup().await;
    let (verifier, challenge) = pkce_pair();
    let code = get_code(&router, &client, &mock, &challenge).await;
    let a1 = make_assertion(
        &mock.client_id,
        &issuer,
        Some("k1"),
        &oauth::b64url_of_random(),
        &[],
    );
    let a2 = make_assertion(
        &mock.client_id,
        &issuer,
        Some("k1"),
        &oauth::b64url_of_random(),
        &[],
    );
    let f1 = exchange_form(&mock, &code, &verifier, &a1);
    let f2 = exchange_form(&mock, &code, &verifier, &a2);

    let gate = spawn_gate(&pool);
    let (r1, r2) = tokio::join!(
        post_form(&router, "/oauth/token", &f1, &[]),
        post_form(&router, "/oauth/token", &f2, &[])
    );
    gate.await.unwrap();
    let mut statuses = [r1.status(), r2.status()];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::BAD_REQUEST],
        "exactly one exchange wins"
    );
    // the loser saw a used code: the winner's grant is revoked (code_reuse)
    let grants: Vec<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(grants.len(), 1, "a single grant was created");
    assert!(grants[0].0.is_some());
    assert_eq!(grants[0].1.as_deref(), Some("code_reuse"));
}

// [covers:auth-oauth.race-refresh-same-token]
#[tokio::test]
async fn concurrent_use_of_one_refresh_token() {
    let (router, pool, mock, client, issuer, _dir) = setup().await;
    let flow = oauth::run_full_flow(&router, &pool, &client, &mock, &issuer, None).await;
    let form = |jti: String| {
        let a = make_assertion(&mock.client_id, &issuer, Some("k1"), &jti, &[]);
        format!(
            "grant_type=refresh_token&refresh_token={}&client_assertion={a}&client_assertion_type={ASSERTION_TYPE}",
            flow.refresh_token
        )
    };
    let f1 = form(oauth::b64url_of_random());
    let f2 = form(oauth::b64url_of_random());

    let gate = spawn_gate(&pool);
    let (r1, r2) = tokio::join!(
        post_form(&router, "/oauth/token", &f1, &[]),
        post_form(&router, "/oauth/token", &f2, &[])
    );
    gate.await.unwrap();
    // serialized: first rotation (step 2), then the grace reissue (step 3)
    assert_eq!(r1.status(), 200);
    assert_eq!(r2.status(), 200);
    let b1 = body_json(r1).await;
    let b2 = body_json(r2).await;
    let children = [
        b1["refresh_token"].as_str().unwrap().to_string(),
        b2["refresh_token"].as_str().unwrap().to_string(),
    ];
    let accesses = [
        b1["access_token"].as_str().unwrap().to_string(),
        b2["access_token"].as_str().unwrap().to_string(),
    ];
    // exactly one live child: child_hash points at one of them, and only its
    // paired access token is unrevoked
    let child_hash: Option<Vec<u8>> =
        sqlx::query_scalar("SELECT child_hash FROM oauth_refresh_tokens WHERE token_hash = ?")
            .bind(oauth::token_hash(&flow.refresh_token))
            .fetch_one(&pool)
            .await
            .unwrap();
    let child_hash = child_hash.expect("child recorded");
    let live_idx = children
        .iter()
        .position(|c| oauth::token_hash(c) == child_hash)
        .expect("child_hash is one of the issued children");
    for (i, access) in accesses.iter().enumerate() {
        let revoked: Option<i64> =
            sqlx::query_scalar("SELECT revoked_at FROM oauth_access_tokens WHERE token_hash = ?")
                .bind(oauth::token_hash(access))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(revoked.is_none(), i == live_idx, "access {i}");
    }
    let grant_revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_grants WHERE id = ?")
            .bind(flow.grant_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(grant_revoked.is_none(), "grace reissue keeps the family");
}

// [covers:auth-oauth.race-jti-insert]
#[tokio::test]
async fn concurrent_reuse_of_one_jti() {
    let (router, pool, mock, client, issuer, _dir) = setup().await;
    let (v1, c1) = pkce_pair();
    let (v2, c2) = pkce_pair();
    let code1 = get_code(&router, &client, &mock, &c1).await;
    let code2 = get_code(&router, &client, &mock, &c2).await;
    let assertion = make_assertion(&mock.client_id, &issuer, Some("k1"), "shared-jti", &[]);
    let f1 = exchange_form(&mock, &code1, &v1, &assertion);
    let f2 = exchange_form(&mock, &code2, &v2, &assertion);

    let gate = spawn_gate(&pool);
    let (r1, r2) = tokio::join!(
        post_form(&router, "/oauth/token", &f1, &[]),
        post_form(&router, "/oauth/token", &f2, &[])
    );
    gate.await.unwrap();
    let mut statuses = [r1.status(), r2.status()];
    statuses.sort();
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::UNAUTHORIZED],
        "the jti is registered once; the replay is invalid_client"
    );
    let jtis: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_client_assertion_jtis WHERE jti = 'shared-jti'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(jtis, 1);
}
