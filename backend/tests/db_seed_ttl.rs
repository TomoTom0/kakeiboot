//! Category seed and TTL cleanup tests (TASK-8, spec_data-model.md sections
//! 9 and 12).

mod common;

use budget_book::store::{self, CleanupReport};
use common::*;

/// 2001-09-09 in JST for NOW = 1_000_000_000_000 ms; the cutoff passed to
/// cleanup is the JST date 90 days before it.
const CUTOFF_DAY: &str = "2001-06-11";

// ---------------------------------------------------------------------------
// seed (section 9)

// [covers:db-schema.seed-item-categories-initial-set]
#[tokio::test]
async fn seed_item_categories_initial_set() {
    let pool = mem_pool().await;
    let ledger = store::create_ledger_with_seed(&pool, "L1", NOW)
        .await
        .unwrap();
    let tops: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM item_categories WHERE ledger_id = ? AND parent_id IS NULL ORDER BY sort_order, id",
    )
    .bind(ledger)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        tops.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(),
        vec![
            "食費",
            "日用品",
            "住居・光熱",
            "交通",
            "医療・健康",
            "衣服・美容",
            "趣味・娯楽",
            "教育・書籍",
            "交際",
            "その他"
        ]
    );
    let subs: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.name, c.name FROM item_categories c JOIN item_categories p ON p.id = c.parent_id
         WHERE c.ledger_id = ? ORDER BY p.sort_order, c.sort_order",
    )
    .bind(ledger)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        subs,
        vec![
            ("食費".into(), "食料品".into()),
            ("食費".into(), "外食".into()),
            ("食費".into(), "飲料".into()),
            ("食費".into(), "菓子".into()),
            ("日用品".into(), "消耗品".into()),
            ("日用品".into(), "衛生用品".into()),
            ("交通".into(), "電車".into()),
            ("交通".into(), "バス".into()),
            ("交通".into(), "タクシー".into()),
            ("交通".into(), "燃料".into()),
            ("医療・健康".into(), "薬".into()),
            ("医療・健康".into(), "通院".into()),
        ]
    );
}

// [covers:db-schema.seed-store-categories-initial-set]
#[tokio::test]
async fn seed_store_categories_initial_set() {
    let pool = mem_pool().await;
    let ledger = store::create_ledger_with_seed(&pool, "L1", NOW)
        .await
        .unwrap();
    let tops: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM store_categories WHERE ledger_id = ? ORDER BY sort_order, id",
    )
    .bind(ledger)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        tops.iter().map(|t| t.0.as_str()).collect::<Vec<_>>(),
        vec![
            "スーパー",
            "コンビニ",
            "ドラッグストア",
            "飲食店",
            "百貨店・専門店",
            "ネット通販",
            "交通機関",
            "その他"
        ]
    );
    let subs: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM store_categories WHERE ledger_id = ? AND parent_id IS NOT NULL",
    )
    .bind(ledger)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(subs, 0, "no sub categories for stores");
}

// [covers:db-schema.seed-per-ledger-independent]
#[tokio::test]
async fn seed_per_ledger_independent() {
    let pool = mem_pool().await;
    let a = store::create_ledger_with_seed(&pool, "A", NOW)
        .await
        .unwrap();
    let b = store::create_ledger_with_seed(&pool, "B", NOW)
        .await
        .unwrap();
    let count = |ledger: i64| {
        let pool = pool.clone();
        async move {
            let items: i64 =
                sqlx::query_scalar("SELECT count(*) FROM item_categories WHERE ledger_id = ?")
                    .bind(ledger)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let stores: i64 =
                sqlx::query_scalar("SELECT count(*) FROM store_categories WHERE ledger_id = ?")
                    .bind(ledger)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            (items, stores)
        }
    };
    assert_eq!(count(a).await, (22, 8));
    assert_eq!(count(b).await, (22, 8));
    // adding to one ledger leaves the other untouched
    insert_category(&pool, "item_categories", a, None, "独自").await;
    assert_eq!(count(a).await, (23, 8));
    assert_eq!(count(b).await, (22, 8));
}

// ---------------------------------------------------------------------------
// TTL cleanup (section 12)

/// Basic ledger/user/member fixture and an expired-or-not pending draft pair.
async fn ttl_fixture(pool: &sqlx::SqlitePool) {
    insert_ledger(pool, 1).await;
    insert_user(pool, 1).await;
    insert_member(pool, 1, 1, "owner").await;
}

async fn run_cleanup(pool: &sqlx::SqlitePool) -> CleanupReport {
    store::cleanup_expired(pool, NOW, CUTOFF_DAY, |_| Ok(()))
        .await
        .unwrap()
}

// [covers:db-schema.ttl-expires-pending-drafts]
#[tokio::test]
async fn ttl_expires_pending_drafts() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    insert_image(&pool, 1, 1).await;
    let overdue = insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    sqlx::query("UPDATE drafts SET image_id = 1, image_status = 'attached', image_unavailable_reason = NULL WHERE id = ?")
        .bind(overdue)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE drafts SET expires_at = ? WHERE id = ?")
        .bind(NOW - 1)
        .bind(overdue)
        .execute(&pool)
        .await
        .unwrap();
    let fresh = insert_draft_min(&pool, 1, 1, "none", None).await;
    let r = run_cleanup(&pool).await;
    assert_eq!(r.expired_drafts, 1);
    assert_eq!(
        draft_state(&pool, overdue).await,
        ("expired".into(), "attached".into(), None, None, 1)
    );
    let (closed_at,): (Option<i64>,) = sqlx::query_as("SELECT closed_at FROM drafts WHERE id = ?")
        .bind(overdue)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(closed_at, Some(NOW));
    assert_eq!(draft_state(&pool, fresh).await.0, "pending");
}

// [covers:db-schema.ttl-deletes-closed-drafts]
#[tokio::test]
async fn ttl_deletes_closed_drafts() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    let old_discarded = insert_draft_min(&pool, 1, 1, "none", None).await;
    let old_expired = insert_draft_min(&pool, 1, 1, "unavailable", Some("chat_upload")).await;
    let young_discarded = insert_draft_min(&pool, 1, 1, "none", None).await;
    let approved = insert_draft_min(&pool, 1, 1, "none", None).await;
    sqlx::query("UPDATE drafts SET status = 'discarded', closed_at = ? WHERE id = ?")
        .bind(NOW - 31 * DAY_MS)
        .bind(old_discarded)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE drafts SET status = 'expired', closed_at = ? WHERE id = ?")
        .bind(NOW - 31 * DAY_MS)
        .bind(old_expired)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE drafts SET status = 'discarded', closed_at = ? WHERE id = ?")
        .bind(NOW - 29 * DAY_MS)
        .bind(young_discarded)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE drafts SET status = 'approved', closed_at = ?, approved_revision = 1 WHERE id = ?",
    )
    .bind(NOW - 31 * DAY_MS)
    .bind(approved)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_drafts, 2);
    let remaining: Vec<i64> = sqlx::query_scalar("SELECT id FROM drafts ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, vec![young_discarded, approved]);
}

// [covers:db-schema.ttl-nulls-approved-payload]
#[tokio::test]
async fn ttl_nulls_approved_draft_payload() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    let old = insert_draft_min(&pool, 1, 1, "none", None).await;
    let young = insert_draft_min(&pool, 1, 1, "none", None).await;
    for (id, age) in [(old, 91), (young, 89)] {
        sqlx::query("UPDATE drafts SET status = 'approved', closed_at = ?, approved_revision = 1 WHERE id = ?")
            .bind(NOW - age * DAY_MS)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    let r = run_cleanup(&pool).await;
    assert_eq!(r.nulled_draft_payloads, 1);
    let payloads: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, payload_json FROM drafts ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(payloads[0], (old, None), "old payload nulled");
    assert!(payloads[1].1.is_some(), "young payload kept");
    let statuses: Vec<(i64, String)> = sqlx::query_as("SELECT id, status FROM drafts ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(statuses[0].1, "approved", "row is kept");
}

// [covers:db-schema.ttl-purges-soft-deleted-receipts]
#[tokio::test]
async fn ttl_purges_soft_deleted_receipts() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    insert_receipt(&pool, 1, 1).await;
    insert_item(&pool, 1, 1, 1, "コーヒー牛乳").await;
    insert_receipt(&pool, 2, 1).await;
    insert_item(&pool, 2, 2, 1, "いちご牛乳").await;
    sqlx::query("UPDATE receipts SET deleted_at = ? WHERE id = 1")
        .bind(NOW - 91 * DAY_MS)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE receipts SET deleted_at = ? WHERE id = 2")
        .bind(NOW - 89 * DAY_MS)
        .execute(&pool)
        .await
        .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.purged_receipts, 1);
    let receipts: Vec<i64> = sqlx::query_scalar("SELECT id FROM receipts ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(receipts, vec![2]);
    let items: Vec<i64> =
        sqlx::query_scalar("SELECT receipt_id FROM receipt_items ORDER BY receipt_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(items, vec![2], "items cascade with the receipt");
    let fts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipt_items_fts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(fts, 1, "FTS entries removed with the items");
}

// [covers:db-schema.ttl-removes-orphan-images]
#[tokio::test]
async fn ttl_removes_orphan_images() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    // two orphans older than 24h; deleting the file for image 1 fails
    for id in 1..=2 {
        insert_image(&pool, id, 1).await;
        sqlx::query("UPDATE images SET created_at = ? WHERE id = ?")
            .bind(NOW - 25 * 3_600_000) // 25h ago
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    // referenced image and a fresh orphan stay
    insert_image(&pool, 3, 1).await;
    insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
    sqlx::query("UPDATE drafts SET image_id = 3, image_status = 'attached', image_unavailable_reason = NULL WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE images SET created_at = ? WHERE id = 3")
        .bind(NOW - 30 * DAY_MS)
        .execute(&pool)
        .await
        .unwrap();
    insert_image(&pool, 4, 1).await;
    sqlx::query("UPDATE images SET created_at = ? WHERE id = 4")
        .bind(NOW - 3_600_000) // 1h ago, unreferenced but too fresh
        .execute(&pool)
        .await
        .unwrap();

    let mut deleted_paths: Vec<String> = Vec::new();
    let r = store::cleanup_expired(&pool, NOW, CUTOFF_DAY, |path| {
        deleted_paths.push(path.to_string());
        if path.ends_with("1.webp") {
            Err(std::io::Error::other("disk error"))
        } else {
            Ok(())
        }
    })
    .await
    .unwrap();
    assert_eq!(r.orphan_image_candidates, 2);
    assert_eq!(r.deleted_orphan_images, 1);
    assert_eq!(deleted_paths.len(), 2, "callback ran for both candidates");
    let images: Vec<i64> = sqlx::query_scalar("SELECT id FROM images ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    // 1 kept (file delete failed), 2 removed, 3 referenced, 4 too fresh
    assert_eq!(images, vec![1, 3, 4]);

    // TASK-18: an image shared by several drafts (one photo, several drafts)
    // is not an orphan while at least one referent remains. Two pending
    // drafts attach to image 5; discarding one leaves the other's reference.
    insert_image(&pool, 5, 1).await;
    sqlx::query("UPDATE images SET created_at = ? WHERE id = 5")
        .bind(NOW - 25 * 3_600_000) // 25h ago
        .execute(&pool)
        .await
        .unwrap();
    for _ in 0..2 {
        let id = insert_draft_min(&pool, 1, 1, "unavailable", Some("fetch_interrupted")).await;
        sqlx::query(
            "UPDATE drafts SET image_id = 5, image_status = 'attached', image_unavailable_reason = NULL WHERE id = ?",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "UPDATE drafts SET status = 'discarded', closed_at = ?, image_id = NULL
         WHERE id = (SELECT MIN(id) FROM drafts WHERE image_id = 5)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    // run_cleanup's callback always succeeds, so image 1 (kept only because
    // its file delete failed in the first sweep above) is cleaned this time.
    // The shared image 5 is not an orphan while a pending draft references it.
    assert_eq!(
        r.deleted_orphan_images, 1,
        "only the image-1 retry; the shared image is not an orphan"
    );
    let images: Vec<i64> = sqlx::query_scalar("SELECT id FROM images ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(
        images.contains(&5),
        "image 5 survives while a draft references it"
    );
    // once every referent is gone the same image becomes a normal orphan
    sqlx::query(
        "UPDATE drafts SET status = 'discarded', closed_at = ?, image_id = NULL WHERE image_id = 5",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_orphan_images, 1);
    let images: Vec<i64> = sqlx::query_scalar("SELECT id FROM images ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(!images.contains(&5), "image 5 is cleaned once unreferenced");
}

// [covers:db-schema.ttl-deletes-expired-image-tokens]
#[tokio::test]
async fn ttl_deletes_expired_image_tokens() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    insert_image(&pool, 1, 1).await;
    insert_user(&pool, 2).await;
    for (hash, expires) in [(vec![1u8; 32], NOW - 1), (vec![2u8; 32], NOW + 60_000)] {
        sqlx::query(
            "INSERT INTO image_access_tokens (token_hash, image_id, ledger_id, user_id, created_at, expires_at)
             VALUES (?, 1, 1, 1, ?, ?)",
        )
        .bind(hash)
        .bind(NOW)
        .bind(expires)
        .execute(&pool)
        .await
        .unwrap();
    }
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_image_tokens, 1);
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM image_access_tokens")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1);
}

// [covers:db-schema.image-token-cascades-on-image-delete]
#[tokio::test]
async fn image_token_cascades_on_image_delete() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    insert_image(&pool, 1, 1).await;
    sqlx::query(
        "INSERT INTO image_access_tokens (token_hash, image_id, ledger_id, user_id, created_at, expires_at)
         VALUES (x'01', 1, 1, 1, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM images WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let tokens: i64 = sqlx::query_scalar("SELECT count(*) FROM image_access_tokens")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tokens, 0);
}

// [covers:db-schema.ttl-deletes-auth-artifacts]
#[tokio::test]
async fn ttl_deletes_auth_artifacts() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES ('c1', '{}', '[]', 'none', 0, ?)",
    )
    .bind(NOW + DAY_MS)
    .execute(&pool)
    .await
    .unwrap();

    // grant past its 30-day post-expiry window, with tokens that cascade
    let dead_grant: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', 0, ?) RETURNING id",
    )
    .bind(NOW - 31 * DAY_MS)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_access_tokens (token_hash, grant_id, created_at, expires_at) VALUES (x'a1', ?, 0, ?)",
    )
    .bind(dead_grant)
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at) VALUES (x'd1', ?, 0, ?)",
    )
    .bind(dead_grant)
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();

    // healthy grant; its expired access token is swept, live refresh stays
    let live_grant: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', ?, ?) RETURNING id",
    )
    .bind(NOW)
    .bind(NOW + 60 * DAY_MS)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_access_tokens (token_hash, grant_id, created_at, expires_at) VALUES (x'a2', ?, ?, ?)",
    )
    .bind(live_grant)
    .bind(NOW)
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at) VALUES (x'd2', ?, ?, ?)",
    )
    .bind(live_grant)
    .bind(NOW)
    .bind(NOW + 30 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();

    // sessions: one past expiry + 1 day, one live
    for (hash, absolute) in [
        (vec![1u8; 32], NOW - 2 * DAY_MS),
        (vec![2u8; 32], NOW + DAY_MS),
    ] {
        sqlx::query(
            "INSERT INTO web_sessions (id_hash, user_id, created_at, auth_at, last_seen_at, idle_expires_at, absolute_expires_at)
             VALUES (?, 1, ?, ?, ?, ?, ?)",
        )
        .bind(hash)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW)
        .bind(NOW + DAY_MS)
        .bind(absolute)
        .execute(&pool)
        .await
        .unwrap();
    }

    // auth codes / jtis / ceremonies / authz requests: expired vs live
    sqlx::query(
        "INSERT INTO oauth_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (x'c1', 1, 'c1', 'https://r', 'cc', 'read', 'https://bb', 0, ?)",
    )
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO oauth_auth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (x'c2', 1, 'c1', 'https://r', 'cc', 'read', 'https://bb', ?, ?)",
    )
    .bind(NOW)
    .bind(NOW + 60_000)
    .execute(&pool)
    .await
    .unwrap();
    for (jti, expires) in [("j1", NOW - 1), ("j2", NOW + 60_000)] {
        sqlx::query(
            "INSERT INTO oauth_client_assertion_jtis (client_id, jti, expires_at) VALUES ('c1', ?, ?)",
        )
        .bind(jti)
        .bind(expires)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (hash, expires) in [(vec![1u8; 31], NOW - 1), (vec![2u8; 31], NOW + 60_000)] {
        sqlx::query(
            "INSERT INTO webauthn_ceremonies (id_hash, kind, state_json, created_at, expires_at)
             VALUES (?, 'register', '{}', ?, ?)",
        )
        .bind(hash)
        .bind(NOW)
        .bind(expires)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (hash, expires) in [(vec![1u8; 30], NOW - 1), (vec![2u8; 30], NOW + 60_000)] {
        sqlx::query(
            "INSERT INTO oauth_authorization_requests (id_hash, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
             VALUES (?, 'c1', 'https://r', 'cc', 'read', 'https://bb', ?, ?)",
        )
        .bind(hash)
        .bind(NOW)
        .bind(expires)
        .execute(&pool)
        .await
        .unwrap();
    }

    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_grants, 1, "only the stale grant is deleted");
    assert_eq!(r.deleted_access_tokens, 2, "both expired access tokens");
    assert_eq!(r.deleted_refresh_tokens, 1, "only the dead grant's refresh");
    assert_eq!(r.deleted_sessions, 1);
    assert_eq!(r.deleted_auth_codes, 1);
    assert_eq!(r.deleted_jtis, 1);
    assert_eq!(r.deleted_ceremonies, 1);
    assert_eq!(r.deleted_authz_requests, 1);

    let grants: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_grants")
        .fetch_one(&pool)
        .await
        .unwrap();
    let refresh: i64 = sqlx::query_scalar("SELECT count(*) FROM oauth_refresh_tokens")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (grants, refresh),
        (1, 1),
        "live grant keeps its live refresh"
    );
}

// [covers:db-schema.ttl-deletes-invitations]
#[tokio::test]
async fn ttl_deletes_invitations() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    // unused + expired a day ago: deleted
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at)
         VALUES (x'01', 'setup', 'n', 0, ?)",
    )
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    // used 31 days ago: deleted
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at, used_at)
         VALUES (x'02', 'setup', 'n', 0, ?, ?)",
    )
    .bind(NOW - 40 * DAY_MS)
    .bind(NOW - 31 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    // unused but still within expiry + 1 day: kept
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at)
         VALUES (x'03', 'setup', 'n', 0, ?)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .unwrap();
    // used 29 days ago: kept
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at, used_at)
         VALUES (x'04', 'setup', 'n', 0, ?, ?)",
    )
    .bind(NOW - 40 * DAY_MS)
    .bind(NOW - 29 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_invitations, 2);
    let remaining: Vec<String> = sqlx::query_scalar(
        "SELECT substr(hex(token_hash), 1, 2) FROM invitations ORDER BY token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec!["03", "04"]);
}

// [covers:db-schema.ttl-deletes-invitations]
// TASK-32: register_invitations follow the same TTL rule, verified through
// both the deleted_register_invitations report column and the remaining rows
// (a sweep! field-ident mix-up would only be caught by the report column).
#[tokio::test]
async fn ttl_deletes_register_invitations() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    // unused + expired a day ago: deleted
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at)
         VALUES (x'01', 1, 'a', 0, ?)",
    )
    .bind(NOW - 2 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    // used 31 days ago: deleted
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at, used_at)
         VALUES (x'02', 1, 'b', 0, ?, ?)",
    )
    .bind(NOW - 40 * DAY_MS)
    .bind(NOW - 31 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    // unused but still within expiry + 1 day: kept
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at)
         VALUES (x'03', 1, 'c', 0, ?)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .unwrap();
    // used 29 days ago: kept
    sqlx::query(
        "INSERT INTO register_invitations (token_hash, created_by, inviter_note, created_at, expires_at, used_at)
         VALUES (x'04', 1, 'd', 0, ?, ?)",
    )
    .bind(NOW - 40 * DAY_MS)
    .bind(NOW - 29 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_register_invitations, 2);
    let remaining: Vec<String> = sqlx::query_scalar(
        "SELECT substr(hex(token_hash), 1, 2) FROM register_invitations ORDER BY token_hash",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, vec!["03", "04"]);
}

// [covers:db-schema.ttl-recovery-request-lifecycle]
#[tokio::test]
async fn ttl_recovery_request_lifecycle() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    // 1) created 25h ago with ip_hash: only the hash is nulled
    sqlx::query(
        "INSERT INTO recovery_requests (request_number, status, ip_hash, created_at)
         VALUES ('R-0001', 'open', x'aa', ?)",
    )
    .bind(NOW - 25 * 3_600_000)
    .execute(&pool)
    .await
    .unwrap();
    // 2) open for 91 days: auto-rejected
    sqlx::query(
        "INSERT INTO recovery_requests (request_number, status, ip_hash, created_at)
         VALUES ('R-0002', 'open', x'bb', ?)",
    )
    .bind(NOW - 91 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    // 3) resolved and closed 181 days ago: deleted
    sqlx::query(
        "INSERT INTO recovery_requests (request_number, status, created_at, closed_at)
         VALUES ('R-0003', 'resolved', 0, ?)",
    )
    .bind(NOW - 181 * DAY_MS)
    .execute(&pool)
    .await
    .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.nulled_recovery_ip_hashes, 2);
    assert_eq!(r.auto_rejected_recoveries, 1);
    assert_eq!(r.deleted_recovery_requests, 1);
    type RecoveryRow = (String, Option<i64>, Option<String>, Option<String>);
    let remaining: Vec<RecoveryRow> = sqlx::query_as(
        "SELECT request_number, ip_hash, status, close_note FROM recovery_requests ORDER BY request_number",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(remaining.len(), 2);
    assert_eq!(remaining[0].0, "R-0001");
    assert!(remaining[0].1.is_none(), "25h ip_hash nulled");
    assert_eq!(remaining[1].0, "R-0002");
    assert!(
        remaining[1].1.is_none(),
        "auto-rejected row ip_hash also nulled"
    );
    assert_eq!(remaining[1].2.as_deref(), Some("rejected"));
    assert_eq!(remaining[1].3.as_deref(), Some("auto: expired"));
}

// [covers:db-schema.ttl-deletes-stale-subject-hashes-and-overflow]
#[tokio::test]
async fn ttl_deletes_stale_subject_hashes_and_overflow() {
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    for (hash, last_seen) in [(1u8, NOW - 401 * DAY_MS), (2u8, NOW - 399 * DAY_MS)] {
        sqlx::query(
            "INSERT INTO user_subject_hashes (subject_hash, user_id, issuer, first_seen_at, last_seen_at)
             VALUES (?, 1, 'openai', 0, ?)",
        )
        .bind(vec![hash; 32])
        .bind(last_seen)
        .execute(&pool)
        .await
        .unwrap();
    }
    for day in ["2000-01-01", "2001-06-11", "2001-06-12"] {
        sqlx::query("INSERT INTO recovery_overflow_daily (day, count) VALUES (?, 1)")
            .bind(day)
            .execute(&pool)
            .await
            .unwrap();
    }
    let r = run_cleanup(&pool).await;
    assert_eq!(r.deleted_subject_hashes, 1);
    // the sweep is `day < cutoff`: strictly before the cutoff day
    assert_eq!(r.deleted_overflow_daily, 1);
    let hashes: i64 = sqlx::query_scalar("SELECT count(*) FROM user_subject_hashes")
        .fetch_one(&pool)
        .await
        .unwrap();
    let overflow: Vec<String> = sqlx::query_scalar("SELECT day FROM recovery_overflow_daily")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(hashes, 1);
    assert_eq!(overflow, vec!["2001-06-11", "2001-06-12"]);
}

// ---------------------------------------------------------------------------
// 0009 labels (TASK-17)

// [covers:db-schema.ledger-labels-seeded-on-create]
#[tokio::test]
async fn ledger_labels_seeded_on_create_ledger_with_seed() {
    // the store helper path: the AFTER INSERT trigger seeds the definitions
    // independently of the creation route (raw INSERT is covered in
    // db_schema.rs, registration in auth_register.rs)
    let pool = mem_pool().await;
    let ledger = store::create_ledger_with_seed(&pool, "L1", NOW)
        .await
        .unwrap();
    let mut colors: Vec<String> =
        sqlx::query_scalar("SELECT color FROM ledger_labels WHERE ledger_id = ?")
            .bind(ledger)
            .fetch_all(&pool)
            .await
            .unwrap();
    colors.sort_by_key(|c| {
        ["red", "yellow", "green", "blue", "purple"]
            .iter()
            .position(|k| k == &c.as_str())
            .unwrap_or(usize::MAX)
    });
    assert_eq!(colors, vec!["red", "yellow", "green", "blue", "purple"]);
    let titled: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM ledger_labels WHERE ledger_id = ? AND title IS NOT NULL",
    )
    .bind(ledger)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(titled, 0, "seeded rows are color-only");
}

// [covers:db-schema.receipt-label-cascade-on-purge]
#[tokio::test]
async fn receipt_labels_cascade_on_purge() {
    // the 90-day purge path (store::cleanup_expired) removes the soft-deleted
    // receipt together with its receipt_labels rows; the definitions stay
    let pool = mem_pool().await;
    ttl_fixture(&pool).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt(&pool, 2, 1).await;
    sqlx::query(
        "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
         VALUES (1, 1, 'red', 1, 0), (2, 1, 'blue', 1, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE receipts SET deleted_at = ? WHERE id = 1")
        .bind(NOW - 91 * DAY_MS)
        .execute(&pool)
        .await
        .unwrap();
    let r = run_cleanup(&pool).await;
    assert_eq!(r.purged_receipts, 1);
    let left: Vec<i64> =
        sqlx::query_scalar("SELECT receipt_id FROM receipt_labels ORDER BY receipt_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(left, vec![2], "purged receipt's label rows cascade away");
    let defs: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_labels WHERE ledger_id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(defs, 5, "definitions survive the purge");
}
