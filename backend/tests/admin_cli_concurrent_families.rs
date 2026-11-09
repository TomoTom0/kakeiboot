//! TASK-155: operator CLI read-only inquiry `admin grant concurrent-families`
//! — grants whose refresh token family still holds two or more concurrent
//! tips. Detection follows the 0012 tip definition (design doc
//! tmp/tasks/tm-155/design_family_inquiry.md): a tip is an unused
//! (`used_at IS NULL`), unrevoked (`revoked_at IS NULL`) row referenced by
//! some row's `child_hash`. Expired tips count; dead grants are listed with
//! their state; only the referencing parent rows' deletion hides a family.

mod common;

use budget_book::admin::{Cli, ScriptedPrompter, ms_to_jst, run_with};
use budget_book::auth::tokens::to_hex;
use budget_book::config::Config;
use clap::Parser as _;
use common::{auth, oauth};

fn cli(args: &[&str]) -> Cli {
    Cli::try_parse_from(
        std::iter::once("budget-book-admin".to_string()).chain(args.iter().map(|s| s.to_string())),
    )
    .expect("parse")
}

/// Run the CLI with the given args (the inquiry never prompts).
async fn run(pool: &sqlx::SqlitePool, cfg: &Config, args: &[&str]) -> String {
    let mut out: Vec<u8> = Vec::new();
    let mut p = ScriptedPrompter { lines: vec![] };
    run_with(pool, cfg, &cli(args), &mut p, &mut out)
        .await
        .expect("cli run");
    String::from_utf8(out).unwrap()
}

fn hash8(hash: &[u8]) -> String {
    to_hex(hash)[..8].to_string()
}

/// Insert an unused, unrevoked refresh row (tip candidate); returns its hash.
async fn tip(pool: &sqlx::SqlitePool, grant_id: i64) -> Vec<u8> {
    let token = oauth::insert_refresh_token(pool, grant_id, None, None).await;
    oauth::token_hash(&token)
}

/// Insert a used row whose `child_hash` references `child` (a parent in the
/// family tree); returns the parent's own hash. Rotation only ever sets the
/// child pointer on used rows, so parents carry no `parent_hash`.
async fn parent_of(pool: &sqlx::SqlitePool, grant_id: i64, child: &[u8]) -> Vec<u8> {
    let token = oauth::insert_refresh_token(pool, grant_id, Some(0), Some(child.to_vec())).await;
    oauth::token_hash(&token)
}

/// The S1 residue shape: two used parents each referencing its own unused
/// tip, i.e. two live branches of one grant's family.
/// Returns (tip1, tip2, parent1, parent2) token hashes.
async fn concurrent_pair(
    pool: &sqlx::SqlitePool,
    grant_id: i64,
) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let tip1 = tip(pool, grant_id).await;
    let tip2 = tip(pool, grant_id).await;
    let parent1 = parent_of(pool, grant_id, &tip1).await;
    let parent2 = parent_of(pool, grant_id, &tip2).await;
    (tip1, tip2, parent1, parent2)
}

/// Overwrite a refresh row's timestamps with fixed values.
async fn set_times(pool: &sqlx::SqlitePool, token_hash: &[u8], created: i64, expires: i64) {
    sqlx::query(
        "UPDATE oauth_refresh_tokens SET created_at = ?, expires_at = ? WHERE token_hash = ?",
    )
    .bind(created)
    .bind(expires)
    .bind(token_hash)
    .execute(pool)
    .await
    .unwrap();
}

/// Fixed reference times (distinct so created_at ordering is observable).
const T1: i64 = 1_700_000_000_000;
const T2: i64 = 1_700_086_400_000;

async fn grant_for(pool: &sqlx::SqlitePool, user: i64, client_id: &str) -> i64 {
    oauth::insert_grant(pool, user, client_id, "ledger.read", None).await
}

// [covers:auth-cli.grant-concurrent-detection]
#[tokio::test]
async fn concurrent_pair_is_listed_with_tip_details() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Fork Holder", None).await;
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    let (tip1, tip2, parent1, parent2) = concurrent_pair(&pool, grant).await;
    set_times(&pool, &tip1, T1, T1 + 30 * common::DAY_MS).await;
    set_times(&pool, &tip2, T2, T2 + 30 * common::DAY_MS).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    // grant header line: ids, user, client, state, tip count
    assert!(out.contains(&format!("grant {grant} user {user}")), "{out}");
    assert!(out.contains("Fork Holder"), "{out}");
    assert!(
        out.contains("client=https://chatgpt.com/clients/x"),
        "{out}"
    );
    assert!(out.contains("grant_revoked=-"), "{out}");
    assert!(out.contains("tips=2"), "{out}");
    // tip detail lines: hash8 + parent hash8 via the child_hash reverse
    // lookup (parent_hash column is always NULL) + JST timestamps
    assert!(out.contains(&format!("tip {}", hash8(&tip1))), "{out}");
    assert!(out.contains(&format!("tip {}", hash8(&tip2))), "{out}");
    assert!(
        out.contains(&format!("parent={}", hash8(&parent1))),
        "{out}"
    );
    assert!(
        out.contains(&format!("parent={}", hash8(&parent2))),
        "{out}"
    );
    assert!(out.contains(&format!("created={}", ms_to_jst(T1))), "{out}");
    assert!(
        out.contains(&format!("expires={}", ms_to_jst(T2 + 30 * common::DAY_MS))),
        "{out}"
    );
    // tips are listed in created_at ascending order
    let (pos1, pos2) = (
        out.find(&hash8(&tip1)).expect("tip1 present"),
        out.find(&hash8(&tip2)).expect("tip2 present"),
    );
    assert!(pos1 < pos2, "tips must follow created_at order: {out}");
    // trailing count line
    assert!(out.contains("1 concurrent family(ies), 2 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-single-tip-excluded]
#[tokio::test]
async fn single_tip_grants_are_not_listed() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Normal Holder", None).await;
    // grant A: only the initial token (unused, referenced by nothing)
    let grant_a = grant_for(&pool, user, "https://chatgpt.com/clients/a").await;
    tip(&pool, grant_a).await;
    // grant B: one used parent referencing the single current tip
    let grant_b = grant_for(&pool, user, "https://chatgpt.com/clients/b").await;
    let current = tip(&pool, grant_b).await;
    parent_of(&pool, grant_b, &current).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(!out.contains("tips="), "no family listed: {out}");
    assert!(!out.contains(&hash8(&current)), "{out}");
    assert!(out.contains("0 concurrent family(ies), 0 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-orphan-excluded]
#[tokio::test]
async fn orphan_old_child_is_not_counted() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Orphan Holder", None).await;
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    // live branch: used parent -> current tip
    let current = tip(&pool, grant).await;
    parent_of(&pool, grant, &current).await;
    // superseded orphan: unused, unrevoked, referenced by no row's child_hash
    // (the exact shape migration 0012 revokes)
    let orphan = tip(&pool, grant).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(!out.contains("tips="), "no family listed: {out}");
    assert!(!out.contains(&hash8(&orphan)), "{out}");
    assert!(out.contains("0 concurrent family(ies), 0 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-used-revoked-tip-excluded]
#[tokio::test]
async fn used_and_revoked_rows_are_not_counted_as_tips() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Mixed Holder", None).await;
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    // live tip referenced by a used row
    let live = tip(&pool, grant).await;
    let used_mid = parent_of(&pool, grant, &live).await;
    // a used row still referenced by another row's child_hash is no tip
    parent_of(&pool, grant, &used_mid).await;
    // a revoked unused row referenced by a used row is no tip either
    let revoked = tip(&pool, grant).await;
    sqlx::query("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?")
        .bind(T1)
        .bind(&revoked)
        .execute(&pool)
        .await
        .unwrap();
    parent_of(&pool, grant, &revoked).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(!out.contains("tips="), "only one live tip: {out}");
    assert!(out.contains("0 concurrent family(ies), 0 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-expired-tip-counted]
#[tokio::test]
async fn expired_tip_still_counts() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Expired Tip Holder", None).await;
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    let (tip1, tip2, _, _) = concurrent_pair(&pool, grant).await;
    let now = budget_book::auth::session::now_ms();
    // one tip is already past its refresh expiry; the evidence row survives
    // until the sweep (expires_at + 1 day), so it must still be counted
    let expired_at = now - common::DAY_MS;
    set_times(&pool, &tip1, now - 2 * common::DAY_MS, expired_at).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(out.contains("tips=2"), "{out}");
    assert!(
        out.contains(&format!("expires={}", ms_to_jst(expired_at))),
        "{out}"
    );
    assert!(out.contains(&hash8(&tip1)), "{out}");
    assert!(out.contains(&hash8(&tip2)), "{out}");
    assert!(out.contains("1 concurrent family(ies), 2 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-dead-grant-listed]
#[tokio::test]
async fn revoked_and_expired_grants_are_still_listed() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Dead Grant Holder", None).await;
    let revoked_grant = grant_for(&pool, user, "https://chatgpt.com/clients/r").await;
    let expired_grant = grant_for(&pool, user, "https://chatgpt.com/clients/e").await;
    concurrent_pair(&pool, revoked_grant).await;
    concurrent_pair(&pool, expired_grant).await;
    sqlx::query("UPDATE oauth_grants SET revoked_at = ?, revoked_reason = 'admin' WHERE id = ?")
        .bind(T1)
        .bind(revoked_grant)
        .execute(&pool)
        .await
        .unwrap();
    let past = budget_book::auth::session::now_ms() - common::DAY_MS;
    sqlx::query("UPDATE oauth_grants SET absolute_expires_at = ? WHERE id = ?")
        .bind(past)
        .bind(expired_grant)
        .execute(&pool)
        .await
        .unwrap();

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(
        out.contains(&format!("grant {revoked_grant} user {user}")),
        "{out}"
    );
    assert!(
        out.contains(&format!("grant_revoked={}", ms_to_jst(T1))),
        "{out}"
    );
    assert!(
        out.contains(&format!("grant {expired_grant} user {user}")),
        "{out}"
    );
    assert!(
        out.contains(&format!("grant_expires={}", ms_to_jst(past))),
        "{out}"
    );
    assert!(out.contains("2 concurrent family(ies), 4 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-user-filter]
#[tokio::test]
async fn user_filter_narrows_and_default_spans_users() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user1 = auth::create_user_direct(&pool, "Fork One", None).await;
    let user2 = auth::create_user_direct(&pool, "Fork Two", None).await;
    let grant1 = grant_for(&pool, user1, "https://chatgpt.com/clients/1").await;
    let grant2 = grant_for(&pool, user2, "https://chatgpt.com/clients/2").await;
    concurrent_pair(&pool, grant1).await;
    concurrent_pair(&pool, grant2).await;

    // default: all users (who is affected is not known in advance)
    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(
        out.contains(&format!("grant {grant1} user {user1}")),
        "{out}"
    );
    assert!(
        out.contains(&format!("grant {grant2} user {user2}")),
        "{out}"
    );
    assert!(out.contains("2 concurrent family(ies), 4 tip(s)"), "{out}");

    // --user (id form; account numbers resolve the same way) narrows
    let out = run(
        &pool,
        &cfg,
        &["grant", "concurrent-families", "--user", &user2.to_string()],
    )
    .await;
    assert!(
        out.contains(&format!("grant {grant2} user {user2}")),
        "{out}"
    );
    assert!(!out.contains(&format!("user {user1} ")), "{out}");
    assert!(out.contains("1 concurrent family(ies), 2 tip(s)"), "{out}");
}

// [covers:auth-cli.grant-concurrent-empty]
#[tokio::test]
async fn no_families_prints_zero_count_line() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Quiet Holder", None).await;
    // a perfectly normal single-tip grant exists, still nothing to report
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    let current = tip(&pool, grant).await;
    parent_of(&pool, grant, &current).await;

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(out.contains("0 concurrent family(ies), 0 tip(s)"), "{out}");
    assert!(!out.contains("tips="), "{out}");
}

// [covers:auth-cli.grant-concurrent-parent-deleted-undetectable]
#[tokio::test]
async fn family_with_parents_swept_is_undetectable() {
    let pool = common::mem_pool().await;
    let cfg = common::repo_config();
    let user = auth::create_user_direct(&pool, "Swept Holder", None).await;
    let grant = grant_for(&pool, user, "https://chatgpt.com/clients/x").await;
    let (tip1, tip2, parent1, parent2) = concurrent_pair(&pool, grant).await;

    // sanity: the residue is detected while the referencing rows exist
    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(out.contains("1 concurrent family(ies), 2 tip(s)"), "{out}");

    // only the used parents get swept (fixed 30-day expiry); the two tips
    // survive unreferenced and the family falls below detection
    for hash in [&parent1, &parent2] {
        sqlx::query("DELETE FROM oauth_refresh_tokens WHERE token_hash = ?")
            .bind(hash)
            .execute(&pool)
            .await
            .unwrap();
    }
    let left: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM oauth_refresh_tokens WHERE grant_id = ?")
            .bind(grant)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 2, "both tips survive the parent sweep");

    let out = run(&pool, &cfg, &["grant", "concurrent-families"]).await;
    assert!(
        !out.contains("tips="),
        "undetectable after parent sweep: {out}"
    );
    assert!(!out.contains(&hash8(&tip1)), "{out}");
    assert!(!out.contains(&hash8(&tip2)), "{out}");
    assert!(out.contains("0 concurrent family(ies), 0 tip(s)"), "{out}");
}
