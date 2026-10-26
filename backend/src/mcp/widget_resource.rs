//! The widget template resource (spec_mcp-tools.md 11-1, 11-4): one
//! single-file HTML served at the stable URI `ui://budget-book/widget.html`,
//! independent of the HTML content so ChatGPT conversations keep working
//! across deploys. Legacy content-hash URIs (`widget-<hash>.html`, pre
//! TASK-106) are accepted as `resources/read` aliases (`is_legacy_hash_uri`).
//! The stable URI is used in the tool descriptors (`ui.resourceUri` /
//! `openai/outputTemplate`).

use std::path::Path;

use serde_json::{Value, json};

/// Stable resource URI of the widget template. Independent of the HTML
/// content so ChatGPT conversations keep working across deploys
/// (spec_mcp-tools.md 11-1, TASK-106).
pub const WIDGET_URI: &str = "ui://budget-book/widget.html";

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
        Self {
            uri: WIDGET_URI.to_string(),
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

    /// `resources/read` body. `requested_uri` is echoed in `contents[0].uri`
    /// (the alias path passes the legacy hash URI through unchanged).
    pub fn read_json(&self, requested_uri: &str) -> Value {
        json!({
            "contents": [{
                "uri": requested_uri,
                "mimeType": WIDGET_MIME,
                "text": self.html,
                "_meta": self.meta(),
            }]
        })
    }
}

/// Legacy content-hash resource URIs (`ui://budget-book/widget-<hash>.html`,
/// 12 lowercase hex chars = first 6 bytes of the sha256 of the HTML, pre
/// TASK-106). Served as an alias of the current template (spec 11-1) so
/// conversations holding an old URI keep rendering.
pub fn is_legacy_hash_uri(uri: &str) -> bool {
    let Some(rest) = uri.strip_prefix("ui://budget-book/widget-") else {
        return false;
    };
    let Some(hex) = rest.strip_suffix(".html") else {
        return false;
    };
    hex.len() == 12 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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

    // [covers:mcp-tools.widget-resource]
    #[test]
    fn stable_uri_is_content_independent() {
        let a = WidgetResource::from_html(
            "<!doctype html><body>build one</body>".into(),
            "http://localhost:40281",
        );
        let b = WidgetResource::from_html(
            "<!doctype html><body>a totally different build</body>".into(),
            "http://localhost:40281",
        );
        assert_eq!(a.uri, "ui://budget-book/widget.html", "stable URI");
        assert_eq!(a.uri, b.uri, "URI does not depend on the HTML content");
        let read = a.read_json(WIDGET_URI);
        assert_eq!(
            read["contents"][0]["uri"],
            json!("ui://budget-book/widget.html"),
            "read echoes the stable URI"
        );
    }

    // [covers:mcp-tools.widget-resource-alias]
    #[test]
    fn legacy_hash_uri_recognition() {
        for uri in [
            "ui://budget-book/widget-4e4f5a2a8f81.html",
            "ui://budget-book/widget-ab3275e3800d.html",
            "ui://budget-book/widget-000000000000.html",
        ] {
            assert!(is_legacy_hash_uri(uri), "legacy hash URI: {uri}");
        }
        for uri in [
            // 11 hex chars
            "ui://budget-book/widget-4e4f5a2a8f8.html",
            // 13 hex chars
            "ui://budget-book/widget-4e4f5a2a8f812.html",
            // uppercase hex
            "ui://budget-book/widget-4E4F5A2A8F81.html",
            // no extension
            "ui://budget-book/widget-4e4f5a2a8f81",
            // wrong prefix
            "ui://budget-book/other.html",
            // the stable URI itself: rejected at the prefix strip
            "ui://budget-book/widget.html",
            // 4 multi-byte chars = 12 bytes: passes the length check, rejected
            // by the hex byte predicate
            "ui://budget-book/widget-ああああ.html",
        ] {
            assert!(!is_legacy_hash_uri(uri), "not a legacy hash URI: {uri}");
        }
    }
}
