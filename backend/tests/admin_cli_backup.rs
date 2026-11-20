//! TASK-83: `admin backup` (spec_auth.md section 9, auth-cli.backup-*):
//! take a single-file snapshot of the WAL database via a read-only
//! `VACUUM INTO` with tmp -> rename (design v4 section 4-5).
//!
//! Unlike the other admin CLI tests these call `admin::run` directly — the
//! same entry point `main` uses — because Backup resolves the db path from
//! `--config-dir` and opens it read-only (create_if_missing(false), no
//! migrations) instead of running on the shared read-write pool, so
//! `run_with(&pool, ..)` cannot host it. A non-zero process exit maps to
//! `Err` returned from `admin::run`.

use std::path::{Path, PathBuf};

use budget_book::config::Config;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{Connection, Executor, SqlitePool};

// Minimal configs/<env>/ contents (mirrors the canonical fixtures in
// src/config.rs tests). Relative db path resolves against the temp root,
// two levels above the config dir (configs/<env>/ convention).
const APP_TOML: &str = r#"
[server]
hosts = ["127.0.0.1"]
port = 0
shutdown_timeout_secs = 5

[mcp]
path = "/mcp"
allowed_hosts = ["localhost"]
max_request_body_bytes = 1024

[database]
path = "var/db/test.sqlite"
max_connections = 5
busy_timeout_ms = 5000

[log]
filter = "info"

[frontend]
dev_port = 5173

[maintenance]
cleanup_interval_secs = 3600
image_root = "var/images"

[data_io]
max_payload_bytes = 67108864
max_receipts = 5000
max_items_total = 50000
"#;
const AUTH_TOML: &str = r#"
[auth]
profile = "dev"

[auth.env.dev]
rp_id = "localhost"
rp_origin = "http://localhost:40281"
public_origin = "http://localhost:40281"
issuer = "http://localhost:40281"
resource = "http://localhost:40281/mcp"

[auth.session]
idle_days = 14
absolute_days = 30
step_up_secs = 600
last_seen_update_secs = 300

[auth.ceremony]
ttl_secs = 300

[auth.invitation]
setup_ttl_hours = 24
invite_ttl_hours = 168
recovery_ttl_hours = 1
recovery_ttl_max_hours = 24
register_ttl_hours = 168
share_ttl_hours = 168

[auth.rate_limit]
webauthn_per_minute = 20
token_accept_per_minute = 10
token_accept_fail_block = 10
token_accept_block_minutes = 15
authorize_per_minute = 30
token_endpoint_per_minute = 60
mcp_per_minute = 120
recovery_anonymous_per_minute = 5
trust_cf_connecting_ip = false

[auth.oauth]
default_scopes = "ledger.read ledger.write"
cimd_allowed_hosts = ["chatgpt.com"]
redirect_uri_allowlist = ["https://chatgpt.com/connector_platform_oauth_redirect"]
authz_request_ttl_secs = 600
code_ttl_secs = 60
access_token_ttl_secs = 3600
refresh_sliding_days = 30
grant_absolute_days = 90
rotation_grace_secs = 60
clock_skew_secs = 60

[auth.oauth.dev]
allow_insecure_loopback = false

[auth.recovery_request]
per_subject_hours = 24
append_per_day = 3
per_ip_per_day = 3
global_per_day = 10
anonymous_ip_per_day = 1
note_max_chars = 200
note_total_max_chars = 1000
"#;
const MCP_TOML: &str = r#"
[limits]
max_items = 200
max_name_chars = 200
max_ledger_name_chars = 100
max_note_chars = 1000
search_default_limit = 20
search_max_limit = 50
max_query_chars = 200
stats_max_rows = 200
catalog_max_stores = 50
widget_refs_max = 20
drafts_default_limit = 20
drafts_max_limit = 50
max_label_title_chars = 20
max_label_batch = 50
batch_max_drafts = 10
batch_max_approve = 20

[image]
fetch_allowed_hosts = ["files.oaiusercontent.com", "*.oaiusercontent.com"]
fetch_timeout_secs = 20
max_download_bytes = 20971520
max_pixels = 50000000
resize_max_edge = 2048
webp_quality = 80.0
access_token_ttl_secs = 900
allow_insecure_loopback = false
batch_fetch_concurrency = 3
decode_concurrency = 2
batch_decode_concurrency = 1
batch_fetch_deadline_secs = 40

[widget]
html_path = "frontend/dist/widget.html"
"#;

/// Write configs/dev/{app,auth,mcp}.toml under `root`; returns the config dir.
fn write_configs(root: &Path) -> PathBuf {
    let cfg_dir = root.join("configs").join("dev");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(cfg_dir.join("app.toml"), APP_TOML).unwrap();
    std::fs::write(cfg_dir.join("auth.toml"), AUTH_TOML).unwrap();
    std::fs::write(cfg_dir.join("mcp.toml"), MCP_TOML).unwrap();
    cfg_dir
}

/// Load the config and open (create + migrate) the WAL db it points to.
async fn open_db(cfg_dir: &Path) -> (Config, SqlitePool) {
    let cfg = Config::load(cfg_dir).unwrap();
    let pool = budget_book::db::connect_file(&cfg.database_path(), &cfg.app.database)
        .await
        .unwrap();
    (cfg, pool)
}

/// `budget-book admin backup --dest <dest> --config-dir <cfg_dir>` via the
/// real entry point. Err here is what `main` turns into a non-zero exit.
async fn run_backup(cfg_dir: &Path, dest: &Path) -> anyhow::Result<()> {
    budget_book::admin::run(vec![
        "backup".to_string(),
        "--dest".to_string(),
        dest.display().to_string(),
        "--config-dir".to_string(),
        cfg_dir.display().to_string(),
    ])
    .await
}

/// Read-only connection to a finished snapshot file (the VACUUM INTO output).
async fn open_snapshot(path: &Path) -> SqliteConnection {
    let opts = SqliteConnectOptions::new().filename(path).read_only(true);
    SqliteConnection::connect_with(&opts).await.unwrap()
}

/// The `<dest>.tmp` staging path from the design (design v4 section 4-5).
fn tmp_of(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".tmp");
    PathBuf::from(s)
}

/// One users row (same shape as common::insert_user) on any executor.
async fn insert_user<'e, E>(executor: E, id: i64)
where
    E: Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "INSERT INTO users (id, webauthn_user_handle, account_number, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(vec![id as u8; 16])
    .bind(format!("BB-0000-{id:04}"))
    .bind(format!("user{id}"))
    .execute(executor)
    .await
    .unwrap();
}

async fn user_count(conn: &mut SqliteConnection) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(conn)
        .await
        .unwrap()
}

// [covers:auth-cli.backup-snapshot]
#[tokio::test]
async fn backup_writes_single_snapshot_file_without_touching_source() {
    let root = tempfile::tempdir().unwrap();
    let cfg_dir = write_configs(root.path());
    let (cfg, pool) = open_db(&cfg_dir).await;
    insert_user(&pool, 1).await;
    let db_path = cfg.database_path();

    // source bytes before the run: a read-only open must not rewrite the
    // db file (no writes, no migration execution on the source)
    let before = std::fs::read(&db_path).unwrap();

    let dest = root.path().join("backups").join("snapshot.sqlite");
    std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
    run_backup(&cfg_dir, &dest)
        .await
        .expect("admin backup succeeds");

    assert!(dest.is_file(), "dest holds a single snapshot file");
    assert!(!tmp_of(&dest).exists(), "no <dest>.tmp is left behind");

    // the snapshot carries the schema and the data committed to WAL
    let mut snap = open_snapshot(&dest).await;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut snap)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(user_count(&mut snap).await, 1);
    let migrations: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&mut snap)
        .await
        .unwrap();
    assert!(migrations > 0, "schema is part of the snapshot");

    // source db untouched by the backup run
    let after = std::fs::read(&db_path).unwrap();
    assert_eq!(
        before, after,
        "read-only open must not modify the source db file"
    );
    let source_users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(source_users, 1, "source data unchanged");
}

// [covers:auth-cli.backup-integrity]
#[tokio::test]
async fn backup_snapshot_is_point_in_time_consistent_amid_writes() {
    const INITIAL: i64 = 4;
    const BATCH: i64 = 5;
    const BATCHES: i64 = 40;

    let root = tempfile::tempdir().unwrap();
    let cfg_dir = write_configs(root.path());
    let (cfg, pool) = open_db(&cfg_dir).await;
    for id in 1..=INITIAL {
        insert_user(&pool, id).await;
    }
    // the committed rows sit in the un-checkpointed WAL while the pool (the
    // "running server") stays open: the snapshot must read through it
    let wal = PathBuf::from(format!("{}-wal", cfg.database_path().display()));
    assert!(
        wal.is_file() && std::fs::metadata(&wal).unwrap().len() > 0,
        "precondition: un-checkpointed WAL content exists"
    );

    // concurrent writer: whole batches of 5 rows per transaction
    let writer = {
        let pool = pool.clone();
        tokio::spawn(async move {
            let mut next = INITIAL + 1;
            for _ in 0..BATCHES {
                let mut tx = pool.begin().await.unwrap();
                for _ in 0..BATCH {
                    insert_user(&mut *tx, next).await;
                    next += 1;
                }
                tx.commit().await.unwrap();
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        })
    };

    // wait until at least one writer batch has committed, so the backup runs
    // against a db with writes in flight
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&pool)
            .await
            .unwrap();
        if n >= INITIAL + BATCH {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "writer never committed a batch"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    let dest = root.path().join("snapshot.sqlite");
    run_backup(&cfg_dir, &dest)
        .await
        .expect("backup succeeds while writes are in flight");
    writer.await.unwrap();

    let total = INITIAL + BATCH * BATCHES;
    let final_source: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(final_source, total, "writer finished every batch");

    let mut snap = open_snapshot(&dest).await;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut snap)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    let n = user_count(&mut snap).await;
    assert!(
        n >= INITIAL + BATCH,
        "snapshot includes the WAL writes observed before the run (got {n})"
    );
    assert!(
        n <= total,
        "snapshot cannot run ahead of the source (got {n})"
    );
    assert_eq!(
        (n - INITIAL) % BATCH,
        0,
        "snapshot holds one point in time: only whole committed batches, never a mix (got {n})"
    );
}

// [covers:auth-cli.backup-error-exits]
#[tokio::test]
async fn backup_failures_exit_nonzero_without_partial_or_created_db() {
    // control: a valid db and dest succeed, so the failures below are
    // attributed to the injected error conditions alone
    let root = tempfile::tempdir().unwrap();
    let cfg_dir = write_configs(root.path());
    let (_cfg, pool) = open_db(&cfg_dir).await;
    insert_user(&pool, 1).await;
    let ok_dest = root.path().join("ok").join("snapshot.sqlite");
    std::fs::create_dir_all(ok_dest.parent().unwrap()).unwrap();
    run_backup(&cfg_dir, &ok_dest)
        .await
        .expect("control backup succeeds");

    // db file missing (--config-dir pointing at a wrong path): open error,
    // and the absent path must NOT be created as an empty db — Backup must
    // not go through the create_if_missing(true) shared connect_file path
    let root2 = tempfile::tempdir().unwrap();
    let cfg_dir2 = write_configs(root2.path());
    let absent_db = root2.path().join("var").join("db").join("test.sqlite");
    let dest2 = root2.path().join("out").join("snapshot.sqlite");
    std::fs::create_dir_all(dest2.parent().unwrap()).unwrap();
    let err = run_backup(&cfg_dir2, &dest2)
        .await
        .expect_err("missing db file must fail");
    assert!(
        !absent_db.exists(),
        "no empty db created at the misconfigured path ({err})"
    );
    assert!(!dest2.exists(), "no partial dest on failure");
    assert!(!tmp_of(&dest2).exists(), "no partial <dest>.tmp on failure");

    // dest parent dir missing: VACUUM INTO cannot create the file
    let bad_dest = root.path().join("no").join("such").join("snapshot.sqlite");
    run_backup(&cfg_dir, &bad_dest)
        .await
        .expect_err("missing dest parent dir must fail");
    assert!(!bad_dest.exists());
    assert!(!tmp_of(&bad_dest).exists());
    assert!(
        !root.path().join("no").exists(),
        "no directories created for the failed dest"
    );
}

// [covers:auth-cli.backup-tmp-idempotent]
#[tokio::test]
async fn backup_rerun_survives_stale_tmp_and_overwrites_dest() {
    let root = tempfile::tempdir().unwrap();
    let cfg_dir = write_configs(root.path());
    let (_cfg, pool) = open_db(&cfg_dir).await;
    insert_user(&pool, 1).await;
    insert_user(&pool, 2).await;

    let dest = root.path().join("snapshot.sqlite");
    run_backup(&cfg_dir, &dest)
        .await
        .expect("first backup succeeds");
    assert!(dest.is_file());

    // simulate an interrupted earlier run (stale <dest>.tmp would make
    // VACUUM INTO fail without the pre-run deletion) plus newer source rows
    std::fs::write(tmp_of(&dest), b"stale partial snapshot").unwrap();
    insert_user(&pool, 3).await;

    run_backup(&cfg_dir, &dest)
        .await
        .expect("rerun over a stale tmp and an existing dest succeeds");
    assert!(!tmp_of(&dest).exists(), "tmp cleaned up after the rerun");

    let mut snap = open_snapshot(&dest).await;
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut snap)
        .await
        .unwrap();
    assert_eq!(integrity, "ok");
    assert_eq!(
        user_count(&mut snap).await,
        3,
        "dest was replaced with the newer snapshot (fs::rename overwrites)"
    );
}
