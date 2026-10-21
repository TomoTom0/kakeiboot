//! Shared serde DTOs. The canonical type list lives in
//! docs/spec_mcp-tools.md section 7-1; this module defines the subset needed
//! by the draft lifecycle (spec_data-model.md section 7). MCP tool I/O types
//! (DraftView etc.) are added in TASK-9.

use serde::{Deserialize, Serialize};

/// Payment method (app-side enum; stored as TEXT, spec_data-model.md section 6-1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    Cash,
    CreditCard,
    DebitCard,
    EMoney,
    QrCode,
    Point,
    GiftCard,
    BankTransfer,
    Other,
}

impl PaymentMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cash => "cash",
            Self::CreditCard => "credit_card",
            Self::DebitCard => "debit_card",
            Self::EMoney => "e_money",
            Self::QrCode => "qr_code",
            Self::Point => "point",
            Self::GiftCard => "gift_card",
            Self::BankTransfer => "bank_transfer",
            Self::Other => "other",
        }
    }
}

/// Printed tax mode. NULL (None) means unknown (spec_data-model.md section 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaxMode {
    Inclusive,
    Exclusive,
}

impl TaxMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Inclusive => "inclusive",
            Self::Exclusive => "exclusive",
        }
    }
}

/// Receipt line kind (spec_data-model.md section 6-2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineKind {
    #[default]
    Item,
    Discount,
}

impl LineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::Discount => "discount",
        }
    }
}

/// draft payload_json, shared with MCP tool I/O (spec_data-model.md section 7-1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_name_raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchased_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchased_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_mode: Option<TaxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_amount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_amount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payment_method: Option<PaymentMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Draft-stage labels (TASK-21): color keys chosen at intake, normalized
    /// to the palette order (spec_mcp-tools.md 7-1). None/empty = unlabeled;
    /// carried into `receipt_labels` by the approval transaction
    /// (spec_data-model.md 7-5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_colors: Option<Vec<super::labels::LabelColor>>,
    pub items: Vec<DraftItem>,
}

/// One printed line of a draft receipt (spec_mcp-tools.md section 7-1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftItem {
    pub line_no: i64,
    #[serde(default = "LineKind::default", skip_serializing_if = "is_default_kind")]
    pub line_kind: LineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_line_no: Option<i64>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_raw: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit_price: Option<i64>,
    pub amount: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tax_rate: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Normalized bounding box `[x, y, w, h]` in 0..1, image top-left origin
    /// (spec_mcp-tools.md section 7-1; stored as the bbox_* columns,
    /// spec_data-model.md section 6-2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[f64; 4]>,
    /// Where the category came from inside the draft (server-managed; model
    /// input is ignored). Becomes receipt_items.category_source at approval:
    /// None = model, Some(History) = history suggestion, Some(User) = changed
    /// by update_receipt_draft (spec_mcp-tools.md 7-2, 7-3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_source: Option<CategorySource>,
}

fn is_default_kind(kind: &LineKind) -> bool {
    *kind == LineKind::Item
}

/// Origin of a line's category (receipt_items.category_source,
/// spec_data-model.md 5-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategorySource {
    Model,
    History,
    User,
}

impl CategorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::History => "history",
            Self::User => "user",
        }
    }
}

// ---------------------------------------------------------------------------
// tool output views (spec_mcp-tools.md section 7)

/// `{ id, name }` of a ledger shown next to a row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerRef {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftImageView {
    pub status: String,
    pub reason: Option<String>,
    /// Display wording (spec 5-4): never asks for a re-upload.
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportedMeta {
    pub filename: Option<String>,
    pub taken_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageMetaView {
    pub original_filename: Option<String>,
    pub original_filename_source: Option<String>,
    pub taken_at: Option<String>,
    pub taken_at_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreResolution {
    /// "existing" | "new"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CategoryResolution {
    pub line_no: i64,
    pub input: Option<String>,
    /// "ok" | "unknown" | "history"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Resolution {
    pub store: StoreResolution,
    pub categories: Vec<CategoryResolution>,
    pub items_total: i64,
    pub total_diff: Option<i64>,
}

/// One possible duplicate (spec 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PossibleDuplicate {
    /// "draft" | "receipt"
    pub kind: String,
    pub id: i64,
    pub ledger: LedgerRef,
    /// "file_id" | "sha256" | "content"
    #[serde(rename = "match")]
    pub match_kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftView {
    pub draft_id: i64,
    pub revision: i64,
    pub status: String,
    /// "image" | "manual"
    pub input_kind: String,
    pub image: DraftImageView,
    pub reported: ReportedMeta,
    pub image_meta: Option<ImageMetaView>,
    pub payload: DraftPayload,
    /// Draft-stage labels with the ledger's titles in palette order
    /// (TASK-21, spec_mcp-tools.md 7-1): what approval will carry into
    /// `receipt_labels`. Always an array (empty when unlabeled).
    pub labels: Vec<Label>,
    pub resolution: Resolution,
    pub approved_receipt_id: Option<i64>,
    pub possible_duplicates: Vec<PossibleDuplicate>,
    /// JST ISO8601
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptStoreView {
    pub store_id: i64,
    pub name: String,
    pub category: Option<String>,
}

/// A color label of a receipt: the palette key plus the ledger's optional
/// title (`ledger_labels.title`, NULL = color only; spec_mcp-tools.md 7-1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Label {
    pub color: super::labels::LabelColor,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptItemView {
    pub item_id: i64,
    pub line_no: i64,
    pub line_kind: String,
    pub parent_item_id: Option<i64>,
    pub name: String,
    pub name_raw: Option<String>,
    pub quantity: f64,
    pub unit: Option<String>,
    pub unit_price: Option<i64>,
    pub amount: i64,
    pub amount_incl: i64,
    pub tax_rate: Option<i64>,
    pub category: Option<String>,
    pub category_source: Option<String>,
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptImageView {
    pub width: i64,
    pub height: i64,
    pub original_filename: Option<String>,
    pub taken_at: Option<String>,
    pub taken_at_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReceiptView {
    pub receipt_id: i64,
    pub revision: i64,
    pub source: String,
    pub has_image: bool,
    pub deleted_at: Option<String>,
    pub store: Option<ReceiptStoreView>,
    pub store_name_raw: Option<String>,
    pub purchased_on: String,
    pub purchased_time: Option<String>,
    pub tax_mode: Option<String>,
    pub total_amount: Option<i64>,
    pub tax_amount: Option<i64>,
    pub payment_method: Option<String>,
    pub note: Option<String>,
    /// Color labels assigned to the receipt (spec_mcp-tools.md 7-1, 7-9).
    /// Outside `revision`: label add/remove does not bump it.
    pub labels: Vec<Label>,
    pub items: Vec<ReceiptItemView>,
    pub items_total: i64,
    pub total_diff: Option<i64>,
    pub image: Option<ReceiptImageView>,
    pub from_draft_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// `{ from, to, label }` of a resolved period (spec 10).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeriodResolved {
    pub from: String,
    pub to: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatsTotals {
    pub value: i64,
    pub compare_value: Option<i64>,
    pub diff: Option<i64>,
    pub diff_pct: Option<f64>,
    pub receipts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatsRow {
    pub keys: Vec<serde_json::Value>,
    pub labels: Vec<String>,
    pub value: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare_value: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatsSection {
    pub id: String,
    pub title: String,
    pub dims: Vec<String>,
    pub chart: String,
    pub rows: Vec<StatsRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated_rows: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatsResult {
    pub report: Option<String>,
    pub period_resolved: PeriodResolved,
    pub compare_period: Option<PeriodResolved>,
    pub totals: StatsTotals,
    pub sections: Vec<StatsSection>,
    pub notes: Vec<String>,
    /// The applied filters, echoed back (omitted when no filter is applied).
    /// Named `label_colors` etc. — distinct from the section rows' `labels`
    /// (chart axis labels), spec_mcp-tools.md 10.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<super::stats::Filters>,
}
