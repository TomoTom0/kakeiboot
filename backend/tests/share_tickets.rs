//! Share ticket tests (share design sections 3, 5, 6, 7): issuance by the
//! ledger owner, non-consuming info, session-only accept that grants
//! membership only (no user creation, no default-ledger change),
//! upgrade-only role changes, idempotent retries, revoke, expiry, and the
//! `POST /api/invitations` compatibility delegation to `/share?token=…`.

mod common;

use axum::http::StatusCode;
use budget_book::auth::tokens::to_hex;
use common::auth::*;

async fn setup() -> (axum::Router, sqlx::SqlitePool) {
    let (router, pool, _cfg) = auth_setup().await;
    (router, pool)
}

/// A logged-in client without a WebAuthn registration: direct user row +
/// a real web session row. Keeps the token-acceptance rate-limit budget of
/// a test for the share calls themselves (registration start/finish share
/// the same limiter class).
async fn direct_session_client(pool: &sqlx::SqlitePool, display: &str) -> (Client, i64) {
    let user_id = create_user_direct(pool, display, None).await;
    let cfg = common::repo_config();
    let token = budget_book::auth::session::create_session(
        pool,
        user_id,
        None,
        budget_book::auth::session::now_ms(),
        &cfg.auth.session,
    )
    .await
    .unwrap();
    let mut client = Client::new();
    client.cookies.insert(
        budget_book::auth::session::COOKIE_SESSION.to_string(),
        b64(&token),
    );
    (client, user_id)
}

async fn default_ledger(pool: &sqlx::SqlitePool, user_id: i64) -> i64 {
    sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn member_role(pool: &sqlx::SqlitePool, ledger_id: i64, user_id: i64) -> Option<String> {
    sqlx::query_scalar("SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
        .bind(ledger_id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

fn token_of(url: &str) -> String {
    url.rsplit("token=").next().unwrap().to_string()
}

/// Issue a share ticket through the API as `client`; returns (token, url).
async fn issue_via_api(
    client: &Client,
    router: &axum::Router,
    ledger_id: i64,
    role: &str,
) -> (String, String) {
    let resp = client
        .post(
            router,
            "/api/share-tickets",
            serde_json::json!({ "ledger_id": ledger_id, "role": role, "inviter_note": "家族へ" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED, "share-ticket issue");
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap().to_string();
    assert!(url.contains("/share?token="), "share url shape: {url}");
    (token_of(&url), url)
}

async fn info(
    client: &Client,
    router: &axum::Router,
    token: &str,
) -> (StatusCode, serde_json::Value) {
    let resp = client
        .post(
            router,
            "/api/share/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    let status = resp.status();
    (status, body_json(resp).await)
}

async fn accept(
    client: &Client,
    router: &axum::Router,
    token: &str,
) -> (StatusCode, serde_json::Value) {
    let resp = client
        .post(
            router,
            "/api/share/accept",
            serde_json::json!({ "token": token }),
        )
        .await;
    let status = resp.status();
    (status, body_json(resp).await)
}

// [covers:share-tickets.info-never-consumes-and-accept-grants-membership-only]
#[tokio::test]
async fn info_never_consumes_and_accept_grants_membership_only() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let (member, member_id) = direct_session_client(&pool, "member").await;
    let member_default_before = default_ledger(&pool, member_id).await;
    let users_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (token, _url) = issue_via_api(&owner, &router, ledger, "editor").await;

    // info is repeatable and never consumes (anonymous view).
    let anon = Client::new();
    for _ in 0..2 {
        let (status, body) = info(&anon, &router, &token).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["role"], "editor");
        assert_eq!(body["issuer_display_name"], "owner");
        assert!(body["ledger_name"].as_str().is_some());
        assert_eq!(body["session"], serde_json::Value::Null);
        assert_eq!(body["already_member"], false);
    }
    // info with a session carries the session display name.
    let (status, body) = info(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["session"]["display_name"], "member");
    assert_eq!(body["already_member"], false);

    // Unauthenticated accept: 401 and the ticket stays open.
    let (status, _) = accept(&anon, &router, &token).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = info(&anon, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "401 accept must not consume");

    // Logged-in accept: membership only.
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "joined");
    assert_eq!(body["ledger"]["id"], ledger);
    assert_eq!(body["ledger"]["role"], "editor");
    assert_eq!(
        member_role(&pool, ledger, member_id).await.as_deref(),
        Some("editor")
    );
    let users_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users_after, users_before, "accept creates no user");
    assert_eq!(
        default_ledger(&pool, member_id).await,
        member_default_before,
        "accept never changes default_ledger_id"
    );

    // After acceptance, info is the uniform invalid_token...
    let (status, body) = info(&anon, &router, &token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_token");

    // ...but the acceptor's own retry is an idempotent already_member.
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "already_member");
    assert_eq!(body["ledger"]["role"], "editor");
    let memberships: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ledger_members WHERE ledger_id = ? AND user_id = ?",
    )
    .bind(ledger)
    .bind(member_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(memberships, 1, "retry adds no second membership row");

    // audit: share_accept recorded against the share_ticket entity.
    let audits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'share_ticket' AND action = 'share_accept' AND user_id = ?",
    )
    .bind(member_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audits >= 1, "share_accept audit row exists");
}

// [covers:share-tickets.no-downgrade]
#[tokio::test]
async fn accept_never_downgrades_existing_role() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let mut member = Client::new();
    let member_id = register_setup_user(&mut member, &router, &pool, "member").await;

    let (token, _) = issue_via_api(&owner, &router, ledger, "editor").await;
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "joined");

    // A weaker (viewer) ticket: already_member, role stays editor, and the
    // ticket is consumed (info now rejects it).
    let (token, _) = issue_via_api(&owner, &router, ledger, "viewer").await;
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "already_member");
    assert_eq!(body["ledger"]["role"], "editor");
    assert_eq!(
        member_role(&pool, ledger, member_id).await.as_deref(),
        Some("editor"),
        "no downgrade"
    );
    let (status, _) = info(&Client::new(), &router, &token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "ticket was consumed");
}

// [covers:share-tickets.upgrade-only]
#[tokio::test]
async fn accept_upgrades_weaker_existing_role() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let mut member = Client::new();
    let member_id = register_setup_user(&mut member, &router, &pool, "member").await;

    let (token, _) = issue_via_api(&owner, &router, ledger, "viewer").await;
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ledger"]["role"], "viewer");

    let (token, _) = issue_via_api(&owner, &router, ledger, "editor").await;
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["outcome"], "joined");
    assert_eq!(body["ledger"]["role"], "editor");
    assert_eq!(
        member_role(&pool, ledger, member_id).await.as_deref(),
        Some("editor"),
        "viewer upgraded to editor"
    );
}

// [covers:share-tickets.list-and-revoke]
#[tokio::test]
async fn list_and_revoke_by_ref() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let mut other = Client::new();
    let _other_id = register_setup_user(&mut other, &router, &pool, "other").await;

    let (token, _) = issue_via_api(&owner, &router, ledger, "viewer").await;
    let hash: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM ledger_share_tickets")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ticket_ref = to_hex(&hash)[..8].to_string();

    // The issuer's open list shows the ticket without any plaintext token.
    let resp = owner.get(&router, "/api/share-tickets").await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["ticket_ref"], ticket_ref);
    assert_eq!(list[0]["ledger_id"], ledger);
    assert_eq!(list[0]["role"], "viewer");
    assert_eq!(list[0]["inviter_note"], "家族へ");
    assert!(
        list[0].get("token").is_none() && list[0].get("url").is_none(),
        "list never carries the plaintext"
    );

    // Another user's DELETE of the ref is 404 and the row survives.
    let resp = other
        .delete(&router, &format!("/api/share-tickets/{ticket_ref}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let (status, _) = info(&Client::new(), &router, &token).await;
    assert_eq!(status, StatusCode::OK, "ticket survives a foreign revoke");

    // The issuer's DELETE revokes: info/accept become invalid_token.
    let resp = owner
        .delete(&router, &format!("/api/share-tickets/{ticket_ref}"))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let (status, body) = info(&Client::new(), &router, &token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_token");
    let resp = owner.get(&router, "/api/share-tickets").await;
    assert_eq!(body_json(resp).await.as_array().unwrap().len(), 0);
}

// [covers:share-tickets.expired-is-invalid-token]
#[tokio::test]
async fn expired_ticket_is_invalid_token() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let mut member = Client::new();
    let _member_id = register_setup_user(&mut member, &router, &pool, "member").await;

    let (token, _) = issue_via_api(&owner, &router, ledger, "editor").await;
    sqlx::query("UPDATE ledger_share_tickets SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = info(&Client::new(), &router, &token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_token");
    let (status, body) = accept(&member, &router, &token).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], "invalid_token");
    // unknown and malformed tokens are indistinguishable
    let (status, _) = info(
        &Client::new(),
        &router,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = info(&Client::new(), &router, "not-a-token").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

// [covers:share-tickets.issue-requires-ownership]
#[tokio::test]
async fn issue_requires_ownership() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let mut member = Client::new();
    let member_id = register_setup_user(&mut member, &router, &pool, "member").await;
    let mut outsider = Client::new();
    let _outsider_id = register_setup_user(&mut outsider, &router, &pool, "outsider").await;

    // member (viewer) of the ledger: 403 owner_required
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)",
    )
    .bind(ledger)
    .bind(member_id)
    .execute(&pool)
    .await
    .unwrap();
    let resp = member
        .post(
            &router,
            "/api/share-tickets",
            serde_json::json!({ "ledger_id": ledger, "role": "viewer" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["error"], "owner_required");

    // non-member: 404 (indistinguishable from a missing ledger)
    let resp = outsider
        .post(
            &router,
            "/api/share-tickets",
            serde_json::json!({ "ledger_id": ledger, "role": "viewer" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);

    // invalid role and over-long note are rejected for the owner too
    let resp = owner
        .post(
            &router,
            "/api/share-tickets",
            serde_json::json!({ "ledger_id": ledger, "role": "owner" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let resp = owner
        .post(
            &router,
            "/api/share-tickets",
            serde_json::json!({ "ledger_id": ledger, "role": "viewer", "inviter_note": "あ".repeat(201) }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:share-tickets.invitations-compat-delegation]
#[tokio::test]
async fn invitations_compat_returns_share_url() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;

    // explicit ledger_id
    let resp = owner
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "viewer", "ledger_id": ledger }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap();
    assert!(
        url.contains("/share?token="),
        "compat url is a share url: {url}"
    );
    assert!(!url.contains("/register?token="), "no legacy register url");
    // and it is a real share ticket: info resolves it, invitations has no row
    let (status, info_body) = info(&Client::new(), &router, &token_of(url)).await;
    assert_eq!(status, StatusCode::OK, "{info_body}");
    let inv_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM invitations WHERE kind = 'invite'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(inv_rows, 0, "no legacy invitation row is created");

    // no ledger_id: the default-ledger resolution of the legacy shape holds
    let resp = owner
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
    let body = body_json(resp).await;
    assert!(body["url"].as_str().unwrap().contains("/share?token="));
}

// [covers:share-tickets.register-info-flags-legacy-invite]
#[tokio::test]
async fn register_info_flags_legacy_invite_as_share_migrated() {
    let (router, pool) = setup().await;
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "owner").await;
    let ledger = default_ledger(&pool, owner_id).await;
    let token = issue_invite_token(&pool, owner_id, ledger, "editor", Some("family")).await;
    let resp = Client::new()
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["kind"], "invite");
    assert_eq!(body["share_migrated"], true);
}
