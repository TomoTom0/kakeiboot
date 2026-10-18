//! Catalog tools #11-#13 (spec_mcp-tools.md 7-12 .. 7-14).

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::domain::actor::Actor;
use crate::domain::catalog::{
    self, CatKind, CatalogError, CategoryChange, ManageCategory, StoreChange,
};
use crate::domain::labels;
use crate::domain::search;
use crate::domain::stats::FilterError;
use crate::mcp::result::{self, envelope};

fn cat_err(e: CatalogError) -> rmcp::model::CallToolResult {
    match e {
        CatalogError::NotFound => result::not_found(),
        CatalogError::Invalid(m) | CatalogError::NameConflict(m) => result::invalid(&[m]),
        CatalogError::SameStore => result::invalid(&[e.to_string()]),
        CatalogError::Db(e) => result::internal(e),
    }
}

/// A nullable-string argument: `None` = absent (keep), `Some(None)` = JSON
/// null (clear), `Some(Some(s))` = a string (set). `Err` = wrong JSON type.
fn nullable_string<'a>(
    field: &str,
    v: &'a Option<Value>,
) -> Result<Option<Option<&'a str>>, rmcp::model::CallToolResult> {
    match v {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.as_str()))),
        Some(_) => Err(result::invalid(&[format!(
            "{field}: 文字列か null にしてください"
        )])),
    }
}

// ---------------------------------------------------------------------------
// #11 get_catalog

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GetCatalogArgs {
    #[serde(default)]
    include: Option<Vec<String>>,
    #[serde(default)]
    store_query: Option<String>,
    #[serde(default)]
    include_archived: bool,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn get(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: GetCatalogArgs = parse(args)?;
    let ledger = c.target(a.ledger_id).await?;
    let include = a
        .include
        .unwrap_or_else(|| vec!["item_categories".into(), "store_categories".into()]);
    for i in &include {
        if !["item_categories", "store_categories", "stores"].contains(&i.as_str()) {
            return Err(result::invalid(&[format!(
                "include: \"item_categories\" / \"store_categories\" / \"stores\" の配列にしてください（{i}）"
            )]));
        }
    }
    let mut conn = c.db().acquire().await.map_err(result::internal)?;
    // `json!` gives a Value, whose `["key"] = v` inserts; a bare Map's would
    // panic on missing keys (serde_json Map IndexMut is get_mut().expect).
    let mut body = json!({});
    if include.iter().any(|i| i == "item_categories") {
        let tree = catalog::category_tree(&mut conn, CatKind::Item, ledger.id, a.include_archived)
            .await
            .map_err(result::internal)?;
        body["item_categories"] = Value::Array(tree);
    }
    if include.iter().any(|i| i == "store_categories") {
        let tree = catalog::category_tree(&mut conn, CatKind::Store, ledger.id, a.include_archived)
            .await
            .map_err(result::internal)?;
        body["store_categories"] = Value::Array(tree);
    }
    // `stores` only with a query (count can be large, spec 7-12).
    if let Some(q) = a.store_query.as_deref().filter(|q| !q.trim().is_empty()) {
        // TASK-73: search query length cap (spec 3-5). The kind is
        // store_query on both this and the web /stores query path (design 3).
        search::check_query_text("store_query", q, c.limits().max_query_chars).map_err(
            |e| match e {
                FilterError::Invalid(m) => result::invalid(&[m]),
                FilterError::Db(e) => result::internal(e),
            },
        )?;
        let stores = catalog::search_stores(&mut conn, ledger.id, q, c.limits().catalog_max_stores)
            .await
            .map_err(result::internal)?;
        body["stores"] = Value::Array(stores);
    }
    body["category_paths"] = json!({
        "item": catalog::category_paths(&mut conn, CatKind::Item, ledger.id)
            .await
            .map_err(result::internal)?,
        "store": catalog::category_paths(&mut conn, CatKind::Store, ledger.id)
            .await
            .map_err(result::internal)?,
    });
    // label definitions (color -> title resolution for label_receipts /
    // summarize_spending filters.label_colors, spec 7-12)
    body["labels"] = json!(
        labels::list_labels(&mut conn, ledger.id)
            .await
            .map_err(result::internal)?
    );
    drop(conn);
    let mut text = String::from("カテゴリを取得しました。");
    if let Some(stores) = body.get("stores").and_then(Value::as_array) {
        text.push_str(&format!(
            "店の検索「{}」: {}件。",
            a.store_query.unwrap_or_default(),
            stores.len()
        ));
    }
    text.push_str(&ledger.text_suffix());
    Ok(result::ok(
        text,
        envelope("catalog", Some(&ledger), &[], body),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #12 manage_category

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManageCategoryArgs {
    kind: String,
    action: String,
    category: String,
    #[serde(default)]
    new_name: Option<String>,
    /// Some(null) = move to top level; Some("Top") = move under that parent
    #[serde(default)]
    new_parent: Option<Value>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn manage_category(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: ManageCategoryArgs = parse(args)?;
    let ledger = c.target_writer(a.ledger_id).await?;
    let kind = CatKind::parse(&a.kind).ok_or_else(|| {
        result::invalid(&[format!(
            "kind: \"item\" か \"store\" にしてください（{}）",
            a.kind
        )])
    })?;
    let new_parent = nullable_string("new_parent", &a.new_parent)?;
    let req = ManageCategory {
        kind,
        action: &a.action,
        category: &a.category,
        new_name: a.new_name.as_deref(),
        new_parent,
    };
    let actor = Actor::mcp(c.auth.user_id, &c.auth.client_id, c.auth.grant_id);
    let change = catalog::manage_category(
        c.db(),
        ledger.id,
        &actor,
        &req,
        c.limits().max_name_chars,
        c.now,
    )
    .await
    .map_err(cat_err)?;
    let CategoryChange {
        id,
        path,
        archived,
        created,
    } = change;
    let verb = match (a.action.as_str(), created) {
        ("create", false) => "既存のカテゴリを返しました（既にありました）",
        ("create", true) => "作成しました",
        (act, _) if act == "archive" || act == "unarchive" => {
            if archived {
                "アーカイブしました"
            } else {
                "アーカイブ解除しました"
            }
        }
        _ => "更新しました",
    };
    let text = format!("カテゴリ「{path}」を{verb}。{}", ledger.text_suffix());
    Ok(result::ok(
        text,
        envelope(
            "catalog_change",
            Some(&ledger),
            &[],
            json!({ "category": { "id": id, "path": path, "archived": archived }, "created": created }),
        ),
        None,
    ))
}

// ---------------------------------------------------------------------------
// #13 manage_store

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManageStoreArgs {
    store_id: i64,
    #[serde(default)]
    name: Option<String>,
    /// None = keep, Some(null) = clear, Some("path") = set
    #[serde(default)]
    category: Option<Value>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

pub async fn manage_store(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: ManageStoreArgs = parse(args)?;
    if a.name.is_none() && a.category.is_none() {
        return Err(result::invalid(&[
            "name か category のどちらかは指定してください（変更がありません）".into(),
        ]));
    }
    let ledger = c.target_writer(a.ledger_id).await?;
    let category = nullable_string("category", &a.category)?;
    let actor = Actor::mcp(c.auth.user_id, &c.auth.client_id, c.auth.grant_id);
    let out: StoreChange = catalog::manage_store(
        c.db(),
        ledger.id,
        &actor,
        a.store_id,
        a.name.as_deref(),
        category,
        c.now,
    )
    .await
    .map_err(cat_err)?;
    let StoreChange {
        store_id,
        name,
        category,
        before_name,
        before_category,
    } = out;
    let mut text = format!("店「{name}」を更新しました。{}", ledger.text_suffix());
    if before_category != category {
        text.push_str("\n店カテゴリの変更は過去分の集計にも反映されます。");
    }
    text.push_str("\n元に戻すときは before の値で manage_store を呼んでください。");
    Ok(result::ok(
        text,
        envelope(
            "store_change",
            Some(&ledger),
            &[],
            json!({
                "store": { "store_id": store_id, "name": name, "category": category },
                "before": { "name": before_name, "category": before_category },
            }),
        ),
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:mcp-catalog.tri-state-category]
    #[test]
    fn manage_store_category_tri_state() {
        // The wire form is JSON: absent / null / string map to keep / clear /
        // set; any other JSON type is an input error.
        let absent: Option<Value> = None;
        let clear = Some(Value::Null);
        let set = Some(json!("食費/外食"));
        let wrong = Some(json!(3));
        assert_eq!(nullable_string("category", &absent).unwrap(), None);
        assert_eq!(nullable_string("category", &clear).unwrap(), Some(None));
        assert_eq!(
            nullable_string("category", &set).unwrap(),
            Some(Some("食費/外食"))
        );
        let err = nullable_string("category", &wrong).unwrap_err();
        let text = serde_json::to_value(&err).unwrap();
        assert!(text.to_string().contains("category"));
    }

    // [covers:mcp-catalog.include-validation]
    #[test]
    fn include_values() {
        // get_catalog accepts only the three known include values; the
        // default (no include) is both category trees and no stores.
        let ok = ["item_categories", "store_categories", "stores"];
        assert!(ok.contains(&"stores"));
        let default: Vec<String> = vec!["item_categories".into(), "store_categories".into()];
        assert_eq!(default.len(), 2);
    }
}
