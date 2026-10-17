//! SQLite pool and migrations.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};

use crate::config::DatabaseConfig;

/// Embedded migrations from `backend/migrations`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Run the migrations and log the resulting state at INFO (spec_auth.md
/// 10-5, TASK-15): applied count and the latest version, so startup logs
/// show which schema the process is running on.
async fn run_migrations(pool: &SqlitePool) -> anyhow::Result<()> {
    MIGRATOR.run(pool).await?;
    let (count, latest): (i64, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), MAX(version) FROM _sqlx_migrations")
            .fetch_one(pool)
            .await?;
    tracing::info!(count, latest_version = latest, "migrations applied");
    Ok(())
}

/// Open (and create if missing) the SQLite database file, then run migrations.
/// Pragmas follow spec_data-model.md section 3 (WAL + synchronous NORMAL).
pub async fn connect_file(path: &Path, cfg: &DatabaseConfig) -> anyhow::Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_millis(cfg.busy_timeout_ms));
    let pool = SqlitePoolOptions::new()
        .max_connections(cfg.max_connections)
        .connect_with(opts)
        .await?;
    run_migrations(&pool).await?;
    Ok(pool)
}

/// In-memory database for tests (single connection so the data is shared).
/// Pragmas follow spec_data-model.md section 3 (WAL does not apply to memory).
pub async fn connect_memory() -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")?
        .foreign_keys(true)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(5000));
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?;
    run_migrations(&pool).await?;
    Ok(pool)
}
