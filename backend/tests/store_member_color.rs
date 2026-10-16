//! Membership color assignment (TASK-16 item 3, decision 3): a new membership
//! gets the first palette key the user does not use yet; with all six used,
//! it cycles by (membership count mod 6).
//!
//! Depends on the not-yet-implemented `budget_book::store::assign_member_color`
//! (signature assumed: `async fn(&mut SqliteConnection, user_id: i64) ->
//! anyhow::Result<&'static str>`, the same connection convention as
//! `store::seed_categories`), so this test target does not compile before the
//! TASK-16 implementation.

mod common;

use common::*;
use sqlx::SqlitePool;

async fn add_membership(pool: &SqlitePool, ledger_id: i64, user_id: i64, color: &str) {
    insert_ledger(pool, ledger_id).await;
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at, color) VALUES (?, ?, 'owner', 0, ?)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(color)
    .execute(pool)
    .await
    .unwrap();
}

async fn assign(pool: &SqlitePool, user_id: i64) -> &'static str {
    let mut conn = pool.acquire().await.unwrap();
    budget_book::store::assign_member_color(&mut conn, user_id)
        .await
        .unwrap()
}

// [covers:auth-register.member-color-unused-first]
#[tokio::test]
async fn member_color_unused_first_then_cycles() {
    let pool = mem_pool().await;
    for u in 1..=4 {
        insert_user(&pool, u).await;
    }

    // no membership yet
    assert_eq!(assign(&pool, 1).await, "teal");

    // teal and pink used -> the first unused key in palette order
    add_membership(&pool, 10, 2, "teal").await;
    add_membership(&pool, 11, 2, "pink").await;
    assert_eq!(assign(&pool, 2).await, "orange");

    // all six used (6 memberships) -> 6 mod 6 = 0
    let palette = ["teal", "orange", "pink", "brown", "slate", "graphite"];
    for (i, c) in palette.iter().enumerate() {
        add_membership(&pool, 20 + i as i64, 3, c).await;
    }
    assert_eq!(assign(&pool, 3).await, "teal");

    // 7 memberships covering all colors -> 7 mod 6 = 1
    for (i, c) in palette.iter().chain(["teal"].iter()).enumerate() {
        add_membership(&pool, 30 + i as i64, 4, c).await;
    }
    assert_eq!(assign(&pool, 4).await, "orange");

    // other users' memberships do not count
    assert_eq!(assign(&pool, 1).await, "teal");
}
