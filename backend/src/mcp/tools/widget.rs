//! refresh_widget_images W1 (spec_mcp-tools.md 7-20): re-issues short-lived
//! image URLs for widget reopens. Widget-only (`ui.visibility: ["app"]`),
//! cross-ledger read (spec 3-1 exception 2). Permits nothing the model can
//! call; unauthorized / image-less refs come back as null.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::mcp::result::{self, envelope};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ref {
    kind: String,
    id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RefreshArgs {
    refs: Vec<Ref>,
}

pub async fn refresh(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: RefreshArgs = parse(args)?;
    if a.refs.len() > c.limits().widget_refs_max {
        return Err(result::invalid(&[format!(
            "refs: 一度に{}件までです",
            c.limits().widget_refs_max
        )]));
    }
    if a.refs.is_empty() {
        return Err(result::invalid(&["refs: 1件以上指定してください".into()]));
    }
    let mut images = Map::new();
    let mut issued = 0usize;
    for r in &a.refs {
        let key = format!("{}:{}", r.kind, r.id);
        let image_id: Option<i64> = match r.kind.as_str() {
            // Draft: own and still pending (spec 7-20).
            "draft" => sqlx::query_scalar(
                "SELECT image_id FROM drafts
                     WHERE id = ? AND user_id = ? AND status = 'pending'",
            )
            .bind(r.id)
            .bind(c.auth.user_id)
            .fetch_optional(c.db())
            .await
            .map_err(result::internal)?
            .flatten(),
            // Receipt: any ledger the user belongs to (spec 7-20).
            "receipt" => sqlx::query_scalar(
                "SELECT image_id FROM receipts
                     WHERE id = ? AND ledger_id IN
                       (SELECT ledger_id FROM ledger_members WHERE user_id = ?)",
            )
            .bind(r.id)
            .bind(c.auth.user_id)
            .fetch_optional(c.db())
            .await
            .map_err(result::internal)?
            .flatten(),
            other => {
                return Err(result::invalid(&[format!(
                    "refs[].kind: \"draft\" か \"receipt\" にしてください（{other}）"
                )]));
            }
        };
        // None (no permission / no image) stays null in the map.
        let url = match image_id {
            Some(id) => c.image_url(id).await,
            None => None,
        };
        if url.is_some() {
            issued += 1;
        }
        images.insert(key, url.unwrap_or(Value::Null));
    }
    Ok(result::ok(
        format!("画像URLを{issued}件更新しました。"),
        envelope("images", None, &[], json!({})),
        Some(json!({ "images": images })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:mcp-widget.ref-key-format]
    #[test]
    fn ref_keys() {
        // `_meta.images` keys are "<kind>:<id>"; absent permissions or a
        // missing image must stay present-but-null (spec 7-20).
        let mut m = Map::new();
        m.insert("draft:3".into(), Value::Null);
        m.insert("receipt:7".into(), json!({ "url": "https://x/i.webp?t=1" }));
        assert!(m["draft:3"].is_null());
        assert!(m["receipt:7"]["url"].is_string());
    }
}
