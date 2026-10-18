//! Auxiliary-data REST API for the web screens (spec_mcp-tools.md 12: the
//! axum adapter over the same `domain::*` functions the MCP tools use).
//! Contract: `frontend/src/web/api/data/http.ts` (paths, methods, bodies)
//! and `./types.ts` (response DTOs, `ApiError` codes).

use axum::Json;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::app::AppState;
use crate::auth::api::AuthApiState;
use crate::auth::ledger::LedgerRole;
use crate::auth::session::ValidSession;
use crate::auth::session::now_ms;
use crate::domain::actor::Actor;
use crate::domain::catalog::{self, CatKind, CatalogError, ManageCategory};
use crate::domain::labels::{self, LABEL_COLORS, LabelColor, LabelError, SkipReason};
use crate::domain::receipts::{self as dr, DeleteOutcome, ReceiptError, ReceiptPatch};
use crate::domain::search::{self, SearchQuery};
use crate::domain::stats::Range;

/// All `/api/ledgers/*` data routes. Same guards as the auth API: the
/// Origin / JSON guard first, then the rate limit guard (spec_auth.md 3-1,
/// 10-1).
pub fn routes(state: AuthApiState) -> Router {
    Router::new()
        .route("/api/ledgers/{ledger_id}/catalog", get(get_catalog))
        .route("/api/ledgers/{ledger_id}/categories", post(manage_category))
        .route("/api/ledgers/{ledger_id}/stores", get(list_stores))
        .route(
            "/api/ledgers/{ledger_id}/stores/{store_id}",
            axum::routing::patch(update_store),
        )
        .route(
            "/api/ledgers/{ledger_id}/stores/{store_id}/merge",
            post(merge_stores),
        )
        .route("/api/ledgers/{ledger_id}/stats", get(get_stats))
        .route("/api/ledgers/{ledger_id}/labels", get(get_labels))
        .route(
            "/api/ledgers/{ledger_id}/labels/{color}",
            axum::routing::patch(update_label_title),
        )
        .route("/api/ledgers/{ledger_id}/items", get(list_items))
        .route("/api/ledgers/{ledger_id}/receipts", get(list_receipts))
        .route(
            "/api/ledgers/{ledger_id}/receipts/{receipt_id}/labels",
            post(post_receipt_labels),
        )
        .route(
            "/api/ledgers/{ledger_id}/receipts/{receipt_id}",
            get(get_receipt).patch(update_receipt),
        )
        .route(
            "/api/ledgers/{ledger_id}/receipts/{receipt_id}/delete",
            post(delete_receipt),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::api::api_guard,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::ratelimit::api_limit_guard,
        ))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// errors (ApiError code contract, frontend/src/web/composables/format.ts)

pub struct DataError {
    status: StatusCode,
    code: &'static str,
}

impl DataError {
    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
        }
    }
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
        }
    }
    fn viewer_only() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "viewer_only",
        }
    }
    fn invalid() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
        }
    }
    fn code(status: StatusCode, code: &'static str) -> Self {
        Self { status, code }
    }
    fn internal(err: anyhow::Error) -> Self {
        tracing::error!(error = %err, "web data api failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
        }
    }
    fn sqlx(err: sqlx::Error) -> Self {
        Self::internal(err.into())
    }

    fn catalog(e: CatalogError) -> Self {
        match e {
            CatalogError::NotFound => Self::not_found(),
            CatalogError::NameConflict(_) => Self::code(StatusCode::CONFLICT, "name_conflict"),
            CatalogError::SameStore => Self::code(StatusCode::BAD_REQUEST, "same_store"),
            CatalogError::Invalid(_) => Self::invalid(),
            CatalogError::Db(e) => Self::sqlx(e),
        }
    }

    fn receipt(e: ReceiptError) -> Self {
        match e {
            ReceiptError::NotFound => Self::not_found(),
            ReceiptError::Stale(_) => Self::code(StatusCode::CONFLICT, "stale_revision"),
            ReceiptError::Deleted(_) => Self::code(StatusCode::CONFLICT, "deleted"),
            ReceiptError::Invalid(_) => Self::invalid(),
            ReceiptError::Db(e) => Self::sqlx(e),
        }
    }

    fn label(e: LabelError) -> Self {
        match e {
            LabelError::Invalid(_) => Self::invalid(),
            LabelError::Forbidden => Self::viewer_only(),
            LabelError::NotFound => Self::not_found(),
            LabelError::Deleted => Self::code(StatusCode::CONFLICT, "deleted"),
            LabelError::Db(e) => Self::sqlx(e),
        }
    }
}

impl IntoResponse for DataError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.code }))).into_response()
    }
}

// ---------------------------------------------------------------------------
// session + ledger resolution

/// The session of the request (401 without / on expiry).
async fn session(state: &AuthApiState, headers: &HeaderMap) -> Result<ValidSession, DataError> {
    crate::auth::api::require_session(state, headers)
        .await
        .map(|(s, _)| s)
        .map_err(|_| DataError::unauthorized())
}

/// Membership-checked ledger (missing membership and missing ledger are the
/// same 404 — no cross-ledger existence leaks, spec_mcp-tools.md 4).
async fn member_ledger(
    db: &SqlitePool,
    ledger_id: i64,
    user_id: i64,
) -> Result<LedgerRole, DataError> {
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM ledger_members WHERE ledger_id = ? AND user_id = ?")
            .bind(ledger_id)
            .bind(user_id)
            .fetch_optional(db)
            .await
            .map_err(DataError::sqlx)?;
    role.as_deref()
        .and_then(LedgerRole::parse)
        .ok_or_else(DataError::not_found)
}

/// editor or above for writes (spec 4: 「この家計簿は閲覧のみです」).
fn require_writer(role: LedgerRole) -> Result<(), DataError> {
    if role >= LedgerRole::Editor {
        Ok(())
    } else {
        Err(DataError::viewer_only())
    }
}

fn actor(s: &ValidSession) -> Actor {
    Actor::web(s.user_id)
}

/// A nullable-string field: `None` = absent, `Some(None)` = JSON null,
/// `Some(Some(s))` = a string; anything else is an input error.
fn nullable_string(v: &Option<Value>) -> Result<Option<Option<String>>, DataError> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(DataError::invalid()),
    }
}

// ---------------------------------------------------------------------------
// catalog (get_catalog / manage_category)

#[derive(Debug, Deserialize)]
pub struct CatalogQuery {
    #[serde(default)]
    include_archived: Option<String>,
}

/// Both category trees, `archived` / `children` keys always present
/// (frontend `CategoryNode`).
pub async fn get_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Query(q): Query<CatalogQuery>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let include_archived = matches!(q.include_archived.as_deref(), Some("1" | "true"));
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let item = catalog::category_tree(&mut conn, CatKind::Item, ledger_id, include_archived)
        .await
        .map_err(DataError::sqlx)?;
    let store = catalog::category_tree(&mut conn, CatKind::Store, ledger_id, include_archived)
        .await
        .map_err(DataError::sqlx)?;
    Ok(Json(json!({
        "item_categories": shape_tree(item),
        "store_categories": shape_tree(store),
    })))
}

/// Fill in `archived: false` and `children: []` the domain tree omits when
/// not including archived entries / on sub-categories.
fn shape_tree(tree: Vec<Value>) -> Vec<Value> {
    tree.into_iter()
        .map(|mut top| {
            if let Some(o) = top.as_object_mut() {
                o.entry("archived").or_insert(json!(false));
                let children = o.entry("children").or_insert(Value::Array(Vec::new()));
                if let Some(arr) = children.as_array_mut() {
                    for child in arr {
                        if let Some(co) = child.as_object_mut() {
                            co.entry("archived").or_insert(json!(false));
                            co.entry("children").or_insert(Value::Array(Vec::new()));
                        }
                    }
                }
            }
            top
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct ManageCategoryBody {
    kind: String,
    action: String,
    category: String,
    #[serde(default)]
    new_name: Option<String>,
    #[serde(default)]
    new_parent: Option<Value>,
}

pub async fn manage_category(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Json(body): Json<ManageCategoryBody>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    let kind = CatKind::parse(&body.kind).ok_or_else(DataError::invalid)?;
    let new_parent = nullable_string(&body.new_parent)?;
    let req = ManageCategory {
        kind,
        action: &body.action,
        category: &body.category,
        new_name: body.new_name.as_deref(),
        new_parent: new_parent.as_ref().map(|o| o.as_deref()),
    };
    let change = catalog::manage_category(
        &state.db,
        ledger_id,
        &actor(&s),
        &req,
        state.tools.limits.max_name_chars,
        now_ms(),
    )
    .await
    .map_err(DataError::catalog)?;
    Ok(Json(json!({
        "category": { "id": change.id, "path": change.path, "archived": change.archived },
        "created": change.created,
    })))
}

// ---------------------------------------------------------------------------
// stores

#[derive(Debug, Deserialize)]
pub struct StoresQuery {
    #[serde(default)]
    query: Option<String>,
}

pub async fn list_stores(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Query(q): Query<StoresQuery>,
) -> Result<Json<Vec<Value>>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let stores = catalog::search_stores(
        &mut conn,
        ledger_id,
        q.query.as_deref().unwrap_or(""),
        state.tools.limits.catalog_max_stores,
    )
    .await
    .map_err(DataError::sqlx)?;
    Ok(Json(stores))
}

#[derive(Debug, Deserialize)]
pub struct UpdateStoreBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    category: Option<Value>,
}

pub async fn update_store(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, store_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateStoreBody>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    if body.name.is_none() && body.category.is_none() {
        return Err(DataError::invalid());
    }
    let category = nullable_string(&body.category)?;
    let out = catalog::manage_store(
        &state.db,
        ledger_id,
        &actor(&s),
        store_id,
        body.name.as_deref(),
        category.as_ref().map(|o| o.as_deref()),
        now_ms(),
    )
    .await
    .map_err(DataError::catalog)?;
    Ok(Json(json!({
        "store": { "store_id": out.store_id, "name": out.name, "category": out.category },
        "before": { "name": out.before_name, "category": out.before_category },
    })))
}

#[derive(Debug, Deserialize)]
pub struct MergeBody {
    into_store_id: i64,
}

pub async fn merge_stores(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, source_id)): Path<(i64, i64)>,
    Json(body): Json<MergeBody>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    let out = catalog::merge_stores(
        &state.db,
        ledger_id,
        &actor(&s),
        source_id,
        body.into_store_id,
        now_ms(),
    )
    .await
    .map_err(DataError::catalog)?;
    Ok(Json(json!({
        "store": out.store,
        "merged_from": { "store_id": out.merged_from_id, "name": out.merged_from_name },
        "moved_receipts": out.moved_receipts,
    })))
}

// ---------------------------------------------------------------------------
// labels (TASK-17, spec_mcp-tools.md 12)

/// Comma-separated `label_colors` query param -> palette colors in
/// definition order, deduplicated (mirrors the MCP schema's uniqueItems;
/// `red,red` is just `red` in the echo and notes). 400 on an unknown key.
/// Absent / empty = no filter.
fn parse_label_colors(v: Option<&str>) -> Result<Vec<LabelColor>, DataError> {
    let Some(s) = v.filter(|s| !s.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let mut asked: Vec<LabelColor> = Vec::new();
    for p in s.split(',') {
        let c = LabelColor::parse(p.trim()).ok_or_else(DataError::invalid)?;
        if !asked.contains(&c) {
            asked.push(c);
        }
    }
    Ok(LABEL_COLORS
        .iter()
        .copied()
        .filter(|c| asked.contains(c))
        .collect())
}

/// GET /api/ledgers/{l}/labels: the five definitions in definition order
/// (title null = color only). Any member (viewer included) may read.
pub async fn get_labels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let labels = labels::list_labels(&mut conn, ledger_id)
        .await
        .map_err(DataError::sqlx)?;
    Ok(Json(json!({ "labels": labels })))
}

/// PATCH /api/ledgers/{l}/labels/{color}: set / clear a definition title
/// (editor or above; MCP has no title tool by design).
pub async fn update_label_title(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, color)): Path<(i64, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    let color = LabelColor::parse(&color).ok_or_else(DataError::invalid)?;
    let title = match body.get("title") {
        None => return Err(DataError::invalid()),
        Some(Value::Null) => None,
        Some(Value::String(t)) => Some(t.as_str()),
        Some(_) => return Err(DataError::invalid()),
    };
    let change = labels::set_title(
        &state.db,
        ledger_id,
        role,
        &actor(&s),
        color,
        title,
        state.tools.limits.max_label_title_chars,
        now_ms(),
    )
    .await
    .map_err(DataError::label)?;
    Ok(Json(
        json!({ "label": change.label, "changed": change.changed }),
    ))
}

/// POST /api/ledgers/{l}/receipts/{r}/labels: diff add / remove (editor or
/// above). Idempotent; `receipts.revision` / `updated_at` stay untouched.
/// Another ledger's or missing receipt is the same 404 as the rest of the
/// API; a soft-deleted receipt is 409 `deleted` (labels are kept and come
/// back on restore).
pub async fn post_receipt_labels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, receipt_id)): Path<(i64, i64)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    let colors = |v: Option<&Value>| -> Result<Vec<LabelColor>, DataError> {
        match v {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(a)) => a
                .iter()
                .map(|c| {
                    c.as_str()
                        .and_then(LabelColor::parse)
                        .ok_or_else(DataError::invalid)
                })
                .collect(),
            Some(_) => Err(DataError::invalid()),
        }
    };
    let add = colors(body.get("add"))?;
    let remove = colors(body.get("remove"))?;
    let out = labels::apply(
        &state.db,
        ledger_id,
        role,
        &actor(&s),
        &[receipt_id],
        &add,
        &remove,
        now_ms(),
    )
    .await
    .map_err(DataError::label)?;
    if let Some((_, reason)) = out.skipped.first() {
        return Err(match reason {
            SkipReason::NotFound => DataError::not_found(),
            SkipReason::Deleted => DataError::code(StatusCode::CONFLICT, "deleted"),
        });
    }
    let (id, labels) = out
        .receipts
        .first()
        .cloned()
        .ok_or_else(DataError::not_found)?;
    Ok(Json(json!({ "receipt_id": id, "labels": labels })))
}

// ---------------------------------------------------------------------------
// stats (dashboard / analysis screens)

#[derive(Debug, Deserialize)]
pub struct StatsQuery {
    #[serde(default)]
    report: Option<String>,
    #[serde(default)]
    month: Option<String>,
    #[serde(default)]
    year: Option<i32>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    store: Option<String>,
    #[serde(default)]
    store_category: Option<String>,
    /// Web-only exact store match (the MCP filters have no store_id)
    #[serde(default)]
    store_id: Option<i64>,
    #[serde(default)]
    item_query: Option<String>,
    /// Comma-separated palette keys (OR), e.g. `label_colors=red,blue`
    #[serde(default)]
    label_colors: Option<String>,
}

/// Read-only aggregation for the web screens: the same
/// `domain::stats::summarize` the MCP summarize_spending tool uses
/// (spec_mcp-tools.md 10, 12). `report` defaults to monthly_overview; the
/// period is one of `month=YYYY-MM` / `year=YYYY` / `from&to`, default the
/// report's default period (JST). Any ledger member (viewer included) may
/// read.
pub async fn get_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Query(q): Query<StatsQuery>,
) -> Result<Json<Value>, DataError> {
    use crate::domain::stats::{self, Filters, Period};
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let report = q.report.unwrap_or_else(|| "monthly_overview".into());
    let period = match (q.month, q.year, q.from, q.to) {
        (Some(month), None, None, None) => Period::Month { month },
        (None, Some(year), None, None) => Period::Year { year },
        (None, None, Some(from), Some(to)) => Period::Range { from, to },
        (None, None, None, None) => stats::default_period(&report),
        _ => return Err(DataError::invalid()),
    };
    let range = stats::resolve_period(&period, crate::domain::util::jst_date(now_ms()))
        .map_err(|_| DataError::invalid())?;
    let label_colors = parse_label_colors(q.label_colors.as_deref())?;
    let filters = Filters {
        category: q.category,
        store: q.store,
        store_category: q.store_category,
        store_id: q.store_id,
        item_query: q.item_query,
        label_colors: (!label_colors.is_empty()).then_some(label_colors),
    };
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let (res, meta) = stats::summarize(
        &mut conn,
        ledger_id,
        &report,
        &range,
        &filters,
        state.tools.limits.stats_max_rows,
    )
    .await
    .map_err(|e| match e {
        stats::FilterError::Invalid(_) => DataError::invalid(),
        stats::FilterError::Db(e) => DataError::sqlx(e),
    })?;
    let mut v = serde_json::to_value(res).map_err(|e| DataError::internal(e.into()))?;
    if let Some(days) = meta.get("daily_cumulative") {
        v["daily_cumulative"] = days.clone();
    }
    Ok(Json(v))
}

// ---------------------------------------------------------------------------
// receipts

#[derive(Debug, Deserialize)]
pub struct ReceiptListQuery {
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    store: Option<String>,
    /// Cross-field search term for the /search receipts tab: item name OR
    /// store name (spec_mcp-tools.md 12)
    #[serde(default)]
    q: Option<String>,
    /// Exact store filter (web only; `store` stays the partial match)
    #[serde(default)]
    store_id: Option<i64>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    item_query: Option<String>,
    #[serde(default)]
    include_deleted: Option<bool>,
    /// Comma-separated palette keys (OR), e.g. `label_colors=red,blue`
    #[serde(default)]
    label_colors: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    cursor: Option<String>,
}

pub async fn list_receipts(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Query(q): Query<ReceiptListQuery>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let range = match (&q.from, &q.to) {
        (Some(from), Some(to)) => Some(Range::custom(
            crate::domain::util::parse_date(from).ok_or_else(DataError::invalid)?,
            crate::domain::util::parse_date(to).ok_or_else(DataError::invalid)?,
        )),
        (None, None) => None,
        _ => return Err(DataError::invalid()),
    };
    let cursor = match &q.cursor {
        Some(c) => Some(search::decode_cursor(c).ok_or_else(DataError::invalid)?),
        None => None,
    };
    let lim = &state.tools.limits;
    let limit = q
        .limit
        .unwrap_or(lim.search_default_limit)
        .clamp(1, lim.search_max_limit);
    let query = SearchQuery {
        store: q.store,
        text: q.q,
        store_id: q.store_id,
        item_query: q.item_query,
        category: q.category,
        payment_method: None,
        label_colors: parse_label_colors(q.label_colors.as_deref())?,
        include_deleted: q.include_deleted.unwrap_or(false),
    };
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let res = search::search_receipts(&mut conn, ledger_id, range.as_ref(), &query, limit, cursor)
        .await
        .map_err(|e| match e {
            crate::domain::stats::FilterError::Invalid(_) => DataError::invalid(),
            crate::domain::stats::FilterError::Db(e) => DataError::sqlx(e),
        })?;
    Ok(Json(json!({
        "total_count": res.total_count,
        "sum_amount": res.sum_amount,
        "receipts": res.rows,
        "next_cursor": res.next_cursor,
    })))
}

#[derive(Debug, Deserialize)]
pub struct ItemListQuery {
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    to: Option<String>,
    /// item-name query (the receipts endpoint's q is the cross-field one)
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    store_id: Option<i64>,
    #[serde(default)]
    include_deleted: Option<bool>,
    /// Comma-separated palette keys (OR), e.g. `label_colors=red,blue`
    #[serde(default)]
    label_colors: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    cursor: Option<String>,
}

/// GET /api/ledgers/{l}/items: the item-level list behind the /search item
/// tab — the same domain::search::search_items the MCP search_receipts
/// mode:"items" uses (design_browsing.md 2-3 A3). q matches item names
/// only. Any ledger member (viewer included) may read.
pub async fn list_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(ledger_id): Path<i64>,
    Query(q): Query<ItemListQuery>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let range = match (&q.from, &q.to) {
        (Some(from), Some(to)) => Some(Range::custom(
            crate::domain::util::parse_date(from).ok_or_else(DataError::invalid)?,
            crate::domain::util::parse_date(to).ok_or_else(DataError::invalid)?,
        )),
        (None, None) => None,
        _ => return Err(DataError::invalid()),
    };
    let cursor = match &q.cursor {
        Some(c) => Some(search::decode_cursor(c).ok_or_else(DataError::invalid)?),
        None => None,
    };
    let lim = &state.tools.limits;
    let limit = q
        .limit
        .unwrap_or(lim.search_default_limit)
        .clamp(1, lim.search_max_limit);
    let query = SearchQuery {
        store: None,
        text: None,
        store_id: q.store_id,
        item_query: q.q,
        category: q.category,
        payment_method: None,
        label_colors: parse_label_colors(q.label_colors.as_deref())?,
        include_deleted: q.include_deleted.unwrap_or(false),
    };
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let res = search::search_items(&mut conn, ledger_id, range.as_ref(), &query, limit, cursor)
        .await
        .map_err(|e| match e {
            crate::domain::stats::FilterError::Invalid(_) => DataError::invalid(),
            crate::domain::stats::FilterError::Db(e) => DataError::sqlx(e),
        })?;
    Ok(Json(json!({
        "total_count": res.total_count,
        "sum_amount": res.sum_amount,
        "items": res.rows,
        "next_cursor": res.next_cursor,
    })))
}

pub async fn get_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, receipt_id)): Path<(i64, i64)>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    member_ledger(&state.db, ledger_id, s.user_id).await?;
    let mut conn = state.db.acquire().await.map_err(DataError::sqlx)?;
    let view = dr::receipt_view(&mut conn, receipt_id, ledger_id)
        .await
        .map_err(DataError::sqlx)?
        .ok_or_else(DataError::not_found)?;
    drop(conn);
    // Fresh short-lived image token URL for the detail screen (spec 11-5;
    // issue_image_url shares the MCP path, /media rechecks per request).
    // receipt_image_id skips logically deleted receipts, whose /media URL
    // would 404 anyway.
    let image_url = match dr::receipt_image_id(&state.db, receipt_id, ledger_id)
        .await
        .map_err(DataError::sqlx)?
    {
        Some(img) => crate::domain::images::issue_image_url(
            &state.db,
            &state.auth.public_origin,
            img,
            s.user_id,
            state.tools.image.access_token_ttl_secs,
            now_ms(),
        )
        .await
        .map_err(DataError::internal)?
        .and_then(|u| serde_json::to_value(u).ok()),
        None => None,
    };
    let mut body = serde_json::to_value(&view).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut body {
        map.insert("image_url".into(), image_url.unwrap_or(Value::Null));
    }
    Ok(Json(body))
}

#[derive(Debug, Deserialize)]
pub struct UpdateReceiptBody {
    revision: i64,
    #[serde(default)]
    set: Option<Map<String, Value>>,
    #[serde(default)]
    upsert_items: Option<Vec<Map<String, Value>>>,
    #[serde(default)]
    delete_item_ids: Option<Vec<i64>>,
}

pub async fn update_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, receipt_id)): Path<(i64, i64)>,
    Json(body): Json<UpdateReceiptBody>,
) -> Result<Json<Value>, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    let patch = ReceiptPatch {
        set: body.set,
        upsert_items: body.upsert_items,
        delete_item_ids: body.delete_item_ids,
    };
    let out = dr::update_receipt(
        &state.db,
        ledger_id,
        &actor(&s),
        receipt_id,
        body.revision,
        &patch,
        &state.tools.limits,
        now_ms(),
    )
    .await
    .map_err(DataError::receipt)?;
    let view = serde_json::to_value(&out.view).unwrap_or(Value::Null);
    Ok(Json(json!({ "receipt": view, "changed": out.changed })))
}

#[derive(Debug, Deserialize)]
pub struct DeleteReceiptBody {
    #[serde(default)]
    confirm: bool,
    #[serde(default)]
    revision: Option<i64>,
    #[serde(default)]
    restore: bool,
}

pub async fn delete_receipt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((ledger_id, receipt_id)): Path<(i64, i64)>,
    Json(body): Json<DeleteReceiptBody>,
) -> Result<Response, DataError> {
    let s = session(&state, &headers).await?;
    let role = member_ledger(&state.db, ledger_id, s.user_id).await?;
    require_writer(role)?;
    if body.confirm && !body.restore && body.revision.is_none() {
        return Err(DataError::code(
            StatusCode::BAD_REQUEST,
            "revision_required",
        ));
    }
    let (outcome, status) = dr::delete_or_restore(
        &state.db,
        ledger_id,
        &actor(&s),
        receipt_id,
        body.restore,
        body.confirm,
        body.revision,
        now_ms(),
    )
    .await
    .map_err(DataError::receipt)?;
    let body = serde_json::to_value(&status).unwrap_or(Value::Null);
    if outcome == DeleteOutcome::Stale {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({ "error": "stale_revision", "status": body })),
        )
            .into_response());
    }
    Ok(Json(body).into_response())
}
