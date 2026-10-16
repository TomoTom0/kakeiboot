//! `/media/img/<token>` widget image delivery (spec_mcp-tools.md 11-5):
//! the delivery-time recheck (token expiry, user disablement, ledger
//! membership, live receipt / pending-draft reference), the response
//! header set, in-TTL reuse, and the per-IP rate limit.

mod common;

use std::path::PathBuf;

use axum::Router;
use budget_book::app::{self, AppState};
use budget_book::auth::session::now_ms;
use budget_book::auth::tokens::b64url_encode;
use budget_book::db;
use budget_book::domain::images::issue_image_url;
use common::auth::Client;
use http_body_util::BodyExt;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 fake payload";

async fn setup() -> (Router, SqlitePool, PathBuf, tempfile::TempDir) {
    let mut cfg = common::repo_config();
    cfg.app.server.port = 0;
    let dir = tempfile::tempdir().expect("tempdir");
    cfg.app.maintenance.image_root = dir.path().to_path_buf();
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    let root = cfg.image_root();
    (router, pool, root, dir)
}

/// A registered user (id 1, default ledger 1) plus their cookie client.
async fn user(router: &Router, pool: &SqlitePool) -> (i64, Client) {
    let mut c = Client::new();
    let id = common::auth::register_setup_user(&mut c, router, pool, "user").await;
    (id, c)
}

/// One stored image (id `image_id`) with the file on disk.
async fn seed_image(pool: &SqlitePool, root: &std::path::Path, image_id: i64) {
    let rel = format!("2026/10/img{image_id}.webp");
    let abs = root.join(&rel);
    tokio::fs::create_dir_all(abs.parent().unwrap())
        .await
        .unwrap();
    tokio::fs::write(&abs, WEBP).await.unwrap();
    sqlx::query(
        "INSERT INTO images (id, ledger_id, uploaded_by, file_key, storage_path, width, height,
             byte_size, sha256, created_at)
         VALUES (?, 1, 1, ?, ?, 10, 10, ?, x'00', ?)",
    )
    .bind(image_id)
    .bind(format!("key{image_id}"))
    .bind(&rel)
    .bind(WEBP.len() as i64)
    .bind(now_ms())
    .execute(pool)
    .await
    .unwrap();
}

/// A live receipt referencing the image (reference rule 3 of the recheck).
async fn insert_receipt(pool: &SqlitePool, image_id: i64) {
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, image_id, purchased_on,
             revision, created_at, updated_at)
         VALUES (1, 1, 1, 'image', ?, '2026-10-01', 1, 0, 0)",
    )
    .bind(image_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn token_for(pool: &SqlitePool, image_id: i64, user_id: i64) -> String {
    let url = issue_image_url(pool, "http://localhost", image_id, user_id, 900, now_ms())
        .await
        .expect("issue")
        .expect("image exists");
    url.url.rsplit('/').next().unwrap().to_string()
}

async fn body_bytes(resp: axum::http::Response<axum::body::Body>) -> Vec<u8> {
    resp.into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec()
}

// [covers:mcp-image.token-delivery-route]
#[tokio::test]
async fn serves_webp_with_headers_and_reuses_within_ttl() {
    let (router, pool, root, _dir) = setup().await;
    let (user_id, client) = user(&router, &pool).await;
    seed_image(&pool, &root, 1).await;
    insert_receipt(&pool, 1).await;
    let token = token_for(&pool, 1, user_id).await;

    for _ in 0..2 {
        // in-TTL reuse is allowed (spec 11-5)
        let resp = client.get(&router, &format!("/media/img/{token}")).await;
        assert_eq!(resp.status(), 200);
        let h = resp.headers();
        assert_eq!(h.get("content-type").unwrap(), "image/webp");
        let cc = h.get("cache-control").unwrap().to_str().unwrap();
        assert!(
            cc.starts_with("private, max-age=") && !cc.ends_with("max-age=0"),
            "cache-control: {cc}"
        );
        assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
        assert_eq!(h.get("referrer-policy").unwrap(), "no-referrer");
        assert_eq!(
            h.get("cross-origin-resource-policy").unwrap(),
            "cross-origin"
        );
        assert_eq!(body_bytes(resp).await, WEBP);
    }
}

// [covers:mcp-image.token-delivery-recheck]
#[tokio::test]
async fn recheck_failures_all_404() {
    let (router, pool, root, _dir) = setup().await;
    let (user_id, client) = user(&router, &pool).await;
    seed_image(&pool, &root, 1).await;
    insert_receipt(&pool, 1).await;
    let token = token_for(&pool, 1, user_id).await;

    // expired -> 404
    sqlx::query("UPDATE image_access_tokens SET expires_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);

    // re-issue for the remaining cases
    let token = token_for(&pool, 1, user_id).await;

    // unknown but well-formed token -> 404
    let other = b64url_encode(&[7u8; 32]);
    let resp = client.get(&router, &format!("/media/img/{other}")).await;
    assert_eq!(resp.status(), 404);

    // malformed token -> 404
    let resp = client.get(&router, "/media/img/not-a-token!!!").await;
    assert_eq!(resp.status(), 404);

    // user disabled -> 404
    sqlx::query("UPDATE users SET disabled_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);
    sqlx::query("UPDATE users SET disabled_at = NULL")
        .execute(&pool)
        .await
        .unwrap();

    // ledger membership lost -> 404
    sqlx::query("DELETE FROM ledger_members")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);
}

// [covers:mcp-image.token-delivery-recheck]
#[tokio::test]
async fn soft_deleted_receipt_and_closed_draft_stop_delivery() {
    let (router, pool, root, _dir) = setup().await;
    let (user_id, client) = user(&router, &pool).await;
    seed_image(&pool, &root, 1).await;
    insert_receipt(&pool, 1).await;
    let token = token_for(&pool, 1, user_id).await;

    // soft-deleted receipt -> 404
    sqlx::query("UPDATE receipts SET deleted_at = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);

    // a pending draft of the token user also keeps the image live
    // (the receipt above stays soft-deleted, so the draft is the only
    // remaining live reference)
    sqlx::query(
        "INSERT INTO drafts (id, ledger_id, user_id, status, payload_json, image_id,
             image_status, created_at, updated_at, expires_at)
         VALUES (1, 1, ?, 'pending', '{}', 1, 'attached', 0, 0, 99999999999999)",
    )
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 200, "pending draft reference");

    // closing the draft (image_id nulled by the CHECK rules) -> 404
    sqlx::query(
        "UPDATE drafts SET status = 'discarded', image_id = NULL, image_status = 'unavailable',
             image_unavailable_reason = 'other', closed_at = 1",
    )
    .execute(&pool)
    .await
    .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);
}

// [covers:mcp-image.token-delivery-recheck]
#[tokio::test]
async fn missing_file_is_404_not_500() {
    let (router, pool, root, _dir) = setup().await;
    let (user_id, client) = user(&router, &pool).await;
    seed_image(&pool, &root, 1).await;
    insert_receipt(&pool, 1).await;
    let token = token_for(&pool, 1, user_id).await;

    tokio::fs::remove_file(root.join("2026/10/img1.webp"))
        .await
        .unwrap();
    let resp = client.get(&router, &format!("/media/img/{token}")).await;
    assert_eq!(resp.status(), 404);
}

// [covers:mcp-image.token-delivery-rate-limit]
#[tokio::test]
async fn per_ip_rate_limit() {
    let (router, pool, _root, _dir) = setup().await;
    let cfg = common::repo_config();
    let n = cfg.auth.rate_limit.mcp_per_minute;
    let (_user_id, client) = user(&router, &pool).await;
    // unknown token: no DB rows needed, still counted by the IP limiter
    let unknown = b64url_encode(&[9u8; 32]);
    let mut got_429 = None;
    for i in 1..=(n as usize) + 1 {
        let resp = client.get(&router, &format!("/media/img/{unknown}")).await;
        if resp.status() == 429 {
            got_429 = Some((i, resp));
            break;
        }
        assert_eq!(resp.status(), 404);
    }
    let (at, resp) = got_429.expect("429 within burst+1");
    assert_eq!(at, (n as usize) + 1, "429 exactly after the burst");
    assert!(resp.headers().get("retry-after").is_some());
}
