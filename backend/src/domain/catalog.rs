//! Catalog reads and edits (spec_mcp-tools.md 7-12 .. 7-14;
//! spec_data-model.md 5): category trees, store lookup without creation,
//! the history-based category suggestion (13-3), and the
//! manage_category / manage_store operations.

use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, Connection, SqliteConnection, SqlitePool};

use super::actor::Actor;
use crate::store::normalize_text;

/// Item or store categories (two same-shaped tables, spec_data-model 5-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatKind {
    Item,
    Store,
}

impl CatKind {
    pub fn table(self) -> &'static str {
        match self {
            Self::Item => "item_categories",
            Self::Store => "store_categories",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "item" => Some(Self::Item),
            "store" => Some(Self::Store),
            _ => None,
        }
    }
}

/// Split "Top" / "Top/Sub" (trimmed).
pub fn split_path(path: &str) -> (String, Option<String>) {
    match path.split_once('/') {
        Some((t, s)) => (t.trim().to_string(), Some(s.trim().to_string())),
        None => (path.trim().to_string(), None),
    }
}

/// Resolve a category path to its id (archived ones still resolve).
pub async fn resolve_path(
    conn: &mut SqliteConnection,
    kind: CatKind,
    ledger_id: i64,
    path: &str,
) -> sqlx::Result<Option<i64>> {
    crate::store::resolve_category(conn, kind.table(), ledger_id, path).await
}

/// "Top" or "Top/Sub" for a category id.
pub async fn path_of(
    conn: &mut SqliteConnection,
    kind: CatKind,
    id: i64,
) -> sqlx::Result<Option<String>> {
    let t = kind.table();
    let sql = format!(
        "SELECT c.name, p.name FROM {t} c LEFT JOIN {t} p ON p.id = c.parent_id WHERE c.id = ?"
    );
    let row: Option<(String, Option<String>)> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(row.map(|(name, parent)| match parent {
        Some(p) => format!("{p}/{name}"),
        None => name,
    }))
}

/// Store lookup by normalized name (aliases first) without creating rows.
pub async fn find_store(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    name: &str,
) -> sqlx::Result<Option<i64>> {
    let norm = normalize_text(name);
    if norm.is_empty() {
        return Ok(None);
    }
    let by_alias: Option<i64> = sqlx::query_scalar(
        "SELECT store_id FROM store_aliases WHERE ledger_id = ? AND alias_norm = ?",
    )
    .bind(ledger_id)
    .bind(&norm)
    .fetch_optional(&mut *conn)
    .await?;
    if by_alias.is_some() {
        return Ok(by_alias);
    }
    sqlx::query_scalar("SELECT id FROM stores WHERE ledger_id = ? AND name_norm = ?")
        .bind(ledger_id)
        .bind(&norm)
        .fetch_optional(conn)
        .await
}

/// History suggestion (spec_data-model 13-3): the category of the latest
/// same-name item, user-chosen first.
pub async fn suggest_category(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    item_name: &str,
) -> sqlx::Result<Option<String>> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT i.category_id
         FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id AND r.deleted_at IS NULL
         WHERE i.ledger_id = ? AND i.name_norm = ? AND i.category_id IS NOT NULL
         ORDER BY (i.category_source = 'user') DESC, r.purchased_on DESC
         LIMIT 1",
    )
    .bind(ledger_id)
    .bind(normalize_text(item_name))
    .fetch_optional(&mut *conn)
    .await?;
    match id {
        Some(id) => path_of(conn, CatKind::Item, id).await,
        None => Ok(None),
    }
}

/// Flat "Top" / "Top/Sub" list of non-archived categories.
pub async fn category_paths(
    conn: &mut SqliteConnection,
    kind: CatKind,
    ledger_id: i64,
) -> sqlx::Result<Vec<String>> {
    let tree = category_tree(conn, kind, ledger_id, false).await?;
    let mut out = Vec::new();
    for top in tree {
        let name = top["name"].as_str().unwrap_or_default().to_string();
        out.push(name.clone());
        for c in top["children"].as_array().into_iter().flatten() {
            out.push(format!("{name}/{}", c["name"].as_str().unwrap_or_default()));
        }
    }
    Ok(out)
}

/// `{ id, name, children: [{id, name}] }[]` (+ archived flags when included).
pub async fn category_tree(
    conn: &mut SqliteConnection,
    kind: CatKind,
    ledger_id: i64,
    include_archived: bool,
) -> sqlx::Result<Vec<Value>> {
    let t = kind.table();
    let sql = format!(
        "SELECT id, parent_id, name, archived_at IS NOT NULL FROM {t}
         WHERE ledger_id = ? AND (? OR archived_at IS NULL)
         ORDER BY parent_id IS NOT NULL, sort_order, id"
    );
    let rows: Vec<(i64, Option<i64>, String, bool)> = sqlx::query_as(AssertSqlSafe(sql))
        .bind(ledger_id)
        .bind(include_archived)
        .fetch_all(conn)
        .await?;
    let mut tops: Vec<Value> = Vec::new();
    for (id, parent, name, archived) in &rows {
        if parent.is_none() {
            let mut v = json!({ "id": id, "name": name, "children": [] });
            if include_archived {
                v["archived"] = json!(archived);
            }
            tops.push(v);
        }
    }
    for (id, parent, name, archived) in &rows {
        if let Some(p) = parent
            && let Some(top) = tops.iter_mut().find(|t| t["id"] == json!(p))
        {
            let mut v = json!({ "id": id, "name": name });
            if include_archived {
                v["archived"] = json!(archived);
            }
            if let Some(arr) = top["children"].as_array_mut() {
                arr.push(v);
            }
        }
    }
    Ok(tops)
}

/// Stores matching a partial name (LIKE, escaped), with usage counts.
#[allow(clippy::type_complexity)]
pub async fn search_stores(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    query: &str,
    limit: i64,
) -> sqlx::Result<Vec<Value>> {
    let pat = format!("%{}%", super::util::escape_like(&normalize_text(query)));
    let rows: Vec<(i64, String, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT s.id, s.name, s.category_id,
                (SELECT COUNT(*) FROM receipts r WHERE r.store_id = s.id AND r.deleted_at IS NULL),
                (SELECT MAX(purchased_on) FROM receipts r WHERE r.store_id = s.id AND r.deleted_at IS NULL)
         FROM stores s
         WHERE s.ledger_id = ? AND (s.name_norm LIKE ? ESCAPE '\\'
            OR EXISTS (SELECT 1 FROM store_aliases a WHERE a.store_id = s.id AND a.alias_norm LIKE ? ESCAPE '\\'))
         ORDER BY 4 DESC, s.id
         LIMIT ?",
    )
    .bind(ledger_id)
    .bind(&pat)
    .bind(&pat)
    .bind(limit)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, cat, count, last) in rows {
        let category = match cat {
            Some(c) => path_of(conn, CatKind::Store, c).await?,
            None => None,
        };
        out.push(json!({
            "store_id": id, "name": name, "category": category,
            "receipt_count": count, "last_purchased_on": last,
        }));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// manage_category (7-13)

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("not found")]
    NotFound,
    /// input validation message (Japanese, shown to the model)
    #[error("{0}")]
    Invalid(String),
    /// a same-named row already exists (web: 409 name_conflict)
    #[error("{0}")]
    NameConflict(String),
    /// merge source and destination are the same store (web: 400 same_store)
    #[error("統合元と統合先に同じ店は指定できません")]
    SameStore,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(Debug, Clone)]
pub struct CategoryChange {
    pub id: i64,
    pub path: String,
    pub archived: bool,
    pub created: bool,
}

/// Audit row for catalog / receipt edits (actor kind from `Actor`).
#[allow(clippy::too_many_arguments)]
pub async fn audit(
    conn: &mut SqliteConnection,
    ledger_id: i64,
    actor: &Actor,
    entity_type: &str,
    entity_id: i64,
    action: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    now: i64,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO audit_events (ledger_id, user_id, actor_kind, client_id, entity_type, entity_id,
            action, before_json, after_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ledger_id)
    .bind(actor.user_id)
    .bind(actor.kind.as_str())
    .bind(actor.kind.client_id())
    .bind(entity_type)
    .bind(entity_id)
    .bind(action)
    .bind(before.map(Value::to_string))
    .bind(after.map(Value::to_string))
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

pub struct ManageCategory<'a> {
    pub kind: CatKind,
    pub action: &'a str,
    pub category: &'a str,
    pub new_name: Option<&'a str>,
    /// Some(None) = move to top level
    pub new_parent: Option<Option<&'a str>>,
}

pub async fn manage_category(
    pool: &SqlitePool,
    ledger_id: i64,
    actor: &Actor,
    req: &ManageCategory<'_>,
    max_name: usize,
    now: i64,
) -> Result<CategoryChange, CatalogError> {
    let t = req.kind.table();
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let (top, sub) = split_path(req.category);
    let check_name = |n: &str| -> Result<(), CatalogError> {
        if n.is_empty() || n.contains('/') || n.chars().count() > max_name {
            return Err(CatalogError::Invalid(format!(
                "カテゴリ名は1〜{max_name}字で「/」を含めないでください"
            )));
        }
        Ok(())
    };
    let existing = resolve_path(&mut tx, req.kind, ledger_id, req.category).await?;
    let id = match req.action {
        "create" => {
            if let Some(id) = existing {
                let change = load_change(&mut tx, req.kind, id, false).await?;
                tx.commit().await?;
                return Ok(change);
            }
            check_name(&top)?;
            let parent_id = match &sub {
                Some(s) => {
                    check_name(s)?;
                    let pid = resolve_path(&mut tx, req.kind, ledger_id, &top).await?;
                    match pid {
                        Some(p) => Some(p),
                        None => {
                            return Err(CatalogError::Invalid(format!(
                                "親カテゴリ「{top}」がありません。先に category=\"{top}\" で create してください"
                            )));
                        }
                    }
                }
                None => None,
            };
            let name = sub.clone().unwrap_or_else(|| top.clone());
            let sql = format!(
                "INSERT INTO {t} (ledger_id, parent_id, name, sort_order, created_at, updated_at)
                 VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM {t}
                                  WHERE ledger_id = ? AND COALESCE(parent_id, 0) = COALESCE(?, 0)), ?, ?)
                 RETURNING id"
            );
            let id: i64 = sqlx::query_scalar(AssertSqlSafe(sql))
                .bind(ledger_id)
                .bind(parent_id)
                .bind(&name)
                .bind(ledger_id)
                .bind(parent_id)
                .bind(now)
                .bind(now)
                .fetch_one(&mut *tx)
                .await?;
            let change = load_change(&mut tx, req.kind, id, true).await?;
            audit(
                &mut tx,
                ledger_id,
                actor,
                &format!("{}_category", kind_word(req.kind)),
                id,
                "create",
                None,
                Some(&json!({ "path": change.path })),
                now,
            )
            .await?;
            tx.commit().await?;
            return Ok(change);
        }
        _ => existing.ok_or(CatalogError::NotFound)?,
    };
    let before = load_change(&mut tx, req.kind, id, false).await?;
    match req.action {
        "rename" => {
            let n = req
                .new_name
                .ok_or_else(|| CatalogError::Invalid("rename には new_name が必要です".into()))?
                .trim();
            check_name(n)?;
            let sql = format!("UPDATE {t} SET name = ?, updated_at = ? WHERE id = ?");
            sqlx::query(AssertSqlSafe(sql))
                .bind(n)
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(dup_name)?;
        }
        "move" => {
            let np = req.new_parent.ok_or_else(|| {
                CatalogError::Invalid(
                    "move には new_parent（大分類名、または null）が必要です".into(),
                )
            })?;
            let parent_id = match np {
                Some(p) => {
                    let pid = resolve_path(&mut tx, req.kind, ledger_id, p.trim())
                        .await?
                        .ok_or_else(|| {
                            CatalogError::Invalid(format!("移動先の大分類「{p}」がありません"))
                        })?;
                    if pid == id || p.contains('/') {
                        return Err(CatalogError::Invalid(
                            "移動先には別の大分類を指定してください".into(),
                        ));
                    }
                    Some(pid)
                }
                None => None,
            };
            let sql = format!("UPDATE {t} SET parent_id = ?, updated_at = ? WHERE id = ?");
            sqlx::query(AssertSqlSafe(sql))
                .bind(parent_id)
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await
                .map_err(|e| match &e {
                    sqlx::Error::Database(d) if d.message().contains("depth") => {
                        CatalogError::Invalid(
                            "小分類を持つ大分類は他の大分類の下へ移動できません（2階層まで）"
                                .into(),
                        )
                    }
                    _ => dup_name(e),
                })?;
        }
        "archive" | "unarchive" => {
            let v = if req.action == "archive" {
                Some(now)
            } else {
                None
            };
            let sql = format!("UPDATE {t} SET archived_at = ?, updated_at = ? WHERE id = ?");
            sqlx::query(AssertSqlSafe(sql))
                .bind(v)
                .bind(now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        other => {
            return Err(CatalogError::Invalid(format!(
                "action「{other}」は使えません（create / rename / move / archive / unarchive）"
            )));
        }
    }
    let after = load_change(&mut tx, req.kind, id, false).await?;
    audit(
        &mut tx,
        ledger_id,
        actor,
        &format!("{}_category", kind_word(req.kind)),
        id,
        req.action,
        Some(&json!({ "path": before.path, "archived": before.archived })),
        Some(&json!({ "path": after.path, "archived": after.archived })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(after)
}

fn kind_word(k: CatKind) -> &'static str {
    match k {
        CatKind::Item => "item",
        CatKind::Store => "store",
    }
}

fn dup_name(e: sqlx::Error) -> CatalogError {
    match &e {
        sqlx::Error::Database(d) if d.message().contains("UNIQUE") => {
            CatalogError::NameConflict("同じ名前のカテゴリが既にあります".into())
        }
        _ => CatalogError::Db(e),
    }
}

async fn load_change(
    conn: &mut SqliteConnection,
    kind: CatKind,
    id: i64,
    created: bool,
) -> sqlx::Result<CategoryChange> {
    let sql = format!(
        "SELECT archived_at IS NOT NULL FROM {} WHERE id = ?",
        kind.table()
    );
    let archived: bool = sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(id)
        .fetch_one(&mut *conn)
        .await?;
    let path = path_of(conn, kind, id).await?.unwrap_or_default();
    Ok(CategoryChange {
        id,
        path,
        archived,
        created,
    })
}

// ---------------------------------------------------------------------------
// manage_store (7-14)

#[derive(Debug, Clone)]
pub struct StoreChange {
    pub store_id: i64,
    pub name: String,
    pub category: Option<String>,
    pub before_name: String,
    pub before_category: Option<String>,
}

/// Rename / recategorize one store (no merge). `category`: None = keep,
/// Some(None) = clear, Some(Some(path)) = set (must exist).
#[allow(clippy::too_many_arguments)]
pub async fn manage_store(
    pool: &SqlitePool,
    ledger_id: i64,
    actor: &Actor,
    store_id: i64,
    name: Option<&str>,
    category: Option<Option<&str>>,
    now: i64,
) -> Result<StoreChange, CatalogError> {
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT name, category_id FROM stores WHERE id = ? AND ledger_id = ?")
            .bind(store_id)
            .bind(ledger_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((before_name, before_cat_id)) = row else {
        return Err(CatalogError::NotFound);
    };
    let before_category = match before_cat_id {
        Some(c) => path_of(&mut tx, CatKind::Store, c).await?,
        None => None,
    };
    if let Some(n) = name {
        let n = n.trim();
        let norm = normalize_text(n);
        if norm.is_empty() {
            return Err(CatalogError::Invalid("name を空にはできません".into()));
        }
        sqlx::query("UPDATE stores SET name = ?, name_norm = ?, updated_at = ? WHERE id = ?")
            .bind(n)
            .bind(&norm)
            .bind(now)
            .bind(store_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| match &e {
                sqlx::Error::Database(d) if d.message().contains("UNIQUE") => {
                    CatalogError::NameConflict(
                        "同じ名前の店が既にあります（店の統合は web 画面で行ってください）".into(),
                    )
                }
                _ => CatalogError::Db(e),
            })?;
        // the new name also resolves to this store (alias), unless taken
        sqlx::query(
            "INSERT OR IGNORE INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(ledger_id)
        .bind(&norm)
        .bind(store_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(cat) = category {
        let cat_id = match cat {
            Some(path) => Some(
                resolve_path(&mut tx, CatKind::Store, ledger_id, path)
                    .await?
                    .ok_or_else(|| {
                        CatalogError::Invalid(format!(
                            "店カテゴリ「{path}」がありません。get_catalog の category_paths.store から選んでください"
                        ))
                    })?,
            ),
            None => None,
        };
        sqlx::query(
            "UPDATE stores SET category_id = ?, category_source = 'user', updated_at = ? WHERE id = ?",
        )
        .bind(cat_id)
        .bind(now)
        .bind(store_id)
        .execute(&mut *tx)
        .await?;
    }
    let (after_name, after_cat): (String, Option<i64>) =
        sqlx::query_as("SELECT name, category_id FROM stores WHERE id = ?")
            .bind(store_id)
            .fetch_one(&mut *tx)
            .await?;
    let after_category = match after_cat {
        Some(c) => path_of(&mut tx, CatKind::Store, c).await?,
        None => None,
    };
    audit(
        &mut tx,
        ledger_id,
        actor,
        "store",
        store_id,
        "update",
        Some(&json!({ "name": before_name, "category": before_category })),
        Some(&json!({ "name": after_name, "category": after_category })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(StoreChange {
        store_id,
        name: after_name,
        category: after_category,
        before_name,
        before_category,
    })
}

// ---------------------------------------------------------------------------
// merge_stores (web only, spec_data-model.md 5-2)

/// The outcome of a store merge.
pub struct MergeChange {
    /// Post-merge destination row (`StoreRow` shape).
    pub store: Value,
    pub merged_from_id: i64,
    pub merged_from_name: String,
    pub moved_receipts: i64,
}

/// Merge `source_id` into `into_id` (web screens only; irreversible, so no
/// MCP tool exposes it — spec_data-model.md 5-2): reassign receipts,
/// re-register the source's names as aliases of the destination, delete the
/// source row.
pub async fn merge_stores(
    pool: &SqlitePool,
    ledger_id: i64,
    actor: &Actor,
    source_id: i64,
    into_id: i64,
    now: i64,
) -> Result<MergeChange, CatalogError> {
    if source_id == into_id {
        return Err(CatalogError::SameStore);
    }
    let mut conn = pool.acquire().await?;
    let mut tx = conn.begin_with("BEGIN IMMEDIATE").await?;
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, name, name_norm FROM stores WHERE ledger_id = ? AND id IN (?, ?)",
    )
    .bind(ledger_id)
    .bind(source_id)
    .bind(into_id)
    .fetch_all(&mut *tx)
    .await?;
    let (src, _dst) = rows
        .iter()
        .find(|(id, _, _)| *id == source_id)
        .zip(rows.iter().find(|(id, _, _)| *id == into_id))
        .ok_or(CatalogError::NotFound)?;
    let moved = sqlx::query("UPDATE receipts SET store_id = ? WHERE ledger_id = ? AND store_id = ?")
        .bind(into_id)
        .bind(ledger_id)
        .bind(source_id)
        .execute(&mut *tx)
        .await?
        .rows_affected() as i64;
    // The source's own name and its existing aliases now resolve to the
    // destination; existing destination aliases stay (PK conflicts skipped).
    sqlx::query(
        "INSERT OR IGNORE INTO store_aliases (ledger_id, alias_norm, store_id, created_at)
         VALUES (?, ?, ?, ?)",
    )
    .bind(ledger_id)
    .bind(&src.2)
    .bind(into_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE OR IGNORE store_aliases SET store_id = ? WHERE store_id = ?")
        .bind(into_id)
        .bind(source_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM stores WHERE id = ? AND ledger_id = ?")
        .bind(source_id)
        .bind(ledger_id)
        .execute(&mut *tx)
        .await?;
    // Post-merge destination row (same shape as search_stores).
    let row: (i64, String, Option<i64>, i64, Option<String>) = sqlx::query_as(
        "SELECT s.id, s.name, s.category_id,
                (SELECT COUNT(*) FROM receipts r WHERE r.store_id = s.id AND r.deleted_at IS NULL),
                (SELECT MAX(purchased_on) FROM receipts r WHERE r.store_id = s.id AND r.deleted_at IS NULL)
         FROM stores s WHERE s.id = ?",
    )
    .bind(into_id)
    .fetch_one(&mut *tx)
    .await?;
    let category = match row.2 {
        Some(c) => path_of(&mut tx, CatKind::Store, c).await?,
        None => None,
    };
    audit(
        &mut tx,
        ledger_id,
        actor,
        "store",
        into_id,
        "merge",
        Some(&json!({ "merged_store_id": src.0, "merged_name": src.1 })),
        Some(&json!({ "moved_receipts": moved })),
        now,
    )
    .await?;
    tx.commit().await?;
    Ok(MergeChange {
        store: json!({
            "store_id": row.0, "name": row.1, "category": category,
            "receipt_count": row.3, "last_purchased_on": row.4,
        }),
        merged_from_id: src.0,
        merged_from_name: src.1.clone(),
        moved_receipts: moved,
    })
}
