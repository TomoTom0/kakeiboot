//! Web data API (TASK-11 integration 6): the /api/ledgers/* REST adapter
//! over the shared domain layer — auth scoping, catalog / stores / receipts
//! CRUD incl. merge, revision conflicts, and the static SPA serving
//! (integration 7).

mod common;

use axum::Router;
use axum::body::Body;
use budget_book::app::{self, AppState};
use budget_book::db;
use common::auth::{Client, body_json};
use http_body_util::BodyExt;
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

async fn setup() -> (Router, SqlitePool) {
    setup_with_static(std::path::PathBuf::from("nonexistent-dist")).await
}

/// Router with the SPA static root pointed at `root`.
async fn setup_with_static(root: std::path::PathBuf) -> (Router, SqlitePool) {
    let mut cfg = common::repo_config();
    cfg.app.server.port = 0;
    cfg.app.frontend.static_dir = root;
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    (router, pool)
}

/// A registered, logged-in user; registration auto-creates their default
/// ledger (id 1 on the fresh in-memory DB) with `role` adjusted.
async fn user_with_ledger(router: &Router, pool: &SqlitePool, role: &str) -> Client {
    let mut c = Client::new();
    let user_id = common::auth::register_setup_user(&mut c, router, pool, "user").await;
    let ledger_id: i64 = sqlx::query_scalar("SELECT default_ledger_id FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(ledger_id, 1, "fresh DB: the default ledger is id 1");
    if role != "owner" {
        sqlx::query("UPDATE ledger_members SET role = ? WHERE ledger_id = ? AND user_id = ?")
            .bind(role)
            .bind(ledger_id)
            .bind(user_id)
            .execute(pool)
            .await
            .unwrap();
    }
    c
}

async fn insert_store(pool: &SqlitePool, id: i64, ledger_id: i64, name: &str, norm: &str) {
    sqlx::query(
        "INSERT INTO stores (id, ledger_id, name, name_norm, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(name)
    .bind(norm)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_receipt_full(
    pool: &SqlitePool,
    id: i64,
    ledger_id: i64,
    store_id: i64,
    on: &str,
    amount: i64,
) {
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, store_id, purchased_on,
             total_amount, tax_mode, revision, created_at, updated_at)
         VALUES (?, ?, 1, 'manual', ?, ?, ?, 'inclusive', 1, 0, 0)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(store_id)
    .bind(on)
    .bind(amount)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'item', 'item', ?, ?, 0, 0)",
    )
    .bind(id * 100)
    .bind(id)
    .bind(ledger_id)
    .bind(amount)
    .bind(amount)
    .execute(pool)
    .await
    .unwrap();
}

async fn status_text(resp: axum::http::Response<Body>) -> (axum::http::StatusCode, String) {
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

// ---------------------------------------------------------------------------
// scoping

#[tokio::test]
// [covers:web-data-api.session-ledger-scoping]
async fn web_data_scoping() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;

    // someone else's ledger (no login needed for that user)
    let other: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('other', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    common::insert_user(&pool, 9).await;
    common::insert_member(&pool, other, 9, "owner").await;

    // no session: 401
    let (router2, _) = setup().await;
    let anon = Client::new();
    let resp = anon.get(&router2, "/api/ledgers/1/catalog").await;
    assert_eq!(resp.status(), 401);

    // other user's ledger: 404 not_found (no existence leak)
    let resp = c
        .get(&router, &format!("/api/ledgers/{other}/catalog"))
        .await;
    assert_eq!(resp.status(), 404);
    assert_eq!(body_json(resp).await["error"], "not_found");

    // missing ledger: the same 404
    let resp = c.get(&router, "/api/ledgers/77/catalog").await;
    assert_eq!(resp.status(), 404);

    // own ledger: 200
    let resp = c.get(&router, "/api/ledgers/1/catalog").await;
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
// [covers:web-data-api.session-ledger-scoping]
async fn viewer_write_is_403() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;

    let resp = c
        .post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "create", "category": "食費" }),
        )
        .await;
    assert_eq!(resp.status(), 403);
    assert_eq!(body_json(resp).await["error"], "viewer_only");

    // reads are fine
    let resp = c.get(&router, "/api/ledgers/1/catalog").await;
    assert_eq!(resp.status(), 200);
}

// ---------------------------------------------------------------------------
// catalog

#[tokio::test]
// [covers:web-data-api.catalog-tree]
async fn catalog_tree_shapes() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "owner").await;
    // the registration seed already made 食費 with 4 subs; add an archived top
    let arch = common::insert_category(&pool, "item_categories", 1, None, "試験趣").await;
    sqlx::query("UPDATE item_categories SET archived_at = 1 WHERE id = ?")
        .bind(arch)
        .execute(&pool)
        .await
        .unwrap();

    let v = body_json(c.get(&router, "/api/ledgers/1/catalog").await).await;
    let items = v["item_categories"].as_array().unwrap();
    assert_eq!(items.len(), 10, "seeded tops, archived excluded: {v}");
    let food = items.iter().find(|n| n["name"] == "食費").unwrap();
    assert_eq!(food["archived"], false, "archived flag always present");
    assert_eq!(food["children"].as_array().unwrap().len(), 4);
    assert_eq!(food["children"][0]["children"].as_array().unwrap().len(), 0);
    assert!(!v["store_categories"].as_array().unwrap().is_empty());

    let v = body_json(
        c.get(&router, "/api/ledgers/1/catalog?include_archived=true")
            .await,
    )
    .await;
    let items = v["item_categories"].as_array().unwrap();
    assert_eq!(items.len(), 11);
    let hobby = items.iter().find(|n| n["name"] == "試験趣").unwrap();
    assert_eq!(hobby["archived"], true);
}

#[tokio::test]
// [covers:web-data-api.category-manage]
async fn category_manage_flow() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "owner").await;

    // create subcategory under a missing parent: 400
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "create", "category": "無い/子" }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(body_json(resp).await["error"], "invalid_request");

    // create (a name outside the registration seed)
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "create", "category": "試験分類" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["created"], true);
    assert_eq!(v["category"]["path"], "試験分類");
    let id = v["category"]["id"].as_i64().unwrap();

    // same path again: created false, same id
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "create", "category": "試験分類" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["created"], false);
    assert_eq!(v["category"]["id"].as_i64().unwrap(), id);

    // rename to a taken (seeded) name: 409 name_conflict
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "rename", "category": "試験分類",
                "new_name": "日用品" }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "name_conflict");

    // archive
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/categories",
            serde_json::json!({ "kind": "item", "action": "archive", "category": "試験分類" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["category"]["archived"], true);
}

// ---------------------------------------------------------------------------
// stores

#[tokio::test]
// [covers:web-data-api.store-update-merge]
async fn store_update_and_merge() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "owner").await;
    // seeded store category スーパー (store.rs seed); the id is looked up
    let cat: i64 = sqlx::query_scalar(
        "SELECT id FROM store_categories WHERE ledger_id = 1 AND name = 'スーパー'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "エーマート", "えーまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 2, "2026-10-08", 398).await;

    // list (empty query = all)
    let v = body_json(c.get(&router, "/api/ledgers/1/stores").await).await;
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 2);
    let a = arr.iter().find(|s| s["name"] == "Aマート").unwrap();
    assert_eq!(a["receipt_count"], 1);
    assert_eq!(a["last_purchased_on"], "2026-10-10");

    // unknown store: 404
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/stores/77",
            serde_json::json!({ "name": "X" }),
        )
        .await;
    assert_eq!(resp.status(), 404);

    // PATCH category to an unknown path: 400
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/stores/1",
            serde_json::json!({ "category": "無い" }),
        )
        .await;
    assert_eq!(resp.status(), 400);

    // PATCH name + category (null-able) with before echo
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/stores/1",
            serde_json::json!({ "name": "エーマート", "category": "スーパー" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["store"]["name"], "エーマート");
    assert_eq!(v["store"]["category"], "スーパー");
    assert_eq!(v["before"]["name"], "Aマート");
    assert_eq!(v["before"]["category"], serde_json::Value::Null);
    // category now resolves (store category row)
    let cid: i64 = sqlx::query_scalar("SELECT category_id FROM stores WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cid, cat);

    // rename onto the other store's name: 409 name_conflict
    // (store 1 now holds エーマート; renaming store 2 to it collides)
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/stores/2",
            serde_json::json!({ "name": "エーマート" }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "name_conflict");

    // merge store 1 (1 receipt) into store 2
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/stores/1/merge",
            serde_json::json!({ "into_store_id": 2 }),
        )
        .await,
    )
    .await;
    assert_eq!(v["moved_receipts"], 1);
    assert_eq!(
        v["merged_from"]["name"], "エーマート",
        "store 1 was renamed above"
    );
    assert_eq!(v["store"]["receipt_count"], 2);
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stores WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(gone, 0, "source store deleted");
    let alias: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM store_aliases WHERE ledger_id = 1 AND alias_norm = 'エーマート' AND store_id = 2",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(alias, 1, "old name registered as alias of the destination");

    // merge into itself: 400 same_store
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/stores/2/merge",
            serde_json::json!({ "into_store_id": 2 }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(body_json(resp).await["error"], "same_store");
}

// ---------------------------------------------------------------------------
// receipts

#[tokio::test]
// [covers:web-data-api.receipt-list]
async fn receipt_list_filters_and_deleted() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "Bコンビニ", "bこんびに").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-09-30", 180).await;
    insert_receipt_full(&pool, 103, 1, 2, "2026-10-05", 150).await;
    sqlx::query("UPDATE receipts SET deleted_at = 500, revision = 2 WHERE id = 102")
        .execute(&pool)
        .await
        .unwrap();

    // default: deleted hidden
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts").await).await;
    assert_eq!(v["total_count"], 2);
    assert_eq!(v["sum_amount"], 370);
    let rows = v["receipts"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["receipt_id"], 101, "date desc");
    assert_eq!(rows[0]["store_name"], "Aマート");
    assert!(rows[0]["deleted_at"].is_null());

    // include_deleted brings it back with deleted_at set
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?include_deleted=true")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 3);
    let del = v["receipts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["receipt_id"] == 102)
        .unwrap();
    assert!(del["deleted_at"].as_str().is_some(), "deleted_at filled");

    // from/to window + store filter
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/receipts?from=2026-10-01&to=2026-10-31&store=A",
        )
        .await,
    )
    .await;
    assert_eq!(v["total_count"], 1);
    assert_eq!(v["receipts"][0]["receipt_id"], 101);

    // category filter (analysis drill-down): items without a category
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?category=未分類")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 2);
    let resp = c
        .get(&router, "/api/ledgers/1/receipts?category=存在しない")
        .await;
    assert_eq!(resp.status(), 400);

    // item name filter (the fixture items are all named "item")
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?item_query=item")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 2);
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?item_query=nothing")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 0);

    // only one of from/to: 400
    let resp = c
        .get(&router, "/api/ledgers/1/receipts?from=2026-10-01")
        .await;
    assert_eq!(resp.status(), 400);

    // garbage cursor: 400
    let resp = c.get(&router, "/api/ledgers/1/receipts?cursor=zzzz").await;
    assert_eq!(resp.status(), 400);

    // keyset pagination
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts?limit=1").await).await;
    assert_eq!(v["receipts"].as_array().unwrap().len(), 1);
    let cur = v["next_cursor"].as_str().unwrap().to_string();
    let v = body_json(
        c.get(
            &router,
            &format!("/api/ledgers/1/receipts?limit=1&cursor={cur}"),
        )
        .await,
    )
    .await;
    assert_eq!(v["receipts"][0]["receipt_id"], 103);
    assert!(v["next_cursor"].is_null());
}

// ---------------------------------------------------------------------------
// TASK-41 /search: the receipts q / store_id cross-field filter and the
// item-level list endpoint behind /search (spec_mcp-tools.md §12).

/// A receipt without items (the fixture names the items explicitly).
async fn insert_receipt_bare(pool: &SqlitePool, id: i64, ledger_id: i64, store_id: i64, on: &str) {
    sqlx::query(
        "INSERT INTO receipts (id, ledger_id, created_by, source, store_id, purchased_on,
             tax_mode, revision, created_at, updated_at)
         VALUES (?, ?, 1, 'manual', ?, ?, 'inclusive', 1, 0, 0)",
    )
    .bind(id)
    .bind(ledger_id)
    .bind(store_id)
    .bind(on)
    .execute(pool)
    .await
    .unwrap();
}

/// A named item (the shared insert_receipt_full hardcodes the name "item").
#[allow(clippy::too_many_arguments)]
async fn insert_named_item(
    pool: &SqlitePool,
    id: i64,
    receipt_id: i64,
    ledger_id: i64,
    line_no: i64,
    name: &str,
    norm: &str,
    amount_incl: i64,
) {
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm,
             amount, amount_incl, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(line_no)
    .bind(name)
    .bind(norm)
    .bind(amount_incl)
    .bind(amount_incl)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
// [covers:web-data-api.receipt-list-text-query]
async fn receipt_list_text_query() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aマート").await;
    insert_store(&pool, 2, 1, "B店", "bてん").await;
    sqlx::query("INSERT INTO store_aliases (ledger_id, alias_norm, store_id, created_at) VALUES (1, 'エーマート', 1, 0)")
        .execute(&pool)
        .await
        .unwrap();
    // 201 (Aマート, 10-10): 牛乳 + 食パン / 202 (Aマート, 09-30): 紅茶
    // 203 (B店, 10-05): ギュウニュウ / 204 (B店, 10-12): 食パン / 205 (B店, 09-15): 牛乳
    insert_receipt_bare(&pool, 201, 1, 1, "2026-10-10").await;
    insert_named_item(&pool, 20101, 201, 1, 1, "牛乳", "牛乳", 250).await;
    insert_named_item(&pool, 20102, 201, 1, 2, "食パン", "食パン", 150).await;
    insert_receipt_bare(&pool, 202, 1, 1, "2026-09-30").await;
    insert_named_item(&pool, 20201, 202, 1, 1, "紅茶", "紅茶", 300).await;
    insert_receipt_bare(&pool, 203, 1, 2, "2026-10-05").await;
    insert_named_item(&pool, 20301, 203, 1, 1, "ギュウニュウ", "ギュウニュウ", 200).await;
    insert_receipt_bare(&pool, 204, 1, 2, "2026-10-12").await;
    insert_named_item(&pool, 20401, 204, 1, 1, "食パン", "食パン", 180).await;
    insert_receipt_bare(&pool, 205, 1, 2, "2026-09-15").await;
    insert_named_item(&pool, 20501, 205, 1, 1, "牛乳", "牛乳", 220).await;

    // q matches item names (LIKE path, <3 chars): 201 and 205 hold 牛乳
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts?q=牛乳").await).await;
    assert_eq!(v["total_count"], 2);
    assert_eq!(
        v["sum_amount"], 620,
        "full item sums of the hit receipts (250+150 + 220)"
    );
    let rows = v["receipts"].as_array().unwrap();
    assert_eq!(rows[0]["receipt_id"], 201, "date desc");
    assert_eq!(rows[0]["matched_items"][0]["name"], "牛乳");
    assert_eq!(rows[1]["receipt_id"], 205);
    assert_eq!(rows[1]["matched_items"].as_array().unwrap().len(), 1);

    // q matches store names AND aliases (OR with the item half); a
    // store-only hit carries matched_items = [] and its full item sums
    for q in ["Aマート", "エーマート", "えーまーと"] {
        let v = body_json(
            c.get(&router, &format!("/api/ledgers/1/receipts?q={q}"))
                .await,
        )
        .await;
        assert_eq!(v["total_count"], 2, "store/alias hit for {q}");
        assert_eq!(v["sum_amount"], 700, "all items of the store-hit receipts");
        for r in v["receipts"].as_array().unwrap() {
            assert_eq!(
                r["matched_items"],
                serde_json::json!([]),
                "store-only hit has no matched items"
            );
        }
    }

    // normalization + the FTS path (>=3 chars): ぎゅうにゅう -> ギュウニュウ
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?q=ぎゅうにゅう")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 1);
    assert_eq!(v["receipts"][0]["receipt_id"], 203);

    // q combines with the existing filters by AND: item_query (204 holds
    // 食パン but no 牛乳), the period window, the exact store_id
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?q=牛乳&item_query=食パン")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 1, "q and item_query combine with AND");
    assert_eq!(v["receipts"][0]["receipt_id"], 201);
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/receipts?q=牛乳&from=2026-10-01&to=2026-10-31",
        )
        .await,
    )
    .await;
    assert_eq!(v["total_count"], 1);
    assert_eq!(v["receipts"][0]["receipt_id"], 201);
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?q=牛乳&store_id=2")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 1);
    assert_eq!(v["receipts"][0]["receipt_id"], 205);

    // a whitespace-only q is no filter at all (the caller trims it away)
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts?q=+").await).await;
    assert_eq!(v["total_count"], 5);

    // a symbol-only q matches nothing but is not an error (it normalizes to
    // itself and rides the LIKE path)
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts?q=!!").await).await;
    assert_eq!(v["total_count"], 0);

    // another ledger's store_id is not an error: the ledger condition ANDs
    // the result down to empty
    let other: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('other', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    insert_store(&pool, 99, other, "他所の店", "たしょのみせ").await;
    let resp = c.get(&router, "/api/ledgers/1/receipts?store_id=99").await;
    assert_eq!(resp.status(), 200);
    let v = body_json(resp).await;
    assert_eq!(v["total_count"], 0);
}

#[tokio::test]
// [covers:web-data-api.items-search]
async fn items_search_endpoint() {
    let (router, pool) = setup().await;
    // any member may read (viewer included)
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aマート").await;
    insert_store(&pool, 2, 1, "B店", "bてん").await;
    insert_receipt_bare(&pool, 211, 1, 1, "2026-10-10").await;
    insert_named_item(&pool, 21101, 211, 1, 1, "牛乳", "牛乳", 250).await;
    insert_receipt_bare(&pool, 212, 1, 1, "2026-09-30").await;
    insert_named_item(&pool, 21201, 212, 1, 1, "紅茶", "紅茶", 300).await;
    insert_receipt_bare(&pool, 213, 1, 2, "2026-10-05").await;
    insert_named_item(&pool, 21301, 213, 1, 1, "牛乳", "牛乳", 220).await;
    // 214: 60 items (牛乳01..牛乳60) for the limit clamp and the cursor walk
    insert_receipt_bare(&pool, 214, 1, 2, "2026-10-12").await;
    for i in 0..60 {
        let name = format!("牛乳{:02}", i + 1);
        insert_named_item(&pool, 21400 + i + 1, 214, 1, i + 1, &name, &name, 10).await;
    }
    // 215: a katakana item for the FTS path (>=3 chars after normalizing)
    insert_receipt_bare(&pool, 215, 1, 1, "2026-10-11").await;
    insert_named_item(&pool, 21501, 215, 1, 1, "ギュウニュウ", "ギュウニュウ", 300).await;

    // q matches item names only: 牛乳 hits 211/213 plus the 60 牛乳NN rows
    let v = body_json(c.get(&router, "/api/ledgers/1/items?q=牛乳").await).await;
    assert_eq!(v["total_count"], 62);
    assert_eq!(v["sum_amount"], 1070);
    let rows = v["items"].as_array().unwrap();
    assert_eq!(rows.len(), 20, "the default limit");
    assert_eq!(rows[0]["receipt_id"], 214, "date desc");
    assert_eq!(rows[0]["name"], "牛乳60", "then item id desc");
    assert_eq!(rows[0]["store_id"], 2);
    assert_eq!(rows[0]["store_name"], "B店");
    for key in [
        "item_id",
        "receipt_id",
        "purchased_on",
        "store_id",
        "store_name",
        "name",
        "quantity",
        "unit",
        "unit_price",
        "amount_incl",
        "category",
    ] {
        assert!(rows[0].get(key).is_some(), "the row DTO carries {key}");
    }
    assert!(v["next_cursor"].is_string());

    // the store-name query brings no rows on the item endpoint
    let v = body_json(c.get(&router, "/api/ledgers/1/items?q=Aマート").await).await;
    assert_eq!(v["total_count"], 0, "q matches item names only");

    // the FTS path (>=3 chars) with the hiragana -> katakana normalization
    let v = body_json(c.get(&router, "/api/ledgers/1/items?q=ぎゅうにゅう").await).await;
    assert_eq!(v["total_count"], 1);
    assert_eq!(v["items"][0]["receipt_id"], 215);
    assert_eq!(v["items"][0]["name"], "ギュウニュウ");

    // the category filter resolves (未分類 = items without a category: all 64)
    let v = body_json(
        c.get(&router, "/api/ledgers/1/items?category=未分類&limit=50")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 64);

    // limit clamps at the max (50) and the cursor walks the remaining 12
    let v = body_json(
        c.get(&router, "/api/ledgers/1/items?q=牛乳&limit=999")
            .await,
    )
    .await;
    assert_eq!(v["items"].as_array().unwrap().len(), 50, "clamped to 50");
    assert_eq!(v["total_count"], 62);
    let cur = v["next_cursor"].as_str().unwrap().to_string();
    let v = body_json(
        c.get(
            &router,
            &format!("/api/ledgers/1/items?q=牛乳&limit=999&cursor={cur}"),
        )
        .await,
    )
    .await;
    assert_eq!(v["items"].as_array().unwrap().len(), 12);
    assert!(v["next_cursor"].is_null());

    // deleted receipts stay out unless asked for
    sqlx::query("UPDATE receipts SET deleted_at = 500, revision = 2 WHERE id = 213")
        .execute(&pool)
        .await
        .unwrap();
    let v = body_json(c.get(&router, "/api/ledgers/1/items?q=牛乳&limit=50").await).await;
    assert_eq!(v["total_count"], 61);
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/items?q=牛乳&include_deleted=true&limit=50",
        )
        .await,
    )
    .await;
    assert_eq!(v["total_count"], 62);

    // the 400 paths are the receipts endpoint's
    for path in [
        "/api/ledgers/1/items?category=存在しない",
        "/api/ledgers/1/items?from=2026-10-01",
        "/api/ledgers/1/items?from=2026-13-99&to=2026-12-31",
        "/api/ledgers/1/items?cursor=zzzz",
    ] {
        let resp = c.get(&router, path).await;
        assert_eq!(resp.status(), 400, "{path}");
    }

    // another ledger's store_id: empty, not an error
    let other: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('other2', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    insert_store(&pool, 98, other, "他所の店", "たしょのみせ").await;
    let resp = c.get(&router, "/api/ledgers/1/items?store_id=98").await;
    assert_eq!(resp.status(), 200);
    let v = body_json(resp).await;
    assert_eq!(v["total_count"], 0);

    // access follows list_receipts: no session 401, another user's ledger 404
    let (router2, _) = setup().await;
    let anon = Client::new();
    let resp = anon.get(&router2, "/api/ledgers/1/items").await;
    assert_eq!(resp.status(), 401);
    let resp = c.get(&router, &format!("/api/ledgers/{other}/items")).await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
// [covers:web-data-api.stats]
async fn stats_reports_and_periods() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-12", 80).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-09-30", 180).await;

    // viewer can read; totals + compare with the previous month
    let resp = c.get(&router, "/api/ledgers/1/stats?month=2026-10").await;
    assert_eq!(resp.status(), 200);
    let v = body_json(resp).await;
    assert_eq!(v["period_resolved"]["from"], "2026-10-01");
    assert_eq!(v["totals"]["value"], 300);
    assert_eq!(v["totals"]["receipts"], 2);
    assert_eq!(v["totals"]["compare_value"], 180);
    let ids: Vec<&str> = v["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["categories", "stores", "trend"]);
    assert_eq!(v["sections"][1]["rows"][0]["labels"][0], "Aマート");
    assert_eq!(v["sections"][2]["rows"].as_array().unwrap().len(), 6);
    let days = v["daily_cumulative"].as_array().unwrap();
    assert_eq!(days.last().unwrap()["value"], 300);

    // other reports / periods share summarize_spending
    let v = body_json(
        c.get(&router, "/api/ledgers/1/stats?report=by_store&year=2026")
            .await,
    )
    .await;
    assert_eq!(v["report"], "by_store");
    assert_eq!(v["period_resolved"]["from"], "2026-01-01");
    assert_eq!(v["sections"][0]["rows"][0]["value"], 480);
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?report=monthly_trend&from=2026-09-01&to=2026-10-31",
        )
        .await,
    )
    .await;
    let trend: Vec<i64> = v["sections"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["value"].as_i64().unwrap())
        .collect();
    assert_eq!(trend, [180, 300]);
    assert!(v["daily_cumulative"].is_null(), "overview only");
    // store filter narrows the totals
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?report=by_category&month=2026-10&store=A",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 300);

    // bad month / mixed period / unknown report / other ledger
    for q in [
        "month=2026-1",
        "month=2026-10&year=2026",
        "from=2026-10-01",
        "report=nope",
    ] {
        let resp = c.get(&router, &format!("/api/ledgers/1/stats?{q}")).await;
        assert_eq!(resp.status(), 400, "{q}");
    }
    let resp = c.get(&router, "/api/ledgers/9/stats").await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
// [covers:web-data-api.stats-store-id]
async fn stats_store_id_exact_match() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B薬局", "bやっきょく").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 2, "2026-10-12", 80).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-09-30", 180).await;

    // web-only exact store match narrows the totals, the compare period and
    // every section row (the same filter_sql the reports share)
    let v = body_json(
        c.get(&router, "/api/ledgers/1/stats?month=2026-10&store_id=1")
            .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 220);
    assert_eq!(v["totals"]["receipts"], 1);
    assert_eq!(v["totals"]["compare_value"], 180, "prev month store 1 only");
    let store_total: i64 = v["sections"][1]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["value"].as_i64().unwrap_or(0))
        .sum();
    assert_eq!(store_total, 220, "section rows share the filter");
    // the echo is emitted (is_empty counts store_id) but never carries the
    // web-only key (serde(skip) keeps it out of the serialization)
    assert!(v["filters"].is_object(), "store_id-only still echoes");
    assert!(v["filters"].get("store_id").is_none(), "no store_id key");

    // no existence check: another ledger's store id is an empty result
    let other: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('other3', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    insert_store(&pool, 98, other, "他所の店", "たしょのみせ").await;
    let v = body_json(
        c.get(&router, "/api/ledgers/1/stats?month=2026-10&store_id=98")
            .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 0);

    // without the filter everything is aggregated
    let v = body_json(c.get(&router, "/api/ledgers/1/stats?month=2026-10").await).await;
    assert_eq!(v["totals"]["value"], 300);
}

#[tokio::test]
// [covers:web-data-api.stats-store-category]
async fn stats_store_category_path_filter() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    // the default ledger is seeded with the top-level store categories; use
    // the seeded スーパー and only add the child (no sub categories seeded)
    let top: i64 = sqlx::query_scalar(
        "SELECT id FROM store_categories WHERE ledger_id = 1 AND parent_id IS NULL AND name = 'スーパー'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let sub =
        common::insert_category(&pool, "store_categories", 1, Some(top), "業務スーパー").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B業務", "bぎょうむ").await;
    for (store, cat) in [(1i64, top), (2, sub)] {
        sqlx::query("UPDATE stores SET category_id = ? WHERE id = ?")
            .bind(cat)
            .bind(store)
            .execute(&pool)
            .await
            .unwrap();
    }
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 2, "2026-10-12", 80).await;

    // a top path includes the stores under the child category
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&store_category=スーパー",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 300, "top includes the child");
    assert_eq!(v["filters"]["store_category"], "スーパー");

    // "Top/Sub" narrows to the child; both share resolve_path validation
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&store_category=スーパー/業務スーパー",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 80);
    assert_eq!(v["filters"]["store_category"], "スーパー/業務スーパー");

    // an unknown path is the same 400 as the MCP filters.store_category
    let resp = c
        .get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&store_category=無い",
        )
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
// [covers:web-data-api.receipt-update-conflicts]
async fn receipt_get_update_conflicts() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;

    // other ledger's receipt must 404 for this user
    common::insert_ledger(&pool, 9).await;
    insert_store(&pool, 91, 9, "X店", "xみせ").await;
    insert_receipt_full(&pool, 901, 9, 91, "2026-10-10", 99).await;

    let resp = c.get(&router, "/api/ledgers/1/receipts/901").await;
    assert_eq!(resp.status(), 404);

    let v = body_json(c.get(&router, "/api/ledgers/1/receipts/101").await).await;
    assert_eq!(v["receipt_id"], 101);
    assert_eq!(v["revision"], 1);
    assert_eq!(v["items_total"], 220);
    assert_eq!(v["store"]["name"], "Aマート");

    // stale revision: 409 stale_revision
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/receipts/101",
            serde_json::json!({ "revision": 9, "set": { "note": "n" } }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "stale_revision");

    // correct revision: apply + changed
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/receipts/101",
            serde_json::json!({ "revision": 1, "set": { "note": "メモ" } }),
        )
        .await,
    )
    .await;
    assert_eq!(v["receipt"]["revision"], 2);
    assert_eq!(v["receipt"]["note"], "メモ");
    assert_eq!(v["changed"], serde_json::json!(["note"]));

    // deleted receipt: 409 deleted
    sqlx::query("UPDATE receipts SET deleted_at = 500 WHERE id = 101")
        .execute(&pool)
        .await
        .unwrap();
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/receipts/101",
            serde_json::json!({ "revision": 2, "set": { "note": "x" } }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "deleted");
}

#[tokio::test]
// [covers:web-data-api.receipt-detail-image-url]
async fn receipt_detail_image_url() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-11", 120).await;
    sqlx::query(
        "INSERT INTO images (id, ledger_id, uploaded_by, file_key, storage_path, width, height,
             byte_size, sha256, created_at)
         VALUES (1, 1, 1, '01IMG', 'images/1.webp', 1024, 2048, 999, X'00', 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE receipts SET image_id = 1 WHERE id IN (101, 102)")
        .execute(&pool)
        .await
        .unwrap();

    // with an image: a fresh /media/img/<token> URL (spec 11-5)
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts/101").await).await;
    let url = v["image_url"]["url"].as_str().expect("image_url.url");
    assert!(
        url.starts_with("http://localhost:40281/media/img/"),
        "{url}"
    );
    assert!(v["image_url"]["expires_at"].is_string());
    assert_eq!(v["image_url"]["width"], 1024);
    assert_eq!(
        v["image"],
        serde_json::json!({
            "width": 1024, "height": 2048,
            "original_filename": null, "taken_at": null, "taken_at_source": null
        })
    );
    // the token row is stored hashed, reusable within the TTL
    let tokens: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM image_access_tokens WHERE image_id = 1 AND ledger_id = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tokens, 1);

    // logically deleted receipt: meta stays but no URL is issued
    sqlx::query("UPDATE receipts SET deleted_at = 500 WHERE id = 102")
        .execute(&pool)
        .await
        .unwrap();
    let v = body_json(c.get(&router, "/api/ledgers/1/receipts/102").await).await;
    assert!(v["deleted_at"].is_string(), "meta still shows deleted_at");
    assert!(v["image_url"].is_null());
}

#[tokio::test]
// [covers:web-data-api.receipt-delete-flow]
async fn receipt_delete_flow() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "owner").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;

    // preview (no confirm): nothing changes, preview attached
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(v["revision"], 1);
    assert!(v["deleted_at"].is_null());
    assert_eq!(v["preview"]["amount"], 220);
    let del: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM receipts WHERE id = 101")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(del.is_none());

    // confirm without revision: 400 revision_required
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "confirm": true }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(body_json(resp).await["error"], "revision_required");

    // confirm with a stale revision: 409 stale_revision
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "confirm": true, "revision": 9 }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "stale_revision");

    // confirm ok: deleted_at + purge_after
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "confirm": true, "revision": 1 }),
        )
        .await,
    )
    .await;
    assert!(v["deleted_at"].as_str().is_some());
    assert!(v["purge_after"].as_str().is_some());

    // restore
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "restore": true }),
        )
        .await,
    )
    .await;
    assert!(v["deleted_at"].is_null());
}

// ---------------------------------------------------------------------------
// static SPA serving (integration 7)

#[tokio::test]
// [covers:web-frame.static-spa-serving]
async fn static_spa_and_headers() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("web.html"),
        "<!doctype html><title>web</title>",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("assets")).unwrap();
    std::fs::write(dir.path().join("assets/app-abc123.js"), "console.log(1)").unwrap();
    let favicon = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>"#;
    std::fs::write(dir.path().join("favicon.svg"), favicon).unwrap();
    let (router, pool) = setup_with_static(dir.path().to_path_buf()).await;
    common::insert_user(&pool, 1).await;

    let c = Client::new();

    // index: CSP + X-Frame-Options (spec_auth.md 4-6)
    let resp = c.get(&router, "/").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("content-security-policy").unwrap(),
        "frame-ancestors 'none'"
    );
    assert_eq!(resp.headers().get("x-frame-options").unwrap(), "DENY");
    assert!(
        resp.headers()
            .get("cache-control")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("no-cache")
    );
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 200);
    assert!(body.contains("title"));

    // hashed asset: long cache + content type
    let resp = c.get(&router, "/assets/app-abc123.js").await;
    assert_eq!(resp.status(), 200);
    assert_eq!(
        resp.headers().get("cache-control").unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert!(
        resp.headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/javascript")
    );

    // TASK-16: the root favicon.svg is served as SVG (not the SPA shell),
    // without immutable caching (its name has no content hash)
    let resp = c.get(&router, "/favicon.svg").await;
    assert_eq!(resp.status(), 200);
    assert!(
        resp.headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("image/svg+xml")
    );
    let cache = resp
        .headers()
        .get("cache-control")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();
    assert!(
        !cache.contains("immutable"),
        "favicon cache-control: {cache}"
    );
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 200);
    assert_eq!(body, favicon);

    // SPA fallback for a client-side route serves the shell
    let resp = c.get(&router, "/receipts/101").await;
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 200);
    assert!(body.contains("title"));
    assert_eq!(c.get(&router, "/assets/missing.js").await.status(), 404);

    // the consent screen is a SPA route under the reserved /oauth prefix
    // (spec_auth.md 4-2: /oauth/authorize redirects to /oauth/consent?req=R)
    let resp = c.get(&router, "/oauth/consent?req=abc").await;
    assert_eq!(
        resp.headers().get("content-security-policy").unwrap(),
        "frame-ancestors 'none'"
    );
    assert_eq!(resp.headers().get("x-frame-options").unwrap(), "DENY");
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 200);
    assert!(body.contains("title"));
    // other /oauth paths stay JSON 404
    let resp = c.get(&router, "/oauth/unknown").await;
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 404);
    assert!(body.contains("not_found"), "plain JSON 404: {body}");

    // API paths never fall back to HTML
    let resp = c.get(&router, "/api/ledgers/1/catalog").await;
    assert_eq!(resp.status(), 401, "guards run before routing");
    let resp = c.get(&router, "/api/unknown-path").await;
    let (status, body) = status_text(resp).await;
    assert_eq!(status, 404);
    assert!(body.contains("not_found"), "plain JSON 404: {body}");
}

#[tokio::test]
// [covers:web-frame.static-spa-serving]
async fn static_missing_dist_is_404() {
    let (router, pool) = setup().await;
    common::insert_user(&pool, 1).await;
    let c = Client::new();
    assert_eq!(c.get(&router, "/").await.status(), 404);
    // the API still works without a built frontend
    assert_eq!(c.get(&router, "/healthz").await.status(), 200);
}

// ---------------------------------------------------------------------------
// labels (TASK-17): GET /labels, PATCH /labels/{color},
// POST /receipts/{r}/labels, label_colors filters on list / view / stats.

async fn insert_receipt_label(pool: &SqlitePool, receipt_id: i64, color: &str) {
    sqlx::query(
        "INSERT INTO receipt_labels (receipt_id, ledger_id, color, created_by, created_at)
         VALUES (?, 1, ?, 1, 0)",
    )
    .bind(receipt_id)
    .bind(color)
    .execute(pool)
    .await
    .unwrap();
}

async fn audit_count(pool: &SqlitePool, entity_type: &str, action: &str) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE entity_type = ? AND action = ?")
        .bind(entity_type)
        .bind(action)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn receipt_revision_row(pool: &SqlitePool, id: i64) -> (i64, i64) {
    sqlx::query_as("SELECT revision, updated_at FROM receipts WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
// [covers:web-data-api.labels-list]
async fn labels_list_five_in_definition_order() {
    let (router, pool) = setup().await;
    // viewers are members and can read the definitions
    let c = user_with_ledger(&router, &pool, "viewer").await;
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = 1 AND color = 'red'")
        .execute(&pool)
        .await
        .unwrap();

    let v = body_json(c.get(&router, "/api/ledgers/1/labels").await).await;
    let labels = v["labels"].as_array().expect("labels array");
    let colors: Vec<&str> = labels
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["red", "yellow", "green", "blue", "purple"]);
    assert_eq!(labels[0]["title"], "旅行");
    assert!(labels[1]["title"].is_null(), "unset titles are null");

    // a ledger the user is not a member of: the same 404 as the other
    // member-scoped endpoints
    let resp = c.get(&router, "/api/ledgers/99/labels").await;
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
// [covers:web-data-api.label-title-update]
async fn label_title_update_rules() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;

    // trim + changed, one ledger_label/update audit row
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/labels/red",
            serde_json::json!({ "title": " 旅行 " }),
        )
        .await,
    )
    .await;
    assert_eq!(v["label"]["color"], "red");
    assert_eq!(v["label"]["title"], "旅行");
    assert_eq!(v["changed"], true);
    assert_eq!(audit_count(&pool, "ledger_label", "update").await, 1);

    // empty string normalizes to NULL
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/labels/red",
            serde_json::json!({ "title": "" }),
        )
        .await,
    )
    .await;
    assert!(v["label"]["title"].is_null());
    assert_eq!(v["changed"], true);

    // same value again: changed = false and no extra audit row
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/labels/red",
            serde_json::json!({ "title": "" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["changed"], false);
    assert_eq!(audit_count(&pool, "ledger_label", "update").await, 2);

    // over the trim-length limit (21 chars): 400
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/labels/red",
            serde_json::json!({ "title": "あ".repeat(21) }),
        )
        .await;
    assert_eq!(resp.status(), 400);

    // unknown color: 400
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/labels/orange",
            serde_json::json!({ "title": "x" }),
        )
        .await;
    assert_eq!(resp.status(), 400);

    // viewer: 403 (same user demoted on the same ledger)
    sqlx::query("UPDATE ledger_members SET role = 'viewer' WHERE ledger_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1/labels/red",
            serde_json::json!({ "title": "x" }),
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
// [covers:web-data-api.receipt-labels-apply]
async fn receipt_labels_apply_diff_and_errors() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    // another ledger's receipt (the user is not a member of ledger 9)
    common::insert_ledger(&pool, 9).await;
    insert_store(&pool, 91, 9, "X店", "xみせ").await;
    insert_receipt_full(&pool, 901, 9, 91, "2026-10-10", 99).await;
    // a soft-deleted receipt on ledger 1
    insert_receipt_full(&pool, 103, 1, 1, "2026-10-11", 120).await;
    sqlx::query("UPDATE receipts SET deleted_at = 500 WHERE id = 103")
        .execute(&pool)
        .await
        .unwrap();

    let before = receipt_revision_row(&pool, 101).await;
    // add red: 200, labels echoed, revision / updated_at untouched
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/labels",
            serde_json::json!({ "add": ["red"] }),
        )
        .await,
    )
    .await;
    assert_eq!(v["receipt_id"], 101);
    assert_eq!(v["labels"][0]["color"], "red");
    assert_eq!(receipt_revision_row(&pool, 101).await, before);
    assert_eq!(audit_count(&pool, "receipt", "label").await, 1);

    // resending the same request: identical response, no extra audit
    let v2 = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/labels",
            serde_json::json!({ "add": ["red"] }),
        )
        .await,
    )
    .await;
    assert_eq!(v2, v);
    assert_eq!(audit_count(&pool, "receipt", "label").await, 1);

    // changing request: one audit row with before / after color arrays
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/labels",
            serde_json::json!({ "add": ["blue"], "remove": ["red"] }),
        )
        .await,
    )
    .await;
    let colors: Vec<&str> = v["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["color"].as_str().unwrap())
        .collect();
    assert_eq!(colors, ["blue"]);
    assert_eq!(audit_count(&pool, "receipt", "label").await, 2);
    let (b, a): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT before_json, after_json FROM audit_events
         WHERE entity_type = 'receipt' AND action = 'label' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(b.as_deref().unwrap()).unwrap(),
        serde_json::json!(["red"])
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(a.as_deref().unwrap()).unwrap(),
        serde_json::json!(["blue"])
    );

    // validation and permission errors
    let bad = [
        serde_json::json!({ "add": ["red"], "remove": ["red"] }), // crossing
        serde_json::json!({ "add": [], "remove": [] }),           // both empty
        serde_json::json!({ "add": ["orange"] }),                 // unknown color
    ];
    for body in &bad {
        let resp = c
            .post(&router, "/api/ledgers/1/receipts/101/labels", body.clone())
            .await;
        assert_eq!(resp.status(), 400, "{body}");
    }
    // another ledger's receipt: the same 404 as the rest of the API
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/receipts/901/labels",
            serde_json::json!({ "add": ["red"] }),
        )
        .await;
    assert_eq!(resp.status(), 404);
    // soft-deleted: 409 deleted
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/receipts/103/labels",
            serde_json::json!({ "add": ["red"] }),
        )
        .await;
    assert_eq!(resp.status(), 409);
    assert_eq!(body_json(resp).await["error"], "deleted");
    // viewer: 403
    sqlx::query("UPDATE ledger_members SET role = 'viewer' WHERE ledger_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = c
        .post(
            &router,
            "/api/ledgers/1/receipts/101/labels",
            serde_json::json!({ "add": ["red"] }),
        )
        .await;
    assert_eq!(resp.status(), 403);
}

#[tokio::test]
// [covers:web-data-api.receipt-list-label-filter]
async fn receipt_list_label_filter() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    for id in [101i64, 102, 103, 104] {
        insert_receipt_full(&pool, id, 1, 1, "2026-10-10", 100).await;
    }
    insert_receipt_label(&pool, 101, "red").await;
    insert_receipt_label(&pool, 102, "red").await;
    insert_receipt_label(&pool, 103, "blue").await;
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = 1 AND color = 'red'")
        .execute(&pool)
        .await
        .unwrap();

    // single color: only the red receipts, each row carries its labels
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?label_colors=red")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 2);
    let rows = v["receipts"].as_array().unwrap();
    let ids: Vec<i64> = rows
        .iter()
        .map(|r| r["receipt_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [102, 101], "date desc");
    assert_eq!(rows[0]["labels"][0]["color"], "red");
    assert_eq!(rows[0]["labels"][0]["title"], "旅行");

    // OR over two colors
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?label_colors=red,blue")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 3);

    // unknown color: 400
    let resp = c
        .get(&router, "/api/ledgers/1/receipts?label_colors=orange")
        .await;
    assert_eq!(resp.status(), 400);

    // composes with cursor pagination
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?label_colors=red&limit=1")
            .await,
    )
    .await;
    assert_eq!(v["receipts"].as_array().unwrap().len(), 1);
    let cur = v["next_cursor"].as_str().unwrap().to_string();
    let v = body_json(
        c.get(
            &router,
            &format!("/api/ledgers/1/receipts?label_colors=red&limit=1&cursor={cur}"),
        )
        .await,
    )
    .await;
    assert_eq!(v["receipts"][0]["receipt_id"], 101);
    assert!(v["next_cursor"].is_null());
}

#[tokio::test]
// [covers:web-data-api.receipt-view-labels]
async fn receipt_view_carries_labels() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_label(&pool, 101, "red").await;
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = 1 AND color = 'red'")
        .execute(&pool)
        .await
        .unwrap();

    let v = body_json(c.get(&router, "/api/ledgers/1/receipts/101").await).await;
    assert_eq!(v["labels"][0]["color"], "red");
    assert_eq!(v["labels"][0]["title"], "旅行");

    // content edit: revision +1 as usual, labels carried over
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1/receipts/101",
            serde_json::json!({ "revision": 1, "set": { "note": "メモ" } }),
        )
        .await,
    )
    .await;
    assert_eq!(v["receipt"]["revision"], 2);
    assert_eq!(v["receipt"]["labels"][0]["color"], "red");

    // soft delete and restore keep the labels
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "confirm": true, "revision": 2 }),
        )
        .await,
    )
    .await;
    assert!(v["deleted_at"].as_str().is_some());
    assert_eq!(v["labels"][0]["color"], "red");
    let v = body_json(
        c.post(
            &router,
            "/api/ledgers/1/receipts/101/delete",
            serde_json::json!({ "restore": true }),
        )
        .await,
    )
    .await;
    assert!(v["deleted_at"].is_null());
    assert_eq!(v["labels"][0]["color"], "red");
}

#[tokio::test]
// [covers:web-data-api.stats-label-filter]
async fn stats_label_filter_and_echo() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 300).await; // red
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-12", 80).await; // unlabeled
    insert_receipt_full(&pool, 103, 1, 1, "2026-09-30", 180).await; // red (prev month)
    insert_receipt_full(&pool, 104, 1, 1, "2026-09-20", 50).await; // unlabeled (prev)
    insert_receipt_label(&pool, 101, "red").await;
    insert_receipt_label(&pool, 103, "red").await;

    // the shared filter_sql applies to every report and the comparison
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&label_colors=red",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 300, "only the red receipt");
    assert_eq!(v["totals"]["receipts"], 1);
    assert_eq!(v["totals"]["compare_value"], 180, "previous month red only");
    let cat_total: i64 = v["sections"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["value"].as_i64().unwrap_or(0))
        .sum();
    assert_eq!(cat_total, 300, "by_category rows also filtered");
    // the applied filters are echoed back
    assert_eq!(v["filters"]["label_colors"], serde_json::json!(["red"]));

    // OR across colors
    insert_receipt_label(&pool, 102, "blue").await;
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&label_colors=red,blue",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["value"], 380);

    // unlabeled query: no filter at all (no filters echo)
    let v = body_json(c.get(&router, "/api/ledgers/1/stats?month=2026-10").await).await;
    assert_eq!(v["totals"]["value"], 380);
    assert!(v["filters"].is_null());

    // unknown color: 400
    let resp = c
        .get(
            &router,
            "/api/ledgers/1/stats?month=2026-10&label_colors=orange",
        )
        .await;
    assert_eq!(resp.status(), 400);
}
