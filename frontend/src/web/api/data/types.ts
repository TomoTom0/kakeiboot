// Web-side DTOs for the auxiliary data screens (categories, stores,
// receipts). They mirror docs/spec_mcp-tools.md 7-9 to 7-14; once the
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
  compare_value?: number
  diff?: number
  share?: number
}

export interface StatsSection {
  id: string
  title: string
  dims: string[]
  chart: string
  rows: StatsRow[]
  truncated_rows?: number
}

export type StatsReport =
  | 'monthly_overview'
  | 'by_category'
  | 'by_store'
  | 'by_payment_method'
  | 'monthly_trend'
  | 'item_price_history'

/** Query of GET /api/ledgers/{l}/stats. Period: month | year | from+to (or none = report default). */
export interface StatsQuery {
  report?: StatsReport
  month?: string
  year?: number
  from?: string
  to?: string
  category?: string
  store?: string
  /** exact store id (web-only, TASK-74 A1: not in the MCP summarize filters) */
  store_id?: number
  /** store category path ("大分類" or "大分類/小分類", TASK-74 A1) */
  store_category?: string
  item_query?: string
  /** label filter: receipts having ANY of these colors (OR, TASK-17) */
  label_colors?: LabelColor[]
}

/** Echo of the applied filters in a stats result (spec_mcp-tools.md 10). */
export interface StatsResultFilters {
  category?: string
  store?: string
  item_query?: string
  label_colors?: LabelColor[]
}

/** GET /api/ledgers/{l}/stats: summarize_spending result (spec_mcp-tools.md 10). */
export interface StatsResult {
  report: string | null
  period_resolved: { from: string; to: string; label: string }
  compare_period: { from: string; to: string; label: string } | null
  totals: {
    value: number
    compare_value: number | null
    diff: number | null
    diff_pct: number | null
    receipts: number
  }
  /** monthly_overview: categories / stores / trend (6 months, oldest first) */
  sections: StatsSection[]
  notes: string[]
  /** echo of the applied filters (label_colors etc., TASK-17) */
  filters?: StatsResultFilters | null
  /** monthly_overview only */
  daily_cumulative?: { date: string; value: number }[]
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
  /** Read-only aggregation (dashboard / analysis); same reports as summarize_spending. */
  getStats(ledgerId: number, query: StatsQuery): Promise<StatsResult>
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
