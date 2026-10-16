//! Lenient `receipt_image` / `receipt_images` handling (spec_mcp-tools.md
//! 5-3, TASK-18 1-4): the argument may be a file object, the `chat_upload...`
//! string some mobile clients send, any other string, null, or missing. Only
//! a well-formed file object leads to a fetch; everything else is an
//! image-less draft. `receipt_images` (create_receipt_drafts) accepts the
//! array form, a single object folded to length 1, or any of the lenient
//! whole-argument shapes.

use serde::Deserialize;
use serde_json::{Map, Value};

/// The `openai/fileParams` object.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OpenAIFile {
    pub download_url: String,
    pub file_id: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
}

/// `enum FileArg { File, Str, Null }` (serde untagged).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum FileArg {
    File(OpenAIFile),
    Str(String),
    Null,
}

/// What arrived in `receipt_image`.
#[derive(Debug, Clone, PartialEq)]
pub enum ImageArg {
    /// key absent
    Missing,
    /// JSON null
    Null,
    File(OpenAIFile),
    /// a string starting with `chat_upload` (openai-apps-sdk-examples#185)
    ChatUpload,
    /// any other string (`/mnt/data/...` etc.) or a malformed object
    Other,
}

impl ImageArg {
    /// Whether something that looks like an image reference was passed
    /// (used for the manual-input mix-up check).
    pub fn is_present(&self) -> bool {
        matches!(self, Self::File(_) | Self::ChatUpload | Self::Other)
    }

    /// `image_unavailable_reason` for the image-less creation path (I4).
    pub fn unavailable_reason(&self) -> &'static str {
        match self {
            Self::ChatUpload => "chat_upload",
            _ => "missing_arg",
        }
    }
}

/// Classify one value with the 1-tool rules (an array element of
/// `receipt_images` classifies each element the same way).
pub fn classify_value(v: &Value) -> ImageArg {
    match serde_json::from_value::<FileArg>(v.clone()) {
        Ok(FileArg::File(f)) if !f.download_url.is_empty() && !f.file_id.is_empty() => {
            ImageArg::File(f)
        }
        Ok(FileArg::Str(s)) if s.starts_with("chat_upload") => ImageArg::ChatUpload,
        Ok(FileArg::Null) => ImageArg::Null,
        _ => ImageArg::Other,
    }
}

pub fn classify(args: &Map<String, Value>, key: &str) -> ImageArg {
    let Some(v) = args.get(key) else {
        return ImageArg::Missing;
    };
    classify_value(v)
}

/// What arrived in `receipt_images` (TASK-18 1-4).
#[derive(Debug, Clone, PartialEq)]
pub enum ImageList {
    /// key absent, JSON null or any other non-array / non-object shape:
    /// every image entry becomes U(missing_arg)
    Missing,
    /// the whole argument is a `chat_upload...` string: U(chat_upload)
    ChatUpload,
    /// an array (a single object folds to length 1), classified per element
    Items(Vec<ImageArg>),
}

impl ImageList {
    pub fn classify(args: &Map<String, Value>, key: &str) -> Self {
        let Some(v) = args.get(key) else {
            return Self::Missing;
        };
        if v.is_array() {
            return Self::Items(v.as_array().unwrap().iter().map(classify_value).collect());
        }
        match classify_value(v) {
            ImageArg::File(f) => Self::Items(vec![ImageArg::File(f)]),
            ImageArg::ChatUpload => Self::ChatUpload,
            ImageArg::Null | ImageArg::Other | ImageArg::Missing => Self::Missing,
        }
    }

    /// The per-element classification, when the argument was an array.
    pub fn items(&self) -> Option<&[ImageArg]> {
        match self {
            Self::Items(v) => Some(v),
            _ => None,
        }
    }

    /// Which `receipt_images` index an entry's `image_index` points at.
    /// Out-of-range indexes, an omitted index with 2+ image entries and every
    /// non-array shape resolve to None (U(missing_arg)); an omitted index with
    /// exactly one image entry resolves to index 0.
    pub fn resolve_index(&self, index: Option<i64>, sole_image_entry: bool) -> Option<usize> {
        let v = self.items()?;
        match index {
            Some(i) if i >= 0 && (i as usize) < v.len() => Some(i as usize),
            Some(_) => None,
            None if sole_image_entry && !v.is_empty() => Some(0),
            None => None,
        }
    }

    /// The [`ImageArg`] an entry refers to after resolving its `image_index`.
    pub fn resolve(&self, index: Option<i64>, sole_image_entry: bool) -> ImageArg {
        match self {
            Self::Items(v) => match self.resolve_index(index, sole_image_entry) {
                Some(i) => v[i].clone(),
                None => ImageArg::Missing,
            },
            Self::ChatUpload => ImageArg::ChatUpload,
            Self::Missing => ImageArg::Missing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(v: Value) -> ImageArg {
        classify(v.as_object().unwrap(), "receipt_image")
    }

    // [covers:mcp-image.file-arg-lenient]
    #[test]
    fn lenient_classification() {
        let f = c(
            json!({"receipt_image": {"download_url": "https://x/y", "file_id": "file_1", "mime_type": "image/jpeg"}}),
        );
        assert!(matches!(f, ImageArg::File(ref o) if o.file_id == "file_1"));
        assert_eq!(
            c(json!({"receipt_image": "chat_upload_abc"})),
            ImageArg::ChatUpload
        );
        assert_eq!(
            c(json!({"receipt_image": "/mnt/data/x.jpg"})),
            ImageArg::Other
        );
        assert_eq!(c(json!({"receipt_image": null})), ImageArg::Null);
        assert_eq!(c(json!({})), ImageArg::Missing);
        // object without required fields is not a file
        assert_eq!(
            c(json!({"receipt_image": {"file_id": "f"}})),
            ImageArg::Other
        );
        assert_eq!(c(json!({"receipt_image": 42})), ImageArg::Other);
        assert_eq!(ImageArg::ChatUpload.unavailable_reason(), "chat_upload");
        assert_eq!(ImageArg::Null.unavailable_reason(), "missing_arg");
        assert!(!ImageArg::Null.is_present() && !ImageArg::Missing.is_present());
    }
}
