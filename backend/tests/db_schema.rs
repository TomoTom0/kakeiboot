//! Schema constraint tests over migrations 0001-0010 (TASK-8, TASK-16,
//! TASK-17, TASK-18). Each test targets one condition in
//! tests/design/conditions.toml via a [covers:<id>] comment on the test it
//! belongs to.

mod common;

use common::*;
use sqlx::{AssertSqlSafe, SqlitePool};

// ---------------------------------------------------------------------------
// migrations apply cleanly + foreign_key_check

// [covers:db-schema.migrations-apply-cleanly]
#[tokio::test]
async fn migrations_apply_cleanly() {
    // connect_memory applies the migrator; reaching this point means all
    // 0000-0008 migrations ran without error (STRICT, WITHOUT ROWID, partial
    // indexes, triggers, FTS5 table and the view included).
    let pool = mem_pool().await;
    let tables: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
            ('users','ledgers','ledger_members','webauthn_credentials','webauthn_ceremonies',
             'web_sessions','invitations','oauth_clients','oauth_jwks_cache',
             'oauth_authorization_requests','oauth_grants','oauth_auth_codes','oauth_access_tokens',
             'oauth_refresh_tokens','oauth_client_assertion_jtis','user_subject_hashes',
             'recovery_requests','recovery_request_candidates','recovery_overflow_daily',
             'item_categories','store_categories','stores','store_aliases','images',
             'image_access_tokens','receipts','receipt_items','drafts','audit_events')
         ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(tables.len(), 29, "all spec tables exist");
    let views: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_item_facts'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(views.len(), 1);
    // 0008 (TASK-16): ledger_members.color exists and the migration is recorded
    let cols: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('ledger_members') WHERE name = 'color'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(cols.len(), 1, "ledger_members.color added by 0008");
    // 0009 (TASK-17): the label tables exist and the migration is recorded
    let mut label_tables: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
            ('ledger_labels','receipt_labels') ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    label_tables.sort();
    assert_eq!(
        label_tables,
        vec![
            ("ledger_labels".to_string(),),
            ("receipt_labels".to_string(),)
        ],
        "label tables added by 0009"
    );
    let latest: i64 =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(latest >= 10, "0009 + 0010 applied (latest {latest})");
    // 0010 (TASK-18): drafts.batch_id (NULL = single-tool / reopen)
    let batch_cols: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('drafts') WHERE name = 'batch_id'")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(batch_cols.len(), 1, "drafts.batch_id added by 0010");
}

// [covers:db-schema.drafts-batch-column]
#[tokio::test]
async fn drafts_batch_column_and_partial_index() {
    // The SQL of 0010 is read at runtime (no include_str!: the file is absent
    // until the TASK-18 implementation lands, which must not break the build).
    let sql = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0010_drafts_batch.sql"
    ))
    .expect("0010_drafts_batch.sql exists");
    assert!(
        sql.to_lowercase().contains("batch_id"),
        "0010 defines the batch_id column: {sql}"
    );
    // apply everything up to 0009, insert a single-tool draft, then run the
    // remaining migration (0010) through the real migrator
    let pool = bare_mem_pool().await;
    migrate_until(&pool, 10).await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await;
    insert_member(&pool, 1, 1, "owner").await;
    let single_id = insert_draft_min(&pool, 1, 1, "none", None).await;
    migrate_rest(&pool).await; // applies 0010 (drafts.batch_id + partial index)
    let latest: i64 =
        sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(latest, 10, "0010 recorded");
    // column: nullable TEXT
    let col: (String, i64) = sqlx::query_as(
        "SELECT type, \"notnull\" FROM pragma_table_info('drafts') WHERE name = 'batch_id'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(col, ("TEXT".to_string(), 0), "batch_id TEXT NULL");
    // partial index drafts_batch over the non-NULL rows only
    let idx: (String,) = sqlx::query_as(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'drafts_batch'",
    )
    .fetch_one(&pool)
    .await
    .expect("partial index drafts_batch missing");
    assert!(
        idx.0.to_lowercase().contains("batch_id is not null"),
        "partial index: {}",
        idx.0
    );
    // single-tool drafts keep batch_id NULL; a batch id can be set on rows
    let single: Option<String> = sqlx::query_scalar("SELECT batch_id FROM drafts WHERE id = ?")
        .bind(single_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(single, None, "single-tool draft has no batch_id");
    sqlx::query("UPDATE drafts SET batch_id = '01ARSTESTBATCH' WHERE id = ?")
        .bind(single_id)
        .execute(&pool)
        .await
        .unwrap();
    // the planner picks the partial index for a batch_id lookup
    let rows =
        sqlx::query("EXPLAIN QUERY PLAN SELECT id FROM drafts WHERE batch_id = '01ARSTESTBATCH'")
            .fetch_all(&pool)
            .await
            .unwrap();
    let plan_text = rows
        .iter()
        .map(|r| {
            use sqlx::Row as _;
            r.try_get::<String, _>("detail").unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" | ");
    assert!(
        plan_text.contains("drafts_batch"),
        "partial index used: {plan_text}"
    );
}

// [covers:db-schema.foreign-key-check-clean]
#[tokio::test]
async fn foreign_key_check_clean() {
    let pool = mem_pool().await;
    let violations: Vec<(i64,)> = sqlx::query_as("PRAGMA foreign_key_check")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert!(violations.is_empty());
}

// ---------------------------------------------------------------------------
// 0001 users / ledger_members

// [covers:db-schema.users-webauthn-handle-length]
#[tokio::test]
async fn users_webauthn_handle_length() {
    let pool = mem_pool().await;
    for len in [15u32, 17] {
        let bytes = vec![0u8; len as usize];
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO users (webauthn_user_handle, account_number, display_name, created_at, updated_at)
                 VALUES (?, 'BB-0000-0001', 'u', 0, 0)",
            )
            .bind(bytes)
            .execute(&pool),
        )
        .await;
    }
    sqlx::query(
        "INSERT INTO users (webauthn_user_handle, account_number, display_name, created_at, updated_at)
         VALUES (?, 'BB-0000-0001', 'u', 0, 0)",
    )
    .bind(vec![0u8; 16])
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.users-account-number-format]
#[tokio::test]
async fn users_account_number_format() {
    let pool = mem_pool().await;
    for bad in [
        "bb-0000-0001",
        "BB-000I-0001",
        "BB-000-00001",
        "XX-0000-0001",
    ] {
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO users (webauthn_user_handle, account_number, display_name, created_at, updated_at)
                 VALUES (?, ?, 'u', 0, 0)",
            )
            .bind(vec![0u8; 16])
            .bind(bad)
            .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.ledger-members-duplicate-rejected]
#[tokio::test]
async fn ledger_members_duplicate_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await;
    insert_member(&pool, 1, 1, "owner").await;
    expect_db_err(
        "UNIQUE",
        sqlx::query("INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (1, 1, 'editor', 0)")
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.ledger-members-pk-immutable]
#[tokio::test]
async fn ledger_members_pk_immutable() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_member(&pool, 1, 1, "owner").await;
    expect_db_err(
        "immutable",
        sqlx::query("UPDATE ledger_members SET ledger_id = 2 WHERE ledger_id = 1 AND user_id = 1")
            .execute(&pool),
    )
    .await;
}

// ---------------------------------------------------------------------------
// 0008 ledger_members.color / "default book" rename (TASK-16)

async fn member_color(pool: &SqlitePool, ledger_id: i64, user_id: i64) -> String {
    sqlx::query_scalar("SELECT color FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
        .bind(ledger_id)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

// [covers:db-schema.ledger-members-color-check]
#[tokio::test]
async fn ledger_members_color_check() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    // color omitted -> 'teal'
    insert_member(&pool, 1, 1, "owner").await;
    assert_eq!(member_color(&pool, 1, 1).await, "teal");
    // palette key update succeeds (the PK immutability trigger ignores color)
    sqlx::query("UPDATE ledger_members SET color = 'graphite' WHERE ledger_id = 1 AND user_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(member_color(&pool, 1, 1).await, "graphite");
    // outside the palette -> CHECK
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO ledger_members (ledger_id, user_id, role, created_at, color) VALUES (2, 1, 'editor', 0, 'red')",
        )
        .execute(&pool),
    )
    .await;
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE ledger_members SET color = 'red' WHERE ledger_id = 1 AND user_id = 1")
            .execute(&pool),
    )
    .await;
    // NULL -> NOT NULL
    expect_db_err(
        "NOT NULL",
        sqlx::query("UPDATE ledger_members SET color = NULL WHERE ledger_id = 1 AND user_id = 1")
            .execute(&pool),
    )
    .await;
    assert_eq!(member_color(&pool, 1, 1).await, "graphite");
}

// [covers:db-schema.migration-0008-backfill-color]
#[tokio::test]
async fn migration_0008_backfills_color_per_user() {
    let pool = bare_mem_pool().await;
    migrate_until(&pool, 8).await;
    for id in 1..=7 {
        insert_ledger(&pool, id).await;
    }
    for id in 1..=3 {
        insert_user(&pool, id).await;
    }
    // user A (1): ledgers 3, 1, 2 (inserted out of order)
    for l in [3, 1, 2] {
        insert_member(&pool, l, 1, "owner").await;
    }
    // user B (2): ledger 2
    insert_member(&pool, 2, 2, "editor").await;
    // user C (3): 7 ledgers
    for l in 1..=7 {
        insert_member(&pool, l, 3, "viewer").await;
    }
    migrate_rest(&pool).await;

    assert_eq!(member_color(&pool, 1, 1).await, "teal");
    assert_eq!(member_color(&pool, 2, 1).await, "orange");
    assert_eq!(member_color(&pool, 3, 1).await, "pink");
    assert_eq!(member_color(&pool, 2, 2).await, "teal");
    let want = [
        "teal", "orange", "pink", "brown", "slate", "graphite", "teal",
    ];
    for (i, w) in want.iter().enumerate() {
        assert_eq!(
            member_color(&pool, i as i64 + 1, 3).await,
            *w,
            "user C ledger {}",
            i + 1
        );
    }
}

// [covers:db-schema.migration-0008-rename-default-book]
#[tokio::test]
async fn migration_0008_renames_auto_created_ledgers() {
    let pool = bare_mem_pool().await;
    migrate_until(&pool, 8).await;
    for (id, name) in [(1, "Alice"), (2, "Bob")] {
        sqlx::query(
            "INSERT INTO users (id, webauthn_user_handle, account_number, display_name, created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 0)",
        )
        .bind(id)
        .bind(vec![id as u8; 16])
        .bind(format!("BB-0000-{id:04}"))
        .bind(name)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (id, name) in [(1, "Aliceの家計簿"), (2, "旅行"), (3, "Bobの家計簿")] {
        sqlx::query("INSERT INTO ledgers (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)")
            .bind(id)
            .bind(name)
            .execute(&pool)
            .await
            .unwrap();
    }
    insert_member(&pool, 1, 1, "owner").await;
    insert_member(&pool, 2, 1, "owner").await;
    // Bob is only an editor of the ledger named after him; Alice owns it
    insert_member(&pool, 3, 1, "owner").await;
    insert_member(&pool, 3, 2, "editor").await;
    migrate_rest(&pool).await;

    let row = |id: i64| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, i64)>("SELECT name, updated_at FROM ledgers WHERE id = ?")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let (name, updated) = row(1).await;
    assert_eq!(name, "default book");
    assert!(updated > 0, "updated_at set");
    assert_eq!(
        updated.to_string().len(),
        13,
        "updated_at is unix ms: {updated}"
    );
    assert_eq!(row(2).await, ("旅行".to_string(), 0));
    assert_eq!(row(3).await, ("Bobの家計簿".to_string(), 0));
}

// ---------------------------------------------------------------------------
// 0002 auth

// [covers:db-schema.oauth-grants-active-ledger-requires-membership]
#[tokio::test]
async fn oauth_grants_active_ledger_requires_membership() {
    let pool = mem_pool().await;
    insert_client(&pool, "c1").await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_member(&pool, 1, 1, "owner").await; // member of 1 only
    // INSERT with a non-member ledger is rejected
    expect_db_err(
        "not a member",
        sqlx::query(
            "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id, created_at, absolute_expires_at)
             VALUES (1, 'c1', 'read', 'https://bb', 2, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // membership ledger is accepted, then UPDATE to a non-member ledger is rejected
    let grant: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', 1, 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "not a member",
        sqlx::query("UPDATE oauth_grants SET active_ledger_id = 2 WHERE id = ?")
            .bind(grant)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.oauth-grants-active-ledger-cleared-on-leave]
#[tokio::test]
async fn oauth_grants_active_ledger_cleared_on_leave() {
    let pool = mem_pool().await;
    insert_client(&pool, "c1").await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_member(&pool, 1, 1, "owner").await;
    insert_member(&pool, 2, 1, "editor").await;
    let keep: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', 2, 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let clear: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, active_ledger_id, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', 1, 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM ledger_members WHERE ledger_id = 1 AND user_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let states: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, active_ledger_id FROM oauth_grants WHERE id IN (?, ?) ORDER BY id",
    )
    .bind(keep)
    .bind(clear)
    .fetch_all(&pool)
    .await
    .unwrap();
    // keep (ledger 2) unaffected; clear (ledger 1) reset to NULL
    assert_eq!(states[0], (keep, Some(2)));
    assert_eq!(states[1], (clear, None));
}

// [covers:db-schema.invitations-kind-shape]
#[tokio::test]
async fn invitations_kind_shape() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await; // creator
    insert_user(&pool, 9).await; // recovery target
    // setup without operator_note
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, created_at, expires_at) VALUES (x'01', 'setup', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // recovery without target_user_id
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at)
             VALUES (x'02', 'recovery', 'n', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // invite without ledger/role/created_by
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, inviter_note, created_at, expires_at)
             VALUES (x'03', 'invite', 'hi', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // invite with operator_note (must be NULL for invite)
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, created_by, ledger_id, role, operator_note, created_at, expires_at)
             VALUES (x'04', 'invite', 1, 1, 'editor', 'n', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // non-invite with inviter_note
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, operator_note, inviter_note, created_at, expires_at)
             VALUES (x'05', 'setup', 'n', 'hi', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // well-formed rows for all three kinds
    for (hash, sql) in [
        (
            6i64,
            "INSERT INTO invitations (token_hash, kind, operator_note, created_at, expires_at) VALUES (x'06', 'setup', 'n', 0, 0)",
        ),
        (
            7,
            "INSERT INTO invitations (token_hash, kind, created_by, ledger_id, role, inviter_note, created_at, expires_at) VALUES (x'07', 'invite', 1, 1, 'editor', 'hi', 0, 0)",
        ),
        (
            8,
            "INSERT INTO invitations (token_hash, kind, target_user_id, created_at, expires_at) VALUES (x'08', 'recovery', 9, 0, 0)",
        ),
    ] {
        sqlx::query(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("{hash}: {e}"));
    }
}

// [covers:db-schema.invitations-recovery-open-unique]
#[tokio::test]
async fn invitations_recovery_open_unique() {
    let pool = mem_pool().await;
    insert_user(&pool, 9).await;
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, target_user_id, created_at, expires_at)
         VALUES (x'01', 'recovery', 9, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    expect_db_err(
        "UNIQUE",
        sqlx::query(
            "INSERT INTO invitations (token_hash, kind, target_user_id, created_at, expires_at)
             VALUES (x'02', 'recovery', 9, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // a used recovery row frees the slot (partial unique index on used_at IS NULL)
    sqlx::query("UPDATE invitations SET used_at = 5 WHERE token_hash = x'01'")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO invitations (token_hash, kind, target_user_id, created_at, expires_at)
         VALUES (x'03', 'recovery', 9, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.refresh-token-used-child-consistency]
#[tokio::test]
async fn refresh_token_used_child_consistency() {
    let pool = mem_pool().await;
    insert_client(&pool, "c1").await;
    insert_user(&pool, 1).await;
    let grant: i64 = sqlx::query_scalar(
        "INSERT INTO oauth_grants (user_id, client_id, scope, resource, created_at, absolute_expires_at)
         VALUES (1, 'c1', 'read', 'https://bb', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let base = |hash: i64| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO oauth_refresh_tokens (token_hash, grant_id, created_at, expires_at)
                 VALUES (?, ?, 0, 0)",
            )
            .bind(vec![hash as u8; 1])
            .bind(grant)
            .execute(&pool)
            .await
        }
    };
    let _ = base(1).await.unwrap();
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE oauth_refresh_tokens SET used_at = 1 WHERE token_hash = x'01'")
            .execute(&pool),
    )
    .await;
    // child_hash without used_at
    let _ = base(2).await.unwrap();
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE oauth_refresh_tokens SET child_hash = x'09' WHERE token_hash = x'02'")
            .execute(&pool),
    )
    .await;
    // both together is accepted
    sqlx::query(
        "UPDATE oauth_refresh_tokens SET used_at = 1, child_hash = x'09' WHERE token_hash = x'02'",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.recovery-request-status-closed-consistency]
#[tokio::test]
async fn recovery_request_status_closed_consistency() {
    let pool = mem_pool().await;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO recovery_requests (request_number, status, created_at) VALUES ('R-0001', 'open', 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "CHECK",
        sqlx::query("UPDATE recovery_requests SET closed_at = 1 WHERE id = ?")
            .bind(id)
            .execute(&pool),
    )
    .await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO recovery_requests (request_number, status, created_at) VALUES ('R-0002', 'resolved', 0)",
        )
        .execute(&pool),
    )
    .await;
    sqlx::query("UPDATE recovery_requests SET status = 'resolved', closed_at = 1 WHERE id = ?")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
}

// [covers:db-schema.ceremony-authz-request-fk-nulls-on-delete]
#[tokio::test]
async fn ceremony_authz_request_fk_nulls_on_delete() {
    let pool = mem_pool().await;
    insert_client(&pool, "c1").await;
    sqlx::query(
        "INSERT INTO oauth_authorization_requests (id_hash, client_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (x'01', 'c1', 'https://r', 'cc', 'read', 'https://bb', 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO webauthn_ceremonies (id_hash, kind, state_json, authz_request_hash, created_at, expires_at)
         VALUES (x'02', 'authenticate', '{}', x'01', 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM oauth_authorization_requests WHERE id_hash = x'01'")
        .execute(&pool)
        .await
        .unwrap();
    let hash: Option<i64> = sqlx::query_scalar(
        "SELECT authz_request_hash FROM webauthn_ceremonies WHERE id_hash = x'02'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(hash.is_none(), "ceremony survives with NULL reference");
}

async fn insert_client(pool: &SqlitePool, client_id: &str) {
    sqlx::query(
        "INSERT INTO oauth_clients (client_id, metadata_json, redirect_uris_json, token_endpoint_auth_method, fetched_at, expires_at)
         VALUES (?, '{}', '[]', 'none', 0, 0)",
    )
    .bind(client_id)
    .execute(pool)
    .await
    .unwrap();
}

// ---------------------------------------------------------------------------
// 0003 catalog (item_categories / store_categories share the same shape; both
// are exercised per condition)

// [covers:db-schema.categories-depth-exceeds-2-rejected]
#[tokio::test]
async fn categories_depth_exceeds_2_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    for table in ["item_categories", "store_categories"] {
        let top = insert_category(&pool, table, 1, None, "top").await;
        let sub = insert_category(&pool, table, 1, Some(top), "sub").await;
        let sql = format!(
            "INSERT INTO {table} (ledger_id, parent_id, name, created_at, updated_at)
             VALUES (1, ?, 'leaf', 0, 0)"
        );
        expect_db_err(
            "depth exceeds 2",
            sqlx::query(AssertSqlSafe(sql.as_str()))
                .bind(sub)
                .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.categories-parent-ledger-mismatch-rejected]
#[tokio::test]
async fn categories_parent_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    for table in ["item_categories", "store_categories"] {
        let other = insert_category(&pool, table, 2, None, "other").await;
        let sql = format!(
            "INSERT INTO {table} (ledger_id, parent_id, name, created_at, updated_at)
             VALUES (1, ?, 'x', 0, 0)"
        );
        expect_db_err(
            "ledger mismatch",
            sqlx::query(AssertSqlSafe(sql.as_str()))
                .bind(other)
                .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.categories-update-depth-guard]
#[tokio::test]
async fn categories_update_depth_guard() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    for table in ["item_categories", "store_categories"] {
        let top = insert_category(&pool, table, 1, None, "top").await;
        let sub = insert_category(&pool, table, 1, Some(top), "sub").await;
        // giving the parent a parent would make depth 3
        expect_db_err(
            "depth exceeds 2",
            sqlx::query(AssertSqlSafe(
                format!("UPDATE {table} SET parent_id = ? WHERE id = ?").as_str(),
            ))
            .bind(sub)
            .bind(top)
            .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.categories-ledger-immutable]
#[tokio::test]
async fn categories_ledger_immutable() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    for table in ["item_categories", "store_categories"] {
        let cat = insert_category(&pool, table, 1, None, "c").await;
        expect_db_err(
            "ledger_id is immutable",
            sqlx::query(AssertSqlSafe(
                format!("UPDATE {table} SET ledger_id = 2 WHERE id = ?").as_str(),
            ))
            .bind(cat)
            .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.categories-name-unique]
#[tokio::test]
async fn categories_name_unique() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    for table in ["item_categories", "store_categories"] {
        let top = insert_category(&pool, table, 1, None, "top").await;
        let _ = insert_category(&pool, table, 1, Some(top), "sub").await;
        let sql = format!(
            "INSERT INTO {table} (ledger_id, parent_id, name, created_at, updated_at)
             VALUES (1, ?, 'sub', 0, 0)"
        );
        expect_db_err(
            "UNIQUE",
            sqlx::query(AssertSqlSafe(sql.as_str()))
                .bind(top)
                .execute(&pool),
        )
        .await;
        // same name under a different parent (or as a top) is allowed
        insert_category(&pool, table, 1, None, "sub").await;
    }
}

// [covers:db-schema.categories-self-reference-rejected]
#[tokio::test]
async fn categories_self_reference_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    for table in ["item_categories", "store_categories"] {
        // a fresh row with parent_id = its own id violates the CHECK; the id is
        // only known after insert, so the self-reference is set via UPDATE
        let sql = format!(
            "INSERT INTO {table} (ledger_id, parent_id, name, created_at, updated_at)
             VALUES (1, NULL, 'x', 0, 0) RETURNING id"
        );
        let cat: i64 = sqlx::query_scalar(AssertSqlSafe(sql.as_str()))
            .fetch_one(&pool)
            .await
            .unwrap();
        let upd = format!("UPDATE {table} SET parent_id = id WHERE id = ?");
        expect_db_err(
            "CHECK",
            sqlx::query(AssertSqlSafe(upd.as_str()))
                .bind(cat)
                .execute(&pool),
        )
        .await;
    }
}

// [covers:db-schema.store-category-mismatch-rejected]
#[tokio::test]
async fn store_category_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    let other = insert_category(&pool, "store_categories", 2, None, "other").await;
    expect_db_err(
        "store category ledger mismatch",
        sqlx::query(
            "INSERT INTO stores (ledger_id, name, name_norm, category_id, created_at, updated_at)
             VALUES (1, 's', 's', ?, 0, 0)",
        )
        .bind(other)
        .execute(&pool),
    )
    .await;
    let store: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (1, 's', 's', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "store category ledger mismatch",
        sqlx::query("UPDATE stores SET category_id = ? WHERE id = ?")
            .bind(other)
            .bind(store)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.store-ledger-immutable]
#[tokio::test]
async fn store_ledger_immutable() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    let store: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (1, 's', 's', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "ledger_id is immutable",
        sqlx::query("UPDATE stores SET ledger_id = 2 WHERE id = ?")
            .bind(store)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.store-alias-store-mismatch-rejected]
#[tokio::test]
async fn store_alias_store_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    let other_store: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (2, 's2', 's2', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "alias ledger mismatch",
        sqlx::query(
            "INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
             VALUES (1, 'a', ?, 0)",
        )
        .bind(other_store)
        .execute(&pool),
    )
    .await;
}

// ---------------------------------------------------------------------------
// 0004 images / image_access_tokens / receipts / receipt_items

// [covers:db-schema.images-metadata-source-consistency]
#[tokio::test]
async fn images_metadata_source_consistency() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await;
    // filename without source
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO images (ledger_id, uploaded_by, file_key, storage_path, width, height, byte_size,
                 sha256, original_filename, created_at)
             VALUES (1, 1, 'k1', 'p1', 1, 1, 1, x'00', 'f.jpg', 0)",
        )
        .execute(&pool),
    )
    .await;
    // taken_at_source without taken_at_local
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO images (ledger_id, uploaded_by, file_key, storage_path, width, height, byte_size,
                 sha256, taken_at_source, created_at)
             VALUES (1, 1, 'k2', 'p2', 1, 1, 1, x'00', 'exif', 0)",
        )
        .execute(&pool),
    )
    .await;
    // consistent pairs are accepted
    sqlx::query(
        "INSERT INTO images (ledger_id, uploaded_by, file_key, storage_path, width, height, byte_size,
             sha256, original_filename, original_filename_source, taken_at_local, taken_at_offset, taken_at_source, created_at)
         VALUES (1, 1, 'k3', 'p3', 1, 1, 1, x'00', 'f.jpg', 'model', '2026-10-01T12:00:00', '+09:00', 'exif', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.image-access-tokens-ledger-mismatch-rejected]
#[tokio::test]
async fn image_access_tokens_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_image(&pool, 1, 1).await;
    expect_db_err(
        "image ledger mismatch",
        sqlx::query(
            "INSERT INTO image_access_tokens (token_hash, image_id, ledger_id, user_id, created_at, expires_at)
             VALUES (x'01', 1, 2, 1, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    sqlx::query(
        "INSERT INTO image_access_tokens (token_hash, image_id, ledger_id, user_id, created_at, expires_at)
         VALUES (x'02', 1, 1, 1, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    // pointing an existing token at another ledger's image is rejected
    insert_image(&pool, 2, 2).await;
    expect_db_err(
        "image ledger mismatch",
        sqlx::query("UPDATE image_access_tokens SET image_id = 2 WHERE token_hash = x'02'")
            .execute(&pool),
    )
    .await;
    // the token's own ledger cannot be moved either
    expect_db_err(
        "ledger_id is immutable",
        sqlx::query("UPDATE image_access_tokens SET ledger_id = 2 WHERE token_hash = x'02'")
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-store-ledger-mismatch-rejected]
#[tokio::test]
async fn receipt_store_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    let other_store: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, created_at, updated_at)
         VALUES (2, 's2', 's2', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    expect_db_err(
        "store ledger mismatch",
        sqlx::query(
            "INSERT INTO receipts (ledger_id, created_by, source, store_id, purchased_on, created_at, updated_at)
             VALUES (1, 1, 'manual', ?, '2026-10-01', 0, 0)",
        )
        .bind(other_store)
        .execute(&pool),
    )
    .await;
    insert_receipt(&pool, 1, 1).await;
    expect_db_err(
        "store ledger mismatch",
        sqlx::query("UPDATE receipts SET store_id = ? WHERE id = 1")
            .bind(other_store)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-image-ledger-mismatch-rejected]
#[tokio::test]
async fn receipt_image_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_user(&pool, 1).await;
    insert_image(&pool, 1, 2).await; // image on ledger 2
    expect_db_err(
        "image ledger mismatch",
        sqlx::query(
            "INSERT INTO receipts (ledger_id, created_by, source, image_id, purchased_on, created_at, updated_at)
             VALUES (1, 1, 'image', 1, '2026-10-01', 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-ledger-immutable]
#[tokio::test]
async fn receipt_ledger_immutable() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_receipt(&pool, 1, 1).await;
    expect_db_err(
        "ledger_id is immutable",
        sqlx::query("UPDATE receipts SET ledger_id = 2 WHERE id = 1").execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-purchased-on-format-rejected]
#[tokio::test]
async fn receipt_purchased_on_format_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_user(&pool, 1).await;
    // the GLOB checks the shape (4-2-2 digits with month 00-19 / day 00-39);
    // impossible month/day values pass the GLOB and are the app's business
    for bad in ["2026-1-01", "2026/10/01", "20261001"] {
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO receipts (ledger_id, created_by, source, purchased_on, created_at, updated_at)
                 VALUES (1, 1, 'manual', ?, 0, 0)",
            )
            .bind(bad)
            .execute(&pool),
        )
        .await;
    }
    sqlx::query(
        "INSERT INTO receipts (ledger_id, created_by, source, purchased_on, created_at, updated_at)
         VALUES (1, 1, 'manual', '2026-10-01', 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.receipt-item-ledger-consistency-enforced]
#[tokio::test]
async fn receipt_item_ledger_consistency_enforced() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_receipt(&pool, 1, 1).await;
    expect_db_err(
        "item ledger mismatch",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl, created_at, updated_at)
             VALUES (1, 2, 1, 'x', 'x', 100, 100, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-item-category-mismatch-rejected]
#[tokio::test]
async fn receipt_item_category_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_receipt(&pool, 1, 1).await;
    let other = insert_category(&pool, "item_categories", 2, None, "other").await;
    expect_db_err(
        "category ledger mismatch",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl,
                 category_id, created_at, updated_at)
             VALUES (1, 1, 1, 'x', 'x', 100, 100, ?, 0, 0)",
        )
        .bind(other)
        .execute(&pool),
    )
    .await;
    insert_item(&pool, 1, 1, 1, "x").await;
    expect_db_err(
        "category ledger mismatch",
        sqlx::query("UPDATE receipt_items SET category_id = ? WHERE id = 1")
            .bind(other)
            .execute(&pool),
    )
    .await;
}

// [covers:db-schema.discount-parent-same-receipt-item-required]
#[tokio::test]
async fn discount_parent_same_receipt_item_required() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt(&pool, 2, 1).await;
    insert_item(&pool, 1, 1, 1, "x").await; // item on receipt 1
    insert_item(&pool, 2, 2, 1, "y").await; // item on receipt 2
    // parent on another receipt
    expect_db_err(
        "discount parent",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (1, 1, 2, 'discount', 2, 'd', 'd', -10, -10, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // parent must be an item line, not another discount
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (1, 1, 3, 'discount', 'd0', 'd0', -5, -5, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    expect_db_err(
        "discount parent",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (1, 1, 4, 'discount', 3, 'd2', 'd2', -5, -5, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
    // same-receipt item parent is accepted
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (1, 1, 5, 'discount', 1, 'd3', 'd3', -5, -5, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.discount-amount-non-positive]
#[tokio::test]
async fn discount_amount_non_positive() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (1, 1, 1, 'discount', 'd', 'd', 100, 100, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.item-line-parent-forbidden]
#[tokio::test]
async fn item_line_parent_forbidden() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_item(&pool, 1, 1, 1, "x").await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id, name, name_norm,
                 amount, amount_incl, created_at, updated_at)
             VALUES (1, 1, 2, 'item', 1, 'y', 'y', 100, 100, 0, 0)",
        )
        .execute(&pool),
    )
    .await;
}

// [covers:db-schema.line-with-discount-stays-item]
#[tokio::test]
async fn line_with_discount_stays_item() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_item(&pool, 1, 1, 1, "x").await;
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, line_kind, parent_item_id, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (1, 1, 2, 'discount', 1, 'd', 'd', -10, -10, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    expect_db_err(
        "must stay an item",
        sqlx::query("UPDATE receipt_items SET line_kind = 'discount' WHERE id = 1").execute(&pool),
    )
    .await;
}

// [covers:db-schema.receipt-item-bbox-all-or-valid]
#[tokio::test]
async fn receipt_item_bbox_all_or_valid() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    // out of range / non-positive size
    for (x, y, w, h) in [(1.5f64, 0.0, 0.5, 0.5), (0.5, 0.2, 0.7, 0.2)] {
        expect_db_err(
            "CHECK",
            sqlx::query(
                "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl,
                     bbox_x, bbox_y, bbox_w, bbox_h, created_at, updated_at)
                 VALUES (1, 1, 1, 'x', 'x', 100, 100, ?, ?, ?, ?, 0, 0)",
            )
            .bind(x)
            .bind(y)
            .bind(w)
            .bind(h)
            .execute(&pool),
        )
        .await;
    }
    // all-NULL and all-valid both pass. Note: a partially-NULL bbox evaluates
    // the CHECK to NULL (SQLite treats it as satisfied), so the all-or-nothing
    // shape is enforced by the bbox serde type ([f64; 4] as one Option) in
    // the app layer, not the DDL.
    insert_item(&pool, 1, 1, 1, "x").await;
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl,
             bbox_x, bbox_y, bbox_w, bbox_h, created_at, updated_at)
         VALUES (1, 1, 2, 'y', 'y', 100, 100, 0.1, 0.2, 0.5, 0.5, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.receipt-item-receipt-ledger-immutable]
#[tokio::test]
async fn receipt_item_receipt_ledger_immutable() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt(&pool, 2, 1).await;
    insert_item(&pool, 1, 1, 1, "x").await;
    expect_db_err(
        "immutable",
        sqlx::query("UPDATE receipt_items SET receipt_id = 2 WHERE id = 1").execute(&pool),
    )
    .await;
}

// ---------------------------------------------------------------------------
// 0006 search / views

// [covers:db-schema.fts-syncs-on-item-changes]
#[tokio::test]
async fn fts_syncs_on_item_changes() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_item(&pool, 1, 1, 1, "コーヒー牛乳").await;
    let matches = |phrase: &str| {
        let pool = pool.clone();
        let phrase = phrase.to_string();
        async move {
            let n: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM receipt_items_fts WHERE receipt_items_fts MATCH ?",
            )
            .bind(format!("\"{phrase}\""))
            .fetch_one(&pool)
            .await
            .unwrap();
            n
        }
    };
    assert_eq!(matches("コーヒー牛乳").await, 1, "indexed on insert");
    // rename: old phrase no longer matches, new one does
    sqlx::query(
        "UPDATE receipt_items SET name = 'いちご牛乳', name_norm = 'いちご牛乳' WHERE id = 1",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(matches("コーヒー牛乳").await, 0, "delete entry on update");
    assert_eq!(matches("いちご牛乳").await, 1, "insert entry on update");
    // delete removes the entry
    sqlx::query("DELETE FROM receipt_items WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(matches("いちご牛乳").await, 0, "entry removed on delete");
}

// [covers:db-schema.item-facts-excludes-deleted-receipts]
#[tokio::test]
async fn item_facts_excludes_deleted_receipts() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt(&pool, 2, 1).await;
    insert_item(&pool, 1, 1, 1, "a").await;
    insert_item(&pool, 2, 2, 1, "b").await;
    sqlx::query("UPDATE receipts SET deleted_at = 1 WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let names: Vec<(String,)> =
        sqlx::query_as("SELECT f.name FROM v_item_facts f ORDER BY f.item_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(names, vec![("b".to_string(),)]);
}

// [covers:db-schema.item-facts-folds-category-top]
#[tokio::test]
async fn item_facts_folds_category_top() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    let top = insert_category(&pool, "item_categories", 1, None, "食費").await;
    let sub = insert_category(&pool, "item_categories", 1, Some(top), "食料品").await;
    insert_receipt(&pool, 1, 1).await;
    // line with the sub category
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl,
             category_id, created_at, updated_at)
         VALUES (1, 1, 1, 'x', 'x', 100, 100, ?, 0, 0)",
    )
    .bind(sub)
    .execute(&pool)
    .await
    .unwrap();
    // line with only the top category
    sqlx::query(
        "INSERT INTO receipt_items (receipt_id, ledger_id, line_no, name, name_norm, amount, amount_incl,
             category_id, created_at, updated_at)
         VALUES (1, 1, 2, 'y', 'y', 100, 100, ?, 0, 0)",
    )
    .bind(top)
    .execute(&pool)
    .await
    .unwrap();
    let tops: Vec<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT i.id, f.category_top_id FROM receipt_items i JOIN v_item_facts f ON f.item_id = i.id ORDER BY i.id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(tops[0], (1, Some(top)), "sub folds to its top");
    assert_eq!(tops[1], (2, Some(top)), "top-only line stays on itself");
    // store categories fold the same way
    let stop = insert_category(&pool, "store_categories", 1, None, "スーパー").await;
    let ssub = insert_category(&pool, "store_categories", 1, Some(stop), "業務スーパー").await;
    let store: i64 = sqlx::query_scalar(
        "INSERT INTO stores (ledger_id, name, name_norm, category_id, created_at, updated_at)
         VALUES (1, 's', 's', ?, 0, 0) RETURNING id",
    )
    .bind(ssub)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE receipts SET store_id = ? WHERE id = 1")
        .bind(store)
        .execute(&pool)
        .await
        .unwrap();
    let store_top: Option<i64> = sqlx::query_scalar(
        "SELECT f.store_category_top_id FROM v_item_facts f WHERE f.item_id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(store_top, Some(stop), "store sub folds to its top");
}

// ---------------------------------------------------------------------------
// 0007 audit + receipt soft delete/restore revision

// [covers:db-schema.audit-events-invalid-json-rejected]
#[tokio::test]
async fn audit_events_invalid_json_rejected() {
    let pool = mem_pool().await;
    expect_db_err(
        "CHECK",
        sqlx::query(
            "INSERT INTO audit_events (actor_kind, entity_type, entity_id, action, before_json, created_at)
             VALUES ('system', 'draft', 1, 'create', '{broken', 0)",
        )
        .execute(&pool),
    )
    .await;
    sqlx::query(
        "INSERT INTO audit_events (actor_kind, entity_type, entity_id, action, after_json, created_at)
         VALUES ('system', 'draft', 1, 'create', '{}', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
}

// [covers:db-schema.receipt-delete-restore-increments-revision]
#[tokio::test]
async fn receipt_delete_restore_increments_revision() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    sqlx::query(
        "UPDATE receipts SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = 1",
    )
    .bind(NOW)
    .bind(NOW)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE receipts SET deleted_at = NULL, revision = revision + 1, updated_at = ? WHERE id = 1")
        .bind(NOW)
        .execute(&pool)
        .await
        .unwrap();
    let (revision, deleted_at): (i64, Option<i64>) =
        sqlx::query_as("SELECT revision, deleted_at FROM receipts WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((revision, deleted_at), (3, None));
}

// ---------------------------------------------------------------------------
// 0009 labels (TASK-17): per-ledger fixed color labels and receipt
// assignments. NOTE: the Rust-side source of the color order is
// domain::labels::LABEL_COLORS (not implemented yet at the time this test
// was written); this file pins the shared expectation for both sides.

/// The canonical label color set and order (seed trigger, backfill and
/// domain::labels::LABEL_COLORS must all match this).
const LABEL_COLOR_ORDER: &[&str] = &["red", "yellow", "green", "blue", "purple"];

async fn label_titles(pool: &SqlitePool, ledger_id: i64) -> Vec<(String, Option<String>)> {
    let mut rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT color, title FROM ledger_labels WHERE ledger_id = ? ORDER BY color")
            .bind(ledger_id)
            .fetch_all(pool)
            .await
            .unwrap();
    rows.sort_by(|a, b| {
        LABEL_COLOR_ORDER
            .iter()
            .position(|c| c == &a.0)
            .cmp(&LABEL_COLOR_ORDER.iter().position(|c| c == &b.0))
    });
    rows
}

async fn insert_receipt_label(pool: &SqlitePool, receipt_id: i64, ledger_id: i64, color: &str) {
    sqlx::query(
        "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
         VALUES (?, ?, ?, 1, 0)",
    )
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(color)
    .execute(pool)
    .await
    .unwrap();
}

// [covers:db-schema.ledger-labels-seeded-on-create]
#[tokio::test]
async fn ledger_labels_seeded_on_direct_insert() {
    // the raw INSERT path (test helpers and any direct SQL): the AFTER INSERT
    // trigger seeds the 5 definition rows with title NULL. The
    // create_ledger_with_seed path is covered in db_seed_ttl.rs and the
    // registration path (auth/ceremony.rs) in auth_register.rs.
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    let rows = label_titles(&pool, 1).await;
    let colors: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(colors, LABEL_COLOR_ORDER, "5 rows in definition order");
    assert!(
        rows.iter().all(|r| r.1.is_none()),
        "titles are NULL by default"
    );
}

// [covers:db-schema.ledger-labels-match-enum]
#[tokio::test]
async fn ledger_labels_color_enums_match() {
    // The color enumeration lives in two places: the Rust enum
    // (domain::labels::LABEL_COLORS, asserted against LABEL_COLOR_ORDER by
    // the implementation) and the SQL of 0009 (seed trigger + backfill).
    // Read the migration SQL at runtime (no include_str!: the file is absent
    // until the TASK-17 implementation lands, which must not break the
    // build) and check both SQL enumerations equal the canonical order.
    let sql = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations/0009_labels.sql"
    ))
    .expect("0009_labels.sql exists");
    // strip line comments, then collect the string literals in order
    let no_comments = sql
        .lines()
        .map(|l| l.split("--").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let mut found: Vec<String> = Vec::new();
    for (i, part) in no_comments.split('\'').enumerate() {
        if i % 2 == 1 && LABEL_COLOR_ORDER.contains(&part) {
            found.push(part.to_string());
        }
    }
    // seed trigger + backfill: the enumeration appears exactly twice
    let want: Vec<&str> = LABEL_COLOR_ORDER
        .iter()
        .chain(LABEL_COLOR_ORDER.iter())
        .copied()
        .collect();
    assert_eq!(
        found, want,
        "seed trigger and backfill both enumerate the canonical color order"
    );
    // the seeded rows (what the trigger actually inserts) match too
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    let rows = label_titles(&pool, 1).await;
    let seeded: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(seeded, LABEL_COLOR_ORDER);
}

// [covers:db-schema.ledger-labels-backfilled]
#[tokio::test]
async fn ledger_labels_backfilled() {
    let pool = bare_mem_pool().await;
    migrate_until(&pool, 9).await; // 0008 state: no label tables yet
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    let n = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM ledger_labels")
        .fetch_one(&pool)
        .await;
    // before 0009 the table does not exist yet (which is also "no rows");
    // after 0009 applies, the backfill trigger seeds both ledgers
    assert!(
        matches!(&n, Ok(0)) || n.is_err(),
        "no label rows before 0009: {n:?}"
    );
    migrate_rest(&pool).await; // applies 0009 (backfill + trigger)
    for ledger in [1i64, 2] {
        let rows = label_titles(&pool, ledger).await;
        let colors: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(colors, LABEL_COLOR_ORDER, "ledger {ledger} backfilled");
        assert!(rows.iter().all(|r| r.1.is_none()));
        for (created, updated) in sqlx::query_as::<_, (i64, i64)>(
            "SELECT created_at, updated_at FROM ledger_labels WHERE ledger_id = ?",
        )
        .bind(ledger)
        .fetch_all(&pool)
        .await
        .unwrap()
        {
            assert_eq!(
                created.to_string().len(),
                13,
                "created_at is unix ms: {created}"
            );
            assert_eq!(updated.to_string().len(), 13);
        }
    }
}

// [covers:db-schema.receipt-label-unknown-color-rejected]
#[tokio::test]
async fn receipt_label_unknown_color_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    // 'orange' is not in the palette: no (ledger_id, color) definition row
    // exists, so the composite FK rejects it (validity via FK, not CHECK)
    expect_db_err(
        "FOREIGN KEY constraint failed",
        sqlx::query(
            "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
             VALUES (1, 1, 'orange', 1, 0)",
        )
        .execute(&pool),
    )
    .await;
    // a seeded color is accepted
    insert_receipt_label(&pool, 1, 1, "red").await;
}

// [covers:db-schema.receipt-label-ledger-mismatch-rejected]
#[tokio::test]
async fn receipt_label_ledger_mismatch_rejected() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_receipt(&pool, 1, 1).await;
    // ledger 2 has the seeded definitions, so the composite FK alone would
    // pass; the guard trigger aborts the cross-ledger assignment
    expect_db_err(
        "receipt ledger mismatch",
        sqlx::query(
            "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
             VALUES (1, 2, 'red', 1, 0)",
        )
        .execute(&pool),
    )
    .await;
    insert_receipt_label(&pool, 1, 1, "red").await;
}

// [covers:db-schema.receipt-label-update-forbidden]
#[tokio::test]
async fn receipt_label_update_forbidden() {
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt_label(&pool, 1, 1, "red").await;
    // receipt_labels rows are insert/delete only
    expect_db_err(
        "receipt_labels rows are insert/delete only",
        sqlx::query("UPDATE receipt_labels SET created_by = 2 WHERE receipt_id = 1").execute(&pool),
    )
    .await;
    // ledger_labels keys (ledger_id, color) are immutable
    expect_db_err(
        "ledger_labels key is immutable",
        sqlx::query(
            "UPDATE ledger_labels SET color = 'blue' WHERE ledger_id = 1 AND color = 'red'",
        )
        .execute(&pool),
    )
    .await;
    // the title column stays updatable (only the key is frozen)
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = 1 AND color = 'red'")
        .execute(&pool)
        .await
        .unwrap();
    let title: Option<String> =
        sqlx::query_scalar("SELECT title FROM ledger_labels WHERE ledger_id = 1 AND color = 'red'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(title.as_deref(), Some("旅行"));
}

// [covers:db-schema.ledger-labels-cascade-on-ledger-delete]
#[tokio::test]
async fn ledger_labels_cascade_on_ledger_delete() {
    // no app path deletes a ledger, so this is a pure schema test
    let pool = mem_pool().await;
    insert_ledger(&pool, 1).await;
    insert_ledger(&pool, 2).await;
    insert_receipt(&pool, 1, 1).await;
    insert_receipt_label(&pool, 1, 1, "red").await;
    insert_receipt_label(&pool, 1, 1, "blue").await;
    sqlx::query("DELETE FROM ledgers WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let defs: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_labels WHERE ledger_id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let assignments: i64 =
        sqlx::query_scalar("SELECT count(*) FROM receipt_labels WHERE ledger_id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((defs, assignments), (0, 0), "both cascade away");
    // the other ledger's definitions are untouched
    let keep: i64 = sqlx::query_scalar("SELECT count(*) FROM ledger_labels WHERE ledger_id = 2")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(keep, 5);
}
