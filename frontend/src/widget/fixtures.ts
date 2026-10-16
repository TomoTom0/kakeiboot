// Sample structuredContent / _meta shaped after docs/spec_mcp-tools.md §7 and §10.
// Used by the development mock host and by unit tests (not by the production widget).
import type {
  DraftBatchEnvelope,
  DraftEnvelope,
  DraftListEnvelope,
  DraftView,
  ItemListEnvelope,
  ReceiptEnvelope,
  ReceiptListEnvelope,
  ReportKind,
  StatsEnvelope,
  WidgetMeta,
} from '@/shared/types'

export const MOCK_ORIGIN = 'http://localhost:40280'
export const mockImageUrl = (token: string) => `${MOCK_ORIGIN}/media/img/${token}`

const LEDGER = { id: 1, name: '我が家', source: 'active' as const }

export function sampleDraft(over: Partial<DraftView> = {}): DraftView {
  return {
    draft_id: 12,
    revision: 2,
    status: 'pending',
    input_kind: 'image',
    image: { status: 'attached', reason: null, display: '画像あり' },
    reported: { filename: 'IMG_0001.jpg', taken_at: '2026-10-12T18:03' },
    image_meta: {
      original_filename: 'IMG_0001.jpg',
      original_filename_source: 'download',
      taken_at: '2026-10-12T18:03:11',
      taken_at_source: 'exif',
    },
    payload: {
      store_name: 'スーパーみどり 駅前店',
      store_name_raw: 'ｽｰﾊﾟｰみどり駅前',
      store_category: 'スーパー',
      purchased_on: '2026-10-12',
      purchased_time: '18:01',
      tax_mode: 'inclusive',
      total_amount: 1280,
      tax_amount: 94,
      payment_method: 'credit_card',
      note: null,
      items: [
        { line_no: 1, name: '牛乳', amount: 248, tax_rate: 8, category: '食費/食料品', bbox: [0.1, 0.3, 0.8, 0.05] },
        { line_no: 2, name: 'たまご 10個', amount: 298, tax_rate: 8, category: '食費/食料品', bbox: [0.1, 0.36, 0.8, 0.05] },
        {
          line_no: 3,
          line_kind: 'discount',
          parent_line_no: 2,
          name: '値引',
          amount: -50,
          tax_rate: 8,
          category: '食費/食料品',
          bbox: [0.1, 0.41, 0.8, 0.04],
        },
        { line_no: 4, name: '食器用洗剤', amount: 328, tax_rate: 10, category: '雑貨', bbox: null },
        { line_no: 5, name: 'パン', amount: 456, tax_rate: 8, category: '食費/食料品' },
      ],
    },
    resolution: {
      store: { status: 'existing', store_id: 3 },
      categories: [
        { line_no: 1, input: '食費/食料品', status: 'ok', resolved: '食費/食料品' },
        { line_no: 2, input: '食費/食料品', status: 'ok', resolved: '食費/食料品' },
        { line_no: 3, input: '食費/食料品', status: 'ok', resolved: '食費/食料品' },
        { line_no: 4, input: '雑貨', status: 'unknown' },
        { line_no: 5, input: null, status: 'history', resolved: '食費/食料品' },
      ],
      items_total: 1280,
      total_diff: 0,
    },
    approved_receipt_id: null,
    possible_duplicates: [{ kind: 'receipt', id: 88, ledger: { id: 1, name: '我が家' }, match: 'content' }],
    expires_at: '2026-10-26T18:05:00+09:00',
    ...over,
  }
}

export function draftEnvelope(over: Partial<DraftView> = {}): DraftEnvelope {
  return { view: 'draft', ledger: { ...LEDGER, source: 'draft' }, draft: sampleDraft(over) }
}

export function draftBatchEnvelope(): DraftBatchEnvelope {
  const drafts = [
    sampleDraft(),
    sampleDraft({
      draft_id: 15,
      revision: 1,
      possible_duplicates: [],
      image: { status: 'unavailable', reason: 'chat_upload', display: '画像なし' },
    }),
  ]
  return {
    view: 'draft_batch',
    ledger: { ...LEDGER, source: 'draft' },
    batch_id: '01JBATCHWIDGET00000000',
    drafts,
    entry_draft_ids: drafts.map((d) => d.draft_id),
    rejected: [],
    images: [{ index: 0, outcome: 'attached', reason: null, draft_ids: drafts.map((d) => d.draft_id) }],
  }
}

export function draftMeta(draftId = 12): WidgetMeta {
  return {
    images: {
      draft_image: { url: mockImageUrl(`draft${draftId}token`), expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 },
    },
  }
}

/** `_meta` of create_receipt_drafts: per-draft initial image URLs (spec §7-22). */
export function draftBatchMeta(): WidgetMeta {
  return {
    images: {
      drafts: { 12: { url: mockImageUrl('draft12token'), expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 } },
    } as unknown as WidgetMeta['images'],
  }
}

export function draftListEnvelope(): DraftListEnvelope {
  return {
    view: 'draft_list',
    ledger: null,
    drafts: [
      {
        draft_id: 12,
        revision: 2,
        status: 'pending',
        ledger: { id: 1, name: '我が家' },
        store_name: 'スーパーみどり 駅前店',
        purchased_on: '2026-10-12',
        items_total: 1280,
        item_count: 5,
        image_status: 'attached',
        image_unavailable_reason: null,
        image_display: '画像あり',
        possible_duplicates: [{ kind: 'receipt', id: 88, ledger: { id: 1, name: '我が家' }, match: 'content' }],
        updated_at: '2026-10-12T18:05:00+09:00',
      },
      {
        draft_id: 15,
        revision: 1,
        status: 'pending',
        ledger: { id: 2, name: '実家' },
        store_name: null,
        purchased_on: null,
        items_total: 540,
        item_count: 2,
        image_status: 'unavailable',
        image_unavailable_reason: 'chat_upload',
        image_display: '画像なし',
        possible_duplicates: [],
        updated_at: '2026-10-13T09:00:00+09:00',
      },
    ],
  }
}

export function receiptEnvelope(receiptId = 88, deleted = false): ReceiptEnvelope {
  return {
    view: 'receipt',
    ledger: LEDGER,
    receipt: {
      receipt_id: receiptId,
      revision: 1,
      source: 'image',
      has_image: true,
      deleted_at: deleted ? '2026-10-13T10:00:00+09:00' : null,
      labels: [{ color: 'red', title: '旅行' }],
      store: { store_id: 3, name: 'スーパーみどり 駅前店', category: 'スーパー' },
      store_name_raw: 'ｽｰﾊﾟｰみどり駅前',
      purchased_on: '2026-10-11',
      purchased_time: '17:40',
      tax_mode: 'inclusive',
      total_amount: 900,
      tax_amount: 66,
      payment_method: 'cash',
      note: '特売日',
      items: [
        {
          item_id: 501,
          line_no: 1,
          line_kind: 'item',
          parent_item_id: null,
          name: 'りんご',
          name_raw: 'ﾘﾝｺﾞ',
          quantity: 3,
          unit: '個',
          unit_price: 150,
          amount: 450,
          amount_incl: 450,
          tax_rate: 8,
          category: '食費/食料品',
          category_source: 'model',
          bbox: [0.1, 0.3, 0.8, 0.05],
        },
        {
          item_id: 502,
          line_no: 2,
          line_kind: 'item',
          parent_item_id: null,
          name: 'ティッシュ',
          name_raw: null,
          quantity: 1,
          unit: null,
          unit_price: null,
          amount: 450,
          amount_incl: 450,
          tax_rate: 10,
          category: null,
          category_source: null,
          bbox: null,
        },
      ],
      items_total: 900,
      total_diff: 0,
      image: { width: 600, height: 1200, original_filename: 'IMG_0000.jpg', taken_at: '2026-10-11T17:41:00', taken_at_source: 'exif' },
      from_draft_id: 9,
      created_at: '2026-10-11T18:00:00+09:00',
      updated_at: '2026-10-11T18:00:00+09:00',
    },
  }
}

export function receiptMeta(receiptId = 88): WidgetMeta {
  return {
    images: {
      receipt_image: { url: mockImageUrl(`receipt${receiptId}token`), expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 },
    },
  }
}

export function receiptListEnvelope(): ReceiptListEnvelope {
  return {
    view: 'receipt_list',
    ledger: LEDGER,
    period_resolved: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
    total_count: 2,
    sum_amount: 2180,
    receipts: [
      {
        receipt_id: 88,
        purchased_on: '2026-10-11',
        purchased_time: '17:40',
        store_name: 'スーパーみどり 駅前店',
        amount: 900,
        item_count: 2,
        has_image: true,
        labels: [{ color: 'red', title: '旅行' }],
      },
      {
        receipt_id: 90,
        purchased_on: '2026-10-05',
        purchased_time: null,
        store_name: 'コンビニ北口',
        amount: 1280,
        item_count: 4,
        has_image: false,
        matched_items: [{ name: '牛乳', amount: 248 }],
        labels: [],
      },
    ],
    next_cursor: null,
  }
}

export function receiptListMeta(): WidgetMeta {
  return { images: { 'receipt:88': { url: mockImageUrl('thumb88token'), expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 } } }
}

export function itemListEnvelope(): ItemListEnvelope {
  return {
    view: 'item_list',
    ledger: LEDGER,
    period_resolved: null,
    total_count: 2,
    sum_amount: 496,
    items: [
      { item_id: 1, receipt_id: 90, purchased_on: '2026-10-05', store_name: 'コンビニ北口', name: '牛乳', quantity: 1, unit: null, unit_price: 248, amount_incl: 248, category: '食費/食料品' },
      { item_id: 2, receipt_id: 70, purchased_on: '2026-09-20', store_name: 'スーパーみどり 駅前店', name: '牛乳', quantity: 1, unit: null, unit_price: 248, amount_incl: 248, category: '食費/食料品' },
    ],
    next_cursor: null,
  }
}

export function statsEnvelope(report: ReportKind = 'monthly_overview', label = '2026年10月'): StatsEnvelope {
  const base = {
    view: 'stats' as const,
    ledger: LEDGER,
    report,
    period_resolved: { from: '2026-10-01', to: '2026-10-31', label },
    compare_period: { from: '2026-09-01', to: '2026-09-30', label: '2026年9月' },
    totals: { value: 52000, compare_value: 48000, diff: 4000, diff_pct: 8.3, receipts: 31 },
    notes: ['全体値引は未分類に含む'],
  }
  const byCategory = {
    id: 'by_category',
    title: '品目カテゴリ別',
    dims: ['category_top' as const],
    chart: 'bar_h' as const,
    rows: [
      { keys: [1], labels: ['食費'], value: 30000, compare_value: 28000, diff: 2000, share: 0.577 },
      { keys: [2], labels: ['日用品'], value: 12000, compare_value: 11000, diff: 1000, share: 0.231 },
      { keys: [null], labels: ['未分類'], value: 10000, compare_value: 9000, diff: 1000, share: 0.192 },
    ],
  }
  const trend = {
    id: 'monthly_trend',
    title: '月次推移',
    dims: ['month' as const],
    chart: 'bar_v' as const,
    rows: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((m, i) => ({
      keys: [m],
      labels: [`${Number(m.slice(5))}月`],
      value: [41000, 45000, 39000, 50000, 48000, 52000][i] ?? 0,
    })),
  }
  switch (report) {
    case 'monthly_overview':
      return {
        ...base,
        sections: [
          byCategory,
          {
            id: 'top_stores',
            title: '上位の店',
            dims: ['store'],
            chart: 'bar_h',
            rows: [
              { keys: [3], labels: ['スーパーみどり 駅前店'], value: 22000 },
              { keys: [4], labels: ['コンビニ北口'], value: 8000 },
            ],
          },
          trend,
        ],
      }
    case 'by_category':
      return { ...base, sections: [{ ...byCategory, chart: 'stacked_bar' }] }
    case 'by_store':
      return {
        ...base,
        sections: [
          {
            id: 'by_store',
            title: '店別',
            dims: ['store'],
            chart: 'bar_h',
            rows: [
              { keys: [3], labels: ['スーパーみどり 駅前店'], value: 22000 },
              { keys: [null], labels: ['その他'], value: 30000 },
            ],
            truncated_rows: 4,
          },
        ],
      }
    case 'monthly_trend':
      return { ...base, compare_period: null, sections: [{ ...trend, chart: 'line' }] }
    case 'by_payment_method':
      return {
        ...base,
        sections: [
          {
            id: 'by_payment_method',
            title: '支払方法別',
            dims: ['payment_method'],
            chart: 'table',
            rows: [
              { keys: ['credit_card'], labels: ['クレジットカード'], value: 40000, compare_value: 35000, diff: 5000 },
              { keys: ['cash'], labels: ['現金'], value: 12000, compare_value: 13000, diff: -1000 },
            ],
          },
        ],
      }
    case 'item_price_history':
      return {
        ...base,
        compare_period: null,
        sections: [
          {
            id: 'item_price_history',
            title: '牛乳の単価',
            dims: ['item'],
            chart: 'scatter_line',
            rows: [
              { keys: ['2026-08-02', 3], labels: ['8/2', 'スーパーみどり 駅前店'], value: 238 },
              { keys: ['2026-09-20', 3], labels: ['9/20', 'スーパーみどり 駅前店'], value: 248 },
              { keys: ['2026-10-05', 4], labels: ['10/5', 'コンビニ北口'], value: 268 },
            ],
          },
        ],
      }
  }
}
