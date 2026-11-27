//! Registration flow tests (spec_auth.md sections 2-1, 2-3, 11-1): token
//! validation, resident_key overwrite, kind-specific finish transactions.

mod common;

use axum::http::StatusCode;
use common::auth::*;
use sqlx::SqlitePool;
use webauthn_rs::prelude::CreationChallengeResponse;

async fn setup() -> (axum::Router, SqlitePool) {
    let (router, pool, _cfg) = auth_setup().await;
    (router, pool)
}

// [covers:auth-register.start-rejects-invalid-token]
#[tokio::test]
async fn register_start_rejects_invalid_tokens() {
    let (router, pool) = setup().await;
    let client = Client::new();

    // unknown token
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "display_name": "x"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "invalid_token");

    // expired token
    let token = issue_setup_token(&pool, "n").await;
    sqlx::query("UPDATE invitations SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "x"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // used token
    let token = issue_setup_token(&pool, "n2").await;
    let raw: [u8; 32] = budget_book::auth::tokens::b64url_decode(&token)
        .unwrap()
        .try_into()
        .unwrap();
    let hash = budget_book::auth::tokens::sha256(&raw).to_vec();
    sqlx::query("UPDATE invitations SET used_at = 5 WHERE token_hash = ?")
        .bind(&hash)
        .execute(&pool)
        .await
        .unwrap();
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "x"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_ceremonies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "no ceremony rows for rejected tokens");
}

// [covers:auth-register.start-rejects-disabled-recovery-target]
#[tokio::test]
async fn register_start_rejects_disabled_recovery_target() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "disabled-target").await;
    sqlx::query("UPDATE users SET disabled_at = 10 WHERE id = ?")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let token = issue_recovery_token(&pool, user).await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_ceremonies")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// [covers:auth-register.start-display-name-rules]
#[tokio::test]
async fn register_start_display_name_rules() {
    let (router, pool) = setup().await;
    let client = Client::new();

    // setup without display_name
    let token = issue_setup_token(&pool, "n").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "display_name_required");

    // setup with blank display_name
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "   "
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // recovery with display_name
    let mut owner = Client::new();
    let user = register_setup_user(&mut owner, &router, &pool, "target").await;
    let token = issue_recovery_token(&pool, user).await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "new name"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "display_name_not_allowed");

    // register (TASK-32): same rule as setup — display_name is required.
    // The token comes from another active user (any user may issue).
    let inviter_id = user;
    let token = issue_register_token(&pool, inviter_id, "note").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body_json(resp).await["error"], "display_name_required");
    // blank display_name is rejected the same way
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token, "display_name": "   " }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-register.info-for-landing-form]
#[tokio::test]
async fn register_info_reports_kind_for_landing_form() {
    let (router, pool) = setup().await;
    let mut client = Client::new();

    let token = issue_setup_token(&pool, "n").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["kind"], "setup");
    assert_eq!(body["needs_display_name"], true);

    // recovery: target display name, no display name input
    let user = register_setup_user(&mut client, &router, &pool, "recoveree").await;
    let token = issue_recovery_token(&pool, user).await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = body_json(resp).await;
    assert_eq!(body["kind"], "recovery");
    assert_eq!(body["needs_display_name"], false);
    assert_eq!(body["user_display_name"], "recoveree");

    // register (TASK-32): setup-shaped landing info — display name needed,
    // no invited ledger to mention
    let token = issue_register_token(&pool, user, "note").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK, "{}", body_text(resp).await);
    let body = body_json(resp).await;
    assert_eq!(body["kind"], "register");
    assert_eq!(body["needs_display_name"], true);
    assert!(body.get("ledger_name").is_none(), "no ledger join");

    // invalid token
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/info",
            serde_json::json!({
                "token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-register.resident-key-overwritten-preferred]
#[tokio::test]
async fn register_start_overwrites_resident_key_preferred() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "rk"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let body = body_json(resp).await;
    let sel = &body["publicKey"]["authenticatorSelection"];
    assert_eq!(sel["residentKey"], "preferred");
    assert_eq!(sel["requireResidentKey"], false);
    assert_eq!(sel["userVerification"], "required");
    assert!(
        body["publicKey"]["extensions"].is_null(),
        "default extensions (credProt etc.) are dropped"
    );
    // and the ceremony still completes against the overwritten challenge
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body).unwrap();
    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);
}

// [covers:auth-register.setup-finish-creates-user-personal-ledger]
// [covers:db-schema.ledger-labels-seeded-on-create]
#[tokio::test]
async fn setup_finish_creates_user_and_personal_ledger() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "setup-user").await;

    // (handle, account_number, admin_note, default_ledger_id, invited_by,
    // invited_via_kind, disabled_at)
    #[allow(clippy::type_complexity)]
    let row: (
        Vec<u8>,
        String,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT webauthn_user_handle, account_number, admin_note, default_ledger_id,
                    invited_by, invited_via_kind, disabled_at
             FROM users WHERE id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (handle, account_number, admin_note, default_ledger, invited_by, via, disabled) = row;
    assert_eq!(handle.len(), 16, "UUID v4 handle");
    assert!(
        account_number.starts_with("BB-")
            && account_number.len() == 12
            && account_number.as_bytes()[7] == b'-',
        "account number shape: {account_number}"
    );
    assert_eq!(admin_note.as_deref(), Some("note for setup-user"));
    assert_eq!(invited_by, None);
    assert_eq!(via.as_deref(), Some("setup"));
    assert_eq!(disabled, None);

    let ledger = default_ledger.expect("default ledger set");
    let (ledger_name, role, color): (String, String, String) = sqlx::query_as(
        "SELECT l.name, m.role, m.color FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? AND m.ledger_id = ?",
    )
    .bind(user)
    .bind(ledger)
    .fetch_one(&pool)
    .await
    .unwrap();
    // TASK-79: the personal ledger is named "<表示名>の家計簿" and the first
    // membership gets the first palette key
    assert_eq!(ledger_name, "setup-userの家計簿");
    assert_eq!(role, "owner");
    assert_eq!(color, "teal");
    let cats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM item_categories WHERE ledger_id = ?")
        .bind(ledger)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cats, 22, "category seed applied");
    // TASK-17: the registration path inserts the ledger directly (no
    // create_ledger_with_seed), so the label definitions must come from the
    // AFTER INSERT trigger — 5 rows, color-only
    let mut label_colors: Vec<String> =
        sqlx::query_scalar("SELECT color FROM ledger_labels WHERE ledger_id = ?")
            .bind(ledger)
            .fetch_all(&pool)
            .await
            .unwrap();
    label_colors.sort_by_key(|c| {
        ["red", "yellow", "green", "blue", "purple"]
            .iter()
            .position(|k| k == &c.as_str())
            .unwrap_or(usize::MAX)
    });
    assert_eq!(
        label_colors,
        vec!["red", "yellow", "green", "blue", "purple"]
    );
    let titled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ledger_labels WHERE ledger_id = ? AND title IS NOT NULL",
    )
    .bind(ledger)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(titled, 0, "seeded label rows are color-only");

    let creds: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(creds, 1);
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sessions, 1, "new web session issued");
    // audit: token_use + user create
    let actions: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE actor_kind = 'web' AND user_id = ? ORDER BY id",
    )
    .bind(user)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(actions.contains(&"token_use".to_string()));
    assert!(actions.contains(&"create".to_string()));
}

// [covers:auth-register.persists-challenge-user-handle]
// A discoverable credential presents the register/start challenge handle at
// every login, so the stored users.webauthn_user_handle must be exactly that
// uuid. (2026-10-17 prod incident: register/finish used to store a fresh
// uuid instead, so the credential created at registration could never log
// in — login_mismatch on the joint user-handle/credential-id lookup.)
#[tokio::test]
async fn setup_finish_persists_challenge_user_handle() {
    let (router, pool) = setup().await;
    let token = issue_setup_token(&pool, "n").await;
    let mut client = Client::new();

    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token, "display_name": "first" }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let ccr: CreationChallengeResponse = serde_json::from_value(body_json(resp).await).unwrap();
    let challenge_handle = ccr.public_key.user.id.to_vec();

    let cred = client.register(ccr);
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred, "label": "first" }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);

    let stored: Vec<u8> = sqlx::query_scalar("SELECT webauthn_user_handle FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, challenge_handle);
}

// [covers:auth-register.register-token-creates-user-and-personal-ledger]
#[tokio::test]
async fn register_token_creates_user_and_personal_ledger() {
    let (router, pool) = setup().await;
    let mut inviter = Client::new();
    let inviter_id = register_setup_user(&mut inviter, &router, &pool, "reg-inviter").await;
    let inviter_ledger: i64 =
        sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(inviter_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    let token = issue_register_token(&pool, inviter_id, "妹に渡す分").await;
    let mut client = Client::new();
    let user = register_with_token(
        &mut client,
        &router,
        &pool,
        &token,
        Some("registered"),
        None,
    )
    .await;

    // lineage: invited_by = issuer, via register, inviter note copied over,
    // no operator note (registration-only tokens carry no admin note)
    #[allow(clippy::type_complexity)]
    let row: (
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT invited_by, invited_via_kind, invite_note, admin_note, default_ledger_id
         FROM users WHERE id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (invited_by, via, invite_note, admin_note, default_ledger) = row;
    assert_eq!(invited_by, Some(inviter_id));
    assert_eq!(via.as_deref(), Some("register"));
    assert_eq!(invite_note.as_deref(), Some("妹に渡す分"));
    assert_eq!(admin_note, None);

    // personal ledger: owner membership, first palette color, category seed
    let personal = default_ledger.expect("default ledger set");
    assert_ne!(personal, inviter_ledger, "own personal ledger, no join");
    let (ledger_name, role, color): (String, String, String) = sqlx::query_as(
        "SELECT l.name, m.role, m.color FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
         WHERE m.user_id = ? AND m.ledger_id = ?",
    )
    .bind(user)
    .bind(personal)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ledger_name, "registeredの家計簿");
    assert_eq!(role, "owner");
    assert_eq!(color, "teal");
    let cats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM item_categories WHERE ledger_id = ?")
        .bind(personal)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cats, 22, "category seed applied");
    // no membership anywhere else (the register token joins no ledger)
    let memberships: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM ledger_members WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(memberships, 1, "only the personal ledger");

    // audit: token_use on register_invitation + user create {kind:register}
    let token_use: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events
         WHERE entity_type = 'register_invitation' AND action = 'token_use' AND user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(token_use, 1);
    let (create_after,): (String,) = sqlx::query_as(
        "SELECT after_json FROM audit_events
         WHERE entity_type = 'user' AND action = 'create' AND user_id = ?",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(create_after, r#"{"kind":"register"}"#);

    // single use: a second start with the same token is rejected
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token, "display_name": "second" }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE display_name = 'second'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 0, "no second user");
}

// [covers:auth-register.recovery-finish-adds-passkey-revokes-sessions]
#[tokio::test]
async fn recovery_finish_adds_passkey_and_revokes_sessions() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "recovered").await;
    // second session via login (drop the cookie so the register session survives)
    client.cookies.remove("__Host-bb_session");
    login(&mut client, &router, &pool, user).await;
    assert_eq!(user_session_hashes(&pool, user).await.len(), 2);

    let old_cred: Vec<u8> =
        sqlx::query_scalar("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();

    let token = issue_recovery_token(&pool, user).await;
    let mut fresh = Client::new();
    let resp = fresh
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    fresh.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = fresh.register(ccr);
    let resp = fresh
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), 200, "{}", body_text(resp).await);

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    let ledgers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ledgers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!((users, ledgers), (1, 1), "recovery creates no user/ledger");

    let creds: Vec<Vec<u8>> = sqlx::query_scalar(
        "SELECT credential_id FROM webauthn_credentials WHERE user_id = ? ORDER BY id",
    )
    .bind(user)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(creds.len(), 2, "existing + new passkey");
    assert!(creds.contains(&old_cred), "existing passkey untouched");

    let valid: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(valid, 1, "old sessions revoked, one new issued");
}

// [covers:auth-register.invitation-single-use]
#[tokio::test]
async fn invitation_token_is_single_use() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    let user = register_with_token(&mut client, &router, &pool, &token, Some("first"), None).await;
    assert!(user > 0);

    // second attempt with the same token
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "second"
            }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(users, 1, "no second user");
}

// [covers:auth-register.ceremony-single-use]
#[tokio::test]
async fn ceremony_cookie_is_single_use() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "once"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    let first = client
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(first.status(), 200);
    // replay the same ceremony cookie: the row is gone
    let second = client
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-register.ceremony-expiry-rejected]
#[tokio::test]
async fn expired_ceremony_is_rejected() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({
                "token": token, "display_name": "late"
            }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    client.store_cookies(&resp);
    let ccr: webauthn_rs::prelude::CreationChallengeResponse =
        serde_json::from_value(body_json(resp).await).unwrap();
    let cred = client.register(ccr);
    sqlx::query("UPDATE webauthn_ceremonies SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/finish",
            serde_json::json!({ "credential": cred }),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// [covers:auth-register.label-default-from-user-agent]
#[tokio::test]
async fn label_defaults_from_user_agent() {
    let (router, pool) = setup().await;

    // no label -> UA-derived default (client sends "test-agent Chrome/130.0")
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    register_with_token(&mut client, &router, &pool, &token, Some("unlabeled"), None).await;
    let label: Option<String> = sqlx::query_scalar(
        "SELECT label FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'unlabeled'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        label.as_deref().is_some_and(|l| !l.is_empty()),
        "default label {label:?}"
    );

    // explicit label wins
    let mut client = Client::new();
    let token = issue_setup_token(&pool, "n").await;
    register_with_token(
        &mut client,
        &router,
        &pool,
        &token,
        Some("labeled"),
        Some("my key"),
    )
    .await;
    let label: Option<String> = sqlx::query_scalar(
        "SELECT label FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE u.display_name = 'labeled'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(label.as_deref(), Some("my key"));
}

// [covers:auth-register.exclude-lists-existing-credentials]
#[tokio::test]
async fn recovery_start_excludes_existing_credentials() {
    let (router, pool) = setup().await;
    let mut client = Client::new();
    let user = register_setup_user(&mut client, &router, &pool, "excluded").await;
    let existing: Vec<u8> =
        sqlx::query_scalar("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();

    let token = issue_recovery_token(&pool, user).await;
    let resp = client
        .post(
            &router,
            "/api/webauthn/register/start",
            serde_json::json!({ "token": token }),
        )
        .await;
    assert_eq!(resp.status(), 200);
    let body = body_json(resp).await;
    let excludes = body["publicKey"]["excludeCredentials"]
        .as_array()
        .expect("excludeCredentials present");
    assert_eq!(excludes.len(), 1);
    assert_eq!(excludes[0]["type"], "public-key");
    assert_eq!(excludes[0]["id"].as_str().unwrap(), b64(&existing));
}
