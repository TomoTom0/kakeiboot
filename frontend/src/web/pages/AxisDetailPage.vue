<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery, type Label, type LabelColor } from '@/shared/labels'
import { barScale } from '@/shared/lib/stackedBars'
import LabelDots from '@/shared/components/LabelDots.vue'
import {
  useDataApi,
  type AnalysisAxis,
  type AnalysisFilters,
  type AnalysisItemResult,
  type AnalysisResult,
  type ReceiptSummary,
  type StatsRow,
  type StoreRow,
} from '../api/data'
import PeriodHeader from '../components/PeriodHeader.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import AppIcon from '../components/AppIcon.vue'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import ContentSwap from '../components/ContentSwap.vue'
import type { FilterChip } from '../components/FilterChips.vue'
import PageHead from '../components/PageHead.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendWindow from '../components/TrendWindow.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { PAYMENT_LABEL, isPaymentMethod } from '../composables/labels'
import { shortDate } from '../composables/period'
import { usePeriodMove } from '../composables/periodMove'
import { currentTrendKey } from '../composables/trend'
import { firstString, listQueryToContext } from '../composables/receiptContext'
import { usePageReady } from '../composables/usePageReady'
import { useTrendWindow } from '../composables/trendWindow'
import { useSessionStore } from '../stores/session'
import { useCatalogStore } from '../stores/catalog'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'

// Axis detail (TASK-89 §1-(5), the compare side removed): one component
// serves the five axes of the /axes/* routes with one skeleton — PageHead
// (kind / name / period total / menu) → PeriodHeader (the total narrowed to
// this axis value) → the
// cross-filter chips → the stacked trend → the cross ranking (the axis's
// counterpart: category×store / store×category / item×store / label×category
// / payment×store) → the category-only extra sections (sub categories on a
// top, items on a sub) → the item-only stats zone (summary / price history /
// by-store) → the recent receipts. The category ids resolve
// through the catalog and the store id through listStores (a wrong id
// replaces back to the list with ?missing=); the name-keyed item / label /
// payment axes resolve nothing — an empty dataset still draws the skeleton.
// The legacy /categories/:top and /stores/:id URLs are simply gone.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
// the deep-linked period / labels keys arrive through the shell-level URL
// sync (TASK-124 D2) before this page sets up; later store moves re-query
// through the route.fullPath watch below (the sync keeps labels= in the URL)

type AxisKind = 'category' | 'store' | 'item' | 'label' | 'payment'
const AXIS_KIND_LABEL: Record<AxisKind, string> = {
  category: 'カテゴリ',
  store: '店',
  item: '品目',
  label: 'ラベル',
  payment: '支払方法',
}

const kind = computed<AxisKind>(() => {
  switch (route.name) {
    case 'axis-category':
    case 'axis-subcategory':
    case 'axis-category-uncategorized':
      return 'category'
    case 'axis-store':
      return 'store'
    case 'axis-item':
      return 'item'
    case 'axis-label':
      return 'label'
    default:
      return 'payment'
  }
})

// --- subject resolution --------------------------------------------------------
/** Resolved view of the route; null until the catalog / stores answered.
 *  The ‹ climb's destination is the resolved parent PATH only — the query
 *  rides the live route through the parentTo computed below (D2-2). */
const view = ref<null | {
  title: string
  sub?: string
  parentName?: string
  parentPath?: string
  backLabel: string
  /** the subject filter of every query */
  subject: AnalysisFilters
  /** the subject's own chip label */
  subjectChip: string
  /** the category hierarchy pair, when kind = category */
  topId?: number
  subId?: number | null
}>(null)

function isAxisRoute(): boolean {
  return typeof route.name === 'string' && route.name.startsWith('axis-')
}

/** Resolve the params (category through the catalog, store through
 *  listStores), replacing away when they are wrong. Returns false when the
 *  navigation moved elsewhere. */
async function resolveRoute(l: number): Promise<boolean> {
  if (kind.value === 'category') {
    if (route.name === 'axis-category-uncategorized') {
      view.value = {
        title: '未分類',
        subject: { category: '未分類' },
        subjectChip: 'カテゴリ: 未分類',
        backLabel: 'カテゴリ一覧',
        parentPath: '/categories',
      }
      return true
    }
    await catalog.load()
    if (route.name === 'axis-category') {
      const topId = Number(route.params.top)
      const node = catalog.nodeById('item', topId)
      if (!node) {
        await router.replace({ path: '/categories', query: { ...route.query, missing: String(topId) } })
        return false
      }
      const parent = catalog.parentIdOf('item', topId)
      if (parent !== null) {
        await router.replace({ path: `/axes/category/${parent}/${topId}`, query: { ...route.query } })
        return false
      }
      view.value = {
        title: node.name,
        subject: { category: catalog.pathOf('item', topId) ?? node.name },
        subjectChip: `カテゴリ: ${node.name}`,
        backLabel: 'カテゴリ一覧',
        parentPath: '/categories',
        topId,
        subId: null,
      }
      return true
    }
    const topId = Number(route.params.top)
    const subId = Number(route.params.sub)
    const topNode = catalog.nodeById('item', topId)
    const subNode = catalog.nodeById('item', subId)
    if (!topNode || !subNode) {
      await router.replace({
        path: '/categories',
        query: { ...route.query, missing: String(topNode ? subId : topId) },
      })
      return false
    }
    const realParent = catalog.parentIdOf('item', subId)
    if (realParent !== topId) {
      const to = realParent === null ? `/axes/category/${subId}` : `/axes/category/${realParent}/${subId}`
      await router.replace({ path: to, query: { ...route.query } })
      return false
    }
    view.value = {
      title: subNode.name,
      subject: { category: catalog.pathOf('item', subId) ?? subNode.name },
      subjectChip: `カテゴリ: ${subNode.name}`,
      parentName: topNode.name,
      backLabel: 'カテゴリ一覧',
      parentPath: `/axes/category/${topId}`,
      topId,
      subId,
    }
    return true
  }
  if (kind.value === 'store') {
    const id = Number(route.params.id)
    const found = (await api.listStores(l)).find((s) => s.store_id === id)
    if (!found) {
      await router.replace({ path: '/stores', query: { ...route.query, missing: String(id) } })
      return false
    }
    storeRow.value = found
    view.value = {
      title: found.name,
      sub: found.category ?? undefined,
      subject: { store_id: id },
      subjectChip: `店: ${found.name}`,
      backLabel: '店一覧',
      parentPath: '/stores',
    }
    return true
  }
  // the name-keyed axes: no resolution, an empty dataset still draws
  if (kind.value === 'item') {
    // the router already decodes params — a second decode breaks item names
    // holding a literal percent (`100%果汁` → URIError). Encoding belongs to
    // the link builders only (PR#1 P2)
    const name = String(route.params.name ?? '')
    view.value = {
      title: name,
      subject: { item_query: name },
      subjectChip: `品目: ${name}`,
      backLabel: 'ホーム',
      parentPath: '/',
    }
    return true
  }
  if (kind.value === 'label') {
    const color = String(route.params.color ?? '')
    view.value = {
      title: labelTitle(color),
      subject: { label_colors: [color as LabelColor] },
      subjectChip: `ラベル: ${labelTitle(color)}`,
      backLabel: 'ホーム',
      parentPath: '/',
    }
    return true
  }
  const raw = String(route.params.method ?? '')
  const method = isPaymentMethod(raw) ? raw : 'other'
  view.value = {
    title: PAYMENT_LABEL[method],
    subject: { payment_method: method },
    subjectChip: `支払: ${PAYMENT_LABEL[method]}`,
    backLabel: 'ホーム',
    parentPath: '/',
  }
  return true
}

/** The ‹ climb's destination (D2-2): the resolved parent path with the LIVE
 *  route query. The shell URL sync keeps month=/labels= current, and the
 *  re-query watch below no longer re-resolves the view on its write-back
 *  echo — so a snapshot taken at resolve time could hold the period from
 *  before the move. Deriving the query here makes the climb carry the
 *  current values whenever it is pressed. */
const parentTo = computed<RouteLocationRaw | null>(() =>
  view.value?.parentPath === undefined ? null : { path: view.value.parentPath, query: { ...route.query } },
)

const storeRow = ref<StoreRow | null>(null)

const labelsStore = useLabelsStore()
// NOTE: resolveRoute runs synchronously inside useLedger's immediate watch —
// before the `ledgerId` const below initializes — so the title lookup reads
// the session directly instead (a TDZ ReferenceError otherwise)
function labelTitle(color: string): string {
  const def = labelsStore
    .definitions(useSessionStore().selectedLedgerId ?? -1)
    .find((l) => l.color === color)
  return def?.title ?? def?.color ?? color
}

// --- the axis wiring table -----------------------------------------------------
/** the counterpart axis of the cross ranking */
const CROSS_AXIS: Record<AxisKind, AnalysisAxis> = {
  category: 'store',
  store: 'category',
  item: 'store',
  label: 'category',
  payment: 'store',
}
const crossAxis = computed<AnalysisAxis>(() => CROSS_AXIS[kind.value])
const crossTitle = computed(
  () =>
    ({
      category: 'このカテゴリを買った店',
      store: 'この店で買ったカテゴリ',
      item: 'この品目を買った店',
      label: 'このラベルのカテゴリ',
      payment: 'この支払方法の店',
    })[kind.value]!,
)
/** the trend's stacking axis (what the segments break the total into) */
const stackAxis = computed<AnalysisAxis>(() => {
  if (kind.value === 'category') return view.value?.subId == null && route.name !== 'axis-category-uncategorized' ? 'category' : 'item'
  if (kind.value === 'item') return 'store'
  return 'category'
})
/** the category-only extra section's axis (null: none) */
const ownAxis = computed<AnalysisAxis | null>(() => {
  if (kind.value !== 'category') return null
  if (route.name === 'axis-category-uncategorized') return null
  return view.value?.subId == null ? 'category' : 'item'
})
const ownTitle = computed(() => (view.value?.subId == null ? '小カテゴリ別' : '品目'))

// --- the cross filters that ride the URL ----------------------------------------
const storeIdQuery = computed(() => {
  const n = Number(route.query.store_id)
  return Number.isInteger(n) && n > 0 ? n : null
})
const storeCategoryQuery = computed(() => firstString(route.query.store_category))
const categoryQuery = computed(() => firstString(route.query.category))

/** the URL-borne cross filters, minus the subject's own key */
function extraFilters(): AnalysisFilters {
  const out: AnalysisFilters = {}
  if (kind.value !== 'store' && kind.value !== 'category' && categoryQuery.value) out.category = categoryQuery.value
  if (kind.value !== 'store' && storeIdQuery.value !== null) out.store_id = storeIdQuery.value
  if (kind.value !== 'store' && storeCategoryQuery.value) out.store_category = storeCategoryQuery.value
  if (kind.value !== 'label' && period.labelColors.length) out.label_colors = period.labelQuery
  return out
}

// --- data -----------------------------------------------------------------------
const cross = ref<AnalysisResult | null>(null)
const own = ref<AnalysisResult | null>(null)
/** the item axis's stats zone (REVIEW-13 M-4): summary / price history /
 *  by-store of THIS 品名 group (GET /analysis/item with item_query=品名 —
 *  the same name grouping as the axis rows that led here) */
const itemStats = ref<AnalysisItemResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const storeName = ref<string | null>(null)
const storeNameFor = ref<number | null>(null)
const error = ref('')
const loading = ref(false)

// TASK-146 §3: the pane's committed key (bumped at the load commit) and the
// move's direction off the shared period store
const committedKey = ref('')
const move = usePeriodMove(committedKey)

// the trend's movable window (TASK-104): the composable owns the trend
// fetch with this screen's stack axis and the resolved subject as filters —
// while view is unresolved the getter returns undefined and the fetch
// defers, so init() refreshes once the subject is known
const win = useTrendWindow({
  axis: () => stackAxis.value,
  filters: () => (view.value ? { ...view.value.subject, ...extraFilters() } : undefined),
  onError: (m) => (error.value = m ?? ''),
})

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid || !view.value) return
  const v = view.value
  const n = ++seq
  loading.value = true
  error.value = ''
  try {
    if (storeIdQuery.value === null) {
      storeName.value = null
      storeNameFor.value = null
    } else if (storeNameFor.value !== storeIdQuery.value) {
      const found = (await api.listStores(l)).find((s) => s.store_id === storeIdQuery.value)
      if (n !== seq) return
      storeNameFor.value = storeIdQuery.value
      storeName.value = found?.name ?? `#${storeIdQuery.value}`
    }
    // the cross fetch drops the cross axis's own URL filter (it would
    // collapse the cross rows to the one value) but keeps everything else
    const crossExtra: AnalysisFilters = { ...extraFilters() }
    if (crossAxis.value === 'category') delete crossExtra.category
    if (crossAxis.value === 'store') {
      delete crossExtra.store_id
      delete crossExtra.store_category
    }
    const subjectAll: AnalysisFilters = { ...v.subject, ...extraFilters() }
    const subjectItem = v.subject.item_query
    const [crossRes, ownRes, itemRes] = await Promise.all([
      api.getAnalysis(l, {
        axis: crossAxis.value,
        metric: 'amount',
        ...period.query(),
        ...v.subject,
        ...crossExtra,
        limit: 20,
      }),
      ownAxis.value
        ? api.getAnalysis(l, { axis: ownAxis.value, metric: 'amount', ...period.query(), ...subjectAll, limit: 50 })
        : Promise.resolve(null),
      kind.value === 'item' && subjectItem
        ? api.getAnalysisItem(l, { item_query: subjectItem, ...period.query(), ...extraFilters() })
        : Promise.resolve(null),
    ])
    const recentQuery: Parameters<typeof api.listReceipts>[1] = {
      from: period.range[0],
      to: period.range[1],
      limit: 5,
      ...(v.subject.category ? { category: v.subject.category } : {}),
      ...(v.subject.store_id !== undefined ? { store_id: v.subject.store_id } : {}),
      ...(v.subject.item_query ? { item_query: v.subject.item_query } : {}),
      ...(kind.value === 'label' && v.subject.label_colors ? { label_colors: v.subject.label_colors } : {}),
      ...(kind.value !== 'label' && period.labelQuery ? { label_colors: period.labelQuery } : {}),
      ...(kind.value === 'payment' && v.subject.payment_method
        ? { payment_method: v.subject.payment_method }
        : {}),
      ...(kind.value !== 'store' && kind.value !== 'category' && categoryQuery.value
        ? { category: categoryQuery.value }
        : {}),
      ...(kind.value !== 'store' && storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
    }
    const recentRes = await api.listReceipts(l, recentQuery)
    if (n !== seq) return
    cross.value = crossRes
    own.value = ownRes
    itemStats.value = itemRes
    recent.value = recentRes.receipts
    committedKey.value = `${l}|${period.mode}|${period.range[0]}|${period.range[1]}|${period.labelQuery?.join(',') ?? ''}|${route.fullPath}`
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      loading.value = false
      markReady()
    }
  }
}

// The ledger is snapshotted for the heading (the Feed pattern, D28 §4-3):
// switching it on a detail page goes back to the list / home instead of
// resolving another book's catalog under the old heading.
let ledgerCalls = 0
const ledgerId = useLedger((id) => {
  ledgerCalls++
  if (ledgerCalls === 1) void init(id)
  else
    void router.replace({
      path: kind.value === 'store' ? '/stores' : kind.value === 'category' ? '/categories' : '/',
      query: { ...route.query },
    })
})
async function init(id?: number): Promise<void> {
  if (!isAxisRoute()) return
  const l = id ?? ledgerId.value
  if (l === null) return
  try {
    if (await resolveRoute(l)) {
      // the trend window rides the resolved subject — the composable's own
      // watch fired before view resolved and deferred; identical refetches
      // (the composable watch also fires on range changes) stay guarded away
      win.refresh()
      void load(l)
    }
  } catch (e) {
    // the catalog / stores fetch itself failed: the ids cannot resolve —
    // surface it (the load catch form) instead of an unhandled rejection
    error.value = errorMessage(e)
  }
}
// same-component param changes (top -> sub, the ‹ climb, an axis move)
// reload through here — the page never remounts on its own routes. The
// sources are the re-query's real inputs only (TASK-145 D2): the period,
// the label filter, the path (a params change) and the cross-filter query
// keys load's extraFilters reads. The shell URL sync's write-back echo
// (period keys / labels landing on the URL) moves none of them — the store
// continuation keeps the values — so a keys-less landing no longer
// double-fires init; missing= and other redirect-only keys are no re-query
// factor and rightly fire nothing.
watch(
  [
    () => period.range,
    () => period.labelQuery,
    () => route.path,
    () => categoryQuery.value,
    () => storeIdQuery.value,
    () => storeCategoryQuery.value,
  ],
  () => void init(),
)

// --- derived --------------------------------------------------------------------
const totals = computed(() => cross.value?.totals ?? null)

/** ranked rows (amount desc) + the muted "ほか n件・計xx円" rest row */
function rankedRows(res: AnalysisResult | null, top = 5): StatsRow[] {
  if (!res) return []
  const sorted = [...res.rows].sort((a, b) => b.amount - a.amount)
  const out: StatsRow[] = sorted.slice(0, top).map((r) => ({
    keys: [r.key],
    labels: [r.label],
    value: r.amount,
    share: r.share ?? undefined,
  }))
  const tail = sorted.slice(top)
  if (tail.length > 0 || res.truncated_rows > 0) {
    const restAmount = tail.reduce((a, r) => a + r.amount, 0)
    const count = tail.length + res.truncated_rows
    out.push({
      keys: [null],
      labels: [`ほか ${count}件・計${formatYen(restAmount)}`],
      value: restAmount,
      share: undefined,
    })
  }
  return out
}

const crossRows = computed(() => rankedRows(cross.value))
const ownRows = computed(() => rankedRows(own.value, 10))

// TASK-129 (web-common.bar-scale): the screen's ONE absolute scale — the max
// over BOTH rankings' row values (each row bar's outer amount). The trend
// bars join this aggregation at TASK-126.
const screenScale = computed(() =>
  barScale(Math.max(0, ...crossRows.value.map((r) => r.value), ...ownRows.value.map((r) => r.value))),
)

const trendCurrent = computed(() =>
  currentTrendKey(win.granularity.value, period.mode, win.window.value[0], win.window.value[1], period.month),
)

/** A bar press: a day bar opens that day's receipts; a week/month bar moves
 *  the shared period (TASK-89 §1-(3)). */
function onTrendSelect(key: string): void {
  if (win.granularity.value === 'day') {
    void router.push({ path: '/receipts', query: { from: key, to: key, ...labelsInQuery() } })
    return
  }
  if (win.granularity.value === 'week') period.setWeek(key)
  else period.setMonth(key)
}

/** the context every deeper link carries (§4-2 — everything passes down) */
function contextQuery(): Record<string, string | number> {
  return {
    ...period.urlQuery,
    ...(kind.value !== 'category' && categoryQuery.value ? { category: categoryQuery.value } : {}),
    ...(kind.value !== 'store' && storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
    ...(kind.value !== 'store' && storeCategoryQuery.value ? { store_category: storeCategoryQuery.value } : {}),
    ...(kind.value !== 'label' && period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
}

/** a cross row's destination: the counterpart axis's own page, handing this
 *  axis over as the cross filter */
function crossTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  if (id === null) {
    // the 未分類 aggregate of a category cross-section keeps its carve-out
    if (crossAxis.value === 'category' && row.labels[0] === '未分類') return { path: '/axes/category/uncategorized', query: contextQuery() }
    return null
  }
  const q = contextQuery()
  if (crossAxis.value === 'category') return { path: `/axes/category/${id}`, query: q }
  if (crossAxis.value === 'store') return { path: `/axes/store/${id}`, query: q }
  return null
}

/** the category-only extra sections' row destinations: the sub rows drill
 *  into the pair route, the item rows carry their name (the URL key) */
function ownTo(row: StatsRow): RouteLocationRaw | null {
  const v = view.value
  if (!v) return null
  if (ownAxis.value === 'item') {
    return { path: `/axes/item/${encodeURIComponent(row.labels[0] ?? '')}`, query: contextQuery() }
  }
  const id = row.keys[0]
  if (v.topId === undefined || v.topId === null || typeof id !== 'number') return null
  // a row keyed by the displayed top itself: items attached straight to the
  // big category — there is no level below this page for them
  if (id === v.topId) return null
  return { path: `/axes/category/${v.topId}/${id}`, query: contextQuery() }
}

const feedQuery = computed(() =>
  listQueryToContext({
    from: period.range[0],
    to: period.range[1],
    ...(view.value?.subject.category ? { category: view.value.subject.category } : {}),
    ...(view.value?.subject.store_id !== undefined ? { store_id: view.value.subject.store_id } : {}),
    ...(view.value?.subject.item_query ? { item_query: view.value.subject.item_query } : {}),
    ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
  }),
)

/** すべて見る: the receipts list with this subject + the cross filters. */
const allReceiptsTo = computed<RouteLocationRaw>(() => ({
  path: '/receipts',
  query: {
    ...period.urlQuery,
    ...(view.value?.subject.category ? { category: view.value.subject.category } : {}),
    ...(view.value?.subject.store_id !== undefined ? { store_id: view.value.subject.store_id } : {}),
    ...(view.value?.subject.item_query ? { item_query: view.value.subject.item_query } : {}),
    ...(kind.value !== 'label' && period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  },
}))

function labelsInQuery(): Record<string, string> {
  return period.labelColors.length ? { labels: formatLabelQuery(period.labelColors)! } : {}
}

// --- chips: the subject has no x -------------------------------------------------
const labelDefOf = (c: LabelColor): Label =>
  labelsStore.definitions(ledgerId.value ?? -1).find((l) => l.color === c) ?? { color: c, title: null }

const chips = computed<FilterChip[]>(() => {
  if (!view.value) return []
  const out: FilterChip[] = [{ key: 'subject', label: view.value.subjectChip, removable: false }]
  // L-2: the store axis drops ?category= (extraFilters does not apply it), so
  // no chip for a filter that is not in effect
  if (kind.value !== 'store' && kind.value !== 'category' && categoryQuery.value)
    out.push({ key: 'category', label: `カテゴリ: ${categoryQuery.value}` })
  if (kind.value !== 'store' && storeIdQuery.value !== null && storeName.value)
    out.push({ key: 'store', label: `店: ${storeName.value}` })
  if (kind.value !== 'store' && storeCategoryQuery.value)
    out.push({ key: 'store_category', label: `店カテゴリ: ${storeCategoryQuery.value}` })
  if (kind.value !== 'label') for (const c of period.labelColors) out.push({ key: `label-${c}`, label: labelDefOf(c).title ?? c })
  return out
})

function removeChip(key: string): void {
  if (key === 'category' || key === 'store' || key === 'store_category') {
    const queryKey = key === 'store' ? 'store_id' : key
    void router.replace({ query: { ...route.query, [queryKey]: undefined } })
    return
  }
  if (key.startsWith('label-')) {
    // the store write is the only move — the shell-level URL sync carries it
    // into labels= (D2-5; the page's own replace here was the leftover that
    // double-wrote one press)
    const color = key.slice(6)
    period.setLabelColors(period.labelColors.filter((c) => c !== color))
  }
}

// --- the heading row --------------------------------------------------------------
const menuItems = computed<PageMenuItem[]>(() => {
  if (kind.value === 'category')
    return [{ to: '/settings/categories?kind=item', label: 'カテゴリを管理', icon: 'tag', test: 'manage-link' }]
  if (kind.value === 'store')
    return [
      { to: '/settings/stores', label: '店を管理', icon: 'store', test: 'manage-link' },
      { to: '/settings/categories?kind=store', label: '店カテゴリを管理', icon: 'tag', test: 'manage-store-categories-link' },
    ]
  return []
})
</script>

<template>
  <div class="view-page">
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>
    <template v-if="view">
      <PageHead
        :kind-label="AXIS_KIND_LABEL[kind]"
        :title="view.title"
        :total="totals ? formatYen(totals.amount) : undefined"
        :sub="view.sub"
        :parent-to="parentTo ?? { path: '/' }"
        :back-label="view.backLabel"
        :parent="view.parentName"
      >
        <template
          v-if="menuItems.length"
          #menu
        >
          <PageMenu
            ariaLabel="その他の操作"
            :items="menuItems"
          />
        </template>
      </PageHead>
      <BrowseToolbar
        :chips="chips"
        @remove="removeChip"
      />

      <div
        v-if="cross && totals"
        class="view-stack"
        :class="{ loading }"
      >
        <!-- TASK-146 §3: the content transition fires at the load commit -->
        <ContentSwap
          :swap-key="committedKey"
          :dir="move.dir.value"
        >
          <div class="content-pane">
            <PeriodHeader
              :label="`${period.label}の支出`"
              :total="totals.amount"
              data-test="axis-period"
            />

            <div class="dash-cols">
              <div class="col-main">
                <section
                  class="zone"
                  :class="{ 'is-loading': win.loading.value }"
                  data-test="trend-card"
                >
                  <div class="zone-head">
                    <h2 class="zone-title">
                      支出の推移
                    </h2>
                  </div>
                  <TrendWindow
                    v-if="win.result.value"
                    :stacked="win.stacked.value"
                    :granularity="win.granularity.value"
                    :span="win.window.value"
                    :current="trendCurrent"
                    :nav="win.active.value"
                    :can-prev="win.canPrev.value"
                    :can-next="win.canNext.value"
                    :window-key="win.windowKey.value"
                    :slide="win.slide.value"
                    @prev="win.prev"
                    @next="win.next"
                    @select="onTrendSelect"
                    @finish-slide="win.finishSlide"
                  />
                </section>

                <!-- the item axis's own extra zone (REVIEW-13 M-4): the price
               movement / purchase stores / frequency of this 品名 group -->
                <section
                  v-if="kind === 'item'"
                  class="zone"
                  data-test="item-stats"
                >
                  <div class="zone-head">
                    <h2 class="zone-title">
                      品目の記録
                    </h2>
                  </div>
                  <template v-if="itemStats && itemStats.summary.count > 0">
                    <p
                      class="muted small"
                      data-test="item-summary"
                    >
                      {{ itemStats.summary.count }}件・{{ formatYen(itemStats.summary.amount) }}・平均単価
                      {{ formatYen(itemStats.summary.avg_unit_price ?? 0) }}・最安
                      {{ formatYen(itemStats.summary.min_unit_price ?? 0) }}〜最高
                      {{ formatYen(itemStats.summary.max_unit_price ?? 0) }}・最終購入
                      {{ itemStats.summary.last_purchased_on ? shortDate(itemStats.summary.last_purchased_on) : '-' }}・{{
                        itemStats.summary.stores.length
                      }}店
                    </p>
                    <div class="zone-head">
                      <h3 class="zone-title">
                        価格履歴
                      </h3>
                    </div>
                    <ul
                      class="recent-list"
                      data-test="item-prices"
                    >
                      <li
                        v-for="(p, i) in itemStats.prices"
                        :key="`${p.date}-${i}`"
                        data-test="item-price-row"
                      >
                        <span class="recent-row">
                          <span class="recent-date">{{ shortDate(p.date) }}</span>
                          <span class="recent-store truncate">{{ p.store_name ?? '店名なし' }}</span>
                          <span class="amount">{{ formatYen(p.unit_price) }}</span>
                        </span>
                      </li>
                    </ul>
                    <div class="zone-head">
                      <h3 class="zone-title">
                        店別
                      </h3>
                    </div>
                    <ul
                      class="recent-list"
                      data-test="item-stores"
                    >
                      <li
                        v-for="s in itemStats.by_store"
                        :key="s.store_id ?? 'none'"
                        data-test="item-store-row"
                      >
                        <span class="recent-row">
                          <span class="recent-store truncate">{{ s.store_name }}</span>
                          <span class="muted small">{{ s.count }}件・平均{{ formatYen(s.avg_unit_price ?? 0) }}</span>
                          <span class="amount">{{ formatYen(s.amount) }}</span>
                        </span>
                      </li>
                    </ul>
                  </template>
                  <p
                    v-else
                    class="muted empty"
                  >
                    この期間の記録はありません。
                  </p>
                </section>
              </div>

              <div class="col-side">
                <section
                  class="zone zone--list"
                  data-test="cross"
                >
                  <div class="zone-head">
                    <h2 class="zone-title">
                      {{ crossTitle }}
                    </h2>
                  </div>
                  <p
                    v-if="crossRows.length === 0"
                    class="muted empty"
                  >
                    この期間の記録はありません。
                  </p>
                  <RankedList
                    v-else
                    :rows="crossRows"
                    :to="crossTo"
                    :axis="crossAxis"
                    :scale="screenScale"
                  />
                </section>

                <section
                  v-if="ownAxis"
                  class="zone zone--list"
                  data-test="own"
                >
                  <div class="zone-head">
                    <h2 class="zone-title">
                      {{ ownTitle }}
                    </h2>
                  </div>
                  <p
                    v-if="ownRows.length === 0"
                    class="muted empty"
                  >
                    この期間の記録はありません。
                  </p>
                  <RankedList
                    v-else
                    :rows="ownRows"
                    :to="ownTo"
                    :axis="ownAxis ?? undefined"
                    :scale="screenScale"
                  />
                </section>

                <section
                  class="zone zone--list"
                  data-test="recent"
                >
                  <div class="zone-head">
                    <h2 class="zone-title">
                      最近のレシート
                    </h2>
                    <RouterLink
                      :to="allReceiptsTo"
                      class="ibtn"
                      aria-label="すべて見る"
                      title="すべて見る"
                      data-test="all-receipts"
                    >
                      <AppIcon name="chevron-right" />
                    </RouterLink>
                  </div>
                  <p
                    v-if="recent.length === 0"
                    class="muted empty"
                  >
                    この期間の記録はありません。
                  </p>
                  <ul
                    v-else
                    class="recent-list"
                  >
                    <li
                      v-for="r in recent"
                      :key="r.receipt_id"
                    >
                      <RouterLink
                        :to="{ path: `/receipts/${r.receipt_id}`, query: feedQuery }"
                        class="recent-row"
                        :data-test="`recent-${r.receipt_id}`"
                      >
                        <span class="recent-date">{{ shortDate(r.purchased_on) }}</span>
                        <span class="recent-store truncate">{{ r.store_name ?? '店名なし' }}</span>
                        <span class="row-labels"><LabelDots
                          :labels="r.labels ?? []"
                          compact
                        /></span>
                        <span class="amount">{{ formatYen(r.amount) }}</span>
                      </RouterLink>
                    </li>
                  </ul>
                </section>
              </div>
            </div>
          </div>
        </ContentSwap>
      </div>
      <DashSkeleton v-else-if="loading" />
    </template>
    <DashSkeleton v-else />
  </div>
</template>
