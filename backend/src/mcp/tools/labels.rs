//! Label tool #19 label_receipts (spec_mcp-tools.md 7-21): batch add / remove
//! of the fixed five-color labels on confirmed receipts. Title editing is
//! web-only (no MCP tool by design).

use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Call, ToolResult, parse};
use crate::domain::actor::Actor;
use crate::domain::labels::{self, LabelColor, LabelError, SkipReason};
use crate::mcp::result::{self, envelope};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LabelArgs {
    receipt_ids: Vec<i64>,
    #[serde(default)]
    add: Vec<LabelColor>,
    #[serde(default)]
    remove: Vec<LabelColor>,
    #[serde(default)]
    ledger_id: Option<i64>,
}

fn label_err(e: LabelError) -> rmcp::model::CallToolResult {
    match e {
        LabelError::Invalid(m) => result::invalid(&m),
        LabelError::Forbidden => result::viewer_only(),
        LabelError::NotFound => result::not_found(),
        LabelError::Deleted => result::err("このレシートは削除済みです。"),
        LabelError::Db(e) => result::internal(e),
    }
}

pub async fn label_receipts(c: &Call<'_>, args: &Map<String, Value>) -> ToolResult {
    let a: LabelArgs = parse(args)?;
    // input validation first (spec 4): count, both-empty, crossing
    let max = c.limits().max_label_batch;
    let mut errs = Vec::new();
    if a.receipt_ids.is_empty() {
        errs.push("receipt_ids: 対象のレシート ID を1件以上指定してください".to_string());
    } else if a.receipt_ids.len() > max {
        errs.push(format!(
            "receipt_ids: 一度に指定できるのは {max} 件までです"
        ));
    }
    if a.add.is_empty() && a.remove.is_empty() {
        errs.push("add / remove: 付与または解除する色を指定してください".to_string());
    }
    if let Some(x) = a.add.iter().find(|x| a.remove.contains(x)) {
        errs.push(format!(
            "add / remove: 同じ色（{}）を付与と解除の両方には指定できません",
            x.as_str()
        ));
    }
    if !errs.is_empty() {
        return Err(result::invalid(&errs));
    }
    // ledger + role like the other write tools (spec_auth 5-3, 6-3): viewer
    // is a whole-call error (not per-receipt skips)
    let ledger = c.target_writer(a.ledger_id).await?;
    let actor = Actor::mcp(c.auth.user_id, &c.auth.client_id, c.auth.grant_id);
    let out = labels::apply(
        c.db(),
        ledger.id,
        ledger.role,
        &actor,
        &a.receipt_ids,
        &a.add,
        &a.remove,
        c.now,
    )
    .await
    .map_err(label_err)?;
    let skipped_json = |s: &[(i64, SkipReason)]| -> Vec<Value> {
        s.iter()
            .map(|(id, r)| json!({ "receipt_id": id, "reason": r.as_str() }))
            .collect()
    };
    if out.receipts.is_empty() {
        // every receipt skipped: the whole call is an error (spec 7-21)
        let detail = out
            .skipped
            .iter()
            .map(|(id, r)| format!("#{id}={}", r.as_str()))
            .collect::<Vec<_>>()
            .join("、");
        return Err(result::err(format!(
            "対象のレシートが見つかりませんでした（{detail}）。ID を確認してください。"
        )));
    }
    let receipts_json: Vec<Value> = out
        .receipts
        .iter()
        .map(|(id, labels)| json!({ "receipt_id": id, "labels": labels }))
        .collect();
    let skipped = skipped_json(&out.skipped);
    let mut text = format!(
        "{} 件のレシートにラベルを反映しました。{}",
        out.receipts.len(),
        ledger.text_suffix()
    );
    if !out.skipped.is_empty() {
        text.push_str(&format!(
            "\n{} 件は対象外のためスキップしました（not_found=他の家計簿・無し / deleted=削除済み）。",
            out.skipped.len()
        ));
    }
    text.push_str("\nラベルはレシートの revision を変えません。");
    Ok(result::ok(
        text,
        envelope(
            "label_change",
            Some(&ledger),
            &[],
            json!({ "receipts": receipts_json, "skipped": skipped }),
        ),
        None,
    ))
}
