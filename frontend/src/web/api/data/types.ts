// Web-side DTOs for the auxiliary data screens (categories, stores,
// receipts). They mirror docs/spec/spec_mcp-tools.md 7-9 to 7-14; once the
// backend generates TS types with ts-rs into src/shared/types/ (spec 12),
// replace these with the generated ones.

import type { Label, LabelColor } from '@/shared/labels'

export type { Label, LabelColor }

export type CategoryKind = 'item' | 'store'
export type PaymentMethod =
  | 'cash'
  | 'credit_card'
  | 'debit_card'
  | 'e_money'
  | 'qr_code'
  | 'point'
  | 'gift_card'
  | 'bank_transfer'
  | 'other'

export interface CategoryNode {
  id: number
  name: string
  archived: boolean
  children: CategoryNode[]
}

export interface Catalog {
  item_categories: CategoryNode[]
  store_categories: CategoryNode[]
}

export interface ManageCategoryInput {
  kind: CategoryKind
  action: 'create' | 'rename' | 'move' | 'archive' | 'unarchive'
  /** target path "大分類" or "大分類/小分類" (the new path for create) */
  category: string
  new_name?: string
  /** move: new parent path, null = make it a top-level category */
  new_parent?: string | null
}

export interface ManageCategoryResult {
  category: { id: number; path: string; archived: boolean }
  created: boolean
}

export interface StoreRow {
  store_id: number
  name: string
  category: string | null
  receipt_count: number
  last_purchased_on: string | null
}

export interface UpdateStoreInput {
  name?: string
  category?: string | null
}

export interface UpdateStoreResult {
  store: { store_id: number; name: string; category: string | null }
  before: { name: string; category: string | null }
}

export interface MergeStoresResult {
  store: StoreRow
  merged_from: { store_id: number; name: string }
  moved_receipts: number
}

export interface ReceiptListQuery {
  from?: string
  to?: string
  store?: string
  /** cross-field search term: item name OR store name (web /search) */
  q?: string
  /** exact store filter (web only; `store` stays the name partial match) */
  store_id?: number
  /** category path ("食費" includes its children) or "未分類" */
  category?: string
  /** item name (partial match) */
  item_query?: string
  /** exact payment-method filter (web only, TASK-65) */
  payment_method?: PaymentMethod
  /** label filter: receipts having ANY of these colors (OR, TASK-17) */
  label_colors?: LabelColor[]
  include_deleted?: boolean
  limit?: number
  cursor?: string
}

export interface ReceiptSummary {
  receipt_id: number
  purchased_on: string | null
  purchased_time: string | null
  store_name: string | null
  amount: number
  item_count: number
  has_image: boolean
  deleted_at: string | null
  /** labels assigned to the receipt (TASK-17; empty when none) */
  labels?: Label[]
}

export interface ReceiptListResult {
  total_count: number
  sum_amount: number
  receipts: ReceiptSummary[]
  next_cursor: string | null
}

/** Query of GET /api/ledgers/{l}/items (the /search item tab). q matches item names only. */
export interface ItemListQuery {
  from?: string
  to?: string
  q?: string
  category?: string
  store_id?: number
  label_colors?: LabelColor[]
  include_deleted?: boolean
  limit?: number
  cursor?: string
}

/** Row of GET /api/ledgers/{l}/items: one receipt item with its receipt's date / store (spec_mcp-tools.md 7-8 mode:"items"). */
export interface ItemSummary {
  item_id: number
  receipt_id: number
  purchased_on: string | null
  store_id: number | null
  store_name: string | null
  name: string
  quantity: number | null
  unit: string | null
  unit_price: number | null
  amount_incl: number
  category: string | null
}

export interface ItemsListResult {
  total_count: number
  sum_amount: number
  items: ItemSummary[]
  next_cursor: string | null
}

export interface ReceiptItem {
  item_id: number
  line_no: number
  line_kind: 'item' | 'discount'
  parent_item_id: number | null
  name: string
  name_raw: string | null
  quantity: number
  unit: string | null
  unit_price: number | null
  amount: number
  amount_incl: number
  tax_rate: 0 | 8 | 10 | null
  category: string | null
  category_source: 'model' | 'history' | 'user' | null
  bbox: [number, number, number, number] | null
}

export interface ReceiptView {
  receipt_id: number
  revision: number
  source: 'image' | 'manual'
  has_image: boolean
  deleted_at: string | null
  /** labels assigned to the receipt (TASK-17; empty when none) */
  labels?: Label[]
  store: { store_id: number; name: string; category: string | null } | null
  store_name_raw: string | null
  purchased_on: string | null
  purchased_time: string | null
  tax_mode: 'inclusive' | 'exclusive' | null
  total_amount: number | null
  tax_amount: number | null
  payment_method: PaymentMethod | null
  note: string | null
  items: ReceiptItem[]
  items_total: number
  total_diff: number | null
  image: null | {
    width: number
    height: number
    original_filename: string | null
    taken_at: string | null
    taken_at_source: string | null
  }
  /** Web-only field: short-lived /media/img/<token> URL (spec 11-5); null when
   *  the receipt has no image or it is logically deleted. */
  image_url: null | { url: string; expires_at: string; width: number; height: number }
  from_draft_id: number | null
  created_at: string
  updated_at: string
}

export interface ReceiptSet {
  store_name?: string
  store_category?: string | null
  purchased_on?: string | null
  purchased_time?: string | null
  tax_mode?: 'inclusive' | 'exclusive' | null
  total_amount?: number | null
  tax_amount?: number | null
  payment_method?: PaymentMethod | null
  note?: string | null
}

export interface ReceiptItemPatch {
  item_id?: number
  line_no?: number
  name?: string
  amount?: number
  quantity?: number
  category?: string | null
  tax_rate?: 0 | 8 | 10 | null
}

export interface UpdateReceiptInput {
  revision: number
  set?: ReceiptSet
  upsert_items?: ReceiptItemPatch[]
  delete_item_ids?: number[]
}

export interface UpdateReceiptResult {
  receipt: ReceiptView
  changed: string[]
}

export interface DeleteReceiptInput {
  confirm?: boolean
  revision?: number
  restore?: boolean
}

export interface DeleteReceiptResult {
  receipt_id: number
  revision: number
  deleted_at: string | null
  purge_after: string | null
  preview?: { store_name: string | null; purchased_on: string | null; amount: number; item_count: number }
}

export interface StatsRow {
  keys: (string | number | null)[]
  labels: string[]
  value: number
  share?: number
}

// --- analysis API (TASK-89): GET /analysis, /analysis/trend, /analysis/item
//
// The three read-only aggregation endpoints behind the redesigned dashboard
// and the axis detail screens (design: tmp/tasks/tm-89/design_backend.md
// §1-A/B/C). The legacy GET /stats web route is gone — the MCP
// summarize_spending side keeps its own contract (spec_mcp-tools.md 10).

export type AnalysisAxis = 'category' | 'store' | 'item' | 'label' | 'payment_method'
export type AnalysisMetric = 'amount' | 'count' | 'unit'
export type AnalysisGranularity = 'day' | 'week' | 'month'

/** Filters shared by every analysis query (the former StatsQuery set minus
 *  `report`; label_colors is the OR filter of TASK-17). */
export interface AnalysisFilters {
  category?: string
  store?: string
  store_id?: number
  store_category?: string
  item_query?: string
  payment_method?: PaymentMethod
  label_colors?: LabelColor[]
}

/** Query of GET /api/ledgers/{l}/analysis. Period: month | year | from+to
 *  (default this month) — the selected period only, no comparison side. */
export interface AnalysisQuery extends AnalysisFilters {
  axis?: AnalysisAxis
  metric?: AnalysisMetric
  month?: string
  year?: number
  from?: string
  to?: string
  limit?: number
}

export interface AnalysisPeriod {
  from: string
  to: string
  label: string
}

/** Whole-filter totals of the selected period. */
export interface AnalysisTotals {
  amount: number
  count: number
  /** amount / count (per receipt), 1-decimal, null when count = 0 */
  unit: number | null
  days: number
}

/** One axis value of the selected period's breakdown. */
export interface AnalysisRow {
  key: string | number | null
  label: string
  amount: number
  count: number
  unit: number | null
  /** metric value / axis total (label axis: duplicated receipts inflate the
   *  denominator; null on metric=unit). No folded "other" row — the client
   *  builds the rest row from truncated_rows and totals. */
  share: number | null
}

/** GET /api/ledgers/{l}/analysis: the period totals and the axis breakdown
 *  (Home and the axis detail in one fetch). */
export interface AnalysisResult {
  axis: AnalysisAxis
  metric: AnalysisMetric
  period: AnalysisPeriod
  totals: AnalysisTotals
  rows: AnalysisRow[]
  truncated_rows: number
  filters?: AnalysisFilters | null
}

/** Query of GET /api/ledgers/{l}/analysis/trend. granularity defaults to
 *  auto (<=62 days day / <=366 week / else month) but the frontend passes it
 *  explicitly — the display decision stays client-side. */
export interface AnalysisTrendQuery extends AnalysisFilters {
  axis?: AnalysisAxis
  metric?: AnalysisMetric
  granularity?: AnalysisGranularity
  month?: string
  year?: number
  from?: string
  to?: string
  /** number of stacked series kept (default 10; the rest is client-side) */
  limit?: number
}

/** GET /api/ledgers/{l}/analysis/trend: the stacked matrix. buckets are
 *  zero-filled ascending (day = date, week = its Monday, month = "YYYY-MM"). */
export interface AnalysisTrendResult {
  axis: AnalysisAxis
  metric: AnalysisMetric
  granularity: AnalysisGranularity
  period: AnalysisPeriod
  buckets: string[]
  /** top `limit` series by whole-period metric total; every other series is
   *  the client's rest segment (bucket_totals - series). values are null on
   *  metric=unit zero-fill buckets (no receipts that bucket) */
  series: { key: string | number | null; label: string; values: (number | null)[]; total: number }[]
  bucket_totals: (number | null)[]
  truncated_rows: number
}

/** Query of GET /api/ledgers/{l}/analysis/item: item_id or item_query
 *  (either required, item_id wins; the default period is last 12 months). */
export interface AnalysisItemQuery extends AnalysisFilters {
  item_id?: number
  item_query?: string
  month?: string
  year?: number
  from?: string
  to?: string
}

/** GET /api/ledgers/{l}/analysis/item: one item group's stats (the web
 *  counterpart of the widget item_price_history). */
export interface AnalysisItemResult {
  item: { item_id: number; name: string } | null
  period: AnalysisPeriod
  summary: {
    count: number
    amount: number
    /** absent when the period has no purchases (backend skip_serializing_if) */
    avg_unit_price?: number
    min_unit_price?: number
    max_unit_price?: number
    last_purchased_on?: string
    /** purchase store names in by_store order */
    stores: string[]
  }
  /** ascending purchase rows (stats_max_rows cap) */
  prices: {
    date: string
    store_id: number | null
    store_name: string | null
    unit_price: number
    quantity: number
    amount_incl: number
  }[]
  by_store: { store_id: number | null; store_name: string; count: number; amount: number; avg_unit_price: number }[]
  /** zero-filled "YYYY-MM" within the period */
  monthly: { ym: string; count: number; amount: number }[]
  truncated_rows: number
}

/**
 * Data API used by the web screens. Errors are thrown as ApiError
 * (404 not_found, 409 stale_revision, 400 <validation code>).
 */
export interface DataApi {
  readonly kind: 'mock' | 'http'
  getCatalog(ledgerId: number, includeArchived: boolean): Promise<Catalog>
  manageCategory(ledgerId: number, input: ManageCategoryInput): Promise<ManageCategoryResult>
  listStores(ledgerId: number, query?: string): Promise<StoreRow[]>
  updateStore(ledgerId: number, storeId: number, input: UpdateStoreInput): Promise<UpdateStoreResult>
  /** Irreversible: reassign receipts, register the old name as an alias, delete the source. */
  mergeStores(ledgerId: number, sourceId: number, intoId: number): Promise<MergeStoresResult>
  /** GET /analysis (TASK-89): period totals + axis breakdown. */
  getAnalysis(ledgerId: number, query: AnalysisQuery): Promise<AnalysisResult>
  /** GET /analysis/trend (TASK-89): the stacked trend matrix. */
  getAnalysisTrend(ledgerId: number, query: AnalysisTrendQuery): Promise<AnalysisTrendResult>
  /** GET /analysis/item (TASK-89): one item group's price stats. */
  getAnalysisItem(ledgerId: number, query: AnalysisItemQuery): Promise<AnalysisItemResult>
  listReceipts(ledgerId: number, query: ReceiptListQuery): Promise<ReceiptListResult>
  /** GET /api/ledgers/{l}/items: the item-level list behind the /search item tab (search_items). */
  searchItems(ledgerId: number, query: ItemListQuery): Promise<ItemsListResult>
  getReceipt(ledgerId: number, receiptId: number): Promise<ReceiptView>
  updateReceipt(ledgerId: number, receiptId: number, input: UpdateReceiptInput): Promise<UpdateReceiptResult>
  deleteReceipt(ledgerId: number, receiptId: number, input: DeleteReceiptInput): Promise<DeleteReceiptResult>
  /** Label definitions of the ledger: 5 colors in display order (TASK-17). */
  listLabels(ledgerId: number): Promise<LabelsResult>
  /** Set a label title (null clears it). Editor or above. */
  updateLabelTitle(ledgerId: number, color: LabelColor, input: LabelTitleInput): Promise<LabelTitleResult>
  /** Apply a label diff to one receipt (idempotent, no revision bump). */
  setReceiptLabels(ledgerId: number, receiptId: number, input: SetReceiptLabelsInput): Promise<SetReceiptLabelsResult>
  /** PATCH /api/ledgers/{l}: rename the ledger (editor or above). */
  renameLedger(ledgerId: number, input: { name: string }): Promise<{ id: number; name: string }>
  /** POST /api/ledgers/{l}/export: one consistent ledger snapshot as a JSON file (TASK-58). */
  exportLedger(ledgerId: number): Promise<Blob>
  /** POST /api/ledgers/import: create a fresh ledger from an export file body (TASK-58). */
  importLedger(payload: unknown): Promise<ImportOutcome>
}

/** POST /api/ledgers/import result: the new ledger and what landed in it. */
export interface ImportOutcome {
  ledger: { id: number; name: string }
  counts: {
    receipts: number
    items: number
    images: number
    stores: number
    item_categories: number
    store_categories: number
  }
}

export interface LabelsResult {
  labels: Label[]
}

export interface LabelTitleInput {
  /** trimmed 1..20 chars; null = color only */
  title: string | null
}

export interface LabelTitleResult {
  label: Label
  changed: boolean
}

export interface SetReceiptLabelsInput {
  add?: LabelColor[]
  remove?: LabelColor[]
}

export interface SetReceiptLabelsResult {
  receipt_id: number
  labels: Label[]
}
