// In-memory DataApi used until the backend web adapter exists. Follows the
// documented semantics (spec_mcp-tools.md 7-10 / 7-11 / 7-13 / 7-14,
// spec_data-model.md 5-1 / 5-2) so the screens behave like the real thing:
// revision checks, preview / confirm delete, 2-level categories, merge.

import { ApiError } from '../http'
import type {
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

function seedLedger(opts: { feed?: number } = {}): Ledger {
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
    { ...receipt(101, 1, '2026-10-10', [
      item(1001, 1, '牛乳', 220, '食費/食料品'),
      item(1002, 2, 'パン', 180, '食費/食料品'),
    ]), has_image: true, labels: [{ color: 'red' as const, title: null }], image: { width: 1024, height: 2048, original_filename: 'receipt.jpg', taken_at: null, taken_at_source: null }, image_url: { url: 'https://localhost:40281/media/img/mock-token-101', expires_at: '2099-01-01T00:00:00+09:00', width: 1024, height: 2048 } },
    receipt(102, 2, '2026-10-08', [item(1003, 1, '洗剤', 398, '日用品')]),
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
  // fixed 5-color label definitions, title NULL = color only (TASK-17)
  const labels: Label[] = LABEL_COLORS.map((color) => ({ color, title: null }))
  return { cats, stores, receipts, labels }
}

export function createMockDataApi(opts: { feed?: number } = {}): DataApi {
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

    async getStats(l, q) {
      const lg = ledger(l)
      const report = q.report ?? 'monthly_overview'
      const today = jstMonth(new Date())
      let from: string
      let to: string
      let kind: 'month' | 'year' | 'days'
      if (q.month !== undefined) {
        if (!/^\d{4}-\d{2}$/.test(q.month)) throw new ApiError(400, 'invalid_request')
        ;[from, to, kind] = [`${q.month}-01`, `${q.month}-31`, 'month']
      } else if (q.year !== undefined) {
        ;[from, to, kind] = [`${q.year}-01-01`, `${q.year}-12-31`, 'year']
      } else if (q.from && q.to) {
        ;[from, to, kind] = [q.from, q.to, 'days']
      } else if (report === 'monthly_trend' || report === 'item_price_history') {
        ;[from, to, kind] = [`${shiftMonth(today, -11)}-01`, `${today}-31`, 'days']
      } else {
        ;[from, to, kind] = [`${today}-01`, `${today}-31`, 'month']
      }
      if (report === 'item_price_history' && !q.item_query?.trim()) throw new ApiError(400, 'invalid_request')
      const facts = (f: string, t: string) =>
        lg.receipts
          .filter((r) => r.deleted_at === null && (r.purchased_on ?? '') >= f && (r.purchased_on ?? '') <= t)
          .filter((r) => !q.store || (r.store?.name ?? '').includes(q.store))
          .filter((r) => !q.label_colors?.length || labelColorsOf(r.labels).some((c) => q.label_colors!.includes(c)))
          .flatMap((r) => r.items.map((it) => ({ r, it, top: (it.category ?? '未分類').split('/')[0]! })))
          .filter((x) =>
            !q.category
              ? true
              : q.category === '未分類'
                ? x.it.category === null
                : x.it.category === q.category || (x.it.category ?? '').startsWith(`${q.category}/`),
          )
          .filter((x) => !q.item_query || x.it.name.includes(q.item_query))
      const cur = facts(from, to)
      const sum = (xs: typeof cur) => xs.reduce((a, x) => a + x.it.amount_incl, 0)
      const value = sum(cur)
      const prevRange = (): [string, string] | null => {
        if (report === 'monthly_trend' || report === 'item_price_history') return null
        if (kind === 'month') {
          const p = shiftMonth(from.slice(0, 7), -1)
          return [`${p}-01`, `${p}-31`]
        }
        if (kind === 'year') return [`${Number(from.slice(0, 4)) - 1}-01-01`, `${Number(from.slice(0, 4)) - 1}-12-31`]
        // a custom range compares against the same-length previous period
        // (backend Range::previous "days"): [from - n days, from - 1 day].
        // Date-only strings parse as UTC, so the day math has no TZ drift.
        const n = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
        const end = new Date(Date.parse(from) - 86_400_000)
        const start = new Date(end.getTime() - (n - 1) * 86_400_000)
        return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
      }
      const pr = prevRange()
      const prev = pr ? facts(pr[0], pr[1]) : null
      const compare = prev ? sum(prev) : null
      const ranked = (id: string, title: string, key: (x: (typeof cur)[number]) => string, limit = 10) => {
        const map = new Map<string, number>()
        for (const x of cur) map.set(key(x), (map.get(key(x)) ?? 0) + x.it.amount_incl)
        const pmap = new Map<string, number>()
        for (const x of prev ?? []) pmap.set(key(x), (pmap.get(key(x)) ?? 0) + x.it.amount_incl)
        const rows = [...map.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([label, v]) => ({
            keys: [label],
            labels: [label],
            value: v,
            ...(prev ? { compare_value: pmap.get(label) ?? 0, diff: v - (pmap.get(label) ?? 0) } : {}),
            share: value ? v / value : 0,
          }))
        return { id, title, dims: [id], chart: 'bar_h', rows }
      }
      const months = (f: string, t: string) => {
        const out: string[] = []
        for (let m = f.slice(0, 7); m <= t.slice(0, 7); m = shiftMonth(m, 1)) out.push(m)
        return out
      }
      // each bar is clipped to the range it is drawn over: backend grouped()
      // filters purchased_on BETWEEN the section's range before grouping by
      // month, and monthly_trend passes the query range (stats.rs) — so a
      // mid-month range start/end counts only the in-range days. The
      // overview's own trend passes no clip: its backend window is six whole
      // months ending at range.to's month end.
      const trendRows = (ms: string[], clipFrom?: string, clipTo?: string) =>
        ms.map((m) => {
          const lo = clipFrom && clipFrom > `${m}-01` ? clipFrom : `${m}-01`
          const hi = clipTo && clipTo < `${m}-31` ? clipTo : `${m}-31`
          return { keys: [m], labels: [m], value: sum(facts(lo, hi)) }
        })
      const catKey = (x: (typeof cur)[number]) =>
        q.category && q.category !== '未分類' ? (x.it.category ?? q.category) : x.top
      let sections
      if (report === 'monthly_overview') {
        sections = [
          ranked('categories', '品目カテゴリ（大分類）別', (x) => x.top),
          ranked('stores', '上位の店', (x) => x.r.store?.name ?? '店不明', 5),
          { id: 'trend', title: '直近6か月の推移', dims: ['month'], chart: 'bar_v', rows: trendRows(months(`${shiftMonth(to.slice(0, 7), -5)}-01`, to)) },
        ]
      } else if (report === 'by_category') {
        sections = [ranked('categories', q.category ? `「${q.category}」の内訳` : '品目カテゴリ（大分類）別', catKey)]
      } else if (report === 'by_store') {
        sections = [ranked('stores', '店別', (x) => x.r.store?.name ?? '店不明')]
      } else if (report === 'by_payment_method') {
        sections = [ranked('payment_methods', '支払方法別', (x) => (x.r.payment_method === 'cash' ? '現金' : x.r.payment_method ?? '支払方法不明'))]
      } else if (report === 'monthly_trend') {
        sections = [{ id: 'trend', title: '月別合計', dims: ['month'], chart: 'bar_v', rows: trendRows(months(from, to), from, to) }]
      } else if (report === 'item_price_history') {
        sections = [{
          id: 'prices',
          title: '購入ごとの単価',
          dims: ['month', 'store', 'item'],
          chart: 'scatter_line',
          rows: cur.map((x) => ({
            keys: [x.r.purchased_on, x.r.store?.store_id ?? null, x.it.item_id],
            labels: [x.r.purchased_on ?? '', x.r.store?.name ?? '店不明', x.it.name],
            value: x.it.unit_price ?? Math.round(x.it.amount_incl / (x.it.quantity || 1)),
          })),
        }]
      } else {
        throw new ApiError(400, 'invalid_request')
      }
      let acc = 0
      const days = new Map<string, number>()
      for (const x of cur) days.set(x.r.purchased_on!, (days.get(x.r.purchased_on!) ?? 0) + x.it.amount_incl)
      return {
        report,
        period_resolved: { from, to, label: from.slice(0, 7) },
        compare_period: pr ? { from: pr[0], to: pr[1], label: pr[0].slice(0, 7) } : null,
        totals: {
          value,
          compare_value: compare,
          diff: compare === null ? null : value - compare,
          diff_pct: compare ? Math.round(((value - compare) / compare) * 1000) / 10 : null,
          receipts: new Set(cur.map((x) => x.r.receipt_id)).size,
        },
        sections,
        notes: [],
        ...(report === 'monthly_overview'
          ? { daily_cumulative: [...days.entries()].sort().map(([date, v]) => ({ date, value: (acc += v) })) }
          : {}),
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
        .sort((a, b) => (b.purchased_on ?? '').localeCompare(a.purchased_on ?? '') || b.receipt_id - a.receipt_id)
      const limit = q.limit ?? 20
      const page = rows.slice(0, limit)
      return {
        total_count: rows.length,
        sum_amount: rows.filter((r) => r.deleted_at === null).reduce((a, r) => a + receiptAmount(r), 0),
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
        .sort(
          (a, b) =>
            (b.purchased_on ?? '').localeCompare(a.purchased_on ?? '') || b.receipt_id - a.receipt_id || b.item_id - a.item_id,
        )
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
  }
  return api
}
