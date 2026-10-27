//! TASK-58 web export / import (settings data tab): POST /api/ledgers/{l}/export
//! (member, viewer included — one consistent snapshot incl. image bytes) and
//! POST /api/ledgers/import (creates a fresh ledger from an export file).
//! Design: tmp/tasks/tm-58/design_settings-data.md.

mod common;

use axum::Router;
use budget_book::app::{self, AppState};
use budget_book::config::Config;
use budget_book::db;
use budget_book::store::normalize_text;
use common::auth::{Client, ORIGIN, body_json};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

async fn setup() -> (Router, SqlitePool, tempfile::TempDir) {
    setup_with_cfg(common::repo_config()).await
}

async fn setup_with_cfg(mut cfg: Config) -> (Router, SqlitePool, tempfile::TempDir) {
    // surface DataError::internal's tracing line when a probe is needed
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    cfg.app.server.port = 0;
    let dir = tempfile::tempdir().unwrap();
    cfg.app.maintenance.image_root = dir.path().to_path_buf();
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool, dir)
}

/// Config with a custom `[data_io]` section (cap tests). The section ships as
/// the last one in app.toml, so trimming from its start + appending the
/// override keeps the TOML valid either way (with or without the section).
fn config_with_data_io(section: &str) -> Config {
    let base = std::fs::read_to_string(common::repo_config_dir().join("app.toml")).unwrap();
    let text = match base.find("[data_io]") {
        Some(i) => format!("{}{}", &base[..i], section),
        None => format!("{base}\n{section}\n"),
    };
    let dir = tempfile::tempdir().unwrap();
    let cfg_dir = dir.path().join("configs/dev");
    std::fs::create_dir_all(&cfg_dir).unwrap();
    std::fs::write(cfg_dir.join("app.toml"), text).unwrap();
    for f in ["auth.toml", "mcp.toml"] {
        std::fs::copy(common::repo_config_dir().join(f), cfg_dir.join(f)).unwrap();
    }
    Config::load(&cfg_dir).expect("configs load")
}

fn data_io_section(payload: usize, receipts: usize, items_total: usize) -> String {
    format!(
        "[data_io]\nmax_payload_bytes = {payload}\nmax_receipts = {receipts}\nmax_items_total = {items_total}\n"
    )
}

/// A registered, logged-in user whose default ledger is the fresh DB's id 1.
async fn user_with_ledger(router: &Router, pool: &SqlitePool) -> (Client, i64, i64) {
    let mut c = Client::new();
    let user_id = common::auth::register_setup_user(&mut c, router, pool, "user").await;
    let ledger_id: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
    (c, user_id, ledger_id)
}

/// Fake WebP bytes (the app checks the magic but never decodes export bytes).
fn webp_bytes(n: usize) -> Vec<u8> {
    let mut v = b"RIFF\x24\x00\x00\x00WEBPVP8 ".to_vec();
    v.extend(std::iter::repeat_n(b'x', n));
    v
}

/// The export format embeds image bytes as base64url without padding (the
/// codec `auth::tokens` already ships; no new dependency).
fn b64(data: &[u8]) -> String {
    budget_book::auth::tokens::b64url_encode(data)
}

/// Overwrite one key of a JSON object (json! has no spread).
fn set(mut v: serde_json::Value, key: &str, val: serde_json::Value) -> serde_json::Value {
    v[key] = val;
    v
}

/// Seed one rich ledger (on top of the registration seed): label titles, a
/// custom 2-level + archived item category, store + alias, an image with a
/// real file, two live receipts (one with a discount line whose line_no is
/// BEFORE its parent item's), one deleted receipt, one pending draft.
async fn seed_rich_ledger(pool: &SqlitePool, root: &std::path::Path, ledger_id: i64, user_id: i64) {
    sqlx::query("UPDATE ledger_labels SET title = '固定費' WHERE ledger_id = ? AND color = 'red'")
        .bind(ledger_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO item_categories (id, ledger_id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (100, ?, NULL, '特別費', 50, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO item_categories (id, ledger_id, parent_id, name, sort_order, created_at, updated_at)
         VALUES (101, ?, 100, '記念日', 51, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO item_categories (id, ledger_id, parent_id, name, sort_order, archived_at, created_at, updated_at)
         VALUES (102, ?, NULL, '旧分類', 52, 777, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO stores (id, ledger_id, name, name_norm, created_at, updated_at)
         VALUES (200, ?, 'スーパーA', 'スーパーa', 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
         VALUES (?, 'スーパーエー', 200, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();

    let bytes = webp_bytes(24);
    let rel = "2026/10/seedkey01.webp";
    tokio::fs::create_dir_all(root.join("2026/10"))
        .await
        .unwrap();
    tokio::fs::write(root.join(rel), &bytes).await.unwrap();
    let sha: Vec<u8> = std::iter::repeat_n(0xAA_u8, 32).collect();
    sqlx::query(
        "INSERT INTO images (id, ledger_id, uploaded_by, file_key, storage_path, width, height,
             byte_size, sha256, original_filename, original_filename_source, taken_at_local,
             taken_at_offset, taken_at_source, created_at)
         VALUES (300, ?, ?, 'seedkey01', ?, 1000, 2000, ?, ?, 'IMG_0001.jpg', 'download',
             '2026-10-01T12:00:00', '+09:00', 'exif', 111)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(rel)
    .bind(bytes.len() as i64)
    .bind(&sha)
    .execute(pool)
    .await
    .unwrap();

    // receipt 400: live, image + store, discount line_no(2) < parent item line_no(5)
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, image_id, store_id, store_name_raw,
             purchased_on, purchased_time, tax_mode, total_amount, tax_amount, payment_method, note,
             revision, created_at, updated_at)
         VALUES (400, ?, ?, 'image', 300, 200, 'スーパーA', '2026-10-01', '12:30', 'inclusive',
             1000, 100, 'cash', 'ちょい高い', 3, 111, 222)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm, quantity,
             unit_price, amount, amount_incl, tax_rate, category_id, category_source,
             bbox_x, bbox_y, bbox_w, bbox_h, created_at, updated_at)
         VALUES (40001, 400, ?, 5, '牛乳 700ml', '牛乳700ml', 1, 200, 200, 220, 10, 101, 'model',
             0.1, 0.2, 0.3, 0.4, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, line_kind, parent_item_id,
             name, name_norm, amount, amount_incl, created_at, updated_at)
         VALUES (40002, 400, ?, 2, 'discount', 40001, '値引', '値引', -20, -20, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();
    for color in ["red", "blue"] {
        sqlx::query(
            "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
             VALUES (400, ?, ?, ?, 0)",
        )
        .bind(ledger_id)
        .bind(color)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    }

    // receipt 401: live, no image, manual, store not resolved
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, store_name_raw, purchased_on,
             tax_mode, total_amount, revision, created_at, updated_at)
         VALUES (401, ?, ?, 'manual', '謎の店', '2026-10-02', 'exclusive', 300, 1, 111, 222)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (40101, 401, ?, 1, 'のり', 'のり', 300, 330, 0, 0)",
    )
    .bind(ledger_id)
    .execute(pool)
    .await
    .unwrap();

    // receipt 402: logically deleted — excluded from export
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, purchased_on, revision,
             created_at, updated_at, deleted_at)
         VALUES (402, ?, ?, 'manual', '2026-10-03', 1, 111, 222, 999)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();

    // pending draft — excluded from export
    sqlx::query(
        "INSERT INTO drafts (ledger_id, user_id, status, payload_json, image_status, created_at, updated_at, expires_at)
         VALUES (?, ?, 'pending', '{}', 'none', 0, 0, 1)",
    )
    .bind(ledger_id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn post_export(
    c: &Client,
    router: &Router,
    ledger_id: i64,
) -> (axum::http::StatusCode, serde_json::Value, Option<String>) {
    let resp = c
        .post(
            router,
            &format!("/api/ledgers/{ledger_id}/export"),
            serde_json::json!({}),
        )
        .await;
    let status = resp.status();
    let disposition = resp
        .headers()
        .get("content-disposition")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = body_json(resp).await;
    (status, body, disposition)
}

/// Minimal valid import file (empty catalog / no receipts).
fn minimal_file(name: &str) -> serde_json::Value {
    serde_json::json!({
        "format": "kakeiboot-ledger-export",
        "version": 1,
        "exported_at": 1,
        "ledger": { "id": 1, "name": name, "created_at": 1 },
        "labels": [],
        "item_categories": [],
        "store_categories": [],
        "stores": [],
        "images": [],
        "receipts": [],
    })
}

fn image_entry(id: i64, data: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "id": id, "width": 10, "height": 10, "byte_size": data.len(),
        "sha256_hex": "aa".repeat(32), "mime_type": "image/webp",
        "source_file_id": null, "source_host": null,
        "original_filename": null, "original_filename_source": null,
        "taken_at_local": null, "taken_at_offset": null, "taken_at_source": null,
        "exif_json": null, "created_at": 5,
        "data_base64": b64(data),
    })
}

fn receipt_entry(id: i64, on: &str, items: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": id, "source": "manual", "image_id": null, "store_id": null, "store_name_raw": null,
        "purchased_on": on, "purchased_time": null, "tax_mode": null,
        "total_amount": 100, "tax_amount": null, "payment_method": null, "note": null,
        "revision": 1, "created_at": 111, "updated_at": 222,
        "labels": [], "items": items,
    })
}

fn item_entry(line_no: i64, name: &str) -> serde_json::Value {
    serde_json::json!({
        "line_no": line_no, "line_kind": "item", "parent_line_no": null,
        "name": name, "name_raw": null, "quantity": 1, "unit": null,
        "unit_price": null, "amount": 100, "amount_incl": 110, "tax_rate": null,
        "category_id": null, "category_source": null, "bbox": null,
    })
}

// ---------------------------------------------------------------------------
// export

#[tokio::test]
// [covers:web-data-api.ledger-export]
async fn export_snapshot_structure_and_audit() {
    let (router, pool, root) = setup().await;
    let (c, user_id, ledger_id) = user_with_ledger(&router, &pool).await;
    seed_rich_ledger(&pool, root.path(), ledger_id, user_id).await;

    // viewer may export (it is a bulk read of data every member already sees)
    sqlx::query("UPDATE ledger_members SET role = 'viewer' WHERE ledger_id = ? AND user_id = ?")
        .bind(ledger_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body, disposition) = post_export(&c, &router, ledger_id).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    assert!(
        disposition
            .as_deref()
            .unwrap_or_default()
            .starts_with("attachment; filename=\"kakeiboot-export-"),
        "content-disposition: {disposition:?}"
    );
    assert_eq!(body["format"], "kakeiboot-ledger-export");
    assert_eq!(body["version"].as_i64(), Some(1));
    assert!(body["exported_at"].is_i64());

    let labels = body["labels"].as_array().unwrap();
    assert_eq!(labels.len(), 5, "five definitions in order");
    assert_eq!(labels[0]["color"], "red");
    assert_eq!(labels[0]["title"], "固定費");
    assert_eq!(labels[1]["color"], "yellow");

    let cats = body["item_categories"].as_array().unwrap();
    let c101 = cats.iter().find(|c| c["id"].as_i64() == Some(101)).unwrap();
    assert_eq!(c101["parent_id"].as_i64(), Some(100));
    assert_eq!(c101["name"], "記念日");
    let c102 = cats.iter().find(|c| c["id"].as_i64() == Some(102)).unwrap();
    assert_eq!(
        c102["archived_at"].as_i64(),
        Some(777),
        "archived_at exported"
    );
    assert!(cats.iter().any(|c| c["archived_at"].is_null()));

    let stores = body["stores"].as_array().unwrap();
    let s200 = stores
        .iter()
        .find(|s| s["id"].as_i64() == Some(200))
        .unwrap();
    assert_eq!(s200["aliases"].as_array().unwrap().len(), 1);
    assert_eq!(s200["aliases"][0], "スーパーエー");

    let images = body["images"].as_array().unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(
        images[0]["byte_size"].as_i64(),
        Some(webp_bytes(24).len() as i64)
    );
    assert_eq!(images[0]["data_base64"], b64(&webp_bytes(24)));

    let receipts = body["receipts"].as_array().unwrap();
    let ids: Vec<i64> = receipts.iter().map(|r| r["id"].as_i64().unwrap()).collect();
    assert_eq!(
        ids,
        vec![400, 401],
        "live receipts only (deleted 402 excluded)"
    );
    let r400 = &receipts[0];
    assert_eq!(r400["labels"], serde_json::json!(["red", "blue"]));
    assert_eq!(r400["revision"].as_i64(), Some(3));
    assert_eq!(r400["created_at"].as_i64(), Some(111));
    let items = r400["items"].as_array().unwrap();
    let discount = items.iter().find(|i| i["line_kind"] == "discount").unwrap();
    assert_eq!(discount["line_no"].as_i64(), Some(2));
    assert_eq!(
        discount["parent_line_no"].as_i64(),
        Some(5),
        "parent referenced by line_no"
    );
    let milk = items
        .iter()
        .find(|i| i["line_no"].as_i64() == Some(5))
        .unwrap();
    assert_eq!(milk["bbox"], serde_json::json!([0.1, 0.2, 0.3, 0.4]));
    assert!(body.get("drafts").is_none(), "drafts never exported");

    // audit: one export row for the ledger, actor web
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, actor_kind FROM audit_events WHERE entity_type = 'ledger' AND action = 'export'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows, vec![("export".into(), "web".into())]);
}

// ---------------------------------------------------------------------------
// guards

#[tokio::test]
// [covers:web-data-api.export-import-guard]
async fn export_import_guards() {
    let (router, pool, root) = setup().await;
    let (c, _user_id, ledger_id) = user_with_ledger(&router, &pool).await;
    seed_rich_ledger(&pool, root.path(), ledger_id, _user_id).await;

    // not logged in: 401 on both
    let anon = Client::new();
    let r = anon
        .post(&router, "/api/ledgers/1/export", serde_json::json!({}))
        .await;
    assert_eq!(r.status(), axum::http::StatusCode::UNAUTHORIZED);
    assert_eq!(body_json(r).await["error"], "unauthorized");
    let r = anon
        .post(&router, "/api/ledgers/import", minimal_file("x"))
        .await;
    assert_eq!(r.status(), axum::http::StatusCode::UNAUTHORIZED);

    // mutation Origin enforcement (api_guard): missing Origin -> 403 on both
    let r = Client::post_raw(
        &router,
        "/api/ledgers/1/export",
        &[("content-type", "application/json".to_string())],
        "{}",
    )
    .await;
    assert_eq!(r.status(), axum::http::StatusCode::FORBIDDEN);
    assert_eq!(body_json(r).await["error"], "origin_mismatch");
    let r = Client::post_raw(
        &router,
        "/api/ledgers/import",
        &[("content-type", "application/json".to_string())],
        "{}",
    )
    .await;
    assert_eq!(r.status(), axum::http::StatusCode::FORBIDDEN);

    // another user's ledger: same 404 as a missing one
    let mut other = Client::new();
    common::auth::register_setup_user(&mut other, &router, &pool, "other").await;
    let r = other
        .post(
            &router,
            &format!("/api/ledgers/{ledger_id}/export"),
            serde_json::json!({}),
        )
        .await;
    assert_eq!(r.status(), axum::http::StatusCode::NOT_FOUND);
    assert_eq!(body_json(r).await["error"], "not_found");

    // import needs only a session: no ledger membership involved
    let r = c
        .post(&router, "/api/ledgers/import", minimal_file("持ち込み"))
        .await;
    assert_eq!(
        r.status(),
        axum::http::StatusCode::OK,
        "import is not ledger-scoped"
    );
}

// ---------------------------------------------------------------------------
// caps

#[tokio::test]
// [covers:web-data-api.ledger-export-cap]
async fn export_payload_cap() {
    let cfg = config_with_data_io(&data_io_section(64, 5000, 50000));
    let (router, pool, root) = setup_with_cfg(cfg).await;
    let (c, user_id, ledger_id) = user_with_ledger(&router, &pool).await;
    seed_rich_ledger(&pool, root.path(), ledger_id, user_id).await;

    let (status, body, _) = post_export(&c, &router, ledger_id).await;
    assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(body, serde_json::json!({ "error": "export_too_large" }));
}

#[tokio::test]
// [covers:web-data-api.ledger-import-cap]
async fn import_count_and_body_caps() {
    // receipts over max_receipts
    let cfg = config_with_data_io(&data_io_section(67_108_864, 1, 50000));
    let (router, pool, _root) = setup_with_cfg(cfg).await;
    let (c, _u, _l) = user_with_ledger(&router, &pool).await;
    let file = set(
        minimal_file("数オーバー"),
        "receipts",
        serde_json::json!([
            receipt_entry(1, "2026-10-01", serde_json::json!([item_entry(1, "a")])),
            receipt_entry(2, "2026-10-02", serde_json::json!([item_entry(1, "b")]))
        ]),
    );
    let r = c.post(&router, "/api/ledgers/import", file).await;
    assert_eq!(r.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(r).await,
        serde_json::json!({ "error": "import_too_large" })
    );

    // total items over max_items_total
    let cfg = config_with_data_io(&data_io_section(67_108_864, 5000, 1));
    let (router, pool, _root) = setup_with_cfg(cfg).await;
    let (c, _u, _l) = user_with_ledger(&router, &pool).await;
    let file = set(
        minimal_file("明細オーバー"),
        "receipts",
        serde_json::json!([receipt_entry(
            1,
            "2026-10-01",
            serde_json::json!([item_entry(1, "a"), item_entry(2, "b")])
        )]),
    );
    let r = c.post(&router, "/api/ledgers/import", file).await;
    assert_eq!(r.status(), axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        body_json(r).await,
        serde_json::json!({ "error": "import_too_large" })
    );

    // body over the route body limit -> rejected before the handler (413);
    // Origin is present so the api_guard passes and the Json extractor rejects
    let cfg = config_with_data_io(&data_io_section(64, 5000, 50000));
    let (router, pool, _root) = setup_with_cfg(cfg).await;
    let (_c, _u, _l) = user_with_ledger(&router, &pool).await;
    let big: &'static str =
        Box::leak(format!("{{\"pad\":\"{}\"}}", "x".repeat(200)).into_boxed_str());
    let r = Client::post_raw(
        &router,
        "/api/ledgers/import",
        &[
            ("content-type", "application/json".to_string()),
            ("origin", ORIGIN.to_string()),
        ],
        big,
    )
    .await;
    assert_eq!(r.status(), axum::http::StatusCode::PAYLOAD_TOO_LARGE);
}

// ---------------------------------------------------------------------------
// import

#[tokio::test]
// [covers:web-data-api.ledger-import]
async fn import_creates_ledger_and_roundtrip() {
    let (router, pool, root) = setup().await;
    let (c, user_id, ledger_id) = user_with_ledger(&router, &pool).await;
    seed_rich_ledger(&pool, root.path(), ledger_id, user_id).await;

    let (_, export, _) = post_export(&c, &router, ledger_id).await;
    let r = c.post(&router, "/api/ledgers/import", export.clone()).await;
    let status = r.status();
    let out = body_json(r).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{out}");
    let new_id = out["ledger"]["id"].as_i64().unwrap();
    assert_ne!(new_id, ledger_id);
    assert_eq!(out["ledger"]["name"], export["ledger"]["name"]);
    assert_eq!(out["counts"]["receipts"].as_i64(), Some(2));
    assert_eq!(out["counts"]["items"].as_i64(), Some(3));
    assert_eq!(out["counts"]["images"].as_i64(), Some(1));
    assert_eq!(out["counts"]["stores"].as_i64(), Some(1));
    assert_eq!(
        out["counts"]["item_categories"].as_i64().unwrap(),
        export["item_categories"].as_array().unwrap().len() as i64
    );
    assert_eq!(
        out["counts"]["store_categories"].as_i64().unwrap(),
        export["store_categories"].as_array().unwrap().len() as i64
    );

    // membership: importer becomes owner with an assigned color
    let (role, color): (String, String) = sqlx::query_as(
        "SELECT role, color FROM ledger_members WHERE ledger_id = ? AND user_id = ?",
    )
    .bind(new_id)
    .bind(user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(role, "owner");
    assert!(!color.is_empty());

    // labels: five seeded rows (trigger) with the exported title applied
    let titles: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT color, title FROM ledger_labels WHERE ledger_id = ? ORDER BY color")
            .bind(new_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(titles.len(), 5);
    assert_eq!(
        titles
            .iter()
            .find(|(c, _)| c == "red")
            .unwrap()
            .1
            .as_deref(),
        Some("固定費")
    );

    // categories: exactly the file's set (no registration seed) with
    // archived_at preserved and the parent link remapped
    let cnt: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM item_categories WHERE ledger_id = ?")
        .bind(new_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        cnt as usize,
        export["item_categories"].as_array().unwrap().len(),
        "no extra seed categories"
    );
    let arch: i64 = sqlx::query_scalar(
        "SELECT archived_at FROM item_categories WHERE ledger_id = ? AND name = '旧分類'",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(arch, 777);
    let sub_parent: i64 = sqlx::query_scalar(
        "SELECT parent_id FROM item_categories WHERE ledger_id = ? AND name = '記念日'",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let sub_parent_name: String =
        sqlx::query_scalar("SELECT name FROM item_categories WHERE id = ?")
            .bind(sub_parent)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sub_parent_name, "特別費");

    // store: norm recomputed, alias carried
    let norm: String = sqlx::query_scalar(
        "SELECT name_norm FROM stores WHERE ledger_id = ? AND name = 'スーパーA'",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(norm, normalize_text("スーパーA"));
    let aliases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_aliases WHERE ledger_id = ?")
        .bind(new_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(aliases, 1);

    // image: fresh file_key / storage_path, file bytes identical
    let (key, path): (String, String) =
        sqlx::query_as("SELECT file_key, storage_path FROM images WHERE ledger_id = ?")
            .bind(new_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(key, "seedkey01");
    let written = tokio::fs::read(root.path().join(&path)).await.unwrap();
    assert_eq!(written, webp_bytes(24));

    // receipt: remapped refs, preserved history columns, importer as creator
    let row: (i64, i64, Option<i64>, i64, Option<i64>, i64) = sqlx::query_as(
        "SELECT revision, created_at, store_id, created_by, image_id, updated_at
         FROM receipts WHERE ledger_id = ? AND purchased_on = '2026-10-01'",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (revision, created_at, store_ref, created_by, image_ref, updated_at) = row;
    assert_eq!(
        (revision, created_at, created_by, updated_at),
        (3, 111, user_id, 222)
    );
    let new_store: i64 =
        sqlx::query_scalar("SELECT id FROM stores WHERE ledger_id = ? AND name = 'スーパーA'")
            .bind(new_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(store_ref, Some(new_store), "store ref remapped");
    let new_image: i64 = sqlx::query_scalar("SELECT id FROM images WHERE ledger_id = ?")
        .bind(new_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(image_ref, Some(new_image), "image ref remapped");

    // items: discount (line_no 2) resolves its parent (line_no 5) after the
    // two-pass insert; norm recomputed
    let parent_id: i64 = sqlx::query_scalar(
        "SELECT parent_item_id FROM receipt_items ri JOIN receipts r ON r.id = ri.receipt_id
         WHERE r.ledger_id = ? AND ri.line_kind = 'discount'",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let (parent_line, parent_name): (i64, String) =
        sqlx::query_as("SELECT line_no, name_norm FROM receipt_items WHERE id = ?")
            .bind(parent_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(parent_line, 5);
    assert_eq!(parent_name, "牛乳700ml");

    // FTS picked the inserted rows up (trigger). The FTS table has no ledger
    // column: the source ledger's own item matches too (source + imported).
    let fts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM receipt_items_fts WHERE receipt_items_fts MATCH '牛乳700ml'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(fts, 2);

    // labels on the receipt
    let lbl: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM receipt_labels rl JOIN receipts r ON r.id = rl.receipt_id WHERE r.ledger_id = ?",
    )
    .bind(new_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(lbl, 2);

    // audit: one import row
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT action FROM audit_events WHERE entity_type = 'ledger' AND entity_id = ? AND action = 'import'",
    )
    .bind(new_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows, vec!["import".to_string()]);

    // round-trip: exporting the imported ledger yields the same content
    let (_, second, _) = post_export(&c, &router, new_id).await;
    assert_eq!(second["labels"], export["labels"]);
    assert_eq!(second["receipts"].as_array().unwrap().len(), 2);
    assert_eq!(
        second["images"][0]["data_base64"],
        export["images"][0]["data_base64"]
    );
    let s0 = &second["receipts"][0];
    assert_eq!(s0["purchased_on"], export["receipts"][0]["purchased_on"]);
    assert_eq!(s0["labels"], export["receipts"][0]["labels"]);
    assert_eq!(s0["revision"], export["receipts"][0]["revision"]);
    assert_eq!(s0["created_at"], export["receipts"][0]["created_at"]);
    // items identical incl. discount parent refs; legacy ids (category_id)
    // are per-export keys, so they are stripped before comparing
    let strip_ids = |items: &serde_json::Value| -> serde_json::Value {
        serde_json::Value::Array(
            items
                .as_array()
                .unwrap()
                .iter()
                .map(|it| {
                    let mut o = it.clone();
                    if let Some(m) = o.as_object_mut() {
                        m.remove("category_id");
                    }
                    o
                })
                .collect(),
        )
    };
    assert_eq!(
        strip_ids(&s0["items"]),
        strip_ids(&export["receipts"][0]["items"]),
        "items identical incl. discount parent refs"
    );
}

// ---------------------------------------------------------------------------
// invalid imports

#[tokio::test]
// [covers:web-data-api.ledger-import-invalid]
async fn import_invalid_variants() {
    let (router, pool, root) = setup().await;
    let (c, _u, _l) = user_with_ledger(&router, &pool).await;
    let ledgers_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ledgers")
        .fetch_one(&pool)
        .await
        .unwrap();

    let webp = webp_bytes(8);
    let not_webp = b"not-webp-at-all!!";
    let bad_files: Vec<serde_json::Value> = vec![
        // wrong format / unknown version
        set(
            minimal_file("x"),
            "format",
            serde_json::json!("something-else"),
        ),
        set(minimal_file("x"), "version", serde_json::json!(2)),
        // ledger name empty / over the cap
        minimal_file(""),
        minimal_file(&"あ".repeat(101)),
        // date / enum / numeric shape violations
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([receipt_entry(
                1,
                "2026/10/01",
                serde_json::json!([item_entry(1, "a")])
            )]),
        ),
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([set(
                receipt_entry(1, "2026-10-01", serde_json::json!([item_entry(1, "a")])),
                "source",
                serde_json::json!("fax")
            )]),
        ),
        set(
            minimal_file("x"),
            "labels",
            serde_json::json!([{ "color": "pink", "title": "x" }]),
        ),
        // duplicate label color (hand-made files only; exports are unique)
        set(
            minimal_file("x"),
            "labels",
            serde_json::json!([
                { "color": "red", "title": "a" },
                { "color": "red", "title": "b" }
            ]),
        ),
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([receipt_entry(
                1,
                "2026-10-01",
                serde_json::json!([set(item_entry(1, "a"), "quantity", serde_json::json!(0))])
            )]),
        ),
        // line_no duplicate / dangling parent
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([receipt_entry(
                1,
                "2026-10-01",
                serde_json::json!([item_entry(1, "a"), item_entry(1, "b")])
            )]),
        ),
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([receipt_entry(
                1,
                "2026-10-01",
                serde_json::json!([set(
                    item_entry(1, "a"),
                    "parent_line_no",
                    serde_json::json!(9)
                )])
            )]),
        ),
        // duplicate legacy ids / duplicate label color on one receipt
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([
                receipt_entry(7, "2026-10-01", serde_json::json!([item_entry(1, "a")])),
                receipt_entry(7, "2026-10-02", serde_json::json!([item_entry(1, "b")]))
            ]),
        ),
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([set(
                receipt_entry(1, "2026-10-01", serde_json::json!([item_entry(1, "a")])),
                "labels",
                serde_json::json!(["red", "red"])
            )]),
        ),
        // image bytes integrity
        set(
            minimal_file("x"),
            "images",
            serde_json::json!([set(
                image_entry(1, &webp),
                "byte_size",
                serde_json::json!(999)
            )]),
        ),
        set(
            minimal_file("x"),
            "images",
            serde_json::json!([image_entry(1, not_webp)]),
        ),
        // missing required field
        set(
            minimal_file("x"),
            "receipts",
            serde_json::json!([set(
                receipt_entry(1, "2026-10-01", serde_json::json!([])),
                "purchased_on",
                serde_json::Value::Null
            )]),
        ),
        // passes pre-validation, hits a DB constraint (duplicate store names)
        set(
            minimal_file("x"),
            "stores",
            serde_json::json!([
                { "id": 1, "name": "同じ店", "category_id": null, "category_source": null, "aliases": [] },
                { "id": 2, "name": "同じ店", "category_id": null, "category_source": null, "aliases": [] }
            ]),
        ),
    ];
    // the constraint case carries a valid image: files must not survive
    let last = bad_files.len() - 1;
    let bad_files: Vec<serde_json::Value> = bad_files
        .into_iter()
        .enumerate()
        .map(|(i, mut f)| {
            if i == last {
                f["images"] = serde_json::json!([image_entry(1, &webp)]);
            }
            f
        })
        .collect();
    for (i, file) in bad_files.iter().enumerate() {
        let r = c.post(&router, "/api/ledgers/import", file).await;
        let status = r.status();
        let body = body_json(r).await;
        assert_eq!(
            status,
            axum::http::StatusCode::BAD_REQUEST,
            "case {i} should be import_invalid: {body}"
        );
        assert_eq!(
            body,
            serde_json::json!({ "error": "import_invalid" }),
            "case {i}"
        );
    }

    // nothing was created: no partial ledger rows, no leftover image files
    let ledgers_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ledgers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        ledgers_after, ledgers_before,
        "rollback removed every partial row"
    );
    let mut files = 0;
    for entry in walkdir_std(root.path()) {
        if entry.is_file() {
            files += 1;
        }
    }
    assert_eq!(files, 0, "compensating delete removed written image files");
}

/// Minimal recursive walk (test-only; avoids a new dev-dependency).
fn walkdir_std(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walkdir_std(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}
