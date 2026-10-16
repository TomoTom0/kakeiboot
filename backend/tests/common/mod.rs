#![allow(dead_code)]

pub mod auth;
pub mod oauth;

use std::net::SocketAddr;
use std::path::PathBuf;

use budget_book::{app, config::Config, db};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

/// The repository's real dev config directory (configs/dev/).
pub fn repo_config_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../configs/dev")
}

pub fn repo_config() -> Config {
    Config::load(&repo_config_dir()).expect("configs/dev/*.toml load")
}

/// Spawn the full app on an OS-assigned port with an in-memory DB.
pub async fn spawn_app() -> (SocketAddr, Config, CancellationToken) {
    let (addr, cfg, ct, _pool) = spawn_app_with_pool().await;
    (addr, cfg, ct)
}

/// Like [`spawn_app`] but also returns the DB pool (for direct fixtures).
pub async fn spawn_app_with_pool() -> (SocketAddr, Config, CancellationToken, SqlitePool) {
    let mut cfg = repo_config();
    cfg.app.server.port = 0;
    cfg.app.server.hosts = vec!["127.0.0.1".into()];
    let pool = db::connect_memory().await.expect("memory db");
    let ct = CancellationToken::new();
    let state = app::AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, ct.child_token());
    let listener = app::bind(&cfg).await.expect("bind").remove(0);
    let addr = listener.local_addr().unwrap();
    let serve_ct = ct.clone();
    tokio::spawn(async move {
        let _ = app::serve(listener, router, serve_ct).await;
    });
    (addr, cfg, ct, pool)
}

// ---------------------------------------------------------------------------
// DB schema fixtures (TASK-8). Minimal rows satisfying NOT NULL / CHECK so
// that constraint-focused tests can target a single violation at a time.

/// Reference "now" for TTL tests (unix ms).
pub const NOW: i64 = 1_000_000_000_000;
/// One day in unix ms (spec_data-model.md section 12).
pub const DAY_MS: i64 = 86_400_000;

pub async fn mem_pool() -> SqlitePool {
    db::connect_memory().await.expect("memory db")
}

/// SQLite error message (trigger abort text or constraint name) for assertions.
pub fn db_err(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(d) => d.message().to_string(),
        other => other.to_string(),
    }
}

/// Assert that the query future fails with a message containing `needle`
/// (trigger abort text or constraint name); returns the message.
pub async fn expect_db_err<F, T>(needle: &str, f: F) -> String
where
    F: std::future::Future<Output = Result<T, sqlx::Error>>,
    T: std::fmt::Debug,
{
    let err = f.await.expect_err("expected a database error");
    let msg = db_err(&err);
    assert!(
        msg.contains(needle),
        "expected error containing {needle:?}, got {msg:?}"
    );
    msg
}

pub async fn insert_user(pool: &SqlitePool, id: i64) {
    sqlx::query(
        "INSERT INTO users (id, webauthn_user_handle, account_number, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(vec![id as u8; 16])
    .bind(format!("BB-0000-{id:04}"))
    .bind(format!("user{id}"))
    .execute(pool)
    .await
    .unwrap();
}

pub async fn insert_ledger(pool: &SqlitePool, id: i64) {
    sqlx::query("INSERT INTO ledgers (id, name, created_at, updated_at) VALUES (?, ?, 0, 0)")
        .bind(id)
        .bind(format!("ledger{id}"))
        .execute(pool)
        .await
        .unwrap();
}

pub async fn insert_member(pool: &SqlitePool, ledger_id: i64, user_id: i64, role: &str) {
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, ?, 0)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();
}

pub async fn insert_image(pool: &SqlitePool, id: i64, ledger_id: i64) {
    sqlx::query(
        "INSERT INTO images (id, ledger_id, uploaded_by, file_key, storage_path, width, height,
             byte_size, sha256, created_at)
         VALUES (?, ?, 1, ?, ?, 1, 1, 1, x'00', ?)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(format!("key{id}"))
    .bind(format!("path/{id}.webp"))
    .bind(NOW)
    .execute(pool)
    .await
    .unwrap();
}

/// Minimal receipt (manual source, no store/image) on `ledger_id`.
/// Implicitly ensures user 1 exists (receipts.created_by references users).
pub async fn insert_receipt(pool: &SqlitePool, id: i64, ledger_id: i64) {
    sqlx::query("INSERT OR IGNORE INTO users (id, webauthn_user_handle, account_number, display_name, created_at, updated_at) VALUES (1, zeroblob(16), 'BB-0000-0001', 'user1', 0, 0)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, purchased_on, created_at, updated_at)
         VALUES (?, ?, 1, 'manual', '2026-10-01', ?, ?)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(NOW)
    .bind(NOW)
    .execute(pool)
    .await
    .unwrap();
}

/// Minimal item line (line 1) on a receipt.
pub async fn insert_item(pool: &SqlitePool, id: i64, receipt_id: i64, ledger_id: i64, name: &str) {
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm, amount,
             amount_incl, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, 100, 100, ?, ?)",
    )
    .bind(id)
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(name)
    .bind(name)
    .bind(NOW)
    .bind(NOW)
    .execute(pool)
    .await
    .unwrap();
}

/// Insert a category row and return its id.
pub async fn insert_category(
    pool: &SqlitePool,
    table: &str,
    ledger_id: i64,
    parent_id: Option<i64>,
    name: &str,
) -> i64 {
    assert!(table == "item_categories" || table == "store_categories");
    let sql = format!(
        "INSERT INTO {table} (ledger_id, parent_id, name, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0) RETURNING id"
    );
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(ledger_id)
        .bind(parent_id)
        .bind(name)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Insert a minimal pending draft (payload is valid JSON) and return its id.
pub async fn insert_draft_min(
    pool: &SqlitePool,
    ledger_id: i64,
    user_id: i64,
    image_status: &str,
    reason: Option<&str>,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, image_unavailable_reason,
             created_at, updated_at, expires_at)
         VALUES (?, ?, '{\"items\":[]}', ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(image_status)
    .bind(reason)
    .bind(NOW)
    .bind(NOW)
    .bind(NOW + 14 * DAY_MS)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// One row of a draft's (status, image_status, image_unavailable_reason, image_id, revision).
pub type DraftState = (String, String, Option<String>, Option<i64>, i64);

pub async fn draft_state(pool: &SqlitePool, id: i64) -> DraftState {
    sqlx::query_as::<_, DraftState>(
        "SELECT status, image_status, image_unavailable_reason, image_id, revision
         FROM drafts WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .unwrap()
}

// ---------------------------------------------------------------------------
// Partial migration (TASK-16; shared with TASK-17's 0009 data migration test).

/// In-memory DB with the same pragmas as `db::connect_memory` but no
/// migrations applied (single connection so the data is shared).
pub async fn bare_mem_pool() -> SqlitePool {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteSynchronous};
    use std::str::FromStr;
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true)
        .synchronous(SqliteSynchronous::Normal);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("bare memory db")
}

/// Apply only the migrations with `version < version_exclusive` from
/// `db::MIGRATOR` (recorded in `_sqlx_migrations`), so a test can insert
/// pre-migration rows and then run the rest with `db::MIGRATOR.run`.
pub async fn migrate_until(pool: &SqlitePool, version_exclusive: i64) {
    db::MIGRATOR
        .run_to(version_exclusive - 1, pool)
        .await
        .expect("partial migration");
}

/// Apply the remaining migrations after [`migrate_until`].
pub async fn migrate_rest(pool: &SqlitePool) {
    db::MIGRATOR.run(pool).await.expect("remaining migrations");
}
