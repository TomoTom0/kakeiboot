// MCP tool I/O types shared by the widget and the web SPA.
//
// Hand-written from docs/spec_mcp-tools.md §3-2 / §7 / §10 / §11. The backend
// generates the same shapes from `backend/src/domain/dto.rs` with ts-rs into
// this directory (spec §12); when that lands, replace this file with the
// generated output and keep `index.ts` re-exporting the same names.

import type { Label, LabelColor } from '../labels'

export type { Label, LabelColor }

export type Integer = number

export type Warning = { code: string; message: string; detail?: WarningDetail }
/** `detail` of duplicate_* warnings: the duplicate target (spec §6 "対象の draft / receipt ID 付き"). */
export type WarningDetail = {
  kind?: 'draft' | 'receipt'
  id?: Integer
  [key: string]: unknown
}

export type LedgerRef = { id: Integer; name: string; source: 'active' | 'explicit' | 'draft' }

export type Envelope<V extends string, B> = {
  view: V
  ledger: LedgerRef | null
  warnings?: Warning[]
} & B

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

export type BBox = [number, number, number, number]

export type DraftItem = {
  line_no: Integer
  line_kind?: 'item' | 'discount'
  parent_line_no?: Integer | null
  name: string
  name_raw?: string | null
  quantity?: number
  unit?: string | null
  unit_price?: Integer | null
  amount: Integer
  tax_rate?: 0 | 8 | 10 | null
  category?: string | null
  bbox?: BBox | null
}

export type DraftPayload = {
  store_name?: string | null
  store_name_raw?: string | null
  store_category?: string | null
  purchased_on?: string | null
  purchased_time?: string | null
  tax_mode?: 'inclusive' | 'exclusive' | null
  total_amount?: Integer | null
  tax_amount?: Integer | null
  payment_method?: PaymentMethod | null
  note?: string | null
  /** draft-stage labels, chosen at intake and carried into the receipt at
   *  approval (TASK-21; normalized to the palette order by the server) */
  label_colors?: LabelColor[] | null
  items: DraftItem[]
}

export type DraftStatus = 'pending' | 'approved' | 'discarded' | 'expired'
export type ImageStatus = 'none' | 'attached' | 'unavailable'
export type DuplicateMatch = 'file_id' | 'sha256' | 'content'

export type PossibleDuplicate = {
  kind: 'draft' | 'receipt'
  id: Integer
  ledger: { id: Integer; name: string }
  match: DuplicateMatch
}

export type DraftView = {
  draft_id: Integer
  revision: Integer
  status: DraftStatus
  input_kind: 'image' | 'manual'
  image: { status: ImageStatus; reason?: string | null; display: string }
  reported: { filename: string | null; taken_at: string | null }
  image_meta?: {
    original_filename: string | null
    original_filename_source: 'download' | 'model' | null
    taken_at: string | null
    taken_at_source: 'exif' | 'model' | null
  } | null
  payload: DraftPayload
  /** draft-stage labels with the ledger's titles, palette order (TASK-21;
   *  empty when unlabeled — older payloads omit it) */
  labels?: Label[]
  resolution: {
    store: { status: 'existing' | 'new'; store_id?: Integer }
    categories: {
      line_no: Integer
      input: string | null
      status: 'ok' | 'unknown' | 'history'
      resolved?: string
    }[]
    items_total: Integer
    total_diff: Integer | null
  }
  approved_receipt_id?: Integer | null
  possible_duplicates?: PossibleDuplicate[]
  expires_at: string
}

export type ReceiptItemView = {
  item_id: Integer
  line_no: Integer
  line_kind: 'item' | 'discount'
  parent_item_id: Integer | null
  name: string
  name_raw: string | null
  quantity: number
  unit: string | null
  unit_price: Integer | null
  amount: Integer
  amount_incl: Integer
  tax_rate: 0 | 8 | 10 | null
  category: string | null
  category_source: string | null
  bbox: BBox | null
}

export type ReceiptView = {
  receipt_id: Integer
  revision: Integer
  source: 'image' | 'manual'
  has_image: boolean
  deleted_at: string | null
  /** labels assigned to the receipt (TASK-17; empty when none) */
  labels?: Label[]
  store: { store_id: Integer; name: string; category: string | null } | null
  store_name_raw: string | null
  purchased_on: string
  purchased_time: string | null
  tax_mode: 'inclusive' | 'exclusive' | null
  total_amount: Integer | null
  tax_amount: Integer | null
  payment_method: PaymentMethod | null
  note: string | null
  items: ReceiptItemView[]
  items_total: Integer
  total_diff: Integer | null
  image: {
    width: Integer
    height: Integer
    original_filename: string | null
    taken_at: string | null
    taken_at_source: string | null
  } | null
  from_draft_id: Integer | null
  created_at: string
  updated_at: string
}

export type DraftListRow = {
  draft_id: Integer
  revision: Integer
  status: DraftStatus
  ledger: { id: Integer; name: string }
  store_name: string | null
  purchased_on: string | null
  items_total: Integer
  item_count: Integer
  image_status: ImageStatus
  image_unavailable_reason: string | null
  image_display: string
  possible_duplicates: PossibleDuplicate[]
  updated_at: string
}

export type PeriodResolved = { from: string; to: string; label: string }

export type ReceiptListRow = {
  receipt_id: Integer
  purchased_on: string
  purchased_time: string | null
  store_name: string | null
  amount: Integer
  item_count: Integer
  has_image: boolean
  matched_items?: { name: string; amount: Integer }[]
  /** labels assigned to the receipt (TASK-17; empty when none) */
  labels?: Label[]
}

export type ItemListRow = {
  item_id: Integer
  receipt_id: Integer
  purchased_on: string
  store_name: string | null
  name: string
  quantity: number
  unit: string | null
  unit_price: Integer | null
  amount_incl: Integer
  category: string | null
}

export type Period =
  | {
      preset:
        | 'this_month'
        | 'last_month'
        | 'this_year'
        | 'last_year'
        | 'last_3_months'
        | 'last_6_months'
        | 'last_12_months'
    }
  | { month: string }
  | { year: Integer }
  | { from: string; to: string }

export type PeriodPreset = Extract<Period, { preset: string }>['preset']

export type ReportKind =
  | 'monthly_overview'
  | 'by_category'
  | 'by_store'
  | 'monthly_trend'
  | 'by_payment_method'
  | 'item_price_history'

export type StatsFilters = {
  category?: string
  store?: string
  store_category?: string
  item_query?: string
  /** receipts having ANY of these label colors (OR, TASK-17) */
  label_colors?: LabelColor[]
}

export type ChartKind = 'bar_h' | 'bar_v' | 'line' | 'stacked_bar' | 'table' | 'scatter_line'
export type Dim = 'month' | 'category_top' | 'category' | 'store' | 'payment_method' | 'item'

export type StatsRow = {
  keys: (string | Integer | null)[]
  labels: string[]
  value: Integer
  compare_value?: Integer | null
  diff?: Integer | null
  share?: number
}

export type StatsSection = {
  id: string
  title: string
  dims: Dim[]
  chart: ChartKind
  rows: StatsRow[]
  truncated_rows?: Integer
}

export type DraftEnvelope = Envelope<
  'draft',
  {
    draft: DraftView
    receipt_id?: Integer
    idempotent_hit?: boolean
    changed?: string[]
    reopened_from?: Integer
  }
>
export type DraftListEnvelope = Envelope<'draft_list', { drafts: DraftListRow[] }>

/** Entry not saved by create_receipt_drafts (#20): the same pre-checks as the single tool (TASK-18). */
export type DraftBatchRejected = { entry_index: Integer; errors: string[] }

/** Per-image record of create_receipt_drafts (#20). `unreferenced` images are never fetched nor saved. */
export type DraftBatchImage = {
  index: Integer
  outcome: 'attached' | 'unavailable' | 'unreferenced'
  reason?: string | null
  draft_ids: Integer[]
}

/** Per-item outcome of approve_receipt_drafts (#21; TASK-18 design 2-4). */
export type ApproveBatchOutcome =
  | 'approved'
  | 'idempotent'
  | 'stale_revision'
  | 'conflict'
  | 'invalid'
  | 'not_found'
  | 'forbidden'
export type ApproveBatchResult = {
  draft_id: Integer
  outcome: ApproveBatchOutcome
  receipt_id?: Integer | null
  revision: Integer
  message?: string
}

/** structuredContent of create_receipt_drafts (#20) and approve_receipt_drafts (#21). */
export type DraftBatchEnvelope = Envelope<
  'draft_batch',
  {
    /** ULID of the creating call; null on approve_receipt_drafts results. */
    batch_id: string | null
    drafts: DraftView[]
    entry_draft_ids?: (Integer | null)[]
    rejected?: DraftBatchRejected[]
    images?: DraftBatchImage[]
    /** Present on approve_receipt_drafts (#21) results. */
    results?: ApproveBatchResult[]
  }
>
export type ReceiptEnvelope = Envelope<'receipt', { receipt: ReceiptView; changed?: string[] }>
export type ReceiptListEnvelope = Envelope<
  'receipt_list',
  {
    period_resolved: PeriodResolved | null
    total_count: Integer
    sum_amount: Integer
    receipts: ReceiptListRow[]
    next_cursor: string | null
  }
>
export type ItemListEnvelope = Envelope<
  'item_list',
  {
    period_resolved: PeriodResolved | null
    total_count: Integer
    sum_amount: Integer
    items: ItemListRow[]
    next_cursor: string | null
  }
>
export type StatsEnvelope = Envelope<
  'stats',
  {
    report: ReportKind | null
    /** Echo of the applied filters (spec §10), incl. label_colors (TASK-17). */
    filters?: StatsFilters | null
    period_resolved: PeriodResolved
    compare_period?: PeriodResolved | null
    totals: {
      value: Integer
      compare_value?: Integer | null
      diff?: Integer | null
      diff_pct?: number | null
      receipts: Integer
    }
    sections: StatsSection[]
    notes: string[]
  }
>
export type ImagesEnvelope = Envelope<'images', Record<string, never>>

/** structuredContent of label_receipts (TASK-17 tool #19; widget does not render it). */
export type LabelChangeEnvelope = Envelope<
  'label_change',
  {
    receipts: { receipt_id: Integer; labels: Label[] }[]
    skipped: { receipt_id: Integer; reason: 'not_found' | 'deleted' }[]
  }
>

/** structuredContent of every tool that draws the widget (spec §11-2). */
export type WidgetEnvelope =
  | DraftEnvelope
  | DraftListEnvelope
  | DraftBatchEnvelope
  | ReceiptEnvelope
  | ReceiptListEnvelope
  | ItemListEnvelope
  | StatsEnvelope

export type WidgetView = WidgetEnvelope['view']

/** Short-lived image URL handed through `_meta` (spec §7-2 / §7-20 / §11-5). */
export type ImageRef = { url: string; expires_at: string; width: Integer; height: Integer }

/** Result `_meta` read only by the widget (spec §3-4). */
export type WidgetMeta = {
  images?: Record<string, ImageRef | null | undefined>
  [key: string]: unknown
}

/** Tool names the widget calls via `callTool` (model + app or app-only, spec §2). */
export type WidgetCallableTool =
  | 'approve_receipt_draft'
  | 'approve_receipt_drafts'
  | 'get_receipt_drafts'
  | 'get_receipt'
  | 'summarize_spending'
  | 'refresh_widget_images'
