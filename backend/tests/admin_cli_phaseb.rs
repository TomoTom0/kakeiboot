//! TASK-10 Phase B: operator CLI additions (spec_auth.md section 9) — grant
//! list / revoke, session list / revoke, recovery request triage.

mod common;

use budget_book::admin::{Cli, Prompter, ScriptedPrompter, run_with};
use budget_book::config::Config;
use clap::Parser as _;
use common::auth;
use common::oauth;

fn cli(args: &[&str]) -> Cli {
    Cli::try_parse_from(
        std::iter::once("budget-book-admin".to_string()).chain(args.iter().map(|s| s.to_string())),
    )
    .expect("parse")
}

async fn run(pool: &sqlx::SqlitePool, cfg: &Config, args: &[&str], prompter: Prompter2) -> String {
    let mut out: Vec<u8> = Vec::new();
    let mut p = prompter.into_prompter();
    run_with(pool, cfg, &cli(args), p.as_mut(), &mut out)
        .await
        .expect("cli run");
    String::from_utf8(out).unwrap()
}

/// Prompter wrapper so tests can pass either scripted or empty input.
pub enum Prompter2 {
    Lines(Vec<String>),
    None,
}

impl Prompter2 {
    fn into_prompter(self) -> Box<dyn Prompter> {
        match self {
            Self::Lines(lines) => Box::new(ScriptedPrompter { lines }),
            Self::None => Box::new(EmptyPrompter),
        }
    }
}

struct EmptyPrompter;

impl Prompter for EmptyPrompter {
    fn read_line(&mut self) -> std::io::Result<String> {
        Ok(String::new())
    }
}

// [covers:auth-cli.grant-list-revoke]
#[tokio::test]
async fn grant_list_and_revoke() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Grant Holder", Some("holder note")).await;
    let grant1 = oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/x",
        "ledger.read",
        None,
    )
    .await;
    let _grant2 = oauth::insert_grant(
        &pool,
        user,
        "https://chatgpt.com/clients/y",
        "ledger.read ledger.write",
        None,
    )
    .await;
    let access = oauth::insert_access_token(&pool, grant1).await;

    let out = run(
        &pool,
        &cfg,
        &["grant", "list", &user.to_string()],
        Prompter2::None,
    )
    .await;
    assert!(out.contains(&format!("grant {grant1}")), "{out}");
    assert!(out.contains("https://chatgpt.com/clients/x"), "{out}");
    assert!(out.contains("2 active grant(s)"), "{out}");

    // display-name mismatch aborts
    let result = {
        let mut out: Vec<u8> = Vec::new();
        let mut p = Box::new(ScriptedPrompter {
            lines: vec!["wrong name".into()],
        }) as Box<dyn Prompter>;
        run_with(
            &pool,
            &cfg,
            &cli(&["grant", "revoke", &grant1.to_string()]),
            p.as_mut(),
            &mut out,
        )
        .await
    };
    let err = result.expect_err("name mismatch aborts").to_string();
    assert!(err.contains("mismatch"), "{err}");
    let revoked: Option<i64> =
        sqlx::query_scalar("SELECT revoked_at FROM oauth_grants WHERE id = ?")
            .bind(grant1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.is_none(), "aborted before revoking");

    // correct confirmation revokes with reason admin + audit
    let out = run(
        &pool,
        &cfg,
        &["grant", "revoke", &grant1.to_string()],
        Prompter2::Lines(vec!["Grant Holder".into()]),
    )
    .await;
    assert!(out.contains("revoked 1 grant(s)"), "{out}");
    let (revoked, reason): (Option<i64>, Option<String>) =
        sqlx::query_as("SELECT revoked_at, revoked_reason FROM oauth_grants WHERE id = ?")
            .bind(grant1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(revoked.is_some());
    assert_eq!(reason.as_deref(), Some("admin"));
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE entity_type = 'oauth_grant' AND action = 'grant_revoke' AND actor_kind = 'system'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit > 0);

    // the token under the revoked grant no longer authenticates
    let state = budget_book::app::AppState::new(&cfg, pool.clone()).unwrap();
    let router = budget_book::app::router(&cfg, state, tokio_util::sync::CancellationToken::new());
    let resp = oauth::post_form(
        &router,
        "/mcp",
        "{}",
        &[("authorization", format!("Bearer {access}"))],
    )
    .await;
    assert_eq!(resp.status(), 401);

    // --all-of wipes the rest
    let out = run(
        &pool,
        &cfg,
        &["grant", "revoke", "--all-of", &user.to_string()],
        Prompter2::Lines(vec!["Grant Holder".into()]),
    )
    .await;
    assert!(out.contains("revoked 1 grant(s)"), "{out}");
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

// [covers:auth-cli.session-list-revoke]
#[tokio::test]
async fn session_list_and_revoke() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Session Holder", None).await;
    // two session rows with distinct hashes
    async fn mk_session(pool: &sqlx::SqlitePool, user: i64, seed: u8, ua: &str) {
        let raw = [seed; 32];
        sqlx::query(
            "INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at,
                 idle_expires_at, absolute_expires_at, user_agent)
             VALUES (?, ?, 1000, 1000, 1000, ?, ?, ?)",
        )
        .bind(budget_book::auth::tokens::sha256(&raw).to_vec())
        .bind(user)
        .bind(budget_book::auth::session::now_ms() + 30 * 86_400_000)
        .bind(budget_book::auth::session::now_ms() + 30 * 86_400_000)
        .bind(ua)
        .execute(pool)
        .await
        .unwrap();
    }
    mk_session(&pool, user, b'a', "ua-a").await;
    mk_session(&pool, user, b'b', "ua-b").await;

    let out = run(
        &pool,
        &cfg,
        &["session", "list", &user.to_string()],
        Prompter2::None,
    )
    .await;
    assert!(out.contains("2 active session(s)"), "{out}");
    assert!(out.matches("session ").count() >= 2, "{out}");
    // hash prefixes shown (8 hex)
    let hash_a: String = {
        let raw: [u8; 32] = [b'a'; 32];
        budget_book::auth::tokens::to_hex(&budget_book::auth::tokens::sha256(&raw))[..8].to_string()
    };
    assert!(out.contains(&hash_a), "{out}");

    // revoke by prefix (first 8 hex of session a)
    let out = run(
        &pool,
        &cfg,
        &["session", "revoke", &hash_a],
        Prompter2::Lines(vec!["Session Holder".into()]),
    )
    .await;
    assert!(out.contains("revoked 1 session(s)"), "{out}");
    let left: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 1);

    // --all-of takes the rest, audit recorded
    let out = run(
        &pool,
        &cfg,
        &["session", "revoke", "--all-of", &user.to_string()],
        Prompter2::Lines(vec!["Session Holder".into()]),
    )
    .await;
    assert!(out.contains("revoked 1 session(s)"), "{out}");
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'session_revoke' AND actor_kind = 'system'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit >= 2);
}

// recovery request fixtures (the MCP tool itself is implementation-gated)
async fn insert_recovery(
    pool: &sqlx::SqlitePool,
    request_number: &str,
    subject: Option<&[u8]>,
    candidates: &[(i64, &str)],
) -> i64 {
    let now = budget_book::auth::session::now_ms();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO recovery_requests (request_number, status, subject_hash, ip_hash, note, created_at)
         VALUES (?, 'open', ?, x'0000000000000000', ?, ?) RETURNING id",
    )
    .bind(request_number)
    .bind(subject)
    .bind("help me")
    .bind(now)
    .fetch_one(pool)
    .await
    .unwrap();
    for (user_id, source) in candidates {
        sqlx::query(
            "INSERT INTO recovery_request_candidates (request_id, user_id, source) VALUES (?, ?, ?)",
        )
        .bind(id)
        .bind(user_id)
        .bind(source)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

// [covers:auth-cli.recovery-list-show]
#[tokio::test]
async fn recovery_list_and_show() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user1 = auth::create_user_direct(&pool, "Candidate One", Some("c1 note")).await;
    let user2 = auth::create_user_direct(&pool, "Candidate Two", None).await;
    let subject: Vec<u8> = vec![1u8; 32];
    insert_recovery(
        &pool,
        "R-ABCD",
        Some(&subject),
        &[(user1, "subject"), (user1, "bearer"), (user2, "subject")],
    )
    .await;
    insert_recovery(&pool, "R-EFGH", None, &[]).await;
    // overflow for today
    let today = {
        let secs = budget_book::auth::session::now_ms().div_euclid(1000) + 9 * 3600;
        let days = secs.div_euclid(86_400);
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let mth = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if mth <= 2 { y + 1 } else { y };
        format!("{y:04}-{mth:02}-{d:02}")
    };
    sqlx::query("INSERT INTO recovery_overflow_daily (day, count) VALUES (?, 3)")
        .bind(&today)
        .execute(&pool)
        .await
        .unwrap();

    let out = run(&pool, &cfg, &["recovery", "list"], Prompter2::None).await;
    assert!(out.contains("overflow today"), "{out}");
    assert!(out.contains("3 request(s) not accepted"), "{out}");
    assert!(out.contains("R-ABCD [open]"), "{out}");
    assert!(out.contains("2 request(s)"), "{out}");

    // status filter
    let out = run(
        &pool,
        &cfg,
        &["recovery", "list", "--status", "open"],
        Prompter2::None,
    )
    .await;
    assert!(out.contains("2 request(s)"), "{out}");

    let out = run(
        &pool,
        &cfg,
        &["recovery", "show", "R-ABCD"],
        Prompter2::None,
    )
    .await;
    assert!(out.contains("R-ABCD [open]"), "{out}");
    assert!(out.contains("note: help me"), "{out}");
    assert!(out.contains(&format!("candidate user {user1}")), "{out}");
    assert!(out.contains(&format!("candidate user {user2}")), "{out}");
    assert!(out.contains("evidence=subject"), "{out}");
    assert!(out.contains("evidence=bearer"), "{out}");
    assert!(out.contains("c1 note"), "{out}");
}

// [covers:auth-cli.recovery-resolve]
#[tokio::test]
async fn recovery_resolve_issues_token_and_closes() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Resolve Target", None).await;
    let other = auth::create_user_direct(&pool, "Not Candidate", None).await;
    let subject: Vec<u8> = vec![2u8; 32];
    insert_recovery(&pool, "R-RES1", Some(&subject), &[(user, "subject")]).await;

    // --yes skips the re-entry; candidate user resolves
    let out = run(
        &pool,
        &cfg,
        &[
            "recovery",
            "resolve",
            "R-RES1",
            "--user",
            &user.to_string(),
            "--yes",
        ],
        Prompter2::None,
    )
    .await;
    assert!(out.contains("/register?token="), "{out}");
    let (status, close_note): (String, Option<String>) = sqlx::query_as(
        "SELECT status, close_note FROM recovery_requests WHERE request_number = 'R-RES1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "resolved");
    assert!(close_note.unwrap().contains(&user.to_string()), "{out}");
    // an unused recovery token exists for the user (exactly one)
    let tokens: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM invitations WHERE kind = 'recovery' AND target_user_id = ? AND used_at IS NULL",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tokens, 1);
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE action = 'recovery_resolve' AND actor_kind = 'system'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit > 0);
    // the URL token never appears in audit
    let audit_tokens: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE after_json LIKE '%register?token=%'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit_tokens, 0);

    // already closed -> error
    let result = {
        let mut out: Vec<u8> = Vec::new();
        let mut p = Box::new(ScriptedPrompter { lines: vec![] }) as Box<dyn Prompter>;
        run_with(
            &pool,
            &cfg,
            &cli(&[
                "recovery",
                "resolve",
                "R-RES1",
                "--user",
                &user.to_string(),
                "--yes",
            ]),
            p.as_mut(),
            &mut out,
        )
        .await
    };
    assert!(result.is_err());

    // non-candidate user requires a reason (empty reason aborts)
    insert_recovery(&pool, "R-RES2", None, &[(user, "bearer")]).await;
    let result = {
        let mut out: Vec<u8> = Vec::new();
        let mut p = Box::new(ScriptedPrompter {
            lines: vec![String::new()],
        }) as Box<dyn Prompter>;
        run_with(
            &pool,
            &cfg,
            &cli(&[
                "recovery",
                "resolve",
                "R-RES2",
                "--user",
                &other.to_string(),
                "--yes",
            ]),
            p.as_mut(),
            &mut out,
        )
        .await
    };
    let err = result.expect_err("empty reason aborts").to_string();
    assert!(err.contains("reason is required"), "{err}");
    let status: String =
        sqlx::query_scalar("SELECT status FROM recovery_requests WHERE request_number = 'R-RES2'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "open", "aborted before resolving");
    // with a reason it resolves and records the reason in audit
    let out = run(
        &pool,
        &cfg,
        &[
            "recovery",
            "resolve",
            "R-RES2",
            "--user",
            &other.to_string(),
            "--yes",
        ],
        Prompter2::Lines(vec!["verified by phone".into()]),
    )
    .await;
    assert!(out.contains("/register?token="), "{out}");
    let audit_note: String = sqlx::query_scalar(
        "SELECT after_json FROM audit_events WHERE action = 'recovery_resolve' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(audit_note.contains("verified by phone"), "{audit_note}");
}

// [covers:auth-cli.recovery-reject]
#[tokio::test]
async fn recovery_reject_closes_with_note() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    insert_recovery(&pool, "R-REJ1", None, &[]).await;
    let out = run(
        &pool,
        &cfg,
        &["recovery", "reject", "R-REJ1", "--reason", "prank"],
        Prompter2::None,
    )
    .await;
    assert!(out.contains("rejected R-REJ1"), "{out}");
    let (status, close_note): (String, String) = sqlx::query_as(
        "SELECT status, close_note FROM recovery_requests WHERE request_number = 'R-REJ1'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(status, "rejected");
    assert_eq!(close_note, "prank");
    let audit: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'recovery_reject'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(audit > 0);
    // double reject errors
    let result = {
        let mut out: Vec<u8> = Vec::new();
        let mut p = Box::new(ScriptedPrompter { lines: vec![] }) as Box<dyn Prompter>;
        run_with(
            &pool,
            &cfg,
            &cli(&["recovery", "reject", "R-REJ1"]),
            p.as_mut(),
            &mut out,
        )
        .await
    };
    assert!(result.is_err());
}

// [covers:auth-cleanup.loop-runs]
#[tokio::test]
async fn cleanup_loop_sweeps_at_interval() {
    let pool = common::mem_pool().await;
    // an expired auth code row (expires_at + 1 day < now)
    let client_id = "https://chatgpt.com/clients/x";
    let user = auth::create_user_direct(&pool, "Cleanup", None).await;
    sqlx::query(
        "INSERT OR IGNORE INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at) VALUES (?, '{}', '[]', 'none', 0, 0)",
    )
    .bind(client_id)
    .execute(&pool)
    .await
    .unwrap();
    let now = budget_book::auth::session::now_ms();
    sqlx::query(
        "INSERT INTO oauth_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (x'11', ?, ?, 'r', 'c', 's', 'res', ?, ?)",
    )
    .bind(user)
    .bind(client_id)
    .bind(now - 2 * 86_400_000)
    .bind(now - 86_400_000 - 1)
    .execute(&pool)
    .await
    .unwrap();
    let ct = tokio_util::sync::CancellationToken::new();
    let task = tokio::spawn(budget_book::maintenance::run_cleanup_loop(
        pool.clone(),
        std::path::PathBuf::from("/nonexistent-image-root"),
        1,
        ct.child_token(),
    ));
    // the startup sweep removes it within a short wait
    let mut gone = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_auth_codes")
            .fetch_one(&pool)
            .await
            .unwrap();
        if count == 0 {
            gone = true;
            break;
        }
    }
    ct.cancel();
    let _ = task.await;
    assert!(gone, "startup sweep removed the expired code");
}
