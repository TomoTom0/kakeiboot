//! MCP tool handlers (spec_mcp-tools.md 7). `call` dispatches by name after
//! the scope check; each handler resolves its target ledger (spec 3-1,
//! spec_auth.md 5-3) and returns a `CallToolResult` built by `result`.

pub mod account;
pub mod catalog;
pub mod drafts;
pub mod labels;
pub mod receipts;
pub mod stats;
pub mod widget;

use std::path::PathBuf;
use std::sync::Arc;

use rmcp::model::CallToolResult;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sqlx::SqlitePool;

use super::auth::{AuthContext, LedgerSource, require_scope, resolve_target_ledger};
use super::registry;
use super::result::{self, LedgerInfo};
use super::widget_resource::WidgetResource;
use crate::auth::ledger::LedgerRole;
use crate::config::{McpToolsConfig, ResolvedAuth};
use crate::domain::drafts::{DraftRow, load_draft};

/// Shared, immutable tool environment.
#[derive(Debug, Clone)]
pub struct ToolEnv {
    pub db: SqlitePool,
    pub auth_cfg: Arc<ResolvedAuth>,
    pub cfg: Arc<McpToolsConfig>,
    pub image_root: PathBuf,
    pub http: reqwest::Client,
    /// Process-wide decode slots shared by every concurrent tool call
    /// (TASK-18 2-5).
    pub decode_gate: crate::domain::images::DecodeGate,
    pub widget: Arc<WidgetResource>,
}

/// One tool invocation.
pub struct Call<'a> {
    pub env: &'a ToolEnv,
    pub auth: &'a AuthContext,
    pub now: i64,
}

impl Call<'_> {
    pub fn db(&self) -> &SqlitePool {
        &self.env.db
    }

    /// Ledger from `ledger_id` or the active ledger (spec 3-1 / auth 5-3).
    pub async fn target(&self, arg: Option<i64>) -> Result<LedgerInfo, CallToolResult> {
        let t = resolve_target_ledger(self.auth, arg, &self.env.db).await?;
        Ok(LedgerInfo {
            id: t.ledger_id,
            name: t.name,
            role: t.role,
            source: match t.source {
                LedgerSource::Active => "active",
                LedgerSource::Explicit => "explicit",
            },
            active_id: self.auth.ledger.as_ref().map(|l| l.ledger_id),
        })
    }

    pub async fn target_writer(&self, arg: Option<i64>) -> Result<LedgerInfo, CallToolResult> {
        let l = self.target(arg).await?;
        require_role(&l)?;
        Ok(l)
    }

    /// Draft-based resolution (spec_auth 5-3 step 6): the user's draft, its
    /// ledger (must still be a member), and the `ledger_id` consistency.
    pub async fn draft(
        &self,
        draft_id: i64,
        arg: Option<i64>,
    ) -> Result<(DraftRow, LedgerInfo), CallToolResult> {
        let row = load_draft(&self.env.db, draft_id, self.auth.user_id)
            .await
            .map_err(result::internal)?
            .ok_or_else(result::not_found)?;
        if let Some(l) = arg
            && l != row.ledger_id
        {
            return Err(result::err(
                "ledger_id がこの下書きの家計簿と一致しません。下書きは作成時の家計簿で処理されます（ledger_id を省略してください）。",
            ));
        }
        let m: Option<(String, String)> = sqlx::query_as(
            "SELECT l.name, m.role FROM ledger_members m JOIN ledgers l ON l.id = m.ledger_id
             WHERE m.ledger_id = ? AND m.user_id = ?",
        )
        .bind(row.ledger_id)
        .bind(self.auth.user_id)
        .fetch_optional(&self.env.db)
        .await
        .map_err(result::internal)?;
        let Some((name, role)) = m.and_then(|(n, r)| Some((n, LedgerRole::parse(&r)?))) else {
            return Err(result::not_found());
        };
        let info = LedgerInfo {
            id: row.ledger_id,
            name,
            role,
            source: "draft",
            active_id: self.auth.ledger.as_ref().map(|l| l.ledger_id),
        };
        Ok((row, info))
    }

    pub fn limits(&self) -> &crate::config::McpLimits {
        &self.env.cfg.limits
    }

    /// Issue a widget image URL (None when no image / failure).
    pub async fn image_url(&self, image_id: i64) -> Option<Value> {
        match crate::domain::images::issue_image_url(
            &self.env.db,
            &self.env.auth_cfg.public_origin,
            image_id,
            self.auth.user_id,
            self.env.cfg.image.access_token_ttl_secs,
            self.now,
        )
        .await
        {
            Ok(Some(u)) => serde_json::to_value(u).ok(),
            Ok(None) => None,
            Err(e) => {
                tracing::warn!(error = %e, "image url issue failed");
                None
            }
        }
    }
}

/// role >= editor for writes (spec 4: 「この家計簿は閲覧のみです」).
pub fn require_role(l: &LedgerInfo) -> Result<(), CallToolResult> {
    if l.role >= LedgerRole::Editor {
        Ok(())
    } else {
        Err(result::viewer_only())
    }
}

/// Deserialize tool arguments into a typed struct (input errors are tool
/// errors, spec 4).
pub fn parse<T: DeserializeOwned>(args: &Map<String, Value>) -> Result<T, CallToolResult> {
    serde_json::from_value(Value::Object(args.clone()))
        .map_err(|e| result::invalid(&[format!("引数: {e}")]))
}

/// Run a tool. `Ok(None)` = unknown tool name.
pub async fn call(
    env: &ToolEnv,
    auth: &AuthContext,
    name: &str,
    args: Map<String, Value>,
    now: i64,
) -> Option<CallToolResult> {
    let def = registry::find(name)?;
    if let Err(r) = require_scope(auth, def.scope, &env.auth_cfg) {
        return Some(r);
    }
    let c = Call { env, auth, now };
    let r = match name {
        "create_receipt_draft" => drafts::create(&c, &args).await,
        "update_receipt_draft" => drafts::update(&c, &args).await,
        "approve_receipt_draft" => drafts::approve(&c, &args).await,
        "discard_receipt_draft" => drafts::discard(&c, &args).await,
        "reopen_receipt_draft" => drafts::reopen(&c, &args).await,
        "get_receipt_drafts" => drafts::get(&c, &args).await,
        "create_receipt_drafts" => drafts::create_batch(&c, &args).await,
        "approve_receipt_drafts" => drafts::approve_batch(&c, &args).await,
        "search_receipts" => receipts::search(&c, &args).await,
        "get_receipt" => receipts::get(&c, &args).await,
        "update_receipt" => receipts::update(&c, &args).await,
        "delete_receipt" => receipts::delete(&c, &args).await,
        "label_receipts" => labels::label_receipts(&c, &args).await,
        "get_catalog" => catalog::get(&c, &args).await,
        "manage_category" => catalog::manage_category(&c, &args).await,
        "manage_store" => catalog::manage_store(&c, &args).await,
        "summarize_spending" => stats::summarize(&c, &args).await,
        "whoami" => account::whoami(&c, &args).await,
        "list_ledgers" => account::list_ledgers(&c, &args).await,
        "switch_ledger" => account::switch_ledger(&c, &args).await,
        "refresh_widget_images" => widget::refresh(&c, &args).await,
        _ => return None,
    };
    Some(r.unwrap_or_else(|e| e))
}

/// Handler result: Err is an already-built error result.
pub type ToolResult = Result<CallToolResult, CallToolResult>;
