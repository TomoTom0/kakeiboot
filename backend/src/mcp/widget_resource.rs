//! The widget template resource (spec_mcp-tools.md 11-1, 11-4): one
//! single-file HTML served as `ui://budget-book/widget-<hash>.html`, where
//! `<hash>` is the content hash of the built HTML. The same URI is used in
//! the tool descriptors (`ui.resourceUri` / `openai/outputTemplate`).

use std::path::Path;

use serde_json::{Value, json};

/// MIME type of MCP Apps HTML templates.
pub const WIDGET_MIME: &str = "text/html;profile=mcp-app";

const PLACEHOLDER: &str = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>budget-book</title></head><body><p>widget は未ビルドです（frontend の build 後に再起動してください）。</p></body></html>";

#[derive(Debug, Clone)]
pub struct WidgetResource {
    pub uri: String,
    pub html: String,
    /// public origin of this server. Base of the img `resourceDomains` CSP
    /// and of the receipt web URL lines in tool content text (spec 3-3).
    pub origin: String,
}

impl WidgetResource {
    /// Read the built HTML (or a placeholder when it is not built yet).
    pub fn load(path: &Path, origin: &str) -> Self {
        let html = match std::fs::read_to_string(path) {
            Ok(h) => h,
            Err(_) => {
                tracing::warn!(path = %path.display(), "widget HTML not found; serving placeholder");
                PLACEHOLDER.to_string()
            }
        };
        Self::from_html(html, origin)
    }

    pub fn from_html(html: String, origin: &str) -> Self {
        let hash = crate::auth::tokens::to_hex(&crate::auth::tokens::sha256(html.as_bytes())[..6]);
        Self {
            uri: format!("ui://budget-book/widget-{hash}.html"),
            html,
            origin: origin.to_string(),
        }
    }

    /// The web deep link of a receipt shown in tool content text
    /// (spec_mcp-tools.md 3-3, TASK-80). Same `origin` as `resourceDomains`.
    pub fn receipt_web_url(&self, receipt_id: i64) -> String {
        format!("{}/receipts/{receipt_id}", self.origin)
    }

    /// Resource `_meta`: CSP (standard + openai twin), border, display modes.
    pub fn meta(&self) -> Value {
        json!({
            "ui": {
                "csp": { "connectDomains": [], "resourceDomains": [self.origin] },
                "prefersBorder": true,
            },
            "openai/widgetCSP": { "connect_domains": [], "resource_domains": [self.origin] },
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription": "家計簿の下書き・レシート・検索結果・集計を表示する。widget の内容をモデルが繰り返し説明する必要はない。",
            "openai/ui.availableDisplayModes": ["inline", "fullscreen"],
        })
    }

    pub fn list_json(&self) -> Value {
        json!({
            "resources": [{
                "uri": self.uri,
                "name": "budget-book-widget",
                "title": "家計簿 widget",
                "mimeType": WIDGET_MIME,
                "_meta": self.meta(),
            }]
        })
    }

    pub fn read_json(&self) -> Value {
        json!({
            "contents": [{
                "uri": self.uri,
                "mimeType": WIDGET_MIME,
                "text": self.html,
                "_meta": self.meta(),
            }]
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // [covers:mcp-tools.receipt-web-url-line]
    #[test]
    fn receipt_web_url_joins_origin_and_id() {
        let w = WidgetResource::from_html("x".into(), "http://localhost:40281");
        assert_eq!(w.receipt_web_url(7), "http://localhost:40281/receipts/7");
        assert_eq!(
            w.receipt_web_url(12345),
            "http://localhost:40281/receipts/12345"
        );
    }
}
