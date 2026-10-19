//! Tool result construction (spec_mcp-tools.md 3-2 .. 3-4, 4): the common
//! envelope `{ view, ledger, warnings?, ...body }` in structuredContent,
//! the Japanese content text, widget-only `_meta`, and the isError shapes.

use rmcp::model::{CallToolResult, ContentBlock};
use serde_json::{Map, Value, json};

/// The ledger a result belongs to (spec 3-2).
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerInfo {
    pub id: i64,
    pub name: String,
    pub role: crate::auth::ledger::LedgerRole,
    /// "active" | "explicit" | "draft"
    pub source: &'static str,
    /// the grant's active ledger id (for the "確定先" note)
    pub active_id: Option<i64>,
}

impl LedgerInfo {
    /// The envelope `ledger` object (spec 3-2, TASK-20): `{id, name, source,
    /// role}` — `role` is the caller's own role on this ledger.
    pub fn json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "source": self.source,
            "role": self.role.as_str(),
        })
    }

    /// Lines every content text carries (spec 3-2, 3-3; spec_auth 6-3, 6-4).
    pub fn text_suffix(&self) -> String {
        match self.source {
            "explicit" => format!("（一時指定: 家計簿 {}）", self.name),
            "draft" if self.active_id != Some(self.id) => {
                format!("確定先: {}（選択中の家計簿とは異なります）", self.name)
            }
            _ => format!("家計簿: {}", self.name),
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Warning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

impl Warning {
    pub fn new(code: &str, message: impl Into<String>, detail: Option<Value>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            detail,
        }
    }
}

/// Build the envelope object.
pub fn envelope(
    view: &str,
    ledger: Option<&LedgerInfo>,
    warnings: &[Warning],
    body: Value,
) -> Value {
    let mut obj = Map::new();
    obj.insert("view".into(), json!(view));
    obj.insert(
        "ledger".into(),
        ledger.map_or(Value::Null, LedgerInfo::json),
    );
    if !warnings.is_empty() {
        obj.insert("warnings".into(), json!(warnings));
    }
    if let Value::Object(b) = body {
        for (k, v) in b {
            obj.insert(k, v);
        }
    }
    Value::Object(obj)
}

fn with_meta(mut r: CallToolResult, meta: Option<Value>) -> CallToolResult {
    if let Some(Value::Object(m)) = meta
        && !m.is_empty()
    {
        r.meta = Some(rmcp::model::MetaObject(m));
    }
    r
}

/// Success (isError: false).
pub fn ok(text: String, structured: Value, meta: Option<Value>) -> CallToolResult {
    let mut r = CallToolResult::success(vec![ContentBlock::text(text)]);
    r.structured_content = Some(structured);
    with_meta(r, meta)
}

/// Tool error with an optional structured body (e.g. the latest draft).
pub fn err_with(text: String, structured: Option<Value>, meta: Option<Value>) -> CallToolResult {
    let mut r = CallToolResult::error(vec![ContentBlock::text(text)]);
    r.structured_content = structured;
    with_meta(r, meta)
}

pub fn err(text: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(text.into())])
}

/// Missing / foreign / non-existent ids look the same (spec 4).
pub fn not_found() -> CallToolResult {
    err("見つかりません。ID を確認してください（一覧・検索 tool で探せます）。")
}

pub fn viewer_only() -> CallToolResult {
    err("この家計簿は閲覧のみです。")
}

/// Input validation error: items + how to fix (spec 4).
pub fn invalid(errs: &[String]) -> CallToolResult {
    let mut t = String::from("入力エラーです。次を直して再度呼び出してください:\n");
    for e in errs {
        t.push_str("- ");
        t.push_str(e);
        t.push('\n');
    }
    err(t.trim_end().to_string())
}

/// Internal error: fixed text + correlation id, detail only in the log.
pub fn internal(e: impl std::fmt::Display) -> CallToolResult {
    let id = crate::auth::tokens::to_hex(&crate::auth::tokens::random_token()[..4]);
    tracing::error!(correlation_id = %id, error = %e, "tool internal error");
    err(format!("一時的なエラーが発生しました（相関ID: {id}）。"))
}

/// Short Japanese yen formatting for content text.
pub fn yen(v: i64) -> String {
    let s = v.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if v < 0 {
        format!("-{out}円")
    } else {
        format!("{out}円")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::ledger::LedgerRole;

    // [covers:mcp-result.envelope-shape]
    #[test]
    fn envelope_and_ledger_text() {
        let l = LedgerInfo {
            id: 3,
            name: "家族".into(),
            role: LedgerRole::Owner,
            source: "draft",
            active_id: Some(1),
        };
        let v = envelope(
            "draft",
            Some(&l),
            &[Warning::new("w", "m", None)],
            json!({"x": 1}),
        );
        assert_eq!(v["view"], "draft");
        assert_eq!(
            v["ledger"],
            json!({"id": 3, "name": "家族", "source": "draft", "role": "owner"})
        );
        assert_eq!(v["warnings"][0]["code"], "w");
        assert_eq!(v["x"], 1);
        assert!(
            l.text_suffix()
                .contains("確定先: 家族（選択中の家計簿とは異なります）")
        );
        let ex = LedgerInfo {
            source: "explicit",
            ..l.clone()
        };
        assert!(ex.text_suffix().contains("（一時指定: 家計簿 家族）"));
        let same = LedgerInfo {
            active_id: Some(3),
            ..l
        };
        assert_eq!(same.text_suffix(), "家計簿: 家族");
        let none = envelope("account", None, &[], json!({}));
        assert!(none["ledger"].is_null() && none.get("warnings").is_none());
        assert_eq!(yen(1234567), "1,234,567円");
        assert_eq!(yen(-20), "-20円");
    }
}
