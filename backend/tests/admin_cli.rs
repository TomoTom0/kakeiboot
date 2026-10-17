//! Operator CLI tests (spec_auth.md section 9): argument validation is
//! covered by unit tests in src/admin.rs; these exercise the DB-facing
//! commands and confirmation flows with a scripted prompter.

mod common;

use budget_book::admin::{Cli, ScriptedPrompter, run_with, validate_args};
use budget_book::auth::invitation::{self, InvitationKind};
use clap::Parser;
use common::auth::*;
use sqlx::SqlitePool;

fn cli(args: &[&str]) -> Cli {
    Cli::parse_from(
        std::iter::once("budget-book-admin".to_string()).chain(args.iter().map(|s| s.to_string())),
    )
}

/// Non-exiting parse for argv that is only valid once the register token
/// kind lands (`--kind register` makes `cli` exit the process before that).
fn try_cli(args: &[&str]) -> Result<Cli, clap::Error> {
    Cli::try_parse_from(
        std::iter::once("budget-book-admin".to_string()).chain(args.iter().map(|s| s.to_string())),
    )
}

async fn setup() -> SqlitePool {
    common::mem_pool().await
}

fn script(lines: &[&str]) -> ScriptedPrompter {
    ScriptedPrompter {
        lines: lines.iter().map(|s| s.to_string()).collect(),
    }
}

// [covers:auth-cli.user-list-search]
#[tokio::test]
async fn user_list_searches_name_note_number_ledger() {
    let pool = setup().await;
    let alice = create_user_direct(&pool, "Alice", Some("wife")).await;
    let _bob = create_user_direct(&pool, "Bob", Some("golf friend")).await;
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(alice)
        .fetch_one(&pool)
        .await
        .unwrap();

    // partial display name
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "list", "--query", "lic"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Alice"), "{text}");
    assert!(!text.contains("Bob"), "{text}");

    // admin_note partial
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "list", "--query", "golf"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Bob") && !text.contains("Alice"), "{text}");

    // account number, normalized (lowercase, no BB-, no hyphens)
    let normalized = budget_book::auth::tokens::normalize_account_number(&account);
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "list", "--query", &normalized]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Alice") && !text.contains("Bob"), "{text}");

    // ledger filter by name
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "list", "--ledger", "Aliceの家計簿"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("Alice") && !text.contains("Bob"), "{text}");
}

// [covers:auth-cli.user-show-details]
#[tokio::test]
async fn user_show_presents_lineage_and_passkeys() {
    let pool = setup().await;
    let owner = create_user_direct(&pool, "Owner", Some("me")).await;
    let owner_ledger: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(owner)
        .fetch_one(&pool)
        .await
        .unwrap();

    // invite-style user with lineage + a passkey + a session + a grant
    let handle: Vec<u8> = uuid::Uuid::new_v4().into_bytes().to_vec();
    let invitee: i64 = sqlx::query_scalar(
        "INSERT INTO users (webauthn_user_handle, account_number, display_name, admin_note, invite_note, invited_by, invited_via_kind, default_ledger_id, created_at, updated_at)
         VALUES (?, 'BB-0000-0099', 'Invitee', 'op note', 'inviter note', ?, 'invite', ?, 0, 0) RETURNING id",
    )
    .bind(handle)
    .bind(owner)
    .bind(owner_ledger)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO webauthn_credentials (user_id, credential_id, passkey_json, label, created_at, updated_at) VALUES (?, x'01', '{}', 'phone', 0, 0)")
        .bind(invitee)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (x'02', ?, 0, 0, 0, 99999999999999, 99999999999999)")
        .bind(invitee)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES ('https://chatgpt.com/x', '{}', '[]', 'none', 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, created_at, absolute_expires_at)
         VALUES (?, 'https://chatgpt.com/x', 'ledger.read', 'https://localhost/mcp', 0, 99999999999999)",
    )
    .bind(invitee)
    .execute(&pool)
    .await
    .unwrap();

    // by account number
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "show", "bb00000099"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("BB-0000-0099"), "{text}");
    assert!(text.contains("op note"), "{text}");
    assert!(
        text.contains(&format!("invited_by: user {owner}")),
        "{text}"
    );
    assert!(text.contains("invite"), "{text}");
    assert!(text.contains("\"phone\""), "{text}");
    assert!(text.contains("active web sessions: 1"), "{text}");
    assert!(text.contains("active grants (1)"), "{text}");

    // by id
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "show", &invitee.to_string()]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    assert!(String::from_utf8(out).unwrap().contains("Invitee"));
}

// [covers:auth-cli.recovery-issue-confirmation]
#[tokio::test]
async fn recovery_issue_requires_display_name_reentry() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Confirm Me", None).await;

    // wrong display name -> aborted, nothing issued
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
        ]),
        &mut script(&["Wrong Name"]),
        &mut out,
    )
    .await;
    assert!(res.is_err());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // correct display name -> issued, URL printed once
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
        ]),
        &mut script(&["Confirm Me"]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("/register?token="), "{text}");
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invitations WHERE kind = 'recovery' AND used_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 1);

    // --yes skips the prompt entirely
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
            "--yes",
        ]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invitations WHERE kind = 'recovery' AND used_at IS NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 1, "old one replaced, still exactly one open recovery");
}

// [covers:auth-invitation.recovery-single-open-per-user]
#[tokio::test]
async fn recovery_token_is_single_open_per_user() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Open", None).await;

    let t1 = issue_recovery_token(&pool, user).await;
    let t2 = issue_recovery_token(&pool, user).await;
    assert_ne!(t1, t2);
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invitations WHERE kind = 'recovery' AND target_user_id = ? AND used_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 1, "old open recovery deleted on issue");
    // the surviving row is the new one
    let raw: [u8; 32] = budget_book::auth::tokens::b64url_decode(&t2)
        .unwrap()
        .try_into()
        .unwrap();
    let hash = budget_book::auth::tokens::sha256(&raw).to_vec();
    let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invitations WHERE token_hash = ?")
        .bind(&hash)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(exists, 1);
}

// [covers:auth-cli.token-revoke]
#[tokio::test]
async fn token_revoke_by_prefix() {
    let pool = setup().await;
    let token = invitation::issue(
        &pool,
        &invitation::NewInvitation {
            kind: InvitationKind::Setup,
            operator_note: Some("n".into()),
            target_user_id: None,
            created_by: None,
            ledger_id: None,
            role: None,
            inviter_note: None,
            ttl_ms: 3_600_000,
        },
        0,
    )
    .await
    .unwrap();
    let raw: [u8; 32] = budget_book::auth::tokens::b64url_decode(&token)
        .unwrap()
        .try_into()
        .unwrap();
    let hash = budget_book::auth::tokens::sha256(&raw).to_vec();
    let prefix = budget_book::auth::tokens::to_hex(&hash)[..8].to_string();

    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", &prefix]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    assert!(String::from_utf8(out).unwrap().contains("deleted token"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // unknown prefix
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", "ffffffff"]),
        &mut script(&[]),
        &mut out,
    )
    .await;
    assert!(res.is_err());

    // ambiguous prefix: two crafted rows sharing a prefix
    sqlx::query("INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at) VALUES (x'aabbccdd00000000', 'setup', 'a', 0, 1)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at) VALUES (x'aabbccddffffffff', 'setup', 'b', 0, 1)")
        .execute(&pool)
        .await
        .unwrap();
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", "aabbccdd"]),
        &mut script(&[]),
        &mut out,
    )
    .await;
    assert!(res.is_err(), "ambiguous prefix rejected");
}

// [covers:auth-invitation.cli-register-issue-rejected]
#[test]
fn token_issue_register_kind_rejected() {
    // register tokens are web-only, symmetric to the invite bail
    let cli = try_cli(&["token", "issue", "--kind", "register"])
        .expect("--kind register parses once TokenKind::Register lands");
    let err = validate_args(&cli).expect_err("register issuance is web-only");
    assert!(
        err.to_string().contains("web UI"),
        "error should say register is issued from the web UI: {err}"
    );
}

// [covers:auth-invitation.cli-token-list-register]
#[test]
fn token_list_register_with_user_rejected() {
    // --user narrows recovery targets (an invitations-only concept);
    // pairing it with --kind register would list user-unrelated rows
    let cli = try_cli(&["token", "list", "--kind", "register", "--user", "5"])
        .expect("--kind register parses for list");
    let err = validate_args(&cli).expect_err("--kind register cannot pair with --user");
    assert!(
        err.to_string().contains("not user-scoped"),
        "error should say register tokens are not user-scoped: {err}"
    );
}

// [covers:auth-invitation.cli-token-list-register]
#[tokio::test]
async fn token_list_and_revoke_cover_register_invitations() {
    let pool = setup().await;
    common::insert_user(&pool, 1).await; // created_by of the register row
    common::insert_ledger(&pool, 1).await;
    common::insert_member(&pool, 1, 1, "owner").await;

    // an invite token (created_at = 0) in `invitations` ...
    invitation::issue(
        &pool,
        &invitation::NewInvitation {
            kind: InvitationKind::Invite,
            operator_note: None,
            target_user_id: None,
            created_by: Some(1),
            ledger_id: Some(1),
            role: Some("editor".into()),
            inviter_note: Some("family".into()),
            ttl_ms: 3_600_000,
        },
        0,
    )
    .await
    .unwrap();
    // ... and a register row (created_at = 1, so it sorts first)
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at)
         VALUES (x'1100000000000000', 1, '妹に渡す分', 1, 9_000_000_000_000)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // list without --kind: both tables merged, created_at descending, the
    // register row shown with issued_by= and the inviter: note prefix
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "list"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    let register_pos = text
        .find("register issued_by=1")
        .unwrap_or_else(|| panic!("register row with issued_by in: {text}"));
    let invite_pos = text
        .find(" invite ")
        .unwrap_or_else(|| panic!("invite row in: {text}"));
    assert!(
        register_pos < invite_pos,
        "merged list is created_at descending: {text}"
    );
    assert!(
        text.contains("inviter: 妹に渡す分"),
        "inviter note is marked as inviter: {text}"
    );

    // --kind register: only the register_invitations table
    let register_only = try_cli(&["token", "list", "--kind", "register"])
        .expect("--kind register parses once TokenKind::Register lands");
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &register_only,
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("register issued_by=1"), "{text}");
    assert!(
        !text.contains(" invite "),
        "invite rows are excluded: {text}"
    );

    // revoke resolves the prefix across both tables: a unique register hit
    // deletes the row (freeing an open-limit slot) and audits
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", "11000000"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    assert!(String::from_utf8(out).unwrap().contains("deleted token"));
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM register_invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events
         WHERE entity_type = 'register_invitation' AND action = 'token_revoke'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audited, 1, "register revoke audited");

    // zero hits across both tables
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", "ffffffff"]),
        &mut script(&[]),
        &mut out,
    )
    .await;
    assert!(res.is_err(), "unknown prefix rejected");

    // one hit in each table sharing a prefix: ambiguous
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at)
         VALUES (x'aabbccdd00000000', 'setup', 'a', 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at)
         VALUES (x'aabbccddffffffff', 1, 'b', 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", "aabbccdd"]),
        &mut script(&[]),
        &mut out,
    )
    .await;
    assert!(
        res.is_err(),
        "one row per table sharing a prefix is ambiguous"
    );
}

// [covers:auth-cli.passkey-revoke-last-requires-account-number]
#[tokio::test]
async fn passkey_revoke_last_one_requires_account_number() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Solo", None).await;
    sqlx::query("INSERT INTO webauthn_credentials (user_id, credential_id, passkey_json, created_at, updated_at) VALUES (?, x'01', '{}', 0, 0)")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // display name only -> not enough for the last one
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["passkey", "revoke", &user.to_string(), "1"]),
        &mut script(&["Solo"]),
        &mut out,
    )
    .await;
    assert!(res.is_err(), "last passkey needs the account number too");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "nothing deleted");

    // wrong account number -> aborted
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["passkey", "revoke", &user.to_string(), "1"]),
        &mut script(&["Solo", "BB-0000-0000"]),
        &mut out,
    )
    .await;
    assert!(res.is_err());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // correct display name + account number -> revoked
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["passkey", "revoke", &user.to_string(), "1"]),
        &mut script(&["Solo", &account]),
        &mut out,
    )
    .await
    .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM webauthn_credentials WHERE user_id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

// [covers:auth-cli.user-disable-revokes-all]
#[tokio::test]
async fn user_disable_revokes_sessions_and_grants() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Victim", None).await;
    for h in [0x11u8, 0x22] {
        sqlx::query("INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, 0, 0, 0, 99999999999999, 99999999999999)")
            .bind(vec![h; 32])
            .bind(user)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES ('https://chatgpt.com/x', '{}', '[]', 'none', 0, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, created_at, absolute_expires_at)
         VALUES (?, 'https://chatgpt.com/x', 'ledger.read', 'https://localhost/mcp', 0, 99999999999999)",
    )
    .bind(user)
    .execute(&pool)
    .await
    .unwrap();
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // wrong display name -> aborted, nothing changed
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "disable", &user.to_string()]),
        &mut script(&["Nope", &account]),
        &mut out,
    )
    .await;
    assert!(res.is_err());
    let disabled: Option<i64> = sqlx::query_scalar("SELECT disabled_at FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(disabled, None);

    // correct inputs
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "disable", &user.to_string()]),
        &mut script(&["Victim", &account]),
        &mut out,
    )
    .await
    .unwrap();
    let disabled: Option<i64> = sqlx::query_scalar("SELECT disabled_at FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(disabled.is_some());
    let sessions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sessions, 0);
    let grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grants, 0);
    let reason: Option<String> =
        sqlx::query_scalar("SELECT revoked_reason FROM oauth_grants WHERE user_id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("admin"));
}

// [covers:auth-invitation.recovery-ttl-bounds]
#[tokio::test]
async fn recovery_ttl_over_24h_is_rejected() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Over", None).await;

    // --ttl beyond the 24h cap is rejected at issue time
    let mut out = Vec::new();
    let res = run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
            "--ttl",
            "25h",
            "--yes",
        ]),
        &mut script(&[]),
        &mut out,
    )
    .await;
    assert!(res.is_err(), "25h must be rejected (capped at 24h)");
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "nothing issued");

    // exactly 24h is accepted
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
            "--ttl",
            "24h",
            "--yes",
        ]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invitations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

// [covers:auth-cli.audits-system-actions]
#[tokio::test]
async fn cli_actions_are_audited_as_system() {
    let pool = setup().await;
    let user = create_user_direct(&pool, "Audited", Some("orig")).await;
    sqlx::query("INSERT INTO webauthn_credentials (user_id, credential_id, passkey_json, created_at, updated_at) VALUES (?, x'01', '{}', 0, 0)")
        .bind(user)
        .execute(&pool)
        .await
        .unwrap();
    let account: String = sqlx::query_scalar("SELECT account_number FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();

    // token issue (recovery), token revoke, user note
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&[
            "token",
            "issue",
            "--kind",
            "recovery",
            "--user",
            &user.to_string(),
            "--yes",
        ]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let url = String::from_utf8(out)
        .unwrap()
        .lines()
        .find(|l| l.contains("token="))
        .unwrap()
        .to_string();
    let token = url.split("token=").nth(1).unwrap().to_string();
    let raw: [u8; 32] = budget_book::auth::tokens::b64url_decode(&token)
        .unwrap()
        .try_into()
        .unwrap();
    let hash = budget_book::auth::tokens::sha256(&raw).to_vec();
    let prefix = budget_book::auth::tokens::to_hex(&hash)[..8].to_string();
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["token", "revoke", &prefix]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["user", "note", &user.to_string(), "updated note"]),
        &mut script(&[]),
        &mut out,
    )
    .await
    .unwrap();
    let mut out = Vec::new();
    run_with(
        &pool,
        &common::repo_config(),
        &cli(&["passkey", "revoke", &user.to_string(), "1"]),
        &mut script(&["Audited", &account]),
        &mut out,
    )
    .await
    .unwrap();

    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, after_json FROM audit_events WHERE actor_kind = 'system' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let actions: Vec<&str> = rows.iter().map(|(a, _)| a.as_str()).collect();
    for expected in ["token_issue", "token_revoke", "user_note", "passkey_revoke"] {
        assert!(
            actions.contains(&expected),
            "missing {expected} in {actions:?}"
        );
    }
    for (action, after) in &rows {
        assert!(
            after.contains("os_user"),
            "{action} after_json must carry the OS user"
        );
        assert!(!after.contains(&token), "no token plaintext in audit");
    }
    // the note update persisted
    let note: String = sqlx::query_scalar("SELECT admin_note FROM users WHERE id = ?")
        .bind(user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(note, "updated note");
}
