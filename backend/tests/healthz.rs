mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use budget_book::app::{self, AppState, Health};
use budget_book::db;
use http_body_util::BodyExt;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

#[tokio::test]
async fn healthz_ok_with_router_oneshot() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    let router = app::router(
        &cfg,
        AppState::new(&cfg, pool).unwrap(),
        CancellationToken::new(),
    );
    let res = router
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let health: Health = serde_json::from_slice(&body).unwrap();
    assert_eq!(health.status, "ok");
    assert_eq!(health.db, "ok");
}

#[tokio::test]
async fn healthz_degraded_when_db_closed() {
    let cfg = common::repo_config();
    let pool = db::connect_memory().await.unwrap();
    pool.close().await;
    let router = app::router(
        &cfg,
        AppState::new(&cfg, pool).unwrap(),
        CancellationToken::new(),
    );
    let res = router
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn healthz_over_tcp() {
    let (addr, _cfg, ct) = common::spawn_app().await;
    let res = reqwest::get(format!("http://{addr}/healthz"))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let health: Health = res.json().await.unwrap();
    assert_eq!(health.status, "ok");
    ct.cancel();
}

#[tokio::test]
async fn file_db_is_created_and_migrated() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::repo_config();
    let path = dir.path().join("nested/test.sqlite");
    let pool = db::connect_file(&path, &cfg.app.database).await.unwrap();
    assert!(path.exists());
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(applied as usize, db::MIGRATOR.iter().count());
    pool.close().await;
}
