//! TASK-18: the batch draft tools through the real `/mcp` route — tool #20
//! create_receipt_drafts (receipt_images array + image_index, per-entry
//! rejection, shared/unreferenced images, decode gate) and #21
//! approve_receipt_drafts (per-item results), plus the single-tool parity
//! regression after the draft_intake extraction (spec_mcp-tools.md 7 new
//! section, 5-3; design tmp/tasks/tm-18/design_mcp-batch.md).
//!
//! Images are served by a local mock HTTP server on 127.0.0.1 with
//! `allow_insecure_loopback` + an exact-host allowlist entry, so the real
//! safe_fetch path (redirect refusal, size cap, decode) runs end to end.

mod common;

use std::collections::HashMap;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use budget_book::app::{self, AppState};
use budget_book::config::Config;
use budget_book::db;
use common::oauth;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tokio_util::sync::CancellationToken;

const PROTOCOL_VERSION: &str = "2025-06-18";

// ---------------------------------------------------------------------------
// mock image server

struct ImgState {
    hits: Mutex<HashMap<String, u32>>,
    in_flight: AtomicI32,
    max_in_flight: AtomicI32,
}

#[derive(Clone)]
struct ImgMock {
    addr: std::net::SocketAddr,
    state: Arc<ImgState>,
}

impl ImgMock {
    /// Requests recorded for a path key (e.g. "ok1").
    fn hits(&self, key: &str) -> u32 {
        *self.state.hits.lock().unwrap().get(key).unwrap_or(&0)
    }
    fn total_hits(&self) -> u32 {
        self.state.hits.lock().unwrap().values().sum()
    }
    fn max_in_flight(&self) -> i32 {
        self.state.max_in_flight.load(Ordering::SeqCst)
    }
    /// A fileParams object for `key`. The same key always yields the same
    /// file_id, so two indexes built from one key share the file_id.
    fn file(&self, key: &str) -> Value {
        json!({
            "download_url": format!("http://{}/img/{}", self.addr, key),
            "file_id": format!("file-{key}"),
            "mime_type": "image/png",
        })
    }
}

fn png(w: u32, h: u32, r: u8) -> Vec<u8> {
    let img = image::RgbaImage::from_pixel(w, h, image::Rgba([r, 40, 200, 255]));
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .unwrap();
    buf.into_inner()
}

async fn img_handler(State(mock): State<Arc<ImgState>>, Path(key): Path<String>) -> Response {
    {
        let mut hits = mock.hits.lock().unwrap();
        *hits.entry(key.clone()).or_insert(0) += 1;
    }
    let cur = mock.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
    mock.max_in_flight.fetch_max(cur, Ordering::SeqCst);
    let short_key = key.trim_start_matches(|c: char| c.is_ascii_digit());
    let delay_key = key.trim_end_matches(|c: char| c.is_ascii_digit());
    let delay_ms: u64 = match delay_key {
        "slow" => 700,
        "late" => 2500,
        "hang" => 30_000,
        _ => 0,
    };
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
    mock.in_flight.fetch_sub(1, Ordering::SeqCst);
    // strip the delay suffix digits for the payload table
    match short_key {
        "huge" => (
            StatusCode::OK,
            HeaderMap::new(),
            vec![0u8; 8192], // over the 4096-byte max_download_bytes override
        )
            .into_response(),
        "text" => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "text/plain")],
            b"not an image".to_vec(),
        )
            .into_response(),
        "redir" => {
            let mut headers = HeaderMap::new();
            headers.insert(axum::http::header::LOCATION, "/img/ok1".parse().unwrap());
            (StatusCode::FOUND, headers, Vec::new()).into_response()
        }
        "ok2" => (StatusCode::OK, HeaderMap::new(), png(48, 48, 90)).into_response(),
        "same" => (StatusCode::OK, HeaderMap::new(), png(24, 24, 150)).into_response(),
        _ => (StatusCode::OK, HeaderMap::new(), png(32, 64, 120)).into_response(),
    }
}

async fn spawn_img_mock() -> ImgMock {
    let state = Arc::new(ImgState {
        hits: Mutex::new(HashMap::new()),
        in_flight: AtomicI32::new(0),
        max_in_flight: AtomicI32::new(0),
    });
    let router = axum::Router::new()
        .route("/img/{key}", axum::routing::get(img_handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    ImgMock { addr, state }
}

// ---------------------------------------------------------------------------
// app / auth setup

fn mcp_headers(token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("host", "localhost:40281".into()),
        ("authorization", format!("Bearer {token}")),
        ("content-type", "application/json".into()),
        ("accept", "application/json, text/event-stream".into()),
        ("mcp-protocol-version", PROTOCOL_VERSION.into()),
    ]
}

async fn post_jsonrpc(router: &axum::Router, token: &str, body: Value) -> Value {
    let headers = mcp_headers(token);
    let mut builder = axum::http::Request::builder().method("POST").uri("/mcp");
    for (k, v) in &headers {
        builder = builder.header(*k, v.as_str());
    }
    use tower::ServiceExt as _;
    let resp = router
        .clone()
        .oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v.get("error").is_none(), "protocol error: {v}");
    v["result"].clone()
}

async fn call(router: &axum::Router, token: &str, id: i64, name: &str, args: Value) -> Value {
    post_jsonrpc(
        router,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        }),
    )
    .await
}

async fn call_list(router: &axum::Router, token: &str, id: i64) -> Value {
    post_jsonrpc(
        router,
        token,
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/list",
            "params": {},
        }),
    )
    .await
}

struct Setup {
    router: axum::Router,
    pool: SqlitePool,
    owner: i64,
    viewer_ledger: i64,
    user: i64,
    img: ImgMock,
    _dir: tempfile::TempDir,
}

/// App with the image allowlist pointed at the loopback mock: http + exact
/// host "127.0.0.1", a short per-image fetch timeout (2s) and a tiny download
/// cap (4KB) so the too_large / late-answer cases run fast.
async fn setup() -> Setup {
    let mock = oauth::spawn_mock().await;
    let img = spawn_img_mock().await;
    let mut cfg: Config = oauth::oauth_config(&mock, None);
    cfg.tools.image.allow_insecure_loopback = true;
    cfg.tools.image.fetch_allowed_hosts = vec!["127.0.0.1".into()];
    cfg.tools.image.fetch_timeout_secs = 2;
    cfg.tools.image.max_download_bytes = 4096;
    let dir = tempfile::tempdir().expect("tempdir");
    cfg.app.maintenance.image_root = dir.path().to_path_buf();
    let pool = db::connect_memory().await.expect("memory db");
    let state = AppState::new(&cfg, pool.clone()).expect("app state");
    let router = app::router(&cfg, state, CancellationToken::new());
    let user = common::auth::create_user_direct(&pool, "Batch User", None).await;
    let owner: i64 =
        sqlx::query_scalar::<_, Option<i64>>("SELECT default_ledger_id FROM users WHERE id = ?")
            .bind(user)
            .fetch_one(&pool)
            .await
            .unwrap()
            .expect("default ledger");
    let viewer_ledger: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('viewer-side', 0, 0) RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    common::insert_member(&pool, viewer_ledger, user, "viewer").await;
    Setup {
        router,
        pool,
        owner,
        viewer_ledger,
        user,
        img,
        _dir: dir,
    }
}

impl Setup {
    async fn token(&self, active_ledger: Option<i64>, scopes: &str) -> String {
        let grant = common::oauth::insert_grant(
            &self.pool,
            self.user,
            "chatgpt.com",
            scopes,
            active_ledger,
        )
        .await;
        common::oauth::insert_access_token(&self.pool, grant).await
    }
}

// ---------------------------------------------------------------------------
// argument builders

fn payload(store: &str, date: &str, total: i64) -> Value {
    json!({
        "store_name": store,
        "purchased_on": date,
        "total_amount": total,
        "items": [{"line_no": 1, "name": "牛乳", "amount": total}],
    })
}

fn image_entry(index: i64, p: Value) -> Value {
    json!({"input_kind": "image", "image_index": index, "payload": p})
}

fn manual_entry(p: Value) -> Value {
    json!({"input_kind": "manual", "payload": p})
}

async fn image_rows(pool: &SqlitePool) -> Vec<(i64, Option<String>)> {
    sqlx::query_as("SELECT id, original_filename FROM images ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// (id, image_status, reason) of the drafts created by the call, in id order.
async fn draft_image_states(pool: &SqlitePool) -> Vec<(i64, String, Option<String>)> {
    sqlx::query_as("SELECT id, image_status, image_unavailable_reason FROM drafts ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
}

fn text_of(r: &Value) -> String {
    r["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

fn warn_codes(sc: &Value) -> Vec<String> {
    sc["warnings"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|w| w["code"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Insert a pending draft (payload_json, revision) directly and return its id.
async fn insert_pending_draft(
    pool: &SqlitePool,
    ledger_id: i64,
    user_id: i64,
    payload_json: &str,
    revision: i64,
) -> i64 {
    sqlx::query_scalar(
        "INSERT INTO drafts (ledger_id, user_id, payload_json, image_status, revision,
             created_at, updated_at, expires_at)
         VALUES (?, ?, ?, 'none', ?, 0, 0, 1210000000000) RETURNING id",
    )
    .bind(ledger_id)
    .bind(user_id)
    .bind(payload_json)
    .bind(revision)
    .fetch_one(pool)
    .await
    .unwrap()
}

const OK_PAYLOAD: &str = r#"{"store_name":"イオン","purchased_on":"2026-10-01","total_amount":198,"items":[{"line_no":1,"name":"牛乳","amount":198}]}"#;

// ---------------------------------------------------------------------------
// 2-1 tool list: schemas and descriptors

// [covers:mcp-registry.batch-schema]
#[tokio::test]
async fn create_receipt_drafts_schema_shape() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let list = call_list(&s.router, &token, 1).await;
    let tools = list["tools"].as_array().unwrap();
    let batch = tools
        .iter()
        .find(|t| t["name"] == "create_receipt_drafts")
        .expect("#20 mounted");
    let single = tools
        .iter()
        .find(|t| t["name"] == "create_receipt_draft")
        .unwrap();

    let sc = &batch["inputSchema"];
    assert_eq!(sc["additionalProperties"], json!(false));
    let required: Vec<&str> = sc["required"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert_eq!(required, ["drafts"], "only drafts is required");
    // receipt_images is a top-level fileParams array, not required
    let ri = &sc["properties"]["receipt_images"];
    assert_eq!(ri["type"], "array");
    assert_eq!(ri["items"]["$ref"], "#/$defs/OpenAIFile");
    assert!(!required.contains(&"receipt_images"));
    // drafts: minItems 1, no maxItems (the cap is a server-side setting)
    let drafts = &sc["properties"]["drafts"];
    assert_eq!(drafts["minItems"], 1);
    assert!(drafts.get("maxItems").is_none());
    let entry = &drafts["items"];
    assert_eq!(entry["additionalProperties"], json!(false));
    let entry_req: Vec<&str> = entry["required"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert_eq!(entry_req, ["input_kind", "payload"]);
    assert_eq!(
        entry["properties"]["image_index"]["type"],
        json!(["integer", "null"])
    );
    assert!(entry["properties"]["reported_filename"].is_object());
    assert!(entry["properties"]["reported_taken_at"].is_object());
    // the payload schema is shared with the single-tool version
    assert_eq!(
        entry["properties"]["payload"],
        single["inputSchema"]["properties"]["payload"]
    );
    assert_eq!(sc["properties"]["ledger_id"]["type"], "integer");
    // OpenAIFile $defs is shared with the single-tool version
    assert_eq!(
        sc["$defs"]["OpenAIFile"],
        single["inputSchema"]["$defs"]["OpenAIFile"]
    );
}

// [covers:mcp-registry.descriptor-pairs]
// (integration-side supplement: the src unit test keeps the full table
// assertion; this pins the TASK-18 additions through the real tools/list.)
#[tokio::test]
async fn batch_tool_descriptors_mounted() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let list = call_list(&s.router, &token, 1).await;
    let tools = list["tools"].as_array().unwrap();
    let mut names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    names.sort_unstable();
    let mut expected: Vec<&str> = [
        "ping",
        "create_receipt_draft",
        "update_receipt_draft",
        "approve_receipt_draft",
        "discard_receipt_draft",
        "reopen_receipt_draft",
        "get_receipt_drafts",
        "search_receipts",
        "get_receipt",
        "update_receipt",
        "delete_receipt",
        "get_catalog",
        "manage_category",
        "manage_store",
        "summarize_spending",
        "whoami",
        "list_ledgers",
        "switch_ledger",
        "label_receipts",
        "create_receipt_drafts",
        "approve_receipt_drafts",
        "refresh_widget_images",
    ]
    .to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected, "21 model tools + W1 + ping");
    let by = |n: &str| tools.iter().find(|t| t["name"] == n).unwrap();
    // fileParams: #1 keeps the single key, #20 carries the array key
    assert_eq!(
        by("create_receipt_draft")["_meta"]["openai/fileParams"],
        json!(["receipt_image"])
    );
    assert_eq!(
        by("create_receipt_drafts")["_meta"]["openai/fileParams"],
        json!(["receipt_images"])
    );
    assert!(
        by("approve_receipt_drafts")["_meta"]
            .get("openai/fileParams")
            .is_none(),
        "#21 has no file params"
    );
    // #21 is callable from the widget ("すべて登録")
    assert_eq!(
        by("approve_receipt_drafts")["_meta"]["ui"]["visibility"],
        json!(["model", "app"])
    );
    assert_eq!(
        by("approve_receipt_drafts")["_meta"]["openai/widgetAccessible"],
        json!(true)
    );
    // the batch tools render the draft_batch widget view
    assert_eq!(
        by("create_receipt_drafts")["_meta"]["ui"]["visibility"],
        json!(["model"])
    );
}

// ---------------------------------------------------------------------------
// #20 create_receipt_drafts

// [covers:mcp-draft-batch.writer-required]
#[tokio::test]
async fn create_batch_requires_writer_and_ledger() {
    let s = setup().await;
    // no active ledger and no ledger_id: the whole call is an error
    let token = s.token(None, "ledger.read ledger.write").await;
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({"drafts": [manual_entry(payload("イオン", "2026-10-01", 198))]}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));

    // viewer role on the target ledger
    let viewer_token = s
        .token(Some(s.viewer_ledger), "ledger.read ledger.write")
        .await;
    let r = call(
        &s.router,
        &viewer_token,
        2,
        "create_receipt_drafts",
        json!({"drafts": [manual_entry(payload("イオン", "2026-10-01", 198))]}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(text_of(&r).contains("閲覧のみ"), "viewer wording");

    let drafts: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(drafts, 0, "no draft is created on the error paths");
    assert_eq!(s.img.total_hits(), 0, "no image fetch is started");
}

// [covers:mcp-draft-batch.per-entry-rejection]
#[tokio::test]
async fn create_batch_rejects_only_invalid_entries() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let long_name = "あ".repeat(201);
    let args = json!({
        "receipt_images": [s.img.file("ok1")],
        "drafts": [
            manual_entry(payload("イオン", "2026-10-01", 198)),
            image_entry(0, payload("スーパーみどり", "2026-10-02", 248)),
            // manual + image_index: the single-tool input mix-up
            json!({"input_kind": "manual", "image_index": 0, "payload": payload("A", "2026-10-01", 100)}),
            // validate_payload violation: duplicate line_no
            json!({"input_kind": "manual", "payload": {"purchased_on": "2026-10-01",
                "items": [{"line_no": 1, "name": "a", "amount": 10}, {"line_no": 1, "name": "b", "amount": 20}]}}),
            // serde 形式不正: payload is not an object
            json!({"input_kind": "manual", "payload": "not-an-object"}),
            // input_kind の値不正
            json!({"input_kind": "photo", "payload": payload("B", "2026-10-01", 100)}),
            // reported_filename 長さ超過
            json!({"input_kind": "manual", "reported_filename": long_name, "payload": payload("C", "2026-10-01", 100)}),
        ],
    });
    let r = call(&s.router, &token, 1, "create_receipt_drafts", args).await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "draft_batch");
    let drafts = sc["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 2, "the two valid entries are saved");
    assert!(sc.get("categories_hint").is_none(), "no unknown category");
    // rejected: entry_index + errors for the five invalid entries
    let rejected: Vec<(i64, usize)> = sc["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            (
                e["entry_index"].as_i64().unwrap(),
                e["errors"].as_array().unwrap().len(),
            )
        })
        .collect();
    assert_eq!(
        rejected,
        [(2, 1), (3, 1), (4, 1), (5, 1), (6, 1)],
        "each invalid entry lists its errors"
    );
    let texts: Vec<String> = sc["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["errors"][0].as_str().unwrap().to_string())
        .collect();
    assert!(
        texts[0].contains("画像") || texts[0].contains("input_kind"),
        "{}",
        texts[0]
    );
    assert!(texts[1].contains("line_no"), "{}", texts[1]);
    // entry_draft_ids: saved entries carry ids, rejected are null
    let ids: Vec<Value> = sc["entry_draft_ids"].as_array().unwrap().clone();
    assert_eq!(ids.len(), 7);
    for i in [0usize, 1] {
        assert!(ids[i].as_i64().is_some(), "entry {i} has a draft_id");
    }
    for i in [2, 3, 4, 5, 6] {
        assert!(ids[i].is_null(), "entry {i} is null");
    }
    let text = text_of(&r);
    assert!(text.contains("保存していません"), "reject note: {text}");
    assert!(
        text.contains("その要素だけ"),
        "fix-only-that-entry note: {text}"
    );
    // the image of the valid entry is fetched and attached; the rejected
    // entry's image reference does not trigger a second fetch
    assert_eq!(s.img.hits("ok1"), 1);
    let states = draft_image_states(&s.pool).await;
    assert_eq!(states.len(), 2);
    assert!(
        states
            .iter()
            .any(|(_, st, reason)| st == "attached" && reason.is_none()),
        "the image entry is attached: {states:?}"
    );

    // all entries invalid: the whole call is an error
    let r = call(
        &s.router,
        &token,
        2,
        "create_receipt_drafts",
        json!({"drafts": [
            json!({"input_kind": "photo", "payload": payload("X", "2026-10-01", 1)}),
            json!({"input_kind": "manual", "payload": "bad"}),
        ]}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let sc = &r["structuredContent"];
    assert_eq!(
        sc["drafts"].as_array().map(Vec::len),
        Some(0),
        "no draft is saved"
    );
    assert_eq!(sc["rejected"].as_array().unwrap().len(), 2);

    // whole-argument parse failures (1-5): drafts not an array / unknown key
    for (id, bad) in [
        (3, json!({"drafts": {"a": 1}})),
        (
            4,
            json!({"drafts": [manual_entry(payload("D", "2026-10-01", 1))], "bogus": 1}),
        ),
    ] {
        let r = call(&s.router, &token, id, "create_receipt_drafts", bad.clone()).await;
        assert_eq!(r["isError"], json!(true), "args must be rejected: {bad}");
    }
    let drafts: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(drafts, 2, "only the first call saved drafts");
}

// [covers:mcp-draft-batch.no-extra-rejection]
#[tokio::test]
async fn create_batch_never_rejects_for_image_mismatch() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;

    // one image entry with image_index omitted: resolves to index 0
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1")],
            "drafts": [json!({"input_kind": "image", "payload": payload("A", "2026-10-01", 100)})],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["rejected"].as_array().unwrap().len(), 0);
    assert_eq!(sc["drafts"].as_array().unwrap().len(), 1);
    let states = draft_image_states(&s.pool).await;
    assert_eq!(
        states.last().unwrap(),
        &(states.last().unwrap().0, "attached".to_string(), None),
        "sole image entry with omitted index attaches index 0"
    );
    assert_eq!(s.img.hits("ok1"), 1);

    // two image entries with the index omitted: both are image-less (no guess)
    let r = call(
        &s.router,
        &token,
        2,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1")],
            "drafts": [
                json!({"input_kind": "image", "payload": payload("B", "2026-10-01", 100)}),
                json!({"input_kind": "image", "payload": payload("C", "2026-10-01", 100)}),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert_eq!(
        r["structuredContent"]["rejected"].as_array().unwrap().len(),
        0
    );
    let states = draft_image_states(&s.pool).await;
    let last2: Vec<(String, Option<String>)> = states
        .iter()
        .rev()
        .take(2)
        .map(|(_, st, r)| (st.clone(), r.clone()))
        .collect();
    assert!(
        last2
            .iter()
            .all(|(st, r)| st == "unavailable" && r.as_deref() == Some("missing_arg")),
        "{last2:?}"
    );
    assert_eq!(
        s.img.hits("ok1"),
        1,
        "no extra fetch for the omitted indexes"
    );

    // out-of-range index: saved image-less, not rejected
    let r = call(
        &s.router,
        &token,
        3,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1")],
            "drafts": [image_entry(9, payload("D", "2026-10-01", 100))],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert_eq!(
        r["structuredContent"]["rejected"].as_array().unwrap().len(),
        0
    );
    let states = draft_image_states(&s.pool).await;
    assert_eq!(
        states.last().unwrap().2.as_deref(),
        Some("missing_arg"),
        "out-of-range index is image-less"
    );

    // receipt_images key absent entirely: image-less entries, no rejection
    let r = call(
        &s.router,
        &token,
        4,
        "create_receipt_drafts",
        json!({"drafts": [image_entry(0, payload("E", "2026-10-01", 100))]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert_eq!(
        r["structuredContent"]["rejected"].as_array().unwrap().len(),
        0
    );
    let states = draft_image_states(&s.pool).await;
    assert_eq!(states.last().unwrap().2.as_deref(), Some("missing_arg"));
    assert_eq!(s.img.total_hits(), 1, "no fetch beyond the first scenario");
}

// [covers:mcp-draft-batch.limit-overflow-not-rejected]
#[tokio::test]
async fn create_batch_overflows_to_rejected_entries() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let mut drafts: Vec<Value> = (0..10)
        .map(|i| manual_entry(payload(&format!("店{i}"), "2026-10-01", 100 + i)))
        .collect();
    // entries 10 and 11 reference the image; only rejected entries do
    drafts.push(image_entry(0, payload("店10", "2026-10-01", 110)));
    drafts.push(image_entry(0, payload("店11", "2026-10-01", 111)));
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({"receipt_images": [s.img.file("ok1")], "drafts": drafts}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["drafts"].as_array().unwrap().len(), 10, "first 10 saved");
    let rejected: Vec<i64> = sc["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["entry_index"].as_i64().unwrap())
        .collect();
    assert_eq!(rejected, [10, 11]);
    let text = text_of(&r);
    assert!(
        text.contains("上限") || text.contains("10件"),
        "cap note: {text}"
    );
    assert!(text.contains("別の呼び出し"), "split note: {text}");
    // the image referenced only by the overflow entries is never fetched
    assert_eq!(s.img.hits("ok1"), 0);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(n, 10);
}

// Tool-level slice of the batch insert: one call, one shared batch_id, entry
// order kept, and no partial rows for rejected entries. The store contract
// itself (db-drafts.create-many-atomic, including the mid-insert constraint
// violation) is covered by the direct store::create_drafts test in
// backend/tests/db_drafts.rs.
#[tokio::test]
async fn create_batch_inserts_one_batch_with_a_shared_id() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({"drafts": [
            manual_entry(payload("店1", "2026-10-01", 100)),
            manual_entry(payload("店2", "2026-10-02", 200)),
            image_entry(0, payload("店3", "2026-10-03", 300)),
            // rejected: no row may exist for this entry
            json!({"input_kind": "photo", "payload": payload("店4", "2026-10-04", 400)}),
        ]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let entry_ids: Vec<i64> = sc["entry_draft_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap_or(-1))
        .collect();
    assert_eq!(entry_ids.len(), 4);
    assert_eq!(entry_ids[3], -1, "the rejected entry has no draft_id");
    // all rows share one non-NULL batch_id (ULID: 26 chars)
    let rows: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, batch_id FROM drafts ORDER BY id")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 3, "no partial row for the rejected entry");
    let batch_id = rows[0].1.as_ref().expect("batch_id set");
    assert_eq!(batch_id.len(), 26, "ULID: {batch_id}");
    assert!(batch_id.chars().all(|c| c.is_ascii_alphanumeric()));
    assert!(
        rows.iter()
            .all(|(_, b)| b.as_deref() == Some(batch_id.as_str())),
        "one batch_id shared by every inserted row: {rows:?}"
    );
    // the ids reported per entry match the insertion (entry) order
    let db_ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
    assert_eq!(
        &db_ids,
        &entry_ids[..3],
        "drafts are inserted in entry order with contiguous ids"
    );
}

// [covers:mcp-draft-batch.saved-before-fetch]
#[tokio::test]
async fn create_batch_commits_drafts_before_fetching() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    // the image server never answers in time (fetch_timeout_secs = 2)
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("hang")],
            "drafts": [
                image_entry(0, payload("A", "2026-10-01", 100)),
                image_entry(0, payload("B", "2026-10-01", 200)),
                image_entry(0, payload("C", "2026-10-01", 300)),
            ],
        }),
    )
    .await;
    assert_eq!(
        r["isError"],
        json!(false),
        "P2: image failure is not an error"
    );
    let text = text_of(&r);
    assert!(text.contains("画像なし"), "{text}");
    // all three drafts were committed before the fetch and stay pending
    let rows: Vec<(i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, status, image_status, COALESCE(image_unavailable_reason, '') FROM drafts ORDER BY id",
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter().all(|(_, st, im, r)| {
            st == "pending" && im == "unavailable" && r.as_deref() == Some("fetch_timeout")
        }),
        "{rows:?}"
    );
    let images: i64 = sqlx::query_scalar("SELECT count(*) FROM images")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(images, 0, "no image row for the timed-out fetch");
    assert_eq!(s.img.hits("hang"), 1, "shared index 0: one fetch");
}

// [covers:mcp-draft-batch.image-mapping]
#[tokio::test]
async fn create_batch_maps_indexes_per_entry() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1"), "chat_upload_abc", null],
            "drafts": [
                image_entry(0, payload("A", "2026-10-01", 100)),
                image_entry(1, payload("B", "2026-10-01", 200)),
                image_entry(2, payload("C", "2026-10-01", 300)),
                image_entry(3, payload("D", "2026-10-01", 400)),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let drafts = sc["drafts"].as_array().unwrap();
    let ids: Vec<i64> = drafts
        .iter()
        .map(|d| d["draft_id"].as_i64().unwrap())
        .collect();
    let statuses: Vec<(&str, Value)> = drafts
        .iter()
        .map(|d| (d["status"].as_str().unwrap(), d["image"].clone()))
        .collect();
    assert_eq!(statuses[0].1["status"], json!("attached"));
    assert_eq!(statuses[1].1["status"], json!("unavailable"));
    assert_eq!(statuses[1].1["reason"], json!("chat_upload"));
    assert_eq!(statuses[2].1["reason"], json!("missing_arg"));
    assert_eq!(statuses[3].1["reason"], json!("missing_arg"));
    // images[] records every receipt_images index with its outcome
    let images = sc["images"].as_array().unwrap();
    assert_eq!(images.len(), 3, "one entry per receipt_images index");
    let outcome = |i: usize| {
        (
            images[i]["outcome"].as_str().unwrap(),
            images[i]["draft_ids"].clone(),
        )
    };
    assert_eq!(outcome(0).0, "attached");
    assert!(outcome(0).1.as_array().unwrap().contains(&json!(ids[0])));
    assert_eq!(outcome(1).0, "unavailable");
    assert_eq!(images[1]["reason"], json!("chat_upload"));
    assert_eq!(outcome(2).0, "unavailable");
    assert_eq!(images[2]["reason"], json!("missing_arg"));
    // _meta.images.drafts carries a URL per attached draft only
    let meta_drafts = r["_meta"]["images"]["drafts"].as_object().unwrap();
    assert!(
        meta_drafts
            .get(&ids[0].to_string())
            .and_then(|u| u["url"].as_str())
            .is_some()
    );
    assert!(!meta_drafts.contains_key(&ids[1].to_string()));
    // the counts line + no image-loss warning anywhere
    let text = text_of(&r);
    assert!(text.contains("4 件"), "count line: {text}");
    assert!(text.contains("画像あり 1"), "{text}");
    assert!(text.contains("画像なし 3"), "{text}");
    let codes = warn_codes(sc);
    assert!(
        codes
            .iter()
            .all(|c| !c.contains("image") && c != "unreferenced"),
        "no image-loss warnings: {codes:?}"
    );
    assert_eq!(s.img.hits("ok1"), 1);
}

// [covers:mcp-draft-batch.ssrf-per-element]
#[tokio::test]
async fn create_batch_failures_are_per_element() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [
                s.img.file("ok1"),
                {"download_url": "http://192.0.2.9/img/x", "file_id": "file-evil"},
                s.img.file("redir"),
                s.img.file("huge"),
                s.img.file("text"),
            ],
            "drafts": [
                image_entry(0, payload("ok", "2026-10-01", 100)),
                image_entry(1, payload("evil", "2026-10-01", 200)),
                image_entry(2, payload("redir", "2026-10-01", 300)),
                image_entry(3, payload("huge", "2026-10-01", 400)),
                image_entry(4, payload("text", "2026-10-01", 500)),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false), "P2: failures are not errors");
    let sc = &r["structuredContent"];
    assert!(warn_codes(sc).is_empty(), "no warnings");
    let images = sc["images"].as_array().unwrap();
    let reasons: Vec<&str> = images
        .iter()
        .map(|i| i["reason"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        reasons,
        [
            "",
            "fetch_failed",
            "fetch_failed",
            "too_large",
            "decode_failed"
        ],
        "per-index failure reasons"
    );
    assert_eq!(images[0]["outcome"], "attached");
    let drafts = sc["drafts"].as_array().unwrap();
    let draft_reasons: Vec<&str> = drafts
        .iter()
        .map(|d| d["image"]["reason"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(
        draft_reasons,
        [
            "",
            "fetch_failed",
            "fetch_failed",
            "too_large",
            "decode_failed"
        ]
    );
    // only the healthy element and the three actually-served failures hit the
    // server; the allowlisted-out host is refused before any request
    assert_eq!(s.img.hits("ok1"), 1);
    assert_eq!(s.img.hits("redir"), 1);
    assert_eq!(s.img.hits("huge"), 1);
    assert_eq!(s.img.hits("text"), 1);
}

// [covers:mcp-draft-batch.shared-image]
#[tokio::test]
async fn create_batch_shares_one_image_per_file_id() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    // the same file object appears at index 0 and index 1
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1"), s.img.file("ok1")],
            "drafts": [
                image_entry(0, payload("A", "2026-10-01", 100)),
                image_entry(0, payload("B", "2026-10-02", 200)),
                image_entry(1, payload("C", "2026-10-03", 300)),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let drafts = sc["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 3);
    assert!(
        drafts.iter().all(|d| d["image"]["status"] == "attached"),
        "all references attach"
    );
    // fetched once per file_id, stored as a single image row
    assert_eq!(s.img.hits("ok1"), 1, "fetch deduped by file_id");
    let imgs = image_rows(&s.pool).await;
    assert_eq!(imgs.len(), 1, "one shared image row");
    let image_ids: Vec<Option<i64>> = sqlx::query_scalar("SELECT image_id FROM drafts ORDER BY id")
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert!(
        image_ids.iter().all(|id| id == &Some(imgs[0].0)),
        "all three drafts reference the same image row"
    );
    // siblings never flag each other as duplicate_file
    for d in drafts {
        let dups = d["possible_duplicates"].as_array().unwrap();
        assert!(
            !dups.iter().any(|x| x["match"] == "file_id"),
            "no sibling duplicate_file: {dups:?}"
        );
    }

    // approve A (single tool), then B and C: no duplicate_file against the
    // receipt that now shares the image either
    let id_a = drafts[0]["draft_id"].as_i64().unwrap();
    let id_b = drafts[1]["draft_id"].as_i64().unwrap();
    let id_c = drafts[2]["draft_id"].as_i64().unwrap();
    // revision comes from the response: the I3a attach bumps it (spec 5-2)
    let rev_of = |i: usize| drafts[i]["revision"].as_i64().unwrap();
    for (rpc, id, rev) in [
        (2, id_a, rev_of(0)),
        (3, id_b, rev_of(1)),
        (4, id_c, rev_of(2)),
    ] {
        let r = call(
            &s.router,
            &token,
            rpc,
            "approve_receipt_draft",
            json!({"draft_id": id, "revision": rev}),
        )
        .await;
        assert_eq!(r["isError"], json!(false), "approve {id}");
        let codes = warn_codes(&r["structuredContent"]);
        assert!(
            !codes.iter().any(|c| c == "duplicate_file"),
            "approve {id}: {codes:?}"
        );
    }
}

// [covers:mcp-draft-batch.unreferenced-image-silent]
#[tokio::test]
async fn create_batch_skips_unreferenced_images_silently() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1"), s.img.file("same1"), s.img.file("ok2")],
            "drafts": [
                image_entry(0, payload("A", "2026-10-01", 100)),
                // rejected entry referencing index 1
                json!({"input_kind": "image", "image_index": 1, "payload": "bad"}),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["drafts"].as_array().unwrap().len(), 1);
    assert_eq!(sc["rejected"].as_array().unwrap().len(), 1);
    // index 2 is referenced by nobody; index 1 only by the rejected entry:
    // neither is fetched nor stored
    assert_eq!(s.img.hits("ok1"), 1);
    assert_eq!(
        s.img.hits("same1"),
        0,
        "rejected-only reference not fetched"
    );
    assert_eq!(s.img.hits("ok2"), 0, "unreferenced image not fetched");
    assert_eq!(image_rows(&s.pool).await.len(), 1);
    // images[] still records both as unreferenced
    let images = sc["images"].as_array().unwrap();
    let outcome = |i: usize| images[i]["outcome"].as_str().unwrap();
    assert_eq!(outcome(0), "attached");
    assert_eq!(outcome(1), "unreferenced");
    assert_eq!(outcome(2), "unreferenced");
    // silent: no warnings, no mention in the content text
    assert!(warn_codes(sc).is_empty(), "{:?}", warn_codes(sc));
    let text = text_of(&r);
    assert!(!text.contains("再アップロード"), "{text}");
    assert!(!text.contains("再送"), "{text}");
    assert!(!text.contains("未参照"), "{text}");
    // the only saved draft is attached: the counts line says so (design 2-2
    // writes the image-less sentence only when an image-less draft exists)
    assert!(text.contains("画像あり 1"), "{text}");
}

// [covers:mcp-draft-batch.deadline-and-concurrency]
#[tokio::test]
async fn create_batch_fetches_within_the_concurrency_cap() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let files: Vec<Value> = (1..=6).map(|i| s.img.file(&format!("slow{i}"))).collect();
    let drafts: Vec<Value> = (0..6)
        .map(|i| image_entry(i, payload(&format!("店{i}"), "2026-10-01", 100 + i)))
        .collect();
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({"receipt_images": files, "drafts": drafts}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let drafts = sc["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 6);
    assert!(
        drafts.iter().all(|d| d["image"]["status"] == "attached"),
        "all images make it within the deadline"
    );
    // the concurrent fetch count never exceeds batch_fetch_concurrency (3)
    let max = s.img.max_in_flight();
    assert!(max <= 3, "observed concurrency {max} > 3");
    assert!(max >= 2, "the fetches actually overlap: {max}");
    // every per-item window respects min(start + fetch_timeout, deadline):
    // the 700ms answers fit inside the 2s per-image timeout
    assert_eq!(image_rows(&s.pool).await.len(), 6);
}

// [covers:mcp-draft-batch.metadata-per-entry]
#[tokio::test]
async fn create_batch_keeps_metadata_per_entry() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let no_date = json!({"store_name": "A", "total_amount": 100,
        "items": [{"line_no": 1, "name": "牛乳", "amount": 100}]});
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1")],
            "drafts": [
                json!({"input_kind": "image", "image_index": 0, "reported_filename": "A.jpg",
                       "reported_taken_at": "2026-10-11T10:00:00", "payload": no_date}),
                json!({"input_kind": "image", "image_index": 0, "reported_filename": "B.jpg",
                       "reported_taken_at": "10月11日", "payload": payload("B", "2026-10-02", 200)}),
                json!({"input_kind": "manual", "payload": {
                    "store_name": "C", "purchased_on": "2026-10-03", "total_amount": 300,
                    "items": [{"line_no": 1, "name": "謎アイテム", "amount": 300, "category": "未知分類/何か"}]}}),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let drafts = sc["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 3);
    // reported_* stored per draft in the DB
    let meta: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT reported_filename, reported_taken_at FROM drafts ORDER BY id")
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(meta[0].0.as_deref(), Some("A.jpg"));
    assert_eq!(meta[0].1.as_deref(), Some("2026-10-11T10:00:00"));
    assert_eq!(meta[1].0.as_deref(), Some("B.jpg"));
    assert_eq!(meta[1].1, None, "invalid taken_at is dropped");
    // purchased_on filled from the reported taken_at (model source)
    assert_eq!(drafts[0]["payload"]["purchased_on"], json!("2026-10-11"));
    // the shared image row takes the FIRST referent's reported values
    let imgs = image_rows(&s.pool).await;
    assert_eq!(imgs.len(), 1);
    assert_eq!(imgs[0].1.as_deref(), Some("A.jpg"));
    let img_taken: Option<String> =
        sqlx::query_scalar("SELECT taken_at_local FROM images WHERE id = ?")
            .bind(imgs[0].0)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(img_taken.as_deref(), Some("2026-10-11T10:00:00"));
    // provenance of those values: the mock sends no download name and the
    // image has no EXIF, so both come from the model (the first referent)
    let (name_src, taken_src): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT original_filename_source, taken_at_source FROM images WHERE id = ?")
            .bind(imgs[0].0)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(name_src.as_deref(), Some("model"));
    assert_eq!(taken_src.as_deref(), Some("model"));
    // warnings carry draft_id + entry_index per draft
    let warnings = sc["warnings"].as_array().unwrap();
    let taken_warn: Vec<&Value> = warnings
        .iter()
        .filter(|w| w["code"] == "purchased_on_from_taken_at")
        .collect();
    assert_eq!(taken_warn.len(), 1);
    assert_eq!(
        taken_warn[0]["detail"]["entry_index"], 0,
        "detail.entry_index: {}",
        taken_warn[0]["detail"]
    );
    assert!(taken_warn[0]["detail"]["draft_id"].is_i64());
    let ignored: Vec<&Value> = warnings
        .iter()
        .filter(|w| w["code"] == "reported_taken_at_ignored")
        .collect();
    assert_eq!(ignored.len(), 1);
    assert_eq!(ignored[0]["detail"]["entry_index"], 1);
    assert!(ignored[0]["detail"]["draft_id"].is_i64());
    // categories_hint appears only because entry 2 has an unknown category
    assert!(sc["categories_hint"].is_object(), "unknown category hint");
}

// [covers:mcp-draft-batch.duplicate-rules]
#[tokio::test]
async fn create_batch_duplicate_rules() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let mut p_content = payload("スーパーみどり", "2026-10-01", 300);
    // spec 6: unresolved stores of same-ledger drafts compare store_name_raw
    p_content["store_name_raw"] = json!("スーパーみどり");
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("same1"), s.img.file("same2")],
            "drafts": [
                image_entry(0, payload("写真A", "2026-10-01", 100)),
                // same photo bytes under a different file_id -> duplicate_image
                image_entry(1, payload("写真B", "2026-10-02", 200)),
                // identical content twice -> duplicate_content
                manual_entry(p_content.clone()),
                manual_entry(p_content.clone()),
                // same file_id as entry 0 (shared photo) -> no duplicate_file
                image_entry(0, payload("写真C", "2026-10-03", 300)),
                // another file_id sibling for the reopen check below
                image_entry(0, payload("写真D", "2026-10-04", 400)),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let drafts = sc["drafts"].as_array().unwrap();
    assert_eq!(drafts.len(), 6);
    let dups_of = |i: usize| drafts[i]["possible_duplicates"].as_array().unwrap().clone();
    // content match survives between batch siblings
    let d2 = dups_of(2);
    let d3 = dups_of(3);
    let content_dups: Vec<&str> = d2
        .iter()
        .chain(d3.iter())
        .map(|d| d["match"].as_str().unwrap())
        .collect();
    assert!(
        content_dups.iter().any(|m| m == &"content"),
        "duplicate_content between identical siblings: {content_dups:?}"
    );
    // same photo, different file_id -> duplicate_image (sha256 not excluded)
    let d0 = dups_of(0);
    let d1 = dups_of(1);
    let img_dups: Vec<&str> = d0
        .iter()
        .chain(d1.iter())
        .map(|d| d["match"].as_str().unwrap())
        .collect();
    assert!(
        img_dups.iter().any(|m| m == &"sha256"),
        "duplicate_image across file_ids: {img_dups:?}"
    );
    // same file_id siblings -> duplicate_file suppressed
    assert!(
        !dups_of(4).iter().any(|d| d["match"] == "file_id"),
        "{:?}",
        dups_of(4)
    );

    // approve entry 0, then entry 4 (same file_id, same batch): still silent;
    // approving entry 1 keeps the sha256 duplicate warning (not excluded)
    let id0 = drafts[0]["draft_id"].as_i64().unwrap();
    let id1 = drafts[1]["draft_id"].as_i64().unwrap();
    let id4 = drafts[4]["draft_id"].as_i64().unwrap();
    let r = call(
        &s.router,
        &token,
        2,
        "approve_receipt_draft",
        json!({"draft_id": id0, "revision": drafts[0]["revision"]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert!(
        !warn_codes(&r["structuredContent"])
            .iter()
            .any(|c| c == "duplicate_file")
    );
    let r = call(
        &s.router,
        &token,
        3,
        "approve_receipt_draft",
        json!({"draft_id": id4, "revision": drafts[4]["revision"]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let codes = warn_codes(&r["structuredContent"]);
    assert!(
        !codes.iter().any(|c| c == "duplicate_file"),
        "same-batch receipt stays excluded: {codes:?}"
    );
    let r = call(
        &s.router,
        &token,
        4,
        "approve_receipt_draft",
        json!({"draft_id": id1, "revision": drafts[1]["revision"]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert!(
        warn_codes(&r["structuredContent"])
            .iter()
            .any(|c| c == "duplicate_image"),
        "sha256 match against the sibling receipt is kept"
    );

    // reopen does not copy the batch_id: the reopened draft is outside the
    // sibling exclusion (batch_id NULL), unlike its batch siblings
    let id5 = drafts[5]["draft_id"].as_i64().unwrap();
    let sibling_batch: Option<String> =
        sqlx::query_scalar("SELECT batch_id FROM drafts WHERE id = ?")
            .bind(id4)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert!(sibling_batch.is_some(), "batch drafts carry the batch_id");
    let r = call(
        &s.router,
        &token,
        5,
        "discard_receipt_draft",
        json!({"draft_id": id5}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let r = call(
        &s.router,
        &token,
        6,
        "reopen_receipt_draft",
        json!({"draft_id": id5}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let reopened_id = r["structuredContent"]["draft"]["draft_id"]
        .as_i64()
        .unwrap();
    let reopened_batch: Option<String> =
        sqlx::query_scalar("SELECT batch_id FROM drafts WHERE id = ?")
            .bind(reopened_id)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        reopened_batch, None,
        "the reopened draft is not part of the batch (no sibling exclusion)"
    );
}

// [covers:mcp-draft-batch.no-retry-wording]
#[tokio::test]
async fn create_batch_response_and_description_avoid_retry_prompts() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    // image-less (out-of-range index) + unreferenced + rejected in one answer
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1")],
            "drafts": [
                image_entry(5, payload("A", "2026-10-01", 100)),
                json!({"input_kind": "photo", "payload": payload("B", "2026-10-01", 100)}),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let text = text_of(&r);
    assert!(text.contains("画像なしで保存しました"), "{text}");
    for banned in ["再アップロード", "再送", "もう一度", "贴り直し", "貼り直し"]
    {
        assert!(
            !text.contains(banned),
            "content text must not say {banned}: {text}"
        );
    }
    assert!(text.contains("その要素だけ"), "{text}");
    assert!(
        text.contains("approve_receipt_drafts"),
        "the approval pointer names the batch tool: {text}"
    );

    // the #20 description carries the no-retry instructions
    let list = call_list(&s.router, &token, 2).await;
    let desc = list["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "create_receipt_drafts")
        .unwrap()["description"]
        .as_str()
        .unwrap();
    assert!(desc.contains("image_index"), "{desc}");
    assert!(desc.contains("必ず"), "index must be mandated: {desc}");
    assert!(desc.contains("呼び直さない"), "{desc}");
    assert!(desc.contains("再アップロードや再送を求めない"), "{desc}");
}

// [covers:mcp-image.file-list-lenient]
#[tokio::test]
async fn receipt_images_shapes_are_classified_leniently() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let image_entry_0 = |store: &str| image_entry(0, payload(store, "2026-10-01", 100));

    // (receipt_images value, expected reason after the call)
    let cases: Vec<(Value, &str)> = vec![
        // a plain array of one file object -> fetched and attached
        (json!([s.img.file("ok1")]), ""),
        // a single object (host folded the array) -> length-1 array
        (s.img.file("ok2"), ""),
        // the chat_upload string some mobile clients send
        (json!("chat_upload_xyz"), "chat_upload"),
        // JSON null
        (Value::Null, "missing_arg"),
        // any other string
        (json!("/mnt/data/x.jpg"), "missing_arg"),
        // a number
        (json!(42), "missing_arg"),
        // an empty array
        (json!([]), "missing_arg"),
    ];
    for (i, (ri, want_reason)) in cases.iter().enumerate() {
        let mut args = json!({"drafts": [image_entry_0(&format!("店{i}"))]});
        if !ri.is_null() || i == 3 {
            // pass null explicitly on the null case; skip the key when absent
            args["receipt_images"] = ri.clone();
        }
        let r = call(
            &s.router,
            &token,
            i as i64 + 1,
            "create_receipt_drafts",
            args,
        )
        .await;
        assert_eq!(r["isError"], json!(false), "case {ri}");
        assert_eq!(
            r["structuredContent"]["rejected"].as_array().unwrap().len(),
            0,
            "no rejection for the shape itself: {ri}"
        );
        let states = draft_image_states(&s.pool).await;
        let (_, status, reason) = states.last().unwrap();
        if want_reason.is_empty() {
            assert_eq!(status, "attached", "case {ri}: {states:?}");
            assert!(reason.is_none());
        } else {
            assert_eq!(status, "unavailable", "case {ri}: {states:?}");
            assert_eq!(reason.as_deref(), Some(*want_reason), "case {ri}");
        }
    }
    // each valid array/object shape fetched exactly once
    assert_eq!(s.img.hits("ok1"), 1);
    assert_eq!(s.img.hits("ok2"), 1);
    assert_eq!(s.img.total_hits(), 2);

    // a mixed array classifies per element (1件版 classify rules)
    let r = call(
        &s.router,
        &token,
        20,
        "create_receipt_drafts",
        json!({
            "receipt_images": [s.img.file("ok1"), "chat_upload_e", null, {"nope": 1}],
            "drafts": [
                image_entry(0, payload("店a", "2026-10-01", 100)),
                image_entry(1, payload("店b", "2026-10-01", 100)),
                image_entry(2, payload("店c", "2026-10-01", 100)),
                image_entry(3, payload("店d", "2026-10-01", 100)),
            ],
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let states = draft_image_states(&s.pool).await;
    let last4: Vec<(String, Option<String>)> = states
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|(_, st, r)| (st.clone(), r.clone()))
        .collect();
    assert_eq!(
        last4,
        vec![
            ("attached".into(), None),
            ("unavailable".into(), Some("chat_upload".into())),
            ("unavailable".into(), Some("missing_arg".into())),
            ("unavailable".into(), Some("missing_arg".into())),
        ],
        "per-element classification"
    );
    assert_eq!(s.img.hits("ok1"), 2);
}

// [covers:mcp-image.decode-gate]
// (integration slice: the permit-hold/deadline-wait unit semantics stay with
// the src unit test added by the implementation; here the observable contract
// is that a late-arriving decode result is never stored.)
#[tokio::test]
async fn late_image_results_are_not_stored_after_the_deadline() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    // "late" answers at 2.5s; the per-image timeout is 2s
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_drafts",
        json!({"receipt_images": [s.img.file("late")], "drafts": [image_entry(0, payload("A", "2026-10-01", 100))]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let states = draft_image_states(&s.pool).await;
    assert_eq!(
        states.last().unwrap(),
        &(
            states.last().unwrap().0,
            "unavailable".into(),
            Some("fetch_timeout".into())
        ),
        "the deadline miss is fetch_timeout"
    );
    assert_eq!(image_rows(&s.pool).await.len(), 0, "nothing stored yet");
    // the late answer (and any decode finishing after the deadline) must not
    // create an image row afterwards
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        image_rows(&s.pool).await.len(),
        0,
        "late completion is discarded"
    );
    let (_, status, _) = draft_image_states(&s.pool).await.last().unwrap().clone();
    assert_eq!(status, "unavailable");
}

// [covers:mcp-image.decode-gate-single-reserved]
#[tokio::test]
async fn single_create_is_not_blocked_by_batch_decoding() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    // a batch of four slow images runs while a single-tool create with a fast
    // image is in flight; the reserved decode slot keeps the single path
    // moving (decode_concurrency 2, batch_decode_concurrency 1)
    let files: Vec<Value> = (1..=4).map(|i| s.img.file(&format!("slow{i}"))).collect();
    let drafts: Vec<Value> = (0..4)
        .map(|i| image_entry(i, payload(&format!("店{i}"), "2026-10-01", 100 + i)))
        .collect();
    let single_file = s.img.file("ok1");
    let (router_b, token_b) = (s.router.clone(), token.clone());
    let batch = async move {
        call(
            &router_b,
            &token_b,
            1,
            "create_receipt_drafts",
            json!({"receipt_images": files, "drafts": drafts}),
        )
        .await
    };
    let (router_s, token_s) = (s.router.clone(), token.clone());
    let single = async move {
        call(
            &router_s,
            &token_s,
            2,
            "create_receipt_draft",
            json!({
                "input_kind": "image",
                "receipt_image": single_file,
                "payload": payload("単発", "2026-10-01", 999),
            }),
        )
        .await
    };
    let (b, single_r) = futures_util::join!(batch, single);
    assert_eq!(b["isError"], json!(false));
    assert_eq!(
        single_r["isError"],
        json!(false),
        "the single path is not starved"
    );
    let text = text_of(&single_r);
    assert!(
        text.contains("画像を保存しました"),
        "single create attached: {text}"
    );
    // both the batch and the single create stored their images
    assert_eq!(image_rows(&s.pool).await.len(), 5);
}

// ---------------------------------------------------------------------------
// single-tool parity after the draft_intake extraction (regression: these
// must keep passing before and after TASK-18)

// [covers:mcp-draft.single-create-parity]
#[tokio::test]
async fn single_create_keeps_current_behaviour() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;

    // healthy image: attached + image row + _meta url
    let r = call(
        &s.router,
        &token,
        1,
        "create_receipt_draft",
        json!({
            "input_kind": "image",
            "receipt_image": s.img.file("ok1"),
            "payload": payload("イオン", "2026-10-01", 198),
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "draft");
    assert_eq!(sc["draft"]["image"]["status"], "attached");
    assert!(text_of(&r).contains("画像を保存しました"));
    let id = sc["draft"]["draft_id"].as_i64().unwrap();
    assert!(r["_meta"]["images"]["draft_image"]["url"].is_string());
    let (status, reason, image_id): (String, Option<String>, Option<i64>) = sqlx::query_as(
        "SELECT image_status, image_unavailable_reason, image_id FROM drafts WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), reason, image_id.is_some()),
        ("attached", None, true)
    );

    // chat_upload string: image-less, still isError=false (P2)
    let r = call(
        &s.router,
        &token,
        2,
        "create_receipt_draft",
        json!({
            "input_kind": "image",
            "receipt_image": "chat_upload_abc",
            "payload": payload("イオン", "2026-10-01", 198),
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert!(text_of(&r).contains("画像なしで保存しました"));
    let states = draft_image_states(&s.pool).await;
    assert_eq!(states.last().unwrap().2.as_deref(), Some("chat_upload"));

    // missing receipt_image: image-less, isError=false
    let r = call(
        &s.router,
        &token,
        3,
        "create_receipt_draft",
        json!({"input_kind": "image", "payload": payload("イオン", "2026-10-01", 198)}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let states = draft_image_states(&s.pool).await;
    assert_eq!(states.last().unwrap().2.as_deref(), Some("missing_arg"));

    // manual + receipt_image: the input mix-up error
    let r = call(
        &s.router,
        &token,
        4,
        "create_receipt_draft",
        json!({
            "input_kind": "manual",
            "receipt_image": s.img.file("ok2"),
            "payload": payload("手動", "2026-10-01", 100),
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(text_of(&r).contains("画像"), "mix-up wording");

    // payload violation: itemised input error
    let r = call(
        &s.router,
        &token,
        5,
        "create_receipt_draft",
        json!({
            "input_kind": "manual",
            "payload": {"purchased_on": "2026-10-01",
                "items": [{"line_no": 1, "name": "a", "amount": 10}, {"line_no": 1, "name": "b", "amount": 20}]},
        }),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let text = text_of(&r);
    assert!(text.contains("入力エラー"), "{text}");
    assert!(text.contains("line_no"), "{text}");
}

// [covers:mcp-draft.single-approve-parity]
#[tokio::test]
async fn single_approve_keeps_current_behaviour() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let ok_250 = r#"{"store_name":"イオン","purchased_on":"2026-10-01","total_amount":250,"items":[{"line_no":1,"name":"牛乳","amount":198}]}"#;

    let d1 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let d3 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 2).await;
    let d4 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let d5 = insert_pending_draft(&s.pool, s.owner, s.user, ok_250, 1).await;
    sqlx::query(
        "UPDATE drafts SET status = 'discarded', closed_at = 0, payload_json = NULL WHERE id = ?",
    )
    .bind(d4)
    .execute(&s.pool)
    .await
    .unwrap();

    // success
    let r = call(
        &s.router,
        &token,
        1,
        "approve_receipt_draft",
        json!({"draft_id": d1, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let receipt_id = sc["receipt_id"].as_i64().unwrap();
    assert_eq!(sc["idempotent_hit"], json!(false));
    assert!(text_of(&r).contains("登録しました"));

    // resend: idempotent success
    let r = call(
        &s.router,
        &token,
        2,
        "approve_receipt_draft",
        json!({"draft_id": d1, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert_eq!(r["structuredContent"]["idempotent_hit"], json!(true));
    assert_eq!(r["structuredContent"]["receipt_id"], json!(receipt_id));
    assert!(text_of(&r).contains("既に"));

    // stale revision: error + the latest draft
    let r = call(
        &s.router,
        &token,
        3,
        "approve_receipt_draft",
        json!({"draft_id": d3, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    let text = text_of(&r);
    assert!(text.contains("rev 2"), "{text}");
    assert_eq!(r["structuredContent"]["draft"]["revision"], json!(2));

    // closed draft: conflict wording
    let r = call(
        &s.router,
        &token,
        4,
        "approve_receipt_draft",
        json!({"draft_id": d4, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(
        text_of(&r).contains("破棄済み"),
        "conflict wording: {}",
        text_of(&r)
    );

    // total mismatch warning
    let r = call(
        &s.router,
        &token,
        5,
        "approve_receipt_draft",
        json!({"draft_id": d5, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    assert!(
        warn_codes(&r["structuredContent"]).contains(&"total_mismatch".to_string()),
        "{:?}",
        warn_codes(&r["structuredContent"])
    );

    // viewer role and a foreign draft keep their current outcomes
    let d6 = insert_pending_draft(&s.pool, s.viewer_ledger, s.user, OK_PAYLOAD, 1).await;
    let viewer_token = s
        .token(Some(s.viewer_ledger), "ledger.read ledger.write")
        .await;
    let r = call(
        &s.router,
        &viewer_token,
        6,
        "approve_receipt_draft",
        json!({"draft_id": d6, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(text_of(&r).contains("閲覧のみ"), "{}", text_of(&r));

    let other = common::auth::create_user_direct(&s.pool, "Other", None).await;
    let d7 = insert_pending_draft(&s.pool, s.owner, other, OK_PAYLOAD, 1).await;
    let r = call(
        &s.router,
        &token,
        7,
        "approve_receipt_draft",
        json!({"draft_id": d7, "revision": 1}),
    )
    .await;
    assert_eq!(r["isError"], json!(true));
    assert!(text_of(&r).contains("見つかりません"), "{}", text_of(&r));
}

// ---------------------------------------------------------------------------
// #21 approve_receipt_drafts

// [covers:mcp-approve-batch.per-item-results]
#[tokio::test]
async fn approve_batch_returns_per_item_results() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let ok_250 = r#"{"store_name":"イオン","purchased_on":"2026-10-01","total_amount":250,"items":[{"line_no":1,"name":"牛乳","amount":198}]}"#;
    let a1 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let a2 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let a3 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 2).await;
    let a4 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let a5 = insert_pending_draft(&s.pool, s.owner, s.user, ok_250, 1).await;
    sqlx::query(
        "UPDATE drafts SET status = 'discarded', closed_at = 0, payload_json = NULL WHERE id = ?",
    )
    .bind(a4)
    .execute(&s.pool)
    .await
    .unwrap();

    let r = call(
        &s.router,
        &token,
        1,
        "approve_receipt_drafts",
        json!({"items": [
            {"draft_id": a1, "revision": 1},
            {"draft_id": a2, "revision": 1},
            {"draft_id": a3, "revision": 1},
            {"draft_id": a4, "revision": 1},
            {"draft_id": 999999, "revision": 1},
            {"draft_id": a5, "revision": 1},
        ]}),
    )
    .await;
    // two approvals (plus the mismatch one) succeeded: not an error
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    assert_eq!(sc["view"], "draft_batch");
    assert_eq!(sc["batch_id"], json!(null));
    let results = sc["results"].as_array().unwrap();
    let outcome_of = |id: i64| {
        results.iter().find(|x| x["draft_id"] == id).unwrap()["outcome"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert_eq!(outcome_of(a1), "approved");
    assert_eq!(outcome_of(a2), "approved");
    assert_eq!(outcome_of(a3), "stale_revision");
    assert_eq!(outcome_of(a4), "conflict");
    assert_eq!(outcome_of(999999), "not_found");
    assert_eq!(outcome_of(a5), "approved");
    for id in [a1, a2, a5] {
        let res = results.iter().find(|x| x["draft_id"] == id).unwrap();
        assert!(res["receipt_id"].is_i64(), "{}", res);
    }
    // per-item tx: the stale / conflict / missing entries do not roll back
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipts")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(receipts, 3, "a1, a2 and a5 approved");
    // drafts carries the post-processing state (stale one at its latest rev)
    let drafts = sc["drafts"].as_array().unwrap();
    let d3 = drafts.iter().find(|d| d["draft_id"] == a3).unwrap();
    assert_eq!(d3["revision"], json!(2));
    assert_eq!(d3["status"], "pending");
    // the total mismatch warning is per draft with detail.draft_id
    let warnings = sc["warnings"].as_array().unwrap();
    let tm: Vec<&Value> = warnings
        .iter()
        .filter(|w| w["code"] == "total_mismatch")
        .collect();
    assert_eq!(tm.len(), 1);
    assert_eq!(tm[0]["detail"]["draft_id"], json!(a5));

    // resend a1: idempotent, still not an error
    let r = call(
        &s.router,
        &token,
        2,
        "approve_receipt_drafts",
        json!({"items": [{"draft_id": a1, "revision": 1}]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let results = r["structuredContent"]["results"].as_array().unwrap();
    assert_eq!(results[0]["outcome"], "idempotent");
    assert!(results[0]["receipt_id"].is_i64());
}

// [covers:mcp-approve-batch.authz-and-not-found-uniform]
#[tokio::test]
async fn approve_batch_hides_and_separates_ledgers() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let own = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let other = common::auth::create_user_direct(&s.pool, "Other", None).await;
    let foreign = insert_pending_draft(&s.pool, s.owner, other, OK_PAYLOAD, 1).await;

    // foreign draft and a missing id share the same not_found wording
    let r = call(
        &s.router,
        &token,
        1,
        "approve_receipt_drafts",
        json!({"items": [
            {"draft_id": foreign, "revision": 1},
            {"draft_id": 987654, "revision": 1},
            {"draft_id": own, "revision": 1},
        ]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false), "own draft still approves");
    let results = r["structuredContent"]["results"].as_array().unwrap();
    let msg_of = |id: Value| {
        results.iter().find(|x| x["draft_id"] == id).unwrap()["message"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };
    let outcomes: Vec<String> = results
        .iter()
        .map(|x| x["outcome"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(outcomes, ["not_found", "not_found", "approved"]);
    assert_eq!(
        msg_of(json!(foreign)),
        msg_of(json!(987654)),
        "existence is hidden with one wording"
    );

    // viewer role: forbidden per item
    let viewer_draft = insert_pending_draft(&s.pool, s.viewer_ledger, s.user, OK_PAYLOAD, 1).await;
    let viewer_token = s
        .token(Some(s.viewer_ledger), "ledger.read ledger.write")
        .await;
    let r = call(
        &s.router,
        &viewer_token,
        2,
        "approve_receipt_drafts",
        json!({"items": [{"draft_id": viewer_draft, "revision": 1}]}),
    )
    .await;
    assert_eq!(r["isError"], json!(true), "nothing succeeded");
    assert_eq!(r["structuredContent"]["results"][0]["outcome"], "forbidden");

    // two ledgers in one call: only the first item's ledger is approved, the
    // rest are invalid with the split-approval guidance
    let second_ledger: i64 = sqlx::query_scalar(
        "INSERT INTO ledgers (name, created_at, updated_at) VALUES ('second', 0, 0) RETURNING id",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    common::insert_member(&s.pool, second_ledger, s.user, "owner").await;
    let l1 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let l2 = insert_pending_draft(&s.pool, second_ledger, s.user, OK_PAYLOAD, 1).await;
    let r = call(
        &s.router,
        &token,
        3,
        "approve_receipt_drafts",
        json!({"items": [{"draft_id": l1, "revision": 1}, {"draft_id": l2, "revision": 1}]}),
    )
    .await;
    let results = r["structuredContent"]["results"].as_array().unwrap();
    assert_eq!(results[0]["outcome"], "approved");
    assert_eq!(results[1]["outcome"], "invalid");
    assert!(
        results[1]["message"]
            .as_str()
            .unwrap_or("")
            .contains("家計簿"),
        "split guidance: {}",
        results[1]["message"]
    );
    let l2_status: String = sqlx::query_scalar("SELECT status FROM drafts WHERE id = ?")
        .bind(l2)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(l2_status, "pending", "the other ledger stays pending");
}

// [covers:mcp-approve-batch.no-active-ledger]
#[tokio::test]
async fn approve_batch_works_without_an_active_ledger() {
    let s = setup().await;
    let token = s.token(None, "ledger.read ledger.write").await;
    let d1 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let d2 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let r = call(
        &s.router,
        &token,
        1,
        "approve_receipt_drafts",
        json!({"items": [{"draft_id": d1, "revision": 1}, {"draft_id": d2, "revision": 1}]}),
    )
    .await;
    assert_eq!(r["isError"], json!(false));
    let sc = &r["structuredContent"];
    let outcomes: Vec<&str> = sc["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["outcome"].as_str().unwrap())
        .collect();
    assert_eq!(outcomes, ["approved", "approved"]);
    assert_eq!(sc["ledger"]["id"], json!(s.owner), "resolved via draft_id");
    assert_eq!(sc["batch_id"], json!(null));
}

// [covers:mcp-approve-batch.limits]
#[tokio::test]
async fn approve_batch_validates_the_whole_call() {
    let s = setup().await;
    let token = s.token(Some(s.owner), "ledger.read ledger.write").await;
    let d1 = insert_pending_draft(&s.pool, s.owner, s.user, OK_PAYLOAD, 1).await;
    let many: Vec<Value> = (1..=21)
        .map(|i| json!({"draft_id": i, "revision": 1}))
        .collect();
    for (id, args) in [
        (1, json!({"items": []})),
        (2, json!({"items": many})),
        (
            3,
            json!({"items": [{"draft_id": d1, "revision": 1}, {"draft_id": d1, "revision": 1}]}),
        ),
        (4, json!({"items": [{"draft_id": "12", "revision": 1}]})),
    ] {
        let r = call(
            &s.router,
            &token,
            id,
            "approve_receipt_drafts",
            args.clone(),
        )
        .await;
        assert_eq!(
            r["isError"],
            json!(true),
            "must be a whole-call error: {args}"
        );
        let sc = &r["structuredContent"];
        let drafts_empty = match sc["drafts"].as_array() {
            None => true,
            Some(a) => a.is_empty(),
        };
        assert!(drafts_empty, "no drafts in the validation error");
    }
    let drafts: i64 = sqlx::query_scalar("SELECT count(*) FROM drafts WHERE status = 'pending'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(drafts, 1, "nothing was processed");
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM receipts")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(receipts, 0);
}
