// In-memory DataApi used until the backend web adapter exists. Follows the
// documented semantics (spec_mcp-tools.md 7-10 / 7-11 / 7-13 / 7-14,
// spec_data-model.md 5-1 / 5-2) so the screens behave like the real thing:
// revision checks, preview / confirm delete, 2-level categories, merge.

import { ApiError } from '../http'
import type {
  AnalysisAxis,
  AnalysisFilters,
  AnalysisGranularity,
  AnalysisMetric,
  AnalysisRow,
  Catalog,
  CategoryKind,
  CategoryNode,
  DataApi,
  ItemSummary,
  Label,
  ReceiptItem,
  ReceiptSummary,
  ReceiptView,
  StoreRow,
} from './types'
import { LABEL_COLORS, MAX_LABEL_TITLE_CHARS, isLabelColor, labelColorsOf } from '@/shared/labels'
import type { LabelColor } from '@/shared/labels'
import { PAYMENT_LABEL } from '../../composables/labels'

interface Cat {
  id: number
  kind: CategoryKind
  name: string
  parentId: number | null
  archived: boolean
}

interface Store {
  id: number
  name: string
  category: string | null
  aliases: string[]
}

interface Ledger {
  cats: Cat[]
  stores: Store[]
  receipts: ReceiptView[]
  labels: Label[]
}

const PURGE_DAYS = 90

// richLabels (TASK-60 design_browser-extension.md §5): titles for the five
// seeded label definitions — color-name-free words in the unit-test fixture
// style (label-chip.test.ts TITLED uses 旅行 for red), mapped in
// LABEL_COLORS order.
const RICH_LABEL_TITLES = ['旅行', '仕事', '育児', '急ぎ', '保険'] as const

const titledLabels = (): Label[] => LABEL_COLORS.map((color, i) => ({ color, title: RICH_LABEL_TITLES[i]! }))

function nowIso(): string {
  return new Date().toISOString()
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString()
}

function jstMonth(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 7)
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const t = y * 12 + (m - 1) + delta
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

function monthEndOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** Monday of the ISO week containing d (same rule as the frontend helpers). */
function weekStartOf(d: string): string {
  const day = new Date(Date.parse(d)).getUTCDay() // 0 = Sunday
  const off = (day + 6) % 7
  return new Date(Date.parse(d) - off * 86_400_000).toISOString().slice(0, 10)
}

/** One decimal, half-up-ish via the same rounding the backend uses for f64. */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function shortDateOf(d: string): string {
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
}

function notFound(): never {
  throw new ApiError(404, 'not_found')
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

function item(id: number, line: number, name: string, amount: number, category: string | null): ReceiptItem {
  return {
    item_id: id,
    line_no: line,
    line_kind: amount < 0 ? 'discount' : 'item',
    parent_item_id: null,
    name,
    name_raw: name,
    quantity: 1,
    unit: null,
    unit_price: null,
    amount,
    amount_incl: amount,
    tax_rate: 8,
    category,
    category_source: 'model',
    bbox: null,
  }
}

function seedLedger(opts: { feed?: number; richLabels?: boolean; bareTags?: boolean } = {}): Ledger {
  let id = 1
  const cats: Cat[] = []
  const add = (kind: CategoryKind, name: string, parentId: number | null, archived = false) => {
    const c = { id: id++, kind, name, parentId, archived }
    cats.push(c)
    return c
  }
  const food = add('item', '食費', null)
  add('item', '食料品', food.id)
  add('item', '外食', food.id)
  add('item', '日用品', null)
  add('item', '交通費', null)
  add('item', '趣味', null, true)
  add('store', 'スーパー', null)
  add('store', 'コンビニ', null)
  add('store', 'ドラッグストア', null)
  const stores: Store[] = [
    { id: 1, name: 'Aマート', category: 'スーパー', aliases: [] },
    { id: 2, name: 'エーマート', category: null, aliases: [] },
    { id: 3, name: 'Bコンビニ', category: 'コンビニ', aliases: [] },
  ]
  const receipt = (
    rid: number,
    storeId: number,
    on: string,
    items: ReceiptItem[],
  ): ReceiptView => {
    const s = stores.find((x) => x.id === storeId)!
    const total = items.reduce((a, b) => a + b.amount_incl, 0)
    return {
      receipt_id: rid,
      revision: 1,
      source: 'image',
      has_image: false,
      deleted_at: null,
      labels: [],
      store: { store_id: s.id, name: s.name, category: s.category },
      store_name_raw: s.name,
      purchased_on: on,
      purchased_time: '18:30',
      tax_mode: 'inclusive',
      total_amount: total,
      tax_amount: null,
      payment_method: 'cash',
      note: null,
      items,
      items_total: total,
      total_diff: 0,
      image: null,
      image_url: null,
      from_draft_id: null,
      created_at: `${on}T19:00:00+09:00`,
      updated_at: `${on}T19:00:00+09:00`,
    }
  }
  const receipts = [
    // bareTags (TASK-60 design_browser-extension.md §9-1 alt-2): the
    // popover-shift spec needs the picker host at the tags row's left edge —
    // at both 390px and 360px the full tags row keeps the host near the
    // row's end (measured panel left 223 of 390, shift 0px), so this seed
    // strips 101 down (no tags, no assigned labels) to put a minimal host at
    // the row head: the panel's preferred minimum then exceeds the host and
    // crosses the 16px viewport margin. The default keeps the full tags +
    // image + red-label composition.
    opts.bareTags
      ? {
          ...receipt(101, 1, '2026-10-10', [
            item(1001, 1, '牛乳', 220, '食費/食料品'),
            item(1002, 2, 'パン', 180, '食費/食料品'),
          ]),
          payment_method: null,
          store: { store_id: 1, name: 'Aマート', category: null },
          labels: [],
        }
      : { ...receipt(101, 1, '2026-10-10', [
          item(1001, 1, '牛乳', 220, '食費/食料品'),
          item(1002, 2, 'パン', 180, '食費/食料品'),
        ]), has_image: true, labels: [{ color: 'red' as const, title: null }], image: { width: 1024, height: 2048, original_filename: 'receipt.jpg', taken_at: null, taken_at_source: null }, image_url: { url: 'https://localhost:40281/media/img/mock-token-101', expires_at: '2099-01-01T00:00:00+09:00', width: 1024, height: 2048 } },
    // richLabels (TASK-60 §5): receipt 102 carries all five labels so the
    // list-row spec has a 5-dot row; the default keeps 102 label-less
    opts.richLabels
      ? { ...receipt(102, 2, '2026-10-08', [item(1003, 1, '洗剤', 398, '日用品')]), labels: titledLabels() }
      : receipt(102, 2, '2026-10-08', [item(1003, 1, '洗剤', 398, '日用品')]),
    { ...receipt(103, 3, '2026-10-05', [item(1004, 1, 'おにぎり', 150, '食費/外食')]), labels: [{ color: 'blue' as const, title: null }] },
  ]
  // feed option (TASK-19 design_browser.md §2-6): extra receipts for the
  // real-browser feed tests — id 104..112, purchased_on one day later per id
  // (2026-10-11..19) so the descending order is 112..104, 101, 102, 103
  // (idx = 112 - id). The fixed 6-item composition with short names keeps
  // the 390px panel rows on one line, so panel heights do not depend on text
  // wrapping. Default (no option) leaves the 3 receipts above unchanged.
  let feedItemId = 2001
  for (let i = 0; i < (opts.feed ?? 0); i++) {
    const composition: Array<[name: string, amount: number]> = [
      ['牛乳', 220],
      ['食パン', 180],
      ['卵', 258],
      ['納豆', 98],
      ['バナナ', 198],
      ['豆腐', 148],
    ]
    receipts.push(
      receipt(
        104 + i,
        (i % 3) + 1,
        `2026-10-${String(11 + i).padStart(2, '0')}`,
        composition.map(([name, amount], line) => item(feedItemId++, line + 1, name, amount, '食費/食料品')),
      ),
    )
  }
  // fixed 5-color label definitions, title NULL = color only (TASK-17);
  // richLabels (TASK-60 §5) titles all five for the real-browser layout /
  // contrast specs — the default stays untitled so the unit fixtures hold
  const labels: Label[] = opts.richLabels ? titledLabels() : LABEL_COLORS.map((color) => ({ color, title: null }))
  return { cats, stores, receipts, labels }
}

export function createMockDataApi(opts: { feed?: number; richLabels?: boolean; bareTags?: boolean } = {}): DataApi {
  const ledgers = new Map<number, Ledger>()
  let seq = 5000

  const ledger = (id: number): Ledger => {
    let l = ledgers.get(id)
    if (!l) {
      l = seedLedger(opts)
      ledgers.set(id, l)
    }
    return l
  }

  const pathOf = (l: Ledger, c: Cat): string => {
    if (c.parentId === null) return c.name
    const p = l.cats.find((x) => x.id === c.parentId)
    return p ? `${p.name}/${c.name}` : c.name
  }

  const findPath = (l: Ledger, kind: CategoryKind, path: string): Cat | undefined => {
    const parts = path.split('/').map((s) => s.trim())
    const [top, sub] = parts
    const parent = l.cats.find((c) => c.kind === kind && c.parentId === null && c.name === top)
    if (!parent || parts.length > 2) return undefined
    if (sub === undefined) return parent
    return l.cats.find((c) => c.kind === kind && c.parentId === parent.id && c.name === sub)
  }

  const tree = (l: Ledger, kind: CategoryKind, includeArchived: boolean): CategoryNode[] => {
    const visible = (c: Cat) => includeArchived || !c.archived
    return l.cats
      .filter((c) => c.kind === kind && c.parentId === null && visible(c))
      .map((c) => ({
        id: c.id,
        name: c.name,
        archived: c.archived,
        children: l.cats
          .filter((x) => x.parentId === c.id && visible(x))
          .map((x) => ({ id: x.id, name: x.name, archived: x.archived, children: [] })),
      }))
  }

  const storeRow = (l: Ledger, s: Store): StoreRow => {
    const rs = l.receipts.filter((r) => r.store?.store_id === s.id && r.deleted_at === null)
    const last = rs
      .map((r) => r.purchased_on)
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1)
    return {
      store_id: s.id,
      name: s.name,
      category: s.category,
      receipt_count: rs.length,
      last_purchased_on: last ?? null,
    }
  }

  const receiptAmount = (r: ReceiptView) => r.total_amount ?? r.items_total

  const recompute = (r: ReceiptView) => {
    r.items_total = r.items.reduce((a, b) => a + b.amount_incl, 0)
    r.total_diff = r.total_amount === null ? null : r.total_amount - r.items_total
  }

  const summary = (r: ReceiptView): ReceiptSummary => ({
    receipt_id: r.receipt_id,
    purchased_on: r.purchased_on,
    purchased_time: r.purchased_time,
    store_name: r.store?.name ?? r.store_name_raw,
    amount: receiptAmount(r),
    item_count: r.items.length,
    has_image: r.has_image,
    deleted_at: r.deleted_at,
    labels: clone(r.labels ?? []),
  })

  // --- analysis helpers (TASK-89) ------------------------------------------
  // --- analysis (TASK-89): GET /analysis, /analysis/trend, /analysis/item.
  // Backend parity of design_backend.md §1-§3: the selected period only,
  // count is COUNT(DISTINCT receipt_id), the label axis double-counts a
  // receipt's multiple labels, and no folded "other" row is produced — the
  // rest row is the client's.
  type Fact = { r: ReceiptView; it: ReceiptItem; top: string }
  const factsOf = (lg2: Ledger, f: string, t: string, flt: AnalysisFilters): Fact[] =>
  lg2.receipts
  .filter((r) => r.deleted_at === null && (r.purchased_on ?? '') >= f && (r.purchased_on ?? '') <= t)
  .filter((r) => !flt.store || (r.store?.name ?? '').includes(flt.store))
  .filter((r) => !flt.store_id || r.store?.store_id === flt.store_id)
  .filter(
  (r) =>
  !flt.store_category ||
  (r.store?.category ?? '') === flt.store_category ||
  (r.store?.category ?? '').startsWith(`${flt.store_category}/`),
  )
  .filter(
  (r) => !flt.label_colors?.length || labelColorsOf(r.labels).some((c) => flt.label_colors!.includes(c)),
  )
  .filter((r) => !flt.payment_method || r.payment_method === flt.payment_method)
  .flatMap((r) =>
  r.items.map((it) => ({
  r,
  it,
  top: (it.category ?? '未分類').split('/')[0]!,
  })),
  )
  .filter((x) =>
  !flt.category
  ? true
  : flt.category === '未分類'
  ? x.it.category === null
  : x.it.category === flt.category || (x.it.category ?? '').startsWith(`${flt.category}/`),
  )
  .filter((x) => !flt.item_query || x.it.name.includes(flt.item_query))

  const AXES: AnalysisAxis[] = ['category', 'store', 'item', 'label', 'payment_method']
  const METRICS: AnalysisMetric[] = ['amount', 'count', 'unit']

  /** month | year | from+to (mutually exclusive) -> [from, to, kind]. */
  function parsePeriod(
  q: { month?: string; year?: number; from?: string; to?: string },
  last12Default = false,
  ): [string, string, 'month' | 'year' | 'days'] {
  if (q.month !== undefined) {
  if (!/^\d{4}-\d{2}$/.test(q.month)) throw new ApiError(400, 'invalid_request')
  return [`${q.month}-01`, monthEndOf(q.month), 'month']
  }
  if (q.year !== undefined) return [`${q.year}-01-01`, `${q.year}-12-31`, 'year']
  if (q.from !== undefined && q.to !== undefined) {
  if (q.from > q.to || !/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to))
  throw new ApiError(400, 'invalid_request')
  return [q.from, q.to, 'days']
  }
  if ((q.from !== undefined) !== (q.to !== undefined)) throw new ApiError(400, 'invalid_request')
  const tm = jstMonth(new Date())
  if (last12Default) return [`${shiftMonth(tm, -11)}-01`, monthEndOf(tm), 'days']
  return [`${tm}-01`, monthEndOf(tm), 'month']
  }
  const periodLabelOf = (kind: 'month' | 'year' | 'days', from: string, to: string): { from: string; to: string; label: string } =>
  kind === 'month'
  ? { from, to, label: `${Number(from.slice(0, 4))}年${Number(from.slice(5, 7))}月` }
  : kind === 'year'
  ? { from, to, label: `${from.slice(0, 4)}年` }
  : { from, to, label: `${shortDateOf(from)}〜${shortDateOf(to)}` }

  interface Agg {
  key: string | number | null
  label: string
  amount: number
  receipts: Set<number>
  }
  type Sel = (x: Fact) => { group: string; key: string | number | null; label: string }[]

  const selectOf = (axis: AnalysisAxis, lg2: Ledger, flt: AnalysisFilters): Sel => {
  if (axis === 'category') {
  // with a category filter the grouping drops to the item's direct
  // category (by_category parity); 未分類 keeps the top-level dim
  const narrow = !!flt.category && flt.category !== '未分類'
  return (x) => {
  if (narrow && x.it.category !== null) {
  return [{ group: x.it.category, key: findPath(lg2, 'item', x.it.category)?.id ?? null, label: x.it.category }]
  }
  return [
  {
  group: x.top,
  key: lg2.cats.find((c) => c.kind === 'item' && c.parentId === null && c.name === x.top)?.id ?? null,
  label: x.top,
  },
  ]
  }
  }
  if (axis === 'store')
  return (x) => [
  {
  group: x.r.store?.name ?? '店不明',
  key: x.r.store?.store_id ?? null,
  label: x.r.store?.name ?? '店不明',
  },
  ]
  // REVIEW-13 M-3 parity: the item axis groups by 品名 — same-name lines are
  // one item (key = label = the display name)
  if (axis === 'item') return (x) => [{ group: x.it.name, key: x.it.name, label: x.it.name }]
  if (axis === 'label') {
  // a receipt with several labels counts into every label row; a
  // label-less receipt lands on the 無ラベル row (key null)
  return (x) => {
  const colors = labelColorsOf(x.r.labels)
  if (colors.length === 0) return [{ group: '', key: null, label: 'ラベルなし' }]
  return colors.map((c) => ({
  group: c,
  key: c,
  label: lg2.labels.find((lb) => lb.color === c)?.title ?? c,
  }))
  }
  }
  return (x) => [
  x.r.payment_method
  ? { group: x.r.payment_method, key: x.r.payment_method, label: PAYMENT_LABEL[x.r.payment_method] }
  : { group: '支払方法不明', key: null, label: '支払方法不明' },
  ]
  }

  const aggregate = (sel: Sel, xs: Fact[]): Map<string, Agg> => {
  const map = new Map<string, Agg>()
  for (const x of xs) {
  for (const s of sel(x)) {
  const e = map.get(s.group) ?? { key: s.key, label: s.label, amount: 0, receipts: new Set<number>() }
  e.amount += x.it.amount_incl
  e.receipts.add(x.r.receipt_id)
  map.set(s.group, e)
  }
  }
  return map
  }

  const metricOfAgg = (a: Agg | undefined, metric: AnalysisMetric): number =>
  !a ? 0 : metric === 'amount' ? a.amount : metric === 'count' ? a.receipts.size : a.receipts.size ? round1(a.amount / a.receipts.size) : 0

  /** the period's axis rows: metric value desc, top limit, no folded row. */
  function breakdownOf(
  sel: Sel,
  metric: AnalysisMetric,
  cur: Fact[],
  limit: number,
  ): { rows: AnalysisRow[]; truncated: number } {
  const curAgg = aggregate(sel, cur)
  const axisTotal = [...curAgg.values()].reduce((a, e) => a + metricOfAgg(e, metric), 0)
  const rows: AnalysisRow[] = [...curAgg.values()].map((e) => {
  const count = e.receipts.size
  return {
  key: e.key,
  label: e.label,
  amount: e.amount,
  count,
  unit: count ? round1(e.amount / count) : null,
  share: metric === 'unit' ? null : axisTotal ? metricOfAgg(e, metric) / axisTotal : 0,
  }
  })
  rows.sort(
  (a, b) =>
  metric === 'amount' ? b.amount - a.amount : metric === 'count' ? b.count - a.count : (b.unit ?? 0) - (a.unit ?? 0),
  )
  return {
  rows: rows.slice(0, limit),
  truncated: rows.length - Math.min(rows.length, limit),
  }
  }

  // --- analysis (TASK-89): GET /analysis, /analysis/trend, /analysis/item ---
  const api: DataApi = {
    kind: 'mock',

    async getCatalog(l, includeArchived): Promise<Catalog> {
      const lg = ledger(l)
      return {
        item_categories: tree(lg, 'item', includeArchived),
        store_categories: tree(lg, 'store', includeArchived),
      }
    },

    async manageCategory(l, input) {
      const lg = ledger(l)
      const path = input.category.trim()
      if (input.action === 'create') {
        const parts = path.split('/').map((s) => s.trim())
        if (parts.length > 2 || parts.some((p) => p === '')) throw new ApiError(400, 'invalid_path')
        const existing = findPath(lg, input.kind, path)
        if (existing) {
          return { category: { id: existing.id, path: pathOf(lg, existing), archived: existing.archived }, created: false }
        }
        let parentId: number | null = null
        if (parts.length === 2) {
          const parent = findPath(lg, input.kind, parts[0]!)
          if (!parent) throw new ApiError(400, 'parent_not_found')
          parentId = parent.id
        }
        const c: Cat = { id: seq++, kind: input.kind, name: parts.at(-1)!, parentId, archived: false }
        lg.cats.push(c)
        return { category: { id: c.id, path: pathOf(lg, c), archived: false }, created: true }
      }
      const target = findPath(lg, input.kind, path) ?? notFound()
      switch (input.action) {
        case 'rename': {
          const name = (input.new_name ?? '').trim()
          if (!name || name.includes('/')) throw new ApiError(400, 'invalid_name')
          const clash = lg.cats.some(
            (c) => c.kind === target.kind && c.parentId === target.parentId && c.name === name && c.id !== target.id,
          )
          if (clash) throw new ApiError(409, 'name_conflict')
          target.name = name
          break
        }
        case 'move': {
          const np = input.new_parent ?? null
          let parentId: number | null = null
          if (np !== null) {
            const parent = findPath(lg, input.kind, np)
            if (!parent || parent.parentId !== null) throw new ApiError(400, 'parent_not_found')
            if (parent.id === target.id) throw new ApiError(400, 'invalid_depth')
            if (lg.cats.some((c) => c.parentId === target.id)) throw new ApiError(400, 'invalid_depth')
            parentId = parent.id
          }
          const clash = lg.cats.some(
            (c) => c.kind === target.kind && c.parentId === parentId && c.name === target.name && c.id !== target.id,
          )
          if (clash) throw new ApiError(409, 'name_conflict')
          target.parentId = parentId
          break
        }
        case 'archive':
          target.archived = true
          break
        case 'unarchive':
          target.archived = false
          break
      }
      return { category: { id: target.id, path: pathOf(lg, target), archived: target.archived }, created: false }
    },

    async listStores(l, query) {
      const lg = ledger(l)
      const q = (query ?? '').trim()
      return lg.stores.filter((s) => !q || s.name.includes(q)).map((s) => storeRow(lg, s))
    },

    async updateStore(l, storeId, input) {
      const lg = ledger(l)
      const s = lg.stores.find((x) => x.id === storeId) ?? notFound()
      const before = { name: s.name, category: s.category }
      if (input.name !== undefined) {
        const name = input.name.trim()
        if (!name) throw new ApiError(400, 'invalid_name')
        s.name = name
      }
      if (input.category !== undefined) {
        if (input.category !== null && !findPath(lg, 'store', input.category)) {
          throw new ApiError(400, 'unknown_category')
        }
        s.category = input.category
      }
      for (const r of lg.receipts) {
        if (r.store?.store_id === s.id) r.store = { store_id: s.id, name: s.name, category: s.category }
      }
      return { store: { store_id: s.id, name: s.name, category: s.category }, before }
    },

    async mergeStores(l, sourceId, intoId) {
      const lg = ledger(l)
      if (sourceId === intoId) throw new ApiError(400, 'same_store')
      const src = lg.stores.find((x) => x.id === sourceId) ?? notFound()
      const dst = lg.stores.find((x) => x.id === intoId) ?? notFound()
      let moved = 0
      for (const r of lg.receipts) {
        if (r.store?.store_id === src.id) {
          r.store = { store_id: dst.id, name: dst.name, category: dst.category }
          moved++
        }
      }
      dst.aliases.push(src.name, ...src.aliases)
      lg.stores = lg.stores.filter((x) => x.id !== src.id)
      return { store: storeRow(lg, dst), merged_from: { store_id: src.id, name: src.name }, moved_receipts: moved }
    },

    async getAnalysis(l, q) {
      const lg2 = ledger(l)
      const axis = q.axis ?? 'category'
      const metric = q.metric ?? 'amount'
      if (!AXES.includes(axis) || !METRICS.includes(metric)) throw new ApiError(400, 'invalid_request')
      const [from, to, kind] = parsePeriod(q)
      const cur = factsOf(lg2, from, to, q)
      const totalOf = (xs: Fact[]) => {
        const amount = xs.reduce((a, x) => a + x.it.amount_incl, 0)
        const count = new Set(xs.map((x) => x.r.receipt_id)).size
        return { amount, count, unit: count ? round1(amount / count) : null }
      }
      const ct = totalOf(cur)
      const dayCount = (f: string, t: string) => Math.round((Date.parse(t) - Date.parse(f)) / 86_400_000) + 1
      const limit = Math.min(Math.max(q.limit ?? 50, 1), 50)
      const b = breakdownOf(selectOf(axis, lg2, q), metric, cur, limit)
      return {
        axis,
        metric,
        period: periodLabelOf(kind, from, to),
        totals: {
          ...ct,
          days: dayCount(from, to),
        },
        rows: b.rows,
        truncated_rows: b.truncated,
        filters: {
          ...(q.category ? { category: q.category } : {}),
          ...(q.store ? { store: q.store } : {}),
          ...(q.item_query ? { item_query: q.item_query } : {}),
          ...(q.label_colors?.length ? { label_colors: [...q.label_colors] } : {}),
        },
      }
    },

    async getAnalysisTrend(l, q) {
      const lg2 = ledger(l)
      const axis = q.axis ?? 'category'
      const metric = q.metric ?? 'amount'
      if (!AXES.includes(axis) || !METRICS.includes(metric)) throw new ApiError(400, 'invalid_request')
      const [from, to, pKind] = parsePeriod(q)
      const spanDays = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
      const granularity: AnalysisGranularity = q.granularity ?? (spanDays <= 62 ? 'day' : spanDays <= 366 ? 'week' : 'month')
      const buckets: string[] = []
      if (granularity === 'day') {
        for (let d = from; d <= to; d = new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10)) {
          buckets.push(d)
          if (d === to) break
        }
      } else if (granularity === 'week') {
        for (let w = weekStartOf(from); w <= to; w = new Date(Date.parse(w) + 7 * 86_400_000).toISOString().slice(0, 10)) {
          buckets.push(w)
        }
      } else {
        for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) buckets.push(m)
      }
      const idx = new Map(buckets.map((b, i) => [b, i]))
      const bucketOf = (on: string) => (granularity === 'day' ? on : granularity === 'week' ? weekStartOf(on) : on.slice(0, 7))
      const xs = factsOf(lg2, from, to, q)
      // cell per axis value: amount and receipt set per bucket (count/unit
      // need the per-bucket DISTINCT receipt, not a sum of line rows)
      const cells = new Map<string, { key: string | number | null; label: string; amount: number[]; receipts: Set<number>[] }>()
      for (const x of xs) {
        if (!x.r.purchased_on) continue
        const i = idx.get(bucketOf(x.r.purchased_on))
        if (i === undefined) continue
        for (const s of selectOf(axis, lg2, q)(x)) {
          const c =
            cells.get(s.group) ??
            {
              key: s.key,
              label: s.label,
              amount: new Array(buckets.length).fill(0) as number[],
              receipts: buckets.map(() => new Set<number>()) as Set<number>[],
            }
          c.amount[i] = (c.amount[i] ?? 0) + x.it.amount_incl
          c.receipts[i]!.add(x.r.receipt_id)
          cells.set(s.group, c)
        }
      }
      const limit = Math.min(Math.max(q.limit ?? 10, 1), 10)
      const seriesAll = [...cells.values()]
        .map((c) => {
          const values: (number | null)[] = c.amount.map((a, i) => {
            const rec = c.receipts[i]!
            return metric === 'amount' ? a : metric === 'count' ? rec.size : rec.size ? round1(a / rec.size) : null
          })
          const receiptsAll = new Set(c.receipts.flatMap((s) => [...s]))
          const amountAll = c.amount.reduce((a, b) => a + b, 0)
          return {
            key: c.key,
            label: c.label,
            values,
            total:
              metric === 'amount'
                ? amountAll
                : metric === 'count'
                  ? receiptsAll.size
                  : receiptsAll.size
                    ? round1(amountAll / receiptsAll.size)
                    : 0,
          }
        })
        .sort(
          (a, b) =>
            b.total - a.total ||
            b.values.reduce<number>((x, y) => x + (y ?? 0), 0) -
              a.values.reduce<number>((x, y) => x + (y ?? 0), 0),
        )
      const bucketAmount = new Array(buckets.length).fill(0) as number[]
      const bucketReceipts = buckets.map(() => new Set<number>()) as Set<number>[]
      for (const c of cells.values())
        c.amount.forEach((a, i) => {
          bucketAmount[i] = (bucketAmount[i] ?? 0) + a
          for (const rid of c.receipts[i] ?? []) bucketReceipts[i]!.add(rid)
        })
      const bucketTotals: (number | null)[] = bucketAmount.map((a, i) => {
        const rec = bucketReceipts[i]!
        return metric === 'amount' ? a : metric === 'count' ? rec.size : rec.size ? round1(a / rec.size) : null
      })
      return {
        axis,
        metric,
        granularity,
        period: periodLabelOf(pKind, from, to),
        buckets,
        series: seriesAll.slice(0, limit),
        bucket_totals: bucketTotals,
        truncated_rows: Math.max(0, seriesAll.length - limit),
      }
    },

    async getAnalysisItem(l, q) {
      const lg2 = ledger(l)
      if (q.item_id === undefined && !q.item_query?.trim()) throw new ApiError(400, 'invalid_request')
      const [from, to, pKind] = parsePeriod(q, true)
      // item_query only SELECTS the item group here — it is not applied as a
      // filter on top of itself (the finalized contract)
      const { item_query: _drop, ...filters } = q
      void _drop
      const xs = factsOf(lg2, from, to, filters).filter((x) =>
        q.item_id !== undefined ? x.it.item_id === q.item_id : x.it.name.includes(q.item_query!.trim()),
      )
      const period = periodLabelOf(pKind, from, to)
      if (xs.length === 0) {
        return {
          item: null,
          period,
          summary: {
            count: 0,
            amount: 0,
            // absent when empty — the backend skips null optional keys
            stores: [],
          },
          prices: [],
          by_store: [],
          monthly: [],
          truncated_rows: 0,
        }
      }
      // the representative name: the latest purchase's (item_id wins when set)
      const latest = [...xs].sort(
        (a, b) => (b.r.purchased_on ?? '').localeCompare(a.r.purchased_on ?? '') || b.it.item_id - a.it.item_id,
      )[0]!
      const unitPriceOf = (x: Fact) => x.it.unit_price ?? Math.round(x.it.amount_incl / (x.it.quantity || 1))
      const prices = [...xs]
        .sort((a, b) => (a.r.purchased_on ?? '').localeCompare(b.r.purchased_on ?? '') || a.r.receipt_id - b.r.receipt_id)
        .map((x) => ({
          date: x.r.purchased_on ?? '',
          store_id: x.r.store?.store_id ?? null,
          store_name: x.r.store?.name ?? null,
          unit_price: unitPriceOf(x),
          quantity: x.it.quantity,
          amount_incl: x.it.amount_incl,
        }))
      const unitPrices = prices.map((p) => p.unit_price)
      const amount = xs.reduce((a, x) => a + x.it.amount_incl, 0)
      const byStoreMap = new Map<string, { store_id: number | null; store_name: string; count: number; amount: number; prices: number[] }>()
      for (const p of prices) {
        const key = p.store_name ?? ''
        const e = byStoreMap.get(key) ?? { store_id: p.store_id, store_name: p.store_name ?? '店名なし', count: 0, amount: 0, prices: [] }
        e.amount += p.amount_incl
        e.prices.push(p.unit_price)
        e.count += 1
        byStoreMap.set(key, e)
      }
      const monthly: { ym: string; count: number; amount: number }[] = []
      for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) monthly.push({ ym: m, count: 0, amount: 0 })
      const ymIdx = new Map(monthly.map((e, i) => [e.ym, i]))
      for (const p of prices) {
        const i = ymIdx.get(p.date.slice(0, 7))
        if (i !== undefined) {
          monthly[i]!.count += 1
          monthly[i]!.amount += p.amount_incl
        }
      }
      return {
        item: { item_id: q.item_id ?? latest.it.item_id, name: q.item_id !== undefined ? xs[0]!.it.name : latest.it.name },
        period,
        summary: {
          count: prices.length,
          amount,
          avg_unit_price: Math.round((unitPrices.reduce((a, b) => a + b, 0) / unitPrices.length) * 10) / 10,
          min_unit_price: Math.min(...unitPrices),
          max_unit_price: Math.max(...unitPrices),
          last_purchased_on: latest.r.purchased_on ?? undefined,
          stores: [...byStoreMap.values()].map((e) => e.store_name),
        },
        prices,
        by_store: [...byStoreMap.values()].map((e) => ({
          store_id: e.store_id,
          store_name: e.store_name,
          count: e.count,
          amount: e.amount,
          avg_unit_price: Math.round((e.prices.reduce((a, b) => a + b, 0) / e.prices.length) * 10) / 10,
        })),
        monthly,
        truncated_rows: 0,
      }
    },

    async listReceipts(l, q) {
      const lg = ledger(l)
      const rows = lg.receipts
        .filter((r) => q.include_deleted || r.deleted_at === null)
        .filter((r) => !q.from || (r.purchased_on ?? '') >= q.from)
        .filter((r) => !q.to || (r.purchased_on ?? '') <= q.to)
        .filter((r) => !q.store || (r.store?.name ?? r.store_name_raw ?? '').includes(q.store))
        // the cross-field q of /search (TASK-41): item name OR store name
        .filter(
          (r) =>
            !q.q ||
            r.items.some((it) => it.name.includes(q.q!)) ||
            (r.store?.name ?? r.store_name_raw ?? '').includes(q.q!),
        )
        .filter((r) => !q.store_id || r.store?.store_id === q.store_id)
        .filter((r) => !q.item_query || r.items.some((it) => it.name.includes(q.item_query!)))
        .filter((r) => !q.payment_method || r.payment_method === q.payment_method)
        .filter((r) => !q.label_colors?.length || labelColorsOf(r.labels).some((c) => q.label_colors!.includes(c)))
        .filter((r) =>
          !q.category
            ? true
            : r.items.some((it) =>
                q.category === '未分類'
                  ? it.category === null
                  : it.category === q.category || (it.category ?? '').startsWith(`${q.category}/`),
              ),
        )
        // backend ordering parity (TASK-63): date desc, then time desc within
        // a day (a missing time sorts last), then id desc
        .sort(
          (a, b) =>
            (b.purchased_on ?? '').localeCompare(a.purchased_on ?? '') ||
            (b.purchased_time ?? '').localeCompare(a.purchased_time ?? '') ||
            b.receipt_id - a.receipt_id,
        )
      const limit = q.limit ?? 20
      const page = rows.slice(0, limit)
      return {
        total_count: rows.length,
        // backend parity (TASK-57 A19): with include_deleted the sum counts
        // the deleted rows too (the totals query filters like the list)
        sum_amount: rows.reduce((a, r) => a + receiptAmount(r), 0),
        receipts: page.map(summary),
        next_cursor: null,
      }
    },

    // GET /items (TASK-41): the item-level list behind the /search item tab.
    // The mock keeps the coarse matching of the rest of the file (plain
    // includes, no normalization): q hits item names only.
    async searchItems(l, q) {
      const lg = ledger(l)
      const rows = lg.receipts
        .filter((r) => q.include_deleted || r.deleted_at === null)
        .filter((r) => !q.from || (r.purchased_on ?? '') >= q.from)
        .filter((r) => !q.to || (r.purchased_on ?? '') <= q.to)
        .filter((r) => !q.store_id || r.store?.store_id === q.store_id)
        .filter((r) => !q.label_colors?.length || labelColorsOf(r.labels).some((c) => q.label_colors!.includes(c)))
        .flatMap((r) =>
          r.items
            .filter((it) => !q.q || it.name.includes(q.q!))
            // the category path match mirrors listReceipts ("未分類" = null,
            // prefix match on "大分類/小分類") at the item level
            .filter((it) =>
              !q.category
                ? true
                : q.category === '未分類'
                  ? it.category === null
                  : it.category === q.category || (it.category ?? '').startsWith(`${q.category}/`),
            )
            .map(
              (it): ItemSummary => ({
                item_id: it.item_id,
                receipt_id: r.receipt_id,
                purchased_on: r.purchased_on,
                store_id: r.store?.store_id ?? null,
                store_name: r.store?.name ?? r.store_name_raw ?? null,
                name: it.name,
                quantity: it.quantity,
                unit: it.unit,
                unit_price: it.unit_price,
                amount_incl: it.amount_incl,
                category: it.category,
              }),
            ),
        )
        .sort((a, b) => {
          // TASK-63 parity: the item rows follow their receipt's time within
          // a day (ItemSummary itself carries the date only)
          const timeOf = new Map(lg.receipts.map((r) => [r.receipt_id, r.purchased_time ?? '']))
          return (
            (b.purchased_on ?? '').localeCompare(a.purchased_on ?? '') ||
            (timeOf.get(b.receipt_id) ?? '').localeCompare(timeOf.get(a.receipt_id) ?? '') ||
            b.receipt_id - a.receipt_id ||
            b.item_id - a.item_id
          )
        })
      return {
        total_count: rows.length,
        sum_amount: rows.reduce((a, r) => a + r.amount_incl, 0),
        items: rows,
        next_cursor: null,
      }
    },

    async getReceipt(l, id) {
      const r = ledger(l).receipts.find((x) => x.receipt_id === id) ?? notFound()
      return clone(r)
    },

    async updateReceipt(l, id, input) {
      const lg = ledger(l)
      const r = lg.receipts.find((x) => x.receipt_id === id) ?? notFound()
      if (r.deleted_at !== null) throw new ApiError(409, 'deleted')
      if (input.revision !== r.revision) throw new ApiError(409, 'stale_revision')
      const changed: string[] = []
      const set = input.set ?? {}
      if (set.store_name !== undefined && set.store_name !== r.store?.name) {
        const name = set.store_name.trim()
        if (!name) throw new ApiError(400, 'invalid_name')
        let s = lg.stores.find((x) => x.name === name || x.aliases.includes(name))
        if (!s) {
          s = { id: seq++, name, category: null, aliases: [] }
          lg.stores.push(s)
        }
        r.store = { store_id: s.id, name: s.name, category: s.category }
        changed.push('store_name')
      }
      for (const key of ['purchased_on', 'purchased_time', 'tax_mode', 'total_amount', 'tax_amount', 'payment_method', 'note'] as const) {
        if (set[key] !== undefined && set[key] !== r[key]) {
          ;(r as unknown as Record<string, unknown>)[key] = set[key]
          changed.push(key)
        }
      }
      for (const p of input.upsert_items ?? []) {
        const existing = p.item_id !== undefined ? r.items.find((x) => x.item_id === p.item_id) : undefined
        if (p.item_id !== undefined && !existing) notFound()
        if (existing) {
          if (p.name !== undefined) existing.name = p.name
          if (p.amount !== undefined) {
            existing.amount = p.amount
            existing.amount_incl = p.amount
          }
          if (p.quantity !== undefined) existing.quantity = p.quantity
          if (p.tax_rate !== undefined) existing.tax_rate = p.tax_rate
          if (p.category !== undefined) {
            existing.category = p.category
            existing.category_source = 'user'
          }
          changed.push(`items[${existing.item_id}]`)
        } else {
          if (!p.name || p.amount === undefined) throw new ApiError(400, 'item_name_amount_required')
          const line = Math.max(0, ...r.items.map((x) => x.line_no)) + 1
          const added = item(seq++, line, p.name, p.amount, p.category ?? null)
          if (p.category !== undefined) added.category_source = 'user'
          r.items.push(added)
          changed.push('items[new]')
        }
      }
      if (input.delete_item_ids?.length) {
        r.items = r.items.filter((x) => !input.delete_item_ids!.includes(x.item_id))
        changed.push('items[deleted]')
      }
      recompute(r)
      r.revision += 1
      r.updated_at = nowIso()
      return { receipt: clone(r), changed }
    },

    async deleteReceipt(l, id, input) {
      const r = ledger(l).receipts.find((x) => x.receipt_id === id) ?? notFound()
      const status = () => ({
        receipt_id: r.receipt_id,
        revision: r.revision,
        deleted_at: r.deleted_at,
        purge_after: r.deleted_at ? addDays(r.deleted_at, PURGE_DAYS) : null,
      })
      if (input.restore) {
        if (r.deleted_at === null) return status()
        if (input.revision !== undefined && input.revision !== r.revision) {
          throw new ApiError(409, 'stale_revision')
        }
        r.deleted_at = null
        r.revision += 1
        return status()
      }
      if (r.deleted_at !== null) return status()
      const preview = {
        store_name: r.store?.name ?? r.store_name_raw,
        purchased_on: r.purchased_on,
        amount: receiptAmount(r),
        item_count: r.items.length,
      }
      if (!input.confirm) return { ...status(), preview }
      if (input.revision === undefined) throw new ApiError(400, 'revision_required')
      if (input.revision !== r.revision) throw new ApiError(409, 'stale_revision')
      r.deleted_at = nowIso()
      r.revision += 1
      return status()
    },

    async listLabels(l) {
      return { labels: clone(ledger(l).labels) }
    },

    async updateLabelTitle(l, color, input) {
      const lg = ledger(l)
      if (!isLabelColor(color)) throw new ApiError(400, 'invalid_request')
      const target = lg.labels.find((x) => x.color === color) ?? notFound()
      const title = input.title === null ? null : input.title.trim()
      if (title !== null && Array.from(title).length > MAX_LABEL_TITLE_CHARS) {
        throw new ApiError(400, 'invalid_label_title')
      }
      const changed = (title ?? null) !== (target.title ?? null)
      target.title = title === '' ? null : title
      return { label: clone(target), changed }
    },

    async setReceiptLabels(l, r, input) {
      const lg = ledger(l)
      const target = lg.receipts.find((x) => x.receipt_id === r) ?? notFound()
      if (target.deleted_at !== null) throw new ApiError(409, 'deleted')
      const add = input.add ?? []
      const remove = input.remove ?? []
      if (add.length === 0 && remove.length === 0) throw new ApiError(400, 'invalid_request')
      for (const c of [...add, ...remove]) if (!isLabelColor(c)) throw new ApiError(400, 'invalid_request')
      if (add.some((c) => remove.includes(c))) throw new ApiError(400, 'invalid_request')
      const next = new Set(labelColorsOf(target.labels))
      for (const c of add) next.add(c)
      for (const c of remove) next.delete(c)
      const defs = new Map(lg.labels.map((x) => [x.color, x]))
      target.labels = LABEL_COLORS.filter((c) => next.has(c)).map((c) => ({
        color: c,
        title: defs.get(c)?.title ?? null,
      }))
      // labels never bump receipts.revision / updated_at (TASK-17 A8)
      return { receipt_id: target.receipt_id, labels: clone(target.labels) }
    },

    // the mock holds no ledger registry (the session me drives the names),
    // so the rename echoes the contract: the trimmed name back (TASK-20 7-1)
    async renameLedger(l, input) {
      return { id: l, name: input.name.trim() }
    },

    // TASK-58: the export/import double follows the version-1 file shape at
    // the fidelity the mock state has (paths instead of category ids, no
    // image bytes — the mock seeds carry none). Enough for the screens and
    // for a mock-side round trip.
    async exportLedger(l) {
      const lg = ledger(l)
      const catFile = (kind: CategoryKind) =>
        lg.cats
          .filter((c) => c.kind === kind)
          .map((c) => ({ name: c.name, archived_at: c.archived ? 0 : null }))
      const file = {
        format: 'kakeiboot-ledger-export',
        version: 1,
        exported_at: Date.now(),
        ledger: { id: l, name: `家計簿${l}` },
        labels: clone(lg.labels),
        item_categories: catFile('item'),
        store_categories: catFile('store'),
        stores: lg.stores.map((s) => ({ name: s.name, category: s.category, aliases: [...s.aliases] })),
        images: [],
        receipts: lg.receipts
          .filter((r) => r.deleted_at === null)
          .map((r) => ({
            source: r.source,
            store_name: r.store?.name ?? r.store_name_raw,
            purchased_on: r.purchased_on,
            purchased_time: r.purchased_time,
            tax_mode: r.tax_mode,
            total_amount: r.total_amount,
            tax_amount: r.tax_amount,
            payment_method: r.payment_method,
            note: r.note,
            revision: r.revision,
            created_at: r.created_at,
            updated_at: r.updated_at,
            labels: labelColorsOf(r.labels),
            items: r.items.map((it) => ({
              line_no: it.line_no,
              line_kind: it.line_kind,
              name: it.name,
              quantity: it.quantity,
              unit: it.unit,
              unit_price: it.unit_price,
              amount: it.amount,
              amount_incl: it.amount_incl,
              tax_rate: it.tax_rate,
              category: it.category,
              category_source: it.category_source,
              bbox: it.bbox,
            })),
          })),
      }
      return new Blob([JSON.stringify(file)], { type: 'application/json' })
    },

    async importLedger(payload) {
      const p = payload as {
        format?: unknown
        version?: unknown
        ledger?: { name?: unknown } | null
        labels?: { color?: unknown; title?: unknown }[] | null
        item_categories?: { name?: unknown; archived_at?: unknown }[] | null
        store_categories?: { name?: unknown; archived_at?: unknown }[] | null
        stores?: { name?: unknown; category?: unknown; aliases?: unknown }[] | null
        receipts?:
          | {
              revision?: unknown
              source?: unknown
              store_name?: unknown
              purchased_on?: unknown
              purchased_time?: unknown
              tax_mode?: unknown
              total_amount?: unknown
              payment_method?: unknown
              note?: unknown
              labels?: unknown
              items?:
                | {
                    line_no?: unknown
                    line_kind?: unknown
                    name?: unknown
                    quantity?: unknown
                    unit?: unknown
                    unit_price?: unknown
                    amount?: unknown
                    amount_incl?: unknown
                    tax_rate?: unknown
                    category?: unknown
                    category_source?: unknown
                    bbox?: unknown
                  }[]
                | null
            }[]
          | null
      }
      const invalid = (): never => {
        throw new ApiError(400, 'import_invalid')
      }
      if (p?.format !== 'kakeiboot-ledger-export' || p?.version !== 1) invalid()
      const name = typeof p.ledger?.name === 'string' ? p.ledger.name.trim() : ''
      if (!name) invalid()
      const cats: Cat[] = []
      for (const kind of ['item', 'store'] as const) {
        for (const c of (kind === 'item' ? p.item_categories : p.store_categories) ?? []) {
          const cname = typeof c?.name === 'string' && c.name ? c.name : invalid()
          cats.push({ id: seq++, kind, name: cname, parentId: null, archived: c.archived_at != null })
        }
      }
      const stores: Store[] = []
      for (const s of p.stores ?? []) {
        const sname = typeof s?.name === 'string' && s.name ? s.name : invalid()
        stores.push({
          id: seq++,
          name: sname,
          category: typeof s.category === 'string' ? s.category : null,
          aliases: Array.isArray(s.aliases) ? s.aliases.filter((a): a is string => typeof a === 'string') : [],
        })
      }
      const titles = new Map(
        (p.labels ?? [])
          .filter((x): x is { color: LabelColor; title?: unknown } => {
            const col = x.color
            return typeof col === 'string' && isLabelColor(col)
          })
          .map((x) => [x.color, typeof x.title === 'string' ? x.title : null]),
      )
      const labels: Label[] = LABEL_COLORS.map((color) => ({ color, title: titles.get(color) ?? null }))
      const receipts: ReceiptView[] = []
      let itemCount = 0
      for (const rc of p.receipts ?? []) {
        const store = typeof rc?.store_name === 'string' ? stores.find((s) => s.name === rc.store_name) : undefined
        const items: ReceiptItem[] = (rc?.items ?? []).map((it, i) => ({
          item_id: seq++,
          line_no: typeof it?.line_no === 'number' ? it.line_no : i + 1,
          line_kind: it?.line_kind === 'discount' ? 'discount' : 'item',
          parent_item_id: null,
          name: typeof it?.name === 'string' ? it.name : invalid(),
          name_raw: null,
          quantity: typeof it?.quantity === 'number' ? it.quantity : 1,
          unit: typeof it?.unit === 'string' ? it.unit : null,
          unit_price: typeof it?.unit_price === 'number' ? it.unit_price : null,
          amount: typeof it?.amount === 'number' ? it.amount : invalid(),
          amount_incl: typeof it?.amount_incl === 'number' ? it.amount_incl : invalid(),
          tax_rate: (typeof it?.tax_rate === 'number' ? it.tax_rate : null) as ReceiptItem['tax_rate'],
          category: typeof it?.category === 'string' ? it.category : null,
          category_source: (typeof it?.category_source === 'string' ? it.category_source : null) as ReceiptItem['category_source'],
          bbox: (Array.isArray(it?.bbox) ? it.bbox : null) as ReceiptItem['bbox'],
        }))
        itemCount += items.length
        const colors = Array.isArray(rc?.labels)
          ? (rc.labels as unknown[]).filter((c): c is LabelColor => typeof c === 'string' && isLabelColor(c))
          : []
        const total = typeof rc?.total_amount === 'number' ? rc.total_amount : items.reduce((a, b) => a + b.amount_incl, 0)
        const itemsTotal = items.reduce((a, b) => a + b.amount_incl, 0)
        receipts.push({
          receipt_id: seq++,
          revision: typeof rc?.revision === 'number' ? rc.revision : 1,
          source: rc?.source === 'manual' ? 'manual' : 'image',
          has_image: false,
          deleted_at: null,
          labels: colors.map((color) => ({ color, title: titles.get(color) ?? null })),
          store: store ? { store_id: store.id, name: store.name, category: store.category } : null,
          store_name_raw: typeof rc?.store_name === 'string' ? rc.store_name : null,
          purchased_on: typeof rc?.purchased_on === 'string' ? rc.purchased_on : null,
          purchased_time: typeof rc?.purchased_time === 'string' ? rc.purchased_time : null,
          tax_mode: rc?.tax_mode === 'inclusive' || rc?.tax_mode === 'exclusive' ? rc.tax_mode : null,
          total_amount: total,
          tax_amount: null,
          payment_method: (typeof rc?.payment_method === 'string' ? rc.payment_method : null) as ReceiptView['payment_method'],
          note: typeof rc?.note === 'string' ? rc.note : null,
          items,
          items_total: itemsTotal,
          total_diff: total - itemsTotal,
          image: null,
          image_url: null,
          from_draft_id: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        })
      }
      const newId = seq++
      ledgers.set(newId, { cats, stores, receipts, labels })
      return {
        ledger: { id: newId, name },
        counts: {
          receipts: receipts.length,
          items: itemCount,
          images: 0,
          stores: stores.length,
          item_categories: cats.filter((c) => c.kind === 'item').length,
          store_categories: cats.filter((c) => c.kind === 'store').length,
        },
      }
    },
  }
  return api
}
