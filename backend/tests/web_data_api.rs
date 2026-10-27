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

// ---------------------------------------------------------------------------
// TASK-73: search query length cap (mcp.toml [limits] max_query_chars = 200,
// chars at the input). Every free-text search param on the 4 endpoints.

#[tokio::test]
// [covers:web-data-api.query-length]
async fn search_query_length_cap() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;

    // 201 chars: every search-ish param on every endpoint answers with the
    // existing invalid-input shape (the garbage cursor style) — never a
    // silent truncation or an ignored param
    let over = "a".repeat(201);
    for path in [
        format!("/api/ledgers/1/stores?query={over}"),
        format!("/api/ledgers/1/receipts?store={over}"),
        format!("/api/ledgers/1/receipts?q={over}"),
        format!("/api/ledgers/1/receipts?item_query={over}"),
        format!("/api/ledgers/1/items?q={over}"),
        format!("/api/ledgers/1/analysis?month=2026-10&store={over}"),
        format!("/api/ledgers/1/analysis?month=2026-10&item_query={over}"),
    ] {
        let resp = c.get(&router, &path).await;
        assert_eq!(resp.status(), 400, "{path}");
        assert_eq!(body_json(resp).await["error"], "invalid_request", "{path}");
    }

    // exactly 200 chars: the boundary passes and searches as before
    // (0 hits is fine)
    let at = "a".repeat(200);
    for path in [
        format!("/api/ledgers/1/stores?query={at}"),
        format!("/api/ledgers/1/receipts?store={at}"),
        format!("/api/ledgers/1/receipts?q={at}"),
        format!("/api/ledgers/1/receipts?item_query={at}"),
        format!("/api/ledgers/1/items?q={at}"),
        format!("/api/ledgers/1/analysis?month=2026-10&store={at}"),
        format!("/api/ledgers/1/analysis?month=2026-10&item_query={at}"),
    ] {
        let resp = c.get(&router, &path).await;
        assert_eq!(resp.status(), 200, "{path}");
    }

    // whitespace-only 201 chars: the trim-empty check wins over the length
    // check (q=+ is one space in form encoding), keeping the existing
    // no-filter behavior — the one receipt is still returned
    for path in [
        format!("/api/ledgers/1/receipts?q={}", "+".repeat(201)),
        format!("/api/ledgers/1/receipts?store={}", "+".repeat(201)),
    ] {
        let resp = c.get(&router, &path).await;
        assert_eq!(resp.status(), 200, "{path}");
        assert_eq!(body_json(resp).await["total_count"], 1, "{path}");
    }
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
// [covers:web-data-api.ledger-rename]
async fn ledger_rename_rules() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    let user: i64 = sqlx::query_scalar("SELECT id FROM users WHERE display_name = 'user'")
        .fetch_one(&pool)
        .await
        .unwrap();
    // a second membership of the same user (the within-user rename conflict)
    // and another user's ledger already holding the target name (a foreign
    // same name must NOT block the rename)
    let mine2: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('共有中', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, ?, 'viewer', 0)",
    )
    .bind(mine2)
    .bind(user)
    .execute(&pool)
    .await
    .unwrap();
    common::insert_user(&pool, 77).await;
    let theirs: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('書き換え後', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO ledger_members (ledger_id, user_id, role, created_at) VALUES (?, 77, 'owner', 0)",
    )
    .bind(theirs)
    .execute(&pool)
    .await
    .unwrap();

    // success: the flat {id, name} with the trimmed name
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "  本家 " }),
        )
        .await,
    )
    .await;
    assert_eq!(v["id"], 1);
    assert_eq!(v["name"], "本家");
    assert_eq!(
        v.as_object().unwrap().len(),
        2,
        "the response is the flat {{id, name}}"
    );

    // [covers:auth-ledger.rename-ledger] exactly one web-actor audit row with
    // the before/after names (entity_type = ledger / action = rename_ledger)
    assert_eq!(audit_count(&pool, "ledger", "rename_ledger").await, 1);
    let audit: (String, Option<String>, String, String) = sqlx::query_as(
        "SELECT actor_kind, client_id, before_json, after_json FROM audit_events
         WHERE entity_type = 'ledger' AND action = 'rename_ledger'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audit.0, "web");
    assert!(audit.1.is_none(), "web actors carry no client_id");
    assert_eq!(audit.2, r#"{"name":"userの家計簿"}"#);
    assert_eq!(audit.3, r#"{"name":"本家"}"#);

    // [covers:auth-ledger.rename-ledger] the same name again: 200 no-op, no
    // extra audit row, updated_at untouched
    let at1: i64 = sqlx::query_scalar("SELECT updated_at FROM ledgers WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "本家" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["name"], "本家");
    let at2: i64 = sqlx::query_scalar("SELECT updated_at FROM ledgers WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(at2, at1, "no-op rename does not touch updated_at");
    assert_eq!(
        audit_count(&pool, "ledger", "rename_ledger").await,
        1,
        "no-op rename writes no audit row"
    );

    // missing / null / non-string name: the one invalid_request shape
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "name": null }),
        serde_json::json!({ "name": 3 }),
    ] {
        let resp = c.patch(&router, "/api/ledgers/1", body.clone()).await;
        assert_eq!(resp.status(), 400, "{body}");
        assert_eq!(body_json(resp).await["error"], "invalid_request", "{body}");
    }

    // trim-empty and over the cap (max_ledger_name_chars = 100): 400
    for name in ["   ".to_string(), "あ".repeat(101)] {
        let resp = c
            .patch(
                &router,
                "/api/ledgers/1",
                serde_json::json!({ "name": name }),
            )
            .await;
        assert_eq!(resp.status(), 400, "{name}");
        assert_eq!(body_json(resp).await["error"], "invalid_request");
    }
    // exactly 100 chars succeeds
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "あ".repeat(100) }),
        )
        .await,
    )
    .await;
    assert_eq!(v["name"].as_str().unwrap().chars().count(), 100);

    // a foreign user's ledger with the same name does not block the rename
    let v = body_json(
        c.patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "書き換え後" }),
        )
        .await,
    )
    .await;
    assert_eq!(v["name"], "書き換え後");

    // [covers:auth-ledger.rename-ledger] the user's own other membership with
    // the name is the within-user conflict: 400 invalid_request
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "共有中" }),
        )
        .await;
    assert_eq!(resp.status(), 400);
    assert_eq!(body_json(resp).await["error"], "invalid_request");

    // non-member and nonexistent ledger ids are the same 404
    for path in [
        format!("/api/ledgers/{theirs}"),
        "/api/ledgers/999".to_string(),
    ] {
        let resp = c
            .patch(&router, &path, serde_json::json!({ "name": "x" }))
            .await;
        assert_eq!(resp.status(), 404, "{path}");
    }

    // viewer: 403 viewer_only (same user demoted on the same ledger)
    sqlx::query("UPDATE ledger_members SET role = 'viewer' WHERE ledger_id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let resp = c
        .patch(
            &router,
            "/api/ledgers/1",
            serde_json::json!({ "name": "もう一度" }),
        )
        .await;
    assert_eq!(resp.status(), 403);
    assert_eq!(body_json(resp).await["error"], "viewer_only");
}

// ---------------------------------------------------------------------------
// TASK-63: same-date receipts order by purchased_time (newest first, NULL
// last) with the 3-part keyset cursor; the item-level list shares the rule.
// TASK-65: the web payment_method filter on /receipts and the /analysis
// endpoints.

/// [covers:web-data-api.receipt-time-ordering] same-day time ordering + cursor
#[tokio::test]
async fn receipt_list_time_ordering_and_cursor() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    // ids in a "wrong" order on the same day: 101 @09:00, 102 @18:30, 103 no
    // time, 104 on another (later) day
    for (id, on) in [
        (101, "2026-10-10"),
        (102, "2026-10-10"),
        (103, "2026-10-10"),
        (104, "2026-10-12"),
    ] {
        insert_receipt_full(&pool, id, 1, 1, on, 100).await;
    }
    for (id, t) in [(101, "09:00"), (102, "18:30")] {
        sqlx::query("UPDATE receipts SET purchased_time = ? WHERE id = ?")
            .bind(t)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    // within the day: 18:30 -> 09:00 -> (no time), then the later date first
    // overall (date desc); pagination with limit=2 loses and duplicates nothing
    let mut got = Vec::new();
    let mut cursor = String::new();
    for _ in 0..3 {
        let path = if cursor.is_empty() {
            "/api/ledgers/1/receipts?limit=2".to_string()
        } else {
            format!("/api/ledgers/1/receipts?limit=2&cursor={cursor}")
        };
        let v = body_json(c.get(&router, &path).await).await;
        for r in v["receipts"].as_array().unwrap() {
            got.push(r["receipt_id"].as_i64().unwrap());
        }
        match v["next_cursor"].as_str() {
            Some(next) => cursor = next.to_string(),
            None => break,
        }
    }
    assert_eq!(
        got,
        vec![104, 102, 101, 103],
        "date desc, then time desc within the day, NULL last"
    );

    // the old 2-part cursor format no longer decodes: 400
    // (base64url of "2026-10-10|101", precomputed)
    let old = "MjAyNi0xMC0xMHwxMDE";
    let resp = c
        .get(&router, &format!("/api/ledgers/1/receipts?cursor={old}"))
        .await;
    assert_eq!(resp.status(), 400);

    // the item-level list shares the key: same-day items follow the receipt's
    // time desc, then item id desc; pagination is lossless as well
    let mut items = Vec::new();
    let mut cursor = String::new();
    for _ in 0..5 {
        let path = if cursor.is_empty() {
            "/api/ledgers/1/items?limit=2".to_string()
        } else {
            format!("/api/ledgers/1/items?limit=2&cursor={cursor}")
        };
        let v = body_json(c.get(&router, &path).await).await;
        for r in v["items"].as_array().unwrap() {
            items.push(r["item_id"].as_i64().unwrap());
        }
        match v["next_cursor"].as_str() {
            Some(next) => cursor = next.to_string(),
            None => break,
        }
    }
    // fixture items: insert_receipt_full gives each receipt one item with the
    // id <receipt>*100 — the later date leads, then the same day by time
    assert_eq!(items, vec![10400, 10200, 10100, 10300]);
}

/// [covers:web-data-api.payment-method-filter] payment_method on /receipts
/// and the /analysis endpoints (the old /stats route is gone; the analysis
/// handlers share the same web_filters parse)
#[tokio::test]
async fn receipt_and_analysis_payment_method_filter() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "editor").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-08", 180).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-10-05", 150).await;
    sqlx::query("UPDATE receipts SET payment_method = 'cash' WHERE id IN (101, 103)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE receipts SET payment_method = 'credit_card' WHERE id = 102")
        .execute(&pool)
        .await
        .unwrap();

    // /receipts narrows to the exact method
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?payment_method=cash")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 2);
    assert_eq!(v["sum_amount"], 370);
    // an unknown key is a 400, a known-but-empty one is a plain empty page
    let resp = c
        .get(&router, "/api/ledgers/1/receipts?payment_method=paypay")
        .await;
    assert_eq!(resp.status(), 400);
    let v = body_json(
        c.get(&router, "/api/ledgers/1/receipts?payment_method=point")
            .await,
    )
    .await;
    assert_eq!(v["total_count"], 0);
    assert_eq!(v["receipts"].as_array().unwrap().len(), 0);

    // /analysis: the filter rides the totals and the axis rows (the same
    // filter_sql the endpoints share), and the filters echo omits it (the
    // store_id web-only pattern)
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis?axis=payment_method&month=2026-10&payment_method=cash",
        )
        .await,
    )
    .await;
    assert_eq!(v["totals"]["amount"], 370, "cash rows only");
    assert!(v.get("filters").is_none() || v["filters"].get("payment_method").is_none());
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["label"], "現金");
    // an unknown key on /analysis is a 400 too
    let resp = c
        .get(&router, "/api/ledgers/1/analysis?payment_method=x")
        .await;
    assert_eq!(resp.status(), 400);
}

// ---------------------------------------------------------------------------
// TASK-89: /analysis endpoints (breakdown / stacked trend / item stats)

/// A priced item line (quantity / unit_price for the item stats rule).
#[allow(clippy::too_many_arguments)]
async fn insert_priced_item(
    pool: &SqlitePool,
    id: i64,
    receipt_id: i64,
    ledger_id: i64,
    line_no: i64,
    name: &str,
    norm: &str,
    amount_incl: i64,
    quantity: f64,
    unit_price: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO receipt_items (id, receipt_id, ledger_id, line_no, name, name_norm,
             amount, amount_incl, quantity, unit_price, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)",
    )
    .bind(id)
    .bind(receipt_id)
    .bind(ledger_id)
    .bind(line_no)
    .bind(name)
    .bind(norm)
    .bind(amount_incl)
    .bind(amount_incl)
    .bind(quantity)
    .bind(unit_price)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
// [covers:web-data-api.analysis-breakdown]
async fn analysis_breakdown_axis_metric_rows() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B薬局", "bやっきょく").await;
    // Oct: Aマート 2 receipts (one with two identical 牛乳 lines), Sep: both stores
    insert_receipt_bare(&pool, 101, 1, 1, "2026-10-10").await;
    insert_priced_item(&pool, 10101, 101, 1, 1, "牛乳", "牛乳", 100, 1.0, None).await;
    insert_priced_item(&pool, 10102, 101, 1, 2, "牛乳", "牛乳", 100, 1.0, None).await;
    insert_receipt_bare(&pool, 102, 1, 1, "2026-10-12").await;
    insert_priced_item(&pool, 10201, 102, 1, 1, "牛乳", "牛乳", 220, 1.0, None).await;
    insert_receipt_bare(&pool, 103, 1, 1, "2026-09-10").await;
    insert_priced_item(&pool, 10301, 103, 1, 1, "牛乳", "牛乳", 180, 1.0, None).await;
    insert_receipt_bare(&pool, 104, 1, 2, "2026-09-15").await;
    insert_priced_item(
        &pool,
        10401,
        104,
        1,
        1,
        "風邪薬",
        "かぜやく",
        200,
        1.0,
        None,
    )
    .await;

    // axis=store&month=2026-10: the current period only (B薬局 has September
    // data alone, so it is absent), metric desc, no その他 row
    let v = body_json(
        c.get(&router, "/api/ledgers/1/analysis?axis=store&month=2026-10")
            .await,
    )
    .await;
    assert_eq!(v["axis"], "store");
    assert_eq!(v["metric"], "amount");
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "September-only stores drop out entirely");
    assert_eq!(rows[0]["label"], "Aマート");
    assert_eq!(rows[0]["amount"], 420);
    assert_eq!(rows[0]["count"], 2);
    assert_eq!(rows[0]["unit"], 210.0);
    assert_eq!(rows[0]["share"], 1.0);
    assert!(
        rows.iter().all(|r| r["label"] != "その他"),
        "no aggregated remainder row"
    );
    assert_eq!(v["totals"]["amount"], 420);
    assert_eq!(v["totals"]["count"], 2);
    assert_eq!(v["totals"]["days"], 31);

    // metric=count: the two identical lines on receipt 101 count as one receipt
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis?axis=store&month=2026-10&metric=count",
        )
        .await,
    )
    .await;
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "Aマート");
    assert_eq!(rows[0]["count"], 2);

    // metric=unit: per-receipt average, one decimal; share null on the unit axis
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis?axis=store&month=2026-10&metric=unit",
        )
        .await,
    )
    .await;
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "Aマート");
    assert_eq!(rows[0]["unit"], 210.0);
    assert!(rows[0]["share"].is_null());

    // axis=item: grouped by 品名 (REVIEW-13 M-3 — same-name lines are one
    // item, so the three 牛乳 lines collapse). One more Oct item (receipt
    // 105, パン) makes the limit=1 tail hold it.
    insert_receipt_bare(&pool, 105, 1, 1, "2026-10-13").await;
    insert_priced_item(&pool, 10501, 105, 1, 1, "パン", "ぱん", 130, 1.0, None).await;
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis?axis=item&month=2026-10&limit=1",
        )
        .await,
    )
    .await;
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["key"], "牛乳", "item axis key is the 品名 string");
    assert!(rows[0]["key"].is_string());
    assert_eq!(rows[0]["label"], "牛乳");
    assert_eq!(rows[0]["amount"], 420, "the three 牛乳 lines in one group");
    // the tail holds the current-period パン only — September values never
    // appear in the current-period analysis
    assert_eq!(v["truncated_rows"], 1);

    // no query: category x amount defaults
    let v = body_json(c.get(&router, "/api/ledgers/1/analysis").await).await;
    assert_eq!(v["axis"], "category");
    assert_eq!(v["metric"], "amount");
    // seeded catalog has no matching category -> 未分類 axis row
    assert_eq!(v["rows"][0]["label"], "未分類");
}

#[tokio::test]
// [covers:web-data-api.analysis-stacked-trend]
async fn analysis_stacked_trend_matrix() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B薬局", "bやっきょく").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-05", 100).await;
    insert_receipt_full(&pool, 102, 1, 2, "2026-10-08", 200).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-10-12", 50).await;

    // granularity=week over a 2-week span: Monday anchors, zero-filled
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?axis=store&from=2026-10-05&to=2026-10-18&granularity=week",
        )
        .await,
    )
    .await;
    assert_eq!(v["granularity"], "week");
    assert_eq!(
        v["buckets"],
        serde_json::json!(["2026-10-05", "2026-10-12"])
    );
    let series = v["series"].as_array().unwrap();
    assert_eq!(series.len(), 2);
    assert_eq!(series[0]["label"], "B薬局", "whole-range metric total desc");
    assert_eq!(series[0]["values"], serde_json::json!([200, 0]));
    assert_eq!(series[1]["label"], "Aマート");
    assert_eq!(series[1]["values"], serde_json::json!([100, 50]));
    assert_eq!(v["bucket_totals"], serde_json::json!([300, 50]));
    assert_eq!(v["truncated_rows"], 0);

    // auto: <= 62 days picks day (zero-filled per date), 63..366 week
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?from=2026-10-01&to=2026-10-18",
        )
        .await,
    )
    .await;
    assert_eq!(v["granularity"], "day");
    assert_eq!(v["buckets"].as_array().unwrap().len(), 18);
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?from=2026-01-01&to=2026-06-30",
        )
        .await,
    )
    .await;
    assert_eq!(v["granularity"], "week");
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?from=2024-01-01&to=2026-12-31",
        )
        .await,
    )
    .await;
    assert_eq!(v["granularity"], "month");

    // 11 series with the default limit 10: series capped, truncated_rows=1
    for i in 0..11 {
        let store = 10 + i;
        insert_store(
            &pool,
            store,
            1,
            &format!("店{store}"),
            &format!("みせ{store}"),
        )
        .await;
        insert_receipt_full(&pool, 200 + i, 1, store, "2026-10-06", 100).await;
    }
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?axis=store&from=2026-10-05&to=2026-10-18&granularity=day",
        )
        .await,
    )
    .await;
    assert_eq!(v["series"].as_array().unwrap().len(), 10);
    // A / B / the 11 stores = 13 series, top 10 kept
    assert_eq!(v["truncated_rows"], 3);
    // bucket totals still cover every axis value (top series + remainder):
    // the 11 stores all sit on 10-06 = buckets[1]
    assert_eq!(v["bucket_totals"][1], 1100, "11 stores on 10-06");
}

#[tokio::test]
// [covers:web-data-api.analysis-trend-filter-predicates]
async fn analysis_stacked_trend_filters_apply() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B薬局", "bやっきょく").await;
    // the selected store 100/300 against elsewhere 50/70 in the same buckets:
    // filter predicates must filter ROWS — the old axis_bucket_totals SQL
    // appended them after GROUP BY, so SQLite folded them into the grouping
    // expression and summed unrelated spending into the totals (PR#1 P1)
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-05", 100).await;
    insert_receipt_full(&pool, 102, 1, 2, "2026-10-05", 50).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-10-13", 300).await;
    insert_receipt_full(&pool, 104, 1, 2, "2026-10-13", 70).await;

    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?axis=store&store_id=1&granularity=week&from=2026-10-05&to=2026-10-18",
        )
        .await,
    )
    .await;
    assert_eq!(
        v["buckets"],
        serde_json::json!(["2026-10-05", "2026-10-12"])
    );
    let series = v["series"].as_array().unwrap();
    assert_eq!(series.len(), 1);
    assert_eq!(series[0]["label"], "Aマート");
    assert_eq!(series[0]["values"], serde_json::json!([100, 300]));
    // bucket_totals cover the FILTERED axis only: [100, 300], not [150, 370]
    assert_eq!(v["bucket_totals"], serde_json::json!([100, 300]));
}

#[tokio::test]
// [covers:web-data-api.analysis-trend-label-unlabeled-buckets]
async fn analysis_stacked_trend_label_axis_unlabeled_buckets() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    // a labeled receipt per bucket and unlabeled spending beside it: the
    // unlabeled tail query of axis_bucket_totals used to sit after GROUP BY
    // (broken even with no user filter), dropping that spending from every
    // bucket (PR#1 P1)
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-05", 100).await;
    insert_receipt_label(&pool, 101, "red").await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-12", 400).await;

    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?axis=label&granularity=week&from=2026-10-05&to=2026-10-18",
        )
        .await,
    )
    .await;
    assert_eq!(
        v["bucket_totals"],
        serde_json::json!([100, 400]),
        "labeled + unlabeled per bucket"
    );
    let series = v["series"].as_array().unwrap();
    assert_eq!(series.len(), 2, "ラベルなし 400 > 赤 100");
    // the unlabeled NULL series carries its actual bucket cells
    assert_eq!(series[0]["key"], serde_json::Value::Null);
    assert_eq!(series[0]["label"], "ラベルなし");
    assert_eq!(series[0]["values"], serde_json::json!([0, 400]));
    assert_eq!(series[1]["key"], "red");
    assert_eq!(series[1]["values"], serde_json::json!([100, 0]));
}

#[tokio::test]
// [covers:web-data-api.analysis-trend-null-key]
async fn analysis_stacked_trend_null_key_series() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    // one categorized receipt per bucket plus 未分類 spending: the ranked
    // top holds BOTH a solid key and the NULL key, so the matrix restriction
    // must carry the IS NULL alternative (a plain IN cannot match NULL rows
    // and the 未分類 series zero-fills — PR#1 P2). 食費 comes from the seed
    let cat: i64 =
        sqlx::query_scalar("SELECT id FROM item_categories WHERE ledger_id = 1 AND name = '食費'")
            .fetch_one(&pool)
            .await
            .unwrap();
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-05", 100).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-05", 500).await;
    insert_receipt_full(&pool, 103, 1, 1, "2026-10-12", 300).await;
    insert_receipt_full(&pool, 104, 1, 1, "2026-10-12", 50).await;
    for id in [102, 104] {
        sqlx::query("UPDATE receipt_items SET category_id = ? WHERE receipt_id = ?")
            .bind(cat)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }

    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/trend?granularity=week&from=2026-10-05&to=2026-10-18",
        )
        .await,
    )
    .await;
    let series = v["series"].as_array().unwrap();
    assert_eq!(series.len(), 2, "食費 550 > 未分類 400");
    assert_eq!(series[0]["label"], "食費");
    assert_eq!(series[0]["values"], serde_json::json!([500, 50]));
    assert_eq!(series[1]["key"], serde_json::Value::Null);
    assert_eq!(series[1]["label"], "未分類");
    assert_eq!(series[1]["values"], serde_json::json!([100, 300]));
    assert_eq!(v["bucket_totals"], serde_json::json!([600, 350]));
}

#[tokio::test]
// [covers:web-data-api.analysis-item-stats]
async fn analysis_item_stats_endpoint() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_store(&pool, 2, 1, "B薬局", "bやっきょく").await;
    // B薬局 9/20: unit_price stated (300 for 2); Aマート 10/05: derived (198 / 1)
    insert_receipt_bare(&pool, 101, 1, 2, "2026-09-20").await;
    insert_priced_item(&pool, 10101, 101, 1, 1, "牛乳", "牛乳", 300, 2.0, Some(150)).await;
    insert_receipt_bare(&pool, 102, 1, 1, "2026-10-05").await;
    insert_priced_item(&pool, 10201, 102, 1, 1, "牛乳", "牛乳", 198, 1.0, None).await;

    // item_id is the exact line: the single 10/05 purchase
    let milk: i64 =
        sqlx::query_scalar("SELECT id FROM receipt_items WHERE name = '牛乳' AND receipt_id = 102")
            .fetch_one(&pool)
            .await
            .unwrap();
    let v = body_json(
        c.get(
            &router,
            &format!("/api/ledgers/1/analysis/item?item_id={milk}&from=2026-09-01&to=2026-10-31"),
        )
        .await,
    )
    .await;
    assert_eq!(v["item"]["item_id"], milk);
    assert_eq!(v["item"]["name"], "牛乳");
    assert_eq!(v["prices"].as_array().unwrap().len(), 1);
    assert_eq!(v["prices"][0]["unit_price"], 198, "amount / quantity");
    assert_eq!(v["truncated_rows"], 0);

    // item_query matches the whole name group across ids/stores: both the
    // stated unit_price row and the derived one
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/item?item_query=牛乳&from=2026-09-01&to=2026-10-31",
        )
        .await,
    )
    .await;
    // the representative is the latest purchase
    assert_eq!(v["item"]["item_id"], milk);
    assert_eq!(v["item"]["name"], "牛乳");
    // prices ascending; unit_price wins, missing -> round(amount/quantity)
    let prices = v["prices"].as_array().unwrap();
    assert_eq!(prices.len(), 2);
    assert_eq!(prices[0]["date"], "2026-09-20");
    assert_eq!(prices[0]["store_name"], "B薬局");
    assert_eq!(prices[0]["unit_price"], 150);
    assert_eq!(prices[0]["quantity"], 2.0);
    assert_eq!(prices[1]["unit_price"], 198);
    assert_eq!(v["truncated_rows"], 0);
    // summary follows the same unit-price rule
    assert_eq!(v["summary"]["count"], 2);
    assert_eq!(v["summary"]["amount"], 498);
    assert_eq!(v["summary"]["min_unit_price"], 150);
    assert_eq!(v["summary"]["max_unit_price"], 198);
    assert_eq!(v["summary"]["avg_unit_price"], 174);
    assert_eq!(v["summary"]["last_purchased_on"], "2026-10-05");
    assert_eq!(
        v["summary"]["stores"],
        serde_json::json!(["B薬局", "Aマート"])
    );
    // by_store aggregates per store
    let by_store = v["by_store"].as_array().unwrap();
    assert_eq!(by_store.len(), 2);
    assert_eq!(by_store[0]["store_name"], "B薬局");
    assert_eq!(by_store[0]["amount"], 300);
    assert_eq!(by_store[0]["count"], 1);
    // monthly zero-fill over the period
    assert_eq!(
        v["monthly"],
        serde_json::json!([
            { "ym": "2026-09", "count": 1, "amount": 300 },
            { "ym": "2026-10", "count": 1, "amount": 198 },
        ])
    );

    // REVIEW-13 M-3: /analysis?axis=item and /analysis/item?item_query=品名
    // agree on the same name group — a row press and its landing page show
    // the same amount (here: the two 牛乳 lines in Oct are ONE axis value
    // despite two distinct item_ids)
    let v = body_json(
        c.get(&router, "/api/ledgers/1/analysis?axis=item&month=2026-10")
            .await,
    )
    .await;
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "one name group across item ids");
    assert_eq!(rows[0]["key"], "牛乳");
    assert_eq!(rows[0]["amount"], 198);
    let v = body_json(
        c.get(
            &router,
            "/api/ledgers/1/analysis/item?item_query=牛乳&month=2026-10",
        )
        .await,
    )
    .await;
    assert_eq!(v["summary"]["amount"], 198, "the landing page's total");

    // neither item_id nor item_query: 400
    let resp = c
        .get(&router, "/api/ledgers/1/analysis/item?month=2026-10")
        .await;
    assert_eq!(resp.status(), 400);
}

#[tokio::test]
// [covers:web-data-api.analysis-label-axis]
async fn analysis_label_axis_semantics() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 400).await;
    insert_receipt_full(&pool, 102, 1, 1, "2026-10-12", 100).await;
    insert_receipt_label(&pool, 101, "red").await;
    insert_receipt_label(&pool, 101, "blue").await;
    sqlx::query("UPDATE ledger_labels SET title = '旅行' WHERE ledger_id = 1 AND color = 'red'")
        .execute(&pool)
        .await
        .unwrap();

    let v = body_json(
        c.get(&router, "/api/ledgers/1/analysis?axis=label&month=2026-10")
            .await,
    )
    .await;
    let rows = v["rows"].as_array().unwrap();
    let red = rows.iter().find(|r| r["label"] == "旅行").unwrap();
    let blue = rows.iter().find(|r| r["label"] == "青").unwrap();
    let none = rows.iter().find(|r| r["label"] == "ラベルなし").unwrap();
    // duplicate postings: the double-labeled receipt lands in both colors
    assert_eq!(red["key"], "red");
    assert_eq!(red["amount"], 400);
    assert_eq!(blue["key"], "blue");
    assert_eq!(blue["amount"], 400);
    assert!(none["key"].is_null(), "unlabeled bucket key is null");
    assert_eq!(none["amount"], 100);
    // shares over the duplicate-inclusive axis total 900
    assert_eq!(red["share"], 0.444);
    assert_eq!(none["share"], 0.111);
}

#[tokio::test]
// [covers:web-data-api.analysis-input-validation]
async fn analysis_input_validation() {
    let (router, pool) = setup().await;
    let c = user_with_ledger(&router, &pool, "viewer").await;
    insert_store(&pool, 1, 1, "Aマート", "aまーと").await;
    insert_receipt_full(&pool, 101, 1, 1, "2026-10-10", 220).await;

    let max = 200i64; // configs/dev mcp.toml stats_max_rows
    let bad = [
        "/api/ledgers/1/analysis?axis=nope",
        "/api/ledgers/1/analysis?metric=avg",
        "/api/ledgers/1/analysis?month=2026-10&year=2026",
        "/api/ledgers/1/analysis?from=2026-10-01",
        "/api/ledgers/1/analysis?from=2026-10-31&to=2026-10-01",
        "/api/ledgers/1/analysis?limit=0",
        &format!("/api/ledgers/1/analysis?limit={}", max + 1),
        "/api/ledgers/1/analysis?category=無いカテゴリ",
        &format!("/api/ledgers/1/analysis?item_query={}", "a".repeat(201)),
        "/api/ledgers/1/analysis/trend?granularity=hour",
        "/api/ledgers/1/analysis/trend?axis=nope",
        "/api/ledgers/1/analysis/item?month=2026-10",
        &format!(
            "/api/ledgers/1/analysis/item?item_query={}",
            "a".repeat(201)
        ),
    ];
    for q in bad {
        let resp = c.get(&router, q).await;
        let (status, body) = status_text(resp).await;
        assert_eq!(status, 400, "{q} -> {body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        assert_eq!(v["error"], "invalid_request", "{q} -> {body}");
    }

    // boundary limits and plain valid calls are 200
    for q in [
        "/api/ledgers/1/analysis?limit=1&month=2026-10",
        &format!("/api/ledgers/1/analysis?limit={max}&month=2026-10"),
        "/api/ledgers/1/analysis/trend?granularity=week&from=2026-10-01&to=2026-10-18",
        "/api/ledgers/1/analysis/item?item_id=10101",
    ] {
        let resp = c.get(&router, q).await;
        assert_eq!(resp.status(), 200, "{q}");
    }

    // another user's / missing ledger: the same 404 as the rest of the API
    let other: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('other89', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    for q in [
        format!("/api/ledgers/{other}/analysis"),
        "/api/ledgers/1/analysis/item?item_id=1".replace("ledgers/1", "ledgers/77"),
    ] {
        let resp = c.get(&router, &q).await;
        assert_eq!(resp.status(), 404, "{q}");
    }
}
