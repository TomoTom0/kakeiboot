<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import LabelDots from '@/shared/components/LabelDots.vue'
import {
  useDataApi,
  type AnalysisAxis,
  type AnalysisResult,
  type AnalysisTrendResult,
  type ReceiptSummary,
  type StatsRow,
} from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import ContentSwap from '../components/ContentSwap.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PeriodHeader from '../components/PeriodHeader.vue'
import RankedList from '../components/RankedList.vue'
import TrendWindow from '../components/TrendWindow.vue'
import WeekRows from '../components/WeekRows.vue'
import type { WeekRow } from '../components/WeekRows.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { shiftDate, shortDate, weekStart } from '../composables/period'
import { usePeriodMove } from '../composables/periodMove'
import { bucketSpan, currentTrendKey } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { barScale, stackedOf } from '@/shared/lib/stackedBars'
import { useTrendWindow } from '../composables/trendWindow'
import { usePeriodStore } from '../stores/period'

// Home (TASK-89 redesign, the compare side removed): one column, four
// compartments — the period header, the stacked trend, the category
// breakdown, the recent receipts. The breakdown stays category-fixed and
// the trend is the stacked money view (TASK-95: no mode / metric chrome).
// The period / label filters live in the shared period store and every
// card re-queries through the watches below.
const api = useDataApi()
const router = useRouter()
const period = usePeriodStore()
const { markReady } = usePageReady()
// the deep-linked period / labels keys arrive through the shell-level URL
// sync (TASK-124 D2) before this page sets up — the store is already in the
// URL's shape here

const analysis = ref<AnalysisResult | null>(null)
const weekRes = ref<AnalysisTrendResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const error = ref('')
const loading = ref(false)

// TASK-146 §3: the content transition's committed key (bumped only at the
// load commit — mid-refetch the old content stays dimmed) and the move's
// direction off the shared period store
const committedKey = ref('')
const move = usePeriodMove(committedKey)

// TASK-146 §2: the month mode's week rows cover every week overlapping the
// selected month — from the Monday of the week holding the 1st to the
// Sunday of the week holding the last day, so the edge rows are FULL 7-day
// weeks (their labels write the month crossing as-is and the totals include
// the adjacent month's days). Null outside the month mode (no week zone).
const weekSpan = computed<[string, string] | null>(() => {
  if (period.mode !== 'month') return null
  const [mFrom, mTo] = period.range
  return [weekStart(mFrom), shiftDate(weekStart(mTo), 6)]
})

// the trend's movable window (TASK-104): the composable owns the trend
// fetch and the stacked assembly; the week rows below stay in load()
const win = useTrendWindow({ axis: () => 'category', onError: (m) => (error.value = m ?? '') })

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const [a, r, wk] = await Promise.all([
      api.getAnalysis(l, { axis: 'category', metric: 'amount', ...period.query(), ...labels, limit: 50 }),
      api.listReceipts(l, { from: period.range[0], to: period.range[1], limit: 5, ...labels }),
      // TASK-103: the month mode's week rows. TASK-146 §2: the fetch range
      // crosses the month (weekSpan) so the backend's Monday-anchored week
      // buckets come back as the full 7-day weeks. TASK-116 (design §3-1):
      // limit 5 brings the month's top series so the row's inline bar can
      // stack its breakdown (the same top-3 + residual assembly the trend
      // paints — TASK-123: the fetch keeps limit=5, the FRONTEND slices to
      // the top 3)
      ...(weekSpan.value
        ? [api.getAnalysisTrend(l, {
            axis: 'category',
            metric: 'amount',
            granularity: 'week',
            from: weekSpan.value[0],
            to: weekSpan.value[1],
            ...labels,
            limit: 5,
          })]
        : []),
    ])
    if (n !== seq) return
    analysis.value = a
    recent.value = r.receipts
    weekRes.value = wk ?? null
    // the pane's committed identity (the content transition fires here,
    // at the commit — never at the press)
    committedKey.value = `${l}|${period.mode}|${period.range[0]}|${period.range[1]}|${period.labelQuery?.join(',') ?? ''}`
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      loading.value = false
      markReady()
    }
  }
}

const ledgerId = useLedger((id) => load(id))
// one array watch so a change that moves both (a ledger switch resetting the
// labels, or a tab switch moving range and mode together) fetches once;
// mode is an explicit watch source on its own — the reload on a mode change
// must not ride on range's reference comparison (the range computed always
// returns a fresh array, which today happens to fire the watcher anyway —
// that is an implementation detail, not a contract)
watch([() => period.range, () => period.labelQuery, () => period.mode], () => void load())

const totals = computed(() => analysis.value?.totals ?? null)

/** an axis row's destination: /axes/<axis>/<key> with the period + labels
 *  context */
function axisTo(axis: AnalysisAxis, key: string | number | null, label: string): RouteLocationRaw | null {
  const query = {
    ...period.urlQuery,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
  if (axis === 'category') {
    if (key === null) return label === '未分類' ? { path: '/axes/category/uncategorized', query } : null
    return { path: `/axes/category/${key}`, query }
  }
  if (axis === 'store') return typeof key === 'number' ? { path: `/axes/store/${key}`, query } : null
  if (axis === 'item') return { path: `/axes/item/${encodeURIComponent(label)}`, query }
  if (axis === 'label') return key === null ? null : { path: `/axes/label/${key}`, query }
  // payment_method: the key is the method string
  return typeof key === 'string' ? { path: `/axes/payment/${key}`, query } : null
}

// --- the stacked trend (§1-(3)) ---------------------------------------------------
// §6: the current key keeps existing rules — out of the slid window it just
// matches no bar and the highlight drops until the window returns
const trendCurrent = computed(() =>
  currentTrendKey(win.granularity.value, period.mode, win.window.value[0], win.window.value[1], period.month),
)

/** A bar press: a day bar opens that day's receipts list, a week/month bar
 *  moves the shared period (TASK-89 §1-(3)). */
function onTrendSelect(key: string): void {
  if (win.granularity.value === 'day') {
    void router.push({
      path: '/receipts',
      query: { from: key, to: key, ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) },
    })
    return
  }
  if (win.granularity.value === 'week') period.setWeek(key)
  else period.setMonth(key)
}

// --- the month mode's week rows (TASK-103) ----------------------------------------
// TASK-116 (design §3-1): the row's inline bar carries the series breakdown —
// stackedOf (shared) assembles each week's segments off the same fetch; the
// month's top-3 series stay fixed across the weeks (whole-month ranking)
const weeks = computed<WeekRow[]>(() => {
  const res = weekRes.value
  const span = weekSpan.value
  if (!res || !span) return []
  const stacked = stackedOf(res)
  return res.buckets.map((b, i) => {
    const [lo, hi] = bucketSpan(b, 'week', span[0], span[1])
    return { key: b, label: `${shortDate(lo)}〜${shortDate(hi)}`, total: res.bucket_totals[i] ?? 0, segments: stacked[i]?.segments ?? [] }
  })
})
// TASK-146 §2: the current-week highlight survives onto the edge row whose
// week overlaps the month from the adjacent side — the extended span holds
// today's week whenever the month does
const weekCurrent = computed(() => {
  const span = weekSpan.value
  return span ? currentTrendKey('week', period.mode, span[0], span[1], period.month) : null
})
function onWeekSelect(key: string): void {
  period.setWeek(key)
}

// --- the category breakdown (§4 案: RankedList + the rest row) --------------------
const breakdownRows = computed<StatsRow[]>(() => {
  const res = analysis.value
  if (!res) return []
  const sorted = [...res.rows].sort((a, b) => b.amount - a.amount)
  const out: StatsRow[] = sorted.slice(0, 5).map((r) => ({
    keys: [r.key],
    labels: [r.label],
    value: r.amount,
    share: r.share ?? undefined,
  }))
  const tail = sorted.slice(5)
  if (tail.length > 0 || res.truncated_rows > 0) {
    const restAmount = tail.reduce((a, r) => a + r.amount, 0)
    out.push({
      keys: [null],
      labels: [`ほか ${tail.length + res.truncated_rows}件・計${formatYen(restAmount)}`],
      value: restAmount,
      share: undefined,
    })
  }
  return out
})

function categoryTo(row: StatsRow): RouteLocationRaw | null {
  return axisTo('category', row.keys[0] ?? null, row.labels[0] ?? '')
}

// TASK-129 (web-common.bar-scale): the screen's ONE absolute scale — the max
// over every bar's outer amount on the screen (the breakdown rows' values
// and the week totals; the trend bars join this aggregation at TASK-126).
// Every row bar then renders value / scale × its track, so the same amount
// paints the same length wherever it appears on the screen.
const screenScale = computed(() =>
  barScale(Math.max(0, ...breakdownRows.value.map((r) => r.value), ...weeks.value.map((w) => w.total))),
)

/** Per-receipt feed links carry this screen's period + filter as context. */
const recentQuery = computed(() => {
  const [from, to] = period.range
  return {
    from,
    to,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
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

    <div
      v-if="analysis && totals"
      class="view-stack"
      :class="{ loading }"
    >
      <!-- TASK-146 §3: the pane's content transition fires at the load
           commit (swapKey) in the move's direction — mid-refetch the old
           content stays right here, dimmed by the loading class above -->
      <ContentSwap
        :swap-key="committedKey"
        :dir="move.dir.value"
      >
        <div class="content-pane">
          <PeriodHeader
            :label="`${period.label}の支出`"
            :total="totals.amount"
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
            </div>

            <div class="col-side">
              <section
                v-if="period.mode === 'month' && weeks.length > 0"
                class="zone zone--list"
                data-test="week-card"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    週ごとの支出
                  </h2>
                </div>
                <WeekRows
                  :weeks="weeks"
                  :current="weekCurrent"
                  :scale="screenScale"
                  @select="onWeekSelect"
                />
              </section>

              <section
                class="zone zone--list"
                data-test="breakdown"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    支出の内訳
                  </h2>
                  <RouterLink
                    :to="{ path: '/categories', query: { ...period.urlQuery } }"
                    class="ibtn"
                    aria-label="カテゴリ別に見る"
                    title="カテゴリ別に見る"
                    data-test="breakdown-more"
                  >
                    <AppIcon name="chevron-right" />
                  </RouterLink>
                </div>
                <p
                  v-if="breakdownRows.length === 0"
                  class="muted empty"
                >
                  この期間の記録はありません。
                </p>
                <RankedList
                  v-else
                  :rows="breakdownRows"
                  :to="categoryTo"
                  axis="category"
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
                    :to="{ path: '/receipts', query: { ...recentQuery } }"
                    class="ibtn"
                    aria-label="すべて見る"
                    title="すべて見る"
                    data-test="recent-more"
                  >
                    <AppIcon name="chevron-right" />
                  </RouterLink>
                </div>
                <div
                  v-if="recent.length === 0"
                  class="empty-state"
                >
                  <AppIcon
                    name="chat"
                    :size="28"
                  />
                  <p>ChatGPT でレシートの写真を送ると、ここに記録されます。</p>
                </div>
                <ul
                  v-else
                  class="recent-list"
                >
                  <li
                    v-for="r in recent"
                    :key="r.receipt_id"
                  >
                    <RouterLink
                      :to="{ path: `/receipts/${r.receipt_id}`, query: recentQuery }"
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
  </div>
</template>
