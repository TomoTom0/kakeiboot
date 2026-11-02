<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import LabelDots from '@/shared/components/LabelDots.vue'
import type { Label, LabelColor } from '@/shared/labels'
import { useDataApi, type AnalysisResult, type AnalysisTrendResult, type PaymentMethod, type ReceiptListQuery, type ReceiptSummary, type StatsRow } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import AppearList from '../components/AppearList.vue'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import ContentSwap from '../components/ContentSwap.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import type { FilterChip } from '../components/FilterChips.vue'
import PopoverPanel from '../components/PopoverPanel.vue'
import RankedList from '../components/RankedList.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { usePageReady } from '../composables/usePageReady'
import { usePeriodMove } from '../composables/periodMove'
import { PAYMENT_LABEL, isPaymentMethod } from '../composables/labels'
import { axisMonthLabels, dayLabel, monthLabel, periodDays, shortDate, shortTime } from '../composables/period'
import { feedReturn, listQueryToContext } from '../composables/receiptContext'
import { bucketSpan, spanGranularity } from '../composables/trend'
import { allocateStack, barScale, stackedOf } from '@/shared/lib/stackedBars'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'

// Receipts dashboard (read-only): the period's total / count / average,
// daily spending and payment methods, then the receipts grouped by day
// (spec_mcp-tools.md 7-8: newest first). Filters (store / item / category
// and the label colors of TASK-17) narrow both the figures and the list;
// links from the other screens set them through the URL query.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const { markReady } = usePageReady()
const rootEl = ref<HTMLElement | null>(null)

const s = (v: unknown) => (typeof v === 'string' ? v : '')
// include_deleted comes back through the URL (the feed round trip returns
// the same context), read the same way receiptContext.ts does
const includeDeletedQuery = s(route.query.include_deleted)
// TASK-65: the payment-method filter rides the URL like the text filters (a
// const first so the isPaymentMethod predicate narrows the property's type)
const paymentQuery = s(route.query.payment_method)
const filters = reactive({
  store: s(route.query.store),
  item: s(route.query.item),
  category: s(route.query.category),
  paymentMethod: (isPaymentMethod(paymentQuery) ? paymentQuery : '') as PaymentMethod | '',
  includeDeleted: includeDeletedQuery === '1' || includeDeletedQuery === 'true',
  labelColors: [] as LabelColor[],
})
// Label filter truth (TASK-17 design 2-5 L3): the URL "labels" key, kept in
// step with the shared store by the shell-level URL sync (TASK-124 D2) —
// which imports a deep link's labels into the store (and the keys-less
// entry the other way round) before this page sets up, so reading the store
// here covers both entries. Later changes arrive from the topbar label chip
// through watch(period.labelQuery) below.
filters.labelColors = [...period.labelColors]
const draft = reactive({ ...filters, labelColors: [...filters.labelColors] })
const filtersOpen = ref(false)

const receipts = ref<ReceiptSummary[]>([])
const totalCount = ref(0)
const sumAmount = ref(0)
const nextCursor = ref<string | null>(null)
const payments = ref<AnalysisResult | null>(null)
// TASK-116 (design §3-2): the WHOLE trend result stays (stackedOf reads the
// series off it — limit 5 fetches the top series for the stacked bars)
const trendRes = ref<AnalysisTrendResult | null>(null)
const error = ref('')
const loading = ref(false)

// TASK-146 §3: the pane's committed key (bumped at the load commit) and the
// move's direction off the shared period store
const committedKey = ref('')
const move = usePeriodMove(committedKey)
// first load finished at least once: until then the screen shows the
// skeleton; later reloads keep the grid and dim it (TASK-39 D)
const loaded = ref(false)

function listQuery(cursor?: string): ReceiptListQuery {
  const [from, to] = period.range
  return {
    from,
    to,
    store: filters.store.trim() || undefined,
    item_query: filters.item.trim() || undefined,
    category: filters.category.trim() || undefined,
    payment_method: filters.paymentMethod || undefined,
    label_colors: filters.labelColors,
    include_deleted: filters.includeDeleted || undefined,
    limit: 50,
    cursor,
  }
}

function analysisFilters() {
  return {
    ...period.query(),
    ...(filters.store.trim() ? { store: filters.store.trim() } : {}),
    ...(filters.item.trim() ? { item_query: filters.item.trim() } : {}),
    ...(filters.category.trim() ? { category: filters.category.trim() } : {}),
    ...(filters.paymentMethod ? { payment_method: filters.paymentMethod } : {}),
    label_colors: filters.labelColors,
  }
}

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  try {
    const [list, pm, tr] = await Promise.all([
      api.listReceipts(l, listQuery()),
      // the payment ranking rides the analysis endpoint (TASK-89: the old
      // GET /stats web route is gone)
      api.getAnalysis(l, { axis: 'payment_method', ...analysisFilters(), limit: 50 }),
      // TASK-116 (design §3-2): limit 5 so the bars can stack their series
      // (top-5 + the client-side residual; the call count stays three)
      api.getAnalysisTrend(l, { axis: 'category', granularity: spanGranularity(...period.range), ...analysisFilters(), limit: 5 }),
    ])
    if (n !== seq) return
    receipts.value = list.receipts
    totalCount.value = list.total_count
    sumAmount.value = list.sum_amount
    nextCursor.value = list.next_cursor
    payments.value = pm
    trendRes.value = tr
    // the pane's committed identity: the query (period + every filter) as it
    // was answered, so the content transition fires here — never at the press
    committedKey.value = `${l}|${JSON.stringify(listQuery())}`
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      // settle the render-affecting state first: the scroll lookup below
      // rides the nextTick after this render, and the skeleton branch does
      // not depend on the list refs, so the flip must come first
      loading.value = false
      loaded.value = true
      markReady()
      void scrollToReturned()
    }
  }
}

/** Returning from the feed: scroll its row into view (once). */
async function scrollToReturned(): Promise<void> {
  const id = feedReturn.receiptId
  if (id === null) return
  feedReturn.receiptId = null
  await nextTick()
  // query inside this page's root: the test mount may be off-document
  rootEl.value?.querySelector(`#receipt-${id}`)?.scrollIntoView({ block: 'start' })
}

async function more(): Promise<void> {
  const l = ledgerId.value
  if (l === null || !nextCursor.value) return
  try {
    const list = await api.listReceipts(l, listQuery(nextCursor.value))
    receipts.value = [...receipts.value, ...list.receipts]
    nextCursor.value = list.next_cursor
  } catch (e) {
    error.value = errorMessage(e)
  }
}

const ledgerId = useLedger((id) => load(id))
watch(() => period.range, () => void load())
// the label filter moved to the topbar center bar (TASK-44 §11-3): its
// dialog writes the shared store, this page follows it into the list (the
// labels= URL itself is the shell-level URL sync's, TASK-124 D2-5)
watch(() => period.labelQuery, (colors) => {
  filters.labelColors = [...(colors ?? [])]
  void load()
})

const labelsStore = useLabelsStore()
/** Definition of a selected filter color, for the filter-chip LabelChips. */
const labelDefOf = (c: LabelColor): Label =>
  labelsStore.definitions(ledgerId.value ?? -1).find((l) => l.color === c) ?? { color: c, title: null }

function applyFilters(): void {
  // label colors are toggled immediately and never come from this form
  filters.store = draft.store
  filters.item = draft.item
  filters.category = draft.category
  filters.paymentMethod = draft.paymentMethod
  filters.includeDeleted = draft.includeDeleted
  filtersOpen.value = false
  syncQuery()
  void load()
}

function clearFilter(key: 'store' | 'item' | 'category'): void {
  filters[key] = ''
  draft[key] = ''
  syncQuery()
  void load()
}

/** RankedList's select: a payment row press toggles the filter in place (the
 *  aggregate rows — ほか / 支払方法不明, keys[0]=null — stay inert). */
function onPaymentRow(row: StatsRow): void {
  const m = row.keys[0]
  if (typeof m !== 'string') return
  togglePayment(m as PaymentMethod)
}

function togglePayment(method: PaymentMethod): void {
  filters.paymentMethod = filters.paymentMethod === method ? '' : method
  draft.paymentMethod = filters.paymentMethod
  syncQuery()
  void load()
}

function syncQuery(): void {
  // keep the filters and the feed-round-trip context in the URL: rows link
  // back into the feed with this same context. The period mode keys and
  // labels= belong to the shell-level URL sync (TASK-124 D2-5) — the replace
  // starts from the current query so their present values ride along, and
  // from/to (the range's derived value, D2-4) lands here for the feed round
  // trip (a reload/deep link restores the mode off the mode key, TASK-57 A16)
  const context = listQueryToContext(listQuery())
  delete context.labels
  const query: LocationQueryRaw = { ...route.query, ...context }
  // a dropped filter key must leave the URL too — the spread above only adds
  for (const k of ['store', 'item', 'category', 'payment_method', 'include_deleted']) {
    if (!(k in context)) delete query[k]
  }
  void router.replace({ query })
}

const activeFilters = computed(() =>
  (
    [
      ['store', '店', filters.store],
      ['item', '品名', filters.item],
      ['category', 'カテゴリ', filters.category],
    ] as const
  ).filter(([, , v]) => v.trim() !== ''),
)

/** The toolbar's condition chips (TASK-75: the FilterChips form): the text
 * filters as「店: イオン」style chips and one chip per selected label color
 * (the title when the ledger defined one, the color key otherwise — the same
 * form as the detail pages). */
const chips = computed<FilterChip[]>(() => [
  ...activeFilters.value.map(([key, label, value]) => ({ key, label: `${label}: ${value}` })),
  ...(filters.paymentMethod ? [{ key: 'payment', label: `支払: ${PAYMENT_LABEL[filters.paymentMethod]}` }] : []),
  ...filters.labelColors.map((c) => ({ key: `label-${c}`, label: labelDefOf(c).title ?? c })),
])

/** A chip's x: text filters clear through clearFilter, a label chip drops
 * just its color (the surviving colors keep filtering through the
 * watch(period.labelQuery) path). */
function removeChip(key: string): void {
  if (key === 'store' || key === 'item' || key === 'category') {
    clearFilter(key)
    return
  }
  if (key === 'payment') {
    // the chip exists only while a method is selected (TS can't see that)
    if (filters.paymentMethod) togglePayment(filters.paymentMethod)
    return
  }
  if (key.startsWith('label-')) {
    period.setLabelColors(filters.labelColors.filter((c) => c !== (key.slice(6) as LabelColor)))
  }
}

const average = computed(() => (totalCount.value ? Math.round(sumAmount.value / totalCount.value) : 0))
/** 1日あたり (TASK-57 A6): the same periodDays rule as the Home KPI. */
const perDay = computed(() => {
  const [from, to] = period.range
  return Math.round(sumAmount.value / periodDays(from, to))
})

/** the payment ranking rows: amount desc + the muted rest row (the old
 *  by_payment_method "その他" fold is the client's now). */
const paymentRows = computed<StatsRow[]>(() => {
  const res = payments.value
  if (!res) return []
  const sorted = [...res.rows].sort((a, b) => b.amount - a.amount)
  const out: StatsRow[] = sorted.map((r) => ({
    keys: [r.key],
    labels: [r.label],
    value: r.amount,
    share: r.share ?? undefined,
  }))
  if (res.truncated_rows > 0) {
    // the folded tail's amount: the period total minus the shown rows (the
    // value cell is money, not the row count — REVIEW-13 M-1)
    const restAmount = res.totals.amount - sorted.reduce((a, r) => a + r.amount, 0)
    out.push({
      keys: [null],
      labels: [`ほか ${res.truncated_rows}件・計${formatYen(restAmount)}`],
      value: restAmount,
      share: undefined,
    })
  }
  return out
})

// TASK-129 (web-common.bar-scale): the screen's ONE absolute scale — the max
// over the payment ranking rows' values (the screen's row bars; the daily
// zone stays on its own basis until TASK-126 wires it in).
const screenScale = computed(() => barScale(Math.max(0, ...paymentRows.value.map((r) => r.value))))

/** TASK-55/A8: the trend card follows the period's length — day (<=62 days,
 *  e.g. a month's 31 bars), Monday-anchored weeks (63..366) or months — so it
 *  never disappears on long periods. TASK-116 (design §3-2): the bars stack
 *  their series — stackedOf (shared) assembles each bucket's segments (top-3
 *  + the residual「ほか」) off the same getAnalysisTrend fetch. TASK-123
 *  (design §4-4/§4-5): the segments carry explicit px heights off the shared
 *  allocateStack (the .daily-bars track is a fixed 110px, so the bar's px
 *  length is the raw value ratio x 110 — no min floors, no top clip), the
 *  full-perimeter 1px outline (border-box inner consumption; rule F drops it
 *  inline) and the top segment's cap radius off the measured column width. */
const trendGran = computed(() => spanGranularity(...period.range))
const trendTitle = computed(() =>
  trendGran.value === 'day' ? '日別の支出' : trendGran.value === 'week' ? '週別の支出' : '月別の支出',
)
/** the .daily-bars track's fixed height (styles.css) — the allocation's px
 * basis; the columns' measured width feeds the corner cap */
const DAILY_TRACK_H = 110
const dailyBarsEl = ref<HTMLElement | null>(null)
const dailyColW = ref(0)
let dailyRo: ResizeObserver | null = null
function measureDaily(): void {
  const col = dailyBarsEl.value?.querySelector('.daily-col') ?? null
  dailyColW.value = col ? col.clientWidth : 0
}
onMounted(() => {
  measureDaily()
  if (typeof ResizeObserver === 'undefined') return
  dailyRo = new ResizeObserver(measureDaily)
  if (dailyBarsEl.value) dailyRo.observe(dailyBarsEl.value)
})
// TASK-146 §3 (ContentSwap 導入に伴う局所stateの確認事項3): the pane's
// commit remounts the .daily-bars element, so the observer must follow the
// ref — a mount-time-only observe would keep watching the detached old node
watch(dailyBarsEl, (el, prev) => {
  if (el === prev) return
  measureDaily()
  if (el) dailyRo?.observe(el)
  if (prev) dailyRo?.unobserve(prev)
})
onBeforeUnmount(() => {
  dailyRo?.disconnect()
  dailyRo = null
})
const trendCols = computed(() => {
  const res = trendRes.value
  if (!res) return []
  const [from, to] = period.range
  const totals = res.bucket_totals
  const stacked = stackedOf(res)
  const max = Math.max(
    ...totals.map((t) => t ?? 0),
    1,
  )
  const title = (key: string, value: number) => {
    if (trendGran.value === 'day') return `${dayLabel(key)} ${formatYen(value)}`
    if (trendGran.value === 'month') return `${monthLabel(key)} ${formatYen(value)}`
    const [lo, hi] = bucketSpan(key, 'week', from, to)
    return `${shortDate(lo)}〜${shortDate(hi)} ${formatYen(value)}`
  }
  return res.buckets.map((key, i) => {
    const value = totals[i] ?? 0
    const ratio = value > 0 ? value / max : 0
    // the stack's px length and its % height are the same raw ratio — the
    // allocation's sizes close over the px length exactly (§4-5 rule A)
    const length = ratio * DAILY_TRACK_H
    const allocated = value > 0 ? allocateStack(stacked[i]?.segments ?? [], length) : []
    const segTotal = allocated.reduce((a, s) => a + s.value, 0)
    return {
      key,
      value,
      height: value ? ratio * 100 : 0,
      title: title(key, value),
      segments: allocated.map((s, j) => ({
        ...s,
        segHeight: s.size,
        top: j === allocated.length - 1,
        pct: segTotal > 0 ? Math.round((s.value / segTotal) * 100) : null,
      })),
    }
  })
})
/** the top segment's corner radius: the cap arithmetic min(2px, width/4) */
const dailyRadius = computed(() => Math.min(2, dailyColW.value / 4))
const trendAxis = computed(() => {
  const cols = trendCols.value
  if (cols.length === 0) return null
  if (trendGran.value === 'day') {
    return { first: dayLabel(cols[0]!.key), last: dayLabel(cols.at(-1)!.key) }
  }
  if (trendGran.value === 'month') return axisMonthLabels(cols.map((c) => c.key))
  return { first: shortDate(cols[0]!.key), last: shortDate(cols.at(-1)!.key) }
})

const groups = computed(() => {
  const out: { date: string; total: number; rows: ReceiptSummary[] }[] = []
  for (const r of receipts.value) {
    const d = r.purchased_on ?? ''
    let g = out[out.length - 1]
    if (!g || g.date !== d) {
      g = { date: d, total: 0, rows: [] }
      out.push(g)
    }
    g.rows.push(r)
    if (!r.deleted_at) g.total += r.amount
  }
  return out
})
</script>

<template>
  <div
    ref="rootEl"
    class="view-page"
  >
    <BrowseToolbar
      :chips="chips"
      @remove="removeChip"
    >
      <template #filter>
        <!-- TASK-76 (§6-3): the 絞り込み form opens in the button's
             PopoverPanel instead of folding inline, so the page body below
             the toolbar never grows — the sheet-narrow variant turns it into
             a bottom sheet with a scrim through 480px -->
        <PopoverPanel
          v-model:open="filtersOpen"
          class="filters-popover"
          variant="sheet-narrow"
          label="レシートを絞り込み"
        >
          <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
            <button
              type="button"
              class="btn btn-small toolbar-filter-btn"
              :aria-expanded="expanded"
              :aria-controls="controls"
              data-test="filters-toggle"
            >
              <AppIcon
                name="search"
                :size="16"
              /><span class="toolbar-filter-word">絞り込み</span><span
                v-if="chips.length > 0"
                class="toolbar-filter-count"
              >{{ chips.length }}</span>
            </button>
          </template>
          <form
            class="filters"
            data-test="filters"
            @submit.prevent="applyFilters"
          >
            <label class="field"><span>店名</span><input
              v-model="draft.store"
              type="search"
              maxlength="200"
              data-autofocus
              data-test="store"
            ></label>
            <label class="field"><span>品名</span><input
              v-model="draft.item"
              type="search"
              maxlength="200"
              data-test="item"
            ></label>
            <label class="field"><span>カテゴリ（例: 食費、食費/外食、未分類）</span><input
              v-model="draft.category"
              type="search"
              data-test="category"
            ></label>
            <!-- TASK-65: the payment-method filter select (未設定 = no filter) -->
            <label class="field"><span>支払方法</span><select
              v-model="draft.paymentMethod"
              data-test="payment"
            ><option value="">未設定</option><option
              v-for="(label, key) in PAYMENT_LABEL"
              :key="key"
              :value="key"
            >{{ label }}</option></select></label>
            <label class="check"><input
              v-model="draft.includeDeleted"
              type="checkbox"
              data-test="include-deleted"
            > 削除済みも一覧に表示</label>
            <div class="actions">
              <button
                class="btn btn-primary"
                type="submit"
                data-test="search"
              >
                適用
              </button>
            </div>
          </form>
        </PopoverPanel>
      </template>
    </BrowseToolbar>

    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <DashSkeleton v-if="loading && !loaded" />
    <div
      v-else
      class="view-stack"
      :class="{ loading }"
    >
      <!-- TASK-146 §3: the content transition fires at the load commit -->
      <ContentSwap
        :swap-key="committedKey"
        :dir="move.dir.value"
      >
        <div class="content-pane">
          <section
            class="card kpi"
            data-test="summary"
          >
            <p class="kpi-head">
              <span class="label">{{ period.label }}の支出</span>
              <strong class="kpi-value">{{ formatYen(sumAmount) }}</strong>
            </p>
            <p class="kpi-sub">
              レシート {{ totalCount }}件 ・ 1日あたり {{ formatYen(perDay) }} ・ 1件あたり {{ formatYen(average) }}
            </p>
          </section>

          <div class="dash-cols">
            <div class="col-main">
              <section
                class="zone"
                data-test="daily"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    {{ trendTitle }}
                  </h2>
                </div>
                <div
                  ref="dailyBarsEl"
                  class="daily-bars"
                  :style="{ gridTemplateColumns: `repeat(${trendCols.length || 1}, minmax(0.25rem, 1fr))` }"
                >
                  <span
                    v-for="c in trendCols"
                    :key="c.key"
                    class="daily-col"
                    :title="c.title"
                  >
                    <!-- TASK-116 (design §3-2): the bar is a stacked container —
                     column-reverse puts the first (top) series at the base;
                     a zero bucket keeps the height-0 element with no
                     segments (the same drawing as before: no visible bar).
                     TASK-123: explicit px segment heights off allocateStack,
                     the full-perimeter 1px outline (rule F drops it inline)
                     and the top segment's cap radius -->
                    <span
                      class="daily-bar"
                      :style="{ height: `${c.height}%` }"
                    >
                      <span
                        v-for="(seg, i) in c.segments"
                        :key="i"
                        class="daily-seg"
                        :style="{
                          height: `${seg.segHeight}px`,
                          background: seg.color,
                          ...(seg.outline ? {} : { border: 'none' }),
                          ...(seg.top ? { borderRadius: `${dailyRadius}px ${dailyRadius}px 0 0` } : {}),
                        }"
                        :title="`${seg.label} ${formatYen(seg.value)}${seg.pct !== null ? `（${seg.pct}%）` : ''}`"
                      />
                    </span>
                  </span>
                </div>
                <div
                  v-if="trendAxis"
                  class="axis-ends muted small"
                >
                  <span>{{ trendAxis.first }}</span>
                  <span v-if="trendAxis.last">{{ trendAxis.last }}</span>
                </div>
              </section>
            </div>

            <div class="col-side">
              <section
                class="zone zone--list"
                data-test="payments"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    支払方法
                  </h2>
                </div>
                <!-- TASK-65: a row press toggles the payment filter in place (the
                 null-key aggregates stay inert rows) -->
                <RankedList
                  v-if="paymentRows.length > 0"
                  :rows="paymentRows"
                  :select="onPaymentRow"
                  :scale="screenScale"
                />
                <p
                  v-else
                  class="muted empty"
                >
                  この期間の記録はありません。
                </p>
              </section>
            </div>
          </div>

          <section
            class="zone"
            data-test="receipts"
          >
            <div class="zone-head">
              <h2 class="zone-title">
                レシート
              </h2>
            </div>
            <p
              v-if="!loading && receipts.length === 0"
              class="empty-state"
              data-test="empty"
            >
              <AppIcon
                name="chat"
                :size="28"
              />
              該当するレシートはありません。ChatGPT や Claude でレシートの写真を送ると記録されます。
            </p>
            <div
              v-for="g in groups"
              :key="g.date"
              class="day-group"
            >
              <div class="day-head">
                <span>{{ g.date ? dayLabel(g.date) : '日付なし' }}</span>
                <span class="amount muted">{{ formatYen(g.total) }}</span>
              </div>
              <!-- AppearList (review MED2): a "さらに表示" page can open a
                   NEW day group whose rows appear through the same grammar,
                   while the pane rebuild of a period step mounts with the
                   rows silent — the pane's motion is the one motion -->
              <AppearList class="recent-list">
                <li
                  v-for="r in g.rows"
                  :id="`receipt-${r.receipt_id}`"
                  :key="r.receipt_id"
                  :data-test="`receipt-${r.receipt_id}`"
                >
                  <RouterLink
                    :to="{ path: `/receipts/${r.receipt_id}`, query: listQueryToContext(listQuery()) }"
                    class="recent-row receipt-row"
                    :class="{ deleted: r.deleted_at }"
                  >
                    <!-- the day head carries the date (TASK-63/57): the row's
                     column is the time; the 日付なし group shows '-' too -->
                    <span class="recent-date">{{ g.date ? shortTime(r.purchased_time) : '-' }}</span>
                    <span
                      class="recent-store truncate"
                      data-test="store-name"
                    >{{ r.store_name ?? '店名なし' }}</span>
                    <span
                      class="row-labels"
                      data-test="row-labels"
                    ><span
                      v-if="r.deleted_at"
                      class="badge badge-danger"
                    >削除済み</span><LabelDots
                      :labels="r.labels ?? []"
                      compact
                    /></span>
                    <span class="amount">{{ formatYen(r.amount) }}</span>
                  </RouterLink>
                </li>
              </AppearList>
            </div>
            <!-- TASK-146 §3 #18: the appended rows appear through the shared
             bb-appear grammar — the loaded rows never move -->
            <button
              v-if="nextCursor"
              class="btn more-btn"
              data-test="more"
              @click="more"
            >
              さらに表示
            </button>
          </section>
        </div>
      </ContentSwap>
    </div>
  </div>
</template>
