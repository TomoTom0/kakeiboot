//! Passkey management and step-up tests (spec_auth.md sections 2-6, 2-7,
//! 3-2): list / add / rename / delete, reauth flow, web invitation issue.

mod common;

use axum::http::StatusCode;
use common::auth::*;
use sqlx::{Connection, SqlitePool};

async fn setup() -> (axum::Router, SqlitePool) {
    let (router, pool, _cfg) = auth_setup().await;
    (router, pool)
}

fn stale_auth_at(
    pool: &SqlitePool,
    user_id: i64,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + '_>> {
    Box::pin(async move {
        let now = budget_book::auth::session::now_ms();
        sqlx::query("UPDATE web_sessions SET auth_at = ? WHERE user_id = ? AND revoked_at IS NULL")
            .bind(now - 11 * 60_000)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
    })
}

// [covers:auth-passkey.list-requires-session]
#[tokio::test]
async fn passkey_list_requires_session() {
    let (router, _pool) = setup().await;
    let resp = Client::new().get(&router, "/api/passkeys").await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

// [covers:auth-passkey.add-without-stepup]
#[tokio::test]
async fn passkey_add_works_without_step_up() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "adder").await;

    // TASK-46: passkey add no longer demands step-up — a session whose
    // auth_at is well past the 10-minute window still starts and finishes.
    stale_auth_at(&pool, user).await;
    let resp = client
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), StatusCode::OK, "{}", body_text(resp).await);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred, "label": "second key" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK, "{}", body_text(resp).await);
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 2, "the add completed without any reauth");
}

// [covers:auth-reauth.renews-auth-at]
// [covers:auth-passkey.add-finish-inserts-credential]
#[tokio::test]
async fn reauth_renews_auth_at_and_unlocks_passkey_delete() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "stepper").await;
    stale_auth_at(&pool, user).await;

    // step-up via non-discoverable reauth
    let resp = client
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.authenticate(rcr);
    let resp = client
        .post(
            &router,
            "/api/webauthn/reauth/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let auth_at: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        budget_book::auth::session::now_ms() - auth_at < 60_000,
        "auth_at renewed"
    );

    // passkey add needs no step-up anymore (TASK-46): the second credential
    // lands on the renewed session all the same (same client = second
    // credential on the soft token)
    let resp = client
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({
                "credential": cred, "label": "second key"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);

    let creds: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, label FROM webauthn_credentials WHERE user_id = ? ORDER BY id")
            .bind(user)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(creds.len(), 2, "two credentials for the user");
    assert_eq!(creds[1].1.as_deref(), Some("second key"));
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'webauthn_credential' AND action = 'create' AND user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 1, "passkey add audited");

    // the step-up gate now guards deletion only (TASK-46): the renewed
    // auth_at lets the delete through — the gated operation is unlocked
    let resp = client
        .delete(&router, &format!("/api/passkeys/{}", creds[0].0))
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1);
}

// [covers:auth-reauth.rejects-other-user-and-ceremony-mismatch]
#[tokio::test]
async fn reauth_rejects_other_user_and_mismatched_ceremony() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "reauth-a").await;
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "reauth-b").await;
    stale_auth_at(&pool, a_user).await;

    // (1) A's ceremony only allows A's credentials: B's token cannot even
    // produce an assertion for it (server-side allow list in the challenge).
    let resp = a
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    assert!(
        b.try_authenticate(rcr).is_err(),
        "another user's passkey cannot sign this challenge"
    );

    // (2) ceremony of B finished with A's session -> 403, ceremony consumed
    let resp = b
        .post(&router, "/api/webauthn/reauth/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    b.store_cookies(&resp);
    let rcr: webauthn_rs::prelude::RequestChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let b_ceremony = b.cookies.get("__Host-bb_ceremony").cloned().unwrap();
    let b_cred = b.authenticate(rcr);
    // a's session cookie + b's ceremony cookie
    a.cookies
        .insert("__Host-bb_ceremony".into(), b_ceremony.clone());
    let resp = a
        .post(
            &router,
            "/api/webauthn/reauth/finish",
            serde_json::json!({ "credential": b_cred }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_ceremonies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        remaining, 1,
        "mismatched ceremony deleted, A's unused one remains"
    );
    let auth_at: i64 = sqlx::query_scalar(
        "SELECT auth_at FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(a_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        budget_book::auth::session::now_ms() - auth_at > 5 * 60_000,
        "A's auth_at untouched"
    );
}

// [covers:auth-passkey.rename-label]
#[tokio::test]
async fn rename_own_passkey_only() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    register_setup_user(&mut a, &router, &pool, "renamer").await;
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "other").await;

    let a_cred_id: i64 = sqlx::query_scalar(
        "SELECT c.id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'renamer'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let b_cred_id: i64 = sqlx::query_scalar(
        "SELECT c.id FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'other'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{a_cred_id}"),
            serde_json::json!({ "label": "renamed" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let label: String = sqlx::query_scalar("SELECT label FROM webauthn_credentials WHERE id = ?")
        .bind(a_cred_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(label, "renamed");

    let resp = b
        .patch(
            &router,
            &format!("/api/passkeys/{a_cred_id}"),
            serde_json::json!({ "label": "steal" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let _ = b_cred_id;
}

// [covers:auth-passkey.rename-label]
#[tokio::test]
async fn rename_label_cap_counts_characters_not_bytes() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "labeler").await;
    let cred_id: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // 100 multibyte characters = 300 bytes: accepted (the cap counts chars)
    let label = "あ".repeat(100);
    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{cred_id}"),
            serde_json::json!({ "label": label }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
    let stored: String = sqlx::query_scalar("SELECT label FROM webauthn_credentials WHERE id = ?")
        .bind(cred_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored.chars().count(), 100);

    // 101 characters (303 bytes): rejected
    let label = "あ".repeat(101);
    let resp = a
        .patch(
            &router,
            &format!("/api/passkeys/{cred_id}"),
            serde_json::json!({ "label": label }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "invalid_label");
}

// [covers:auth-passkey.delete-last-one-409]
#[tokio::test]
async fn deleting_last_passkey_conflicts() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "single").await;
    let only: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);

    // add a second one, then deletion succeeds (auth_at is fresh from login)
    login(&mut a, &router, &pool, user).await;
    let resp = a
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = a.register(ccr);
    let resp = a
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1);
}

// [covers:auth-passkey.delete-last-one-409]
#[tokio::test]
async fn concurrent_deletes_cannot_remove_the_last_passkey() {
    // A real file DB with a multi-connection pool: concurrent requests use
    // separate connections and actually contend for the SQLite write lock
    // (the in-memory setup has max_connections = 1 and serializes everything).
    let (router, pool, _dir) = auth_setup_file().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "racer").await;
    // second credential so two ids can be targeted concurrently
    let resp = a
        .post(&router, "/api/passkeys/start", serde_json::json!({}))
        .await;
    assert_eq!(resp.status(), 200);
    a.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = a.register(ccr);
    let resp = a
        .post(
            &router,
            "/api/passkeys/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ? ORDER BY id")
            .bind(user)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(ids.len(), 2);

    // Barrier: a third connection holds the SQLite write lock so both DELETE
    // requests run concurrently, pile up on their BEGIN IMMEDIATE and only
    // proceed once the gate releases -- their count checks genuinely overlap
    // the same write window.
    let gate_pool = pool.clone();
    let gate = tokio::spawn(async move {
        let mut conn = gate_pool.acquire().await.unwrap();
        let mut tx = conn.begin_with("BEGIN IMMEDIATE").await.unwrap();
        sqlx::query("SELECT COUNT(*) FROM webauthn_credentials")
            .execute(&mut *tx)
            .await
            .unwrap();
        // hold the write lock long enough for both requests to reach their
        // BEGIN IMMEDIATE and wait (busy_timeout = 5s in the repo config)
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        tx.commit().await.unwrap();
    });
    let path0 = format!("/api/passkeys/{}", ids[0]);
    let path1 = format!("/api/passkeys/{}", ids[1]);
    let (r1, r2) = tokio::join!(a.delete(&router, &path0), a.delete(&router, &path1));
    gate.await.unwrap();
    let statuses = [r1.status(), r2.status()];
    assert!(
        !statuses.contains(&StatusCode::INTERNAL_SERVER_ERROR),
        "both requests must survive the lock contention: {statuses:?}"
    );
    assert!(statuses.contains(&StatusCode::NO_CONTENT), "{statuses:?}");
    assert!(
        statuses.contains(&StatusCode::CONFLICT),
        "one delete must hit the last-passkey conflict: {statuses:?}"
    );
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 1, "the last passkey survives concurrent deletes");
}

// [covers:auth-passkey.delete-requires-stepup]
#[tokio::test]
async fn passkey_delete_requires_step_up() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let user = register_setup_user(&mut a, &router, &pool, "del-step").await;
    let only: i64 = sqlx::query_scalar("SELECT id FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    stale_auth_at(&pool, user).await;
    let resp = a.delete(&router, &format!("/api/passkeys/{only}")).await;
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(body_json(resp).await["error"], "reauth_required");
}

// [covers:auth-invitation.web-issue-owner]
// [covers:auth-invitation.web-issue-ledger]
// [covers:auth-invitation.invite-ttl-config]
#[tokio::test]
async fn web_invitation_issue_owner_and_ledger_choice() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "inv-Owner").await;
    let a_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(a_user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // no ledger_id: the default ledger (legacy shape). The invite TTL is
    // 168 hours since TASK-46 (was 72).
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": "hi" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://localhost:40281/register?token="),
        "{url}"
    );
    let now = budget_book::auth::session::now_ms();
    let expires_at = body["expires_at"].as_i64().unwrap();
    assert!(
        expires_at > now + 167 * 3_600_000 && expires_at <= now + 169 * 3_600_000,
        "168h ttl: {expires_at}"
    );

    // issuance no longer requires step-up (TASK-46): a stale auth_at issues
    let mut stale = Client::new();
    let stale_user = register_setup_user(&mut stale, &router, &pool, "inv-stale").await;
    stale_auth_at(&pool, stale_user).await;
    let resp = stale
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );

    // viewer of someone else's ledger as the default -> forbidden
    let mut viewer = Client::new();
    let viewer_user = register_setup_user(&mut viewer, &router, &pool, "inv-viewer").await;
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)")
        .bind(a_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(a_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = viewer
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["error"], "owner_required");

    // TASK-78: an explicit ledger_id targets a ledger the issuer owns
    let second: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('別荘', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)")
        .bind(second)
        .bind(a_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "viewer", "ledger_id": second }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let invited: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT role, inviter_note FROM invitations WHERE kind = 'invite' AND ledger_id = ?",
    )
    .bind(second)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        invited,
        vec![("viewer".to_string(), None)],
        "the invitation joins the chosen ledger with the chosen role"
    );

    // an editor membership of the target is not enough (owner only)
    let mut b = Client::new();
    let b_user = register_setup_user(&mut b, &router, &pool, "inv-editor-target").await;
    let b_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(b_user)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'editor', 0)")
        .bind(b_ledger)
        .bind(a_user)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "ledger_id": b_ledger }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(resp).await["error"], "owner_required");

    // a ledger the issuer does not belong to and an unknown id look the same
    let mut c = Client::new();
    let c_user = register_setup_user(&mut c, &router, &pool, "inv-outsider").await;
    let c_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(c_user)
        .fetch_one(&pool)
        .await
        .unwrap();
    for unknown in [c_ledger, 999_999] {
        let resp = a
            .post(
                &router,
                "/api/invitations",
                serde_json::json!({ "role": "editor", "ledger_id": unknown }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "ledger {unknown}");
        assert_eq!(body_json(resp).await["error"], "not_found");
    }

    // invalid role
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "owner" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // inviter_note is capped at 200 characters (chars, not bytes)
    let long_note = "あ".repeat(201);
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": long_note }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "inviter_note_too_long");
    // exactly 200 multibyte characters is fine (the cap counts characters)
    let ok_note = "あ".repeat(200);
    let resp = a
        .post(
            &router,
            "/api/invitations",
            serde_json::json!({ "role": "editor", "inviter_note": ok_note }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
}

// [covers:auth-invitation.web-issue-register]
#[tokio::test]
async fn web_register_invitation_issue_for_any_active_user() {
    let (router, pool) = setup().await;

    // a viewer of someone else's ledger (not a default-ledger owner) issues
    let mut owner = Client::new();
    let owner_id = register_setup_user(&mut owner, &router, &pool, "ri-owner").await;
    let owner_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(owner_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut viewer = Client::new();
    let viewer_user = register_setup_user(&mut viewer, &router, &pool, "ri-viewer").await;
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)",
    )
    .bind(owner_ledger)
    .bind(viewer_user)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET default_ledger_id = ? WHERE id = ?")
        .bind(owner_ledger)
        .bind(viewer_user)
        .execute(&pool)
        .await
        .unwrap();

    // a user without any default ledger issues too (registration-only
    // invitations need no ledger at all)
    let mut ledgerless = Client::new();
    let ledgerless_user = register_setup_user(&mut ledgerless, &router, &pool, "ri-noledger").await;
    sqlx::query("UPDATE users SET default_ledger_id = NULL WHERE id = ?")
        .bind(ledgerless_user)
        .execute(&pool)
        .await
        .unwrap();

    // issue: 201 { url, expires_at } with the 168h register TTL (TASK-46)
    let resp = viewer
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "妹" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );
    let body = body_json(resp).await;
    let url = body["url"].as_str().unwrap();
    assert!(
        url.starts_with("http://localhost:40281/register?token="),
        "{url}"
    );
    let now = budget_book::auth::session::now_ms();
    let expires_at = body["expires_at"].as_i64().unwrap();
    assert!(
        expires_at > now + 167 * 3_600_000 && expires_at <= now + 169 * 3_600_000,
        "168h ttl: {expires_at}"
    );

    // issuance audited as register_invitation / create by the issuer
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events
         WHERE actor_kind = 'web' AND entity_type = 'register_invitation'
           AND action = 'create' AND user_id = ?",
    )
    .bind(viewer_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 1);

    // the issued URL resolves on register/info as a register token
    let token = url.rsplit("token=").next().unwrap();
    let resp = Client::new()
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let info = body_json(resp).await;
    assert_eq!(info["kind"], "register");
    assert_eq!(info["needs_display_name"], true);

    // the ledgerless user can issue as well
    let resp = ledgerless
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "n" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // TASK-46: issuance no longer requires step-up — a stale auth_at issues
    stale_auth_at(&pool, viewer_user).await;
    let resp = viewer
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "x" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "{}",
        body_text(resp).await
    );

    // note validation: required, and
    // capped at 200 characters (chars, not bytes)
    for (note, code) in [
        ("", "inviter_note_required"),
        ("   ", "inviter_note_required"),
        (&"あ".repeat(201), "inviter_note_too_long"),
    ] {
        let resp = owner
            .post(
                &router,
                "/api/register-invitations",
                serde_json::json!({ "inviter_note": note }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "note {code}");
        assert_eq!(body_json(resp).await["error"], code);
    }
    // exactly 200 multibyte characters is fine
    let resp = owner
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "あ".repeat(200) }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);
}

// [covers:auth-invitation.register-open-limit]
#[tokio::test]
async fn register_invitation_open_limit() {
    let (router, pool) = setup().await;
    let mut a = Client::new();
    let a_user = register_setup_user(&mut a, &router, &pool, "limit-a").await;

    // five open register tokens
    for i in 0..5 {
        let resp = a
            .post(
                &router,
                "/api/register-invitations",
                serde_json::json!({ "inviter_note": format!("note {i}") }),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::CREATED, "open token {i}");
    }
    // the sixth open token is rejected
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "sixth" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "register_open_limit");

    // another user's budget is independent
    let mut b = Client::new();
    register_setup_user(&mut b, &router, &pool, "limit-b").await;
    let resp = b
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "other user" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // using one token frees a slot
    let hash: Vec<u8> = sqlx::query_scalar(
        "SELECT token_hash FROM register_invitations WHERE created_by = ? AND used_at IS NULL LIMIT 1",
    )
    .bind(a_user)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE register_invitations SET used_at = 1 WHERE token_hash = ?")
        .bind(&hash)
        .execute(&pool)
        .await
        .unwrap();
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "refill" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::CREATED);

    // expired-but-unswept rows do not count against the limit
    sqlx::query(
        "UPDATE register_invitations SET expires_at = 1 WHERE created_by = ? AND used_at IS NULL",
    )
    .bind(a_user)
    .execute(&pool)
    .await
    .unwrap();
    let resp = a
        .post(
            &router,
            "/api/register-invitations",
            serde_json::json!({ "inviter_note": "after expiry" }),
        )
        .await;
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "expired rows are outside the open count"
    );
}
