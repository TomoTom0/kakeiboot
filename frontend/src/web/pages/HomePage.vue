<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import LabelDots from '@/shared/components/LabelDots.vue'
import { useDataApi, type ReceiptSummary, type StatsResult, type StatsRow } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import DonutChart from '../components/DonutChart.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { periodDays, shortDate } from '../composables/period'
import { usePageReady } from '../composables/usePageReady'
import { currentTrendKey, dailyRows, trendGranularity, weeklyRows } from '../composables/trend'
import { usePeriodStore } from '../stores/period'

// Dashboard: the selected period's spending at a glance (GET
// /api/ledgers/{l}/stats monthly_overview — the same aggregation as
// summarize_spending — plus its own monthly_trend call for the bars) and the
// period's latest receipts. The period lives in the shared period store and
// follows all of its modes (TASK-66: month / year / range — the KPI, the
// trend window and the recent list all read period.range); it moves through
// the topbar period chip's dialog and the trend bars below, is shared with
// the other screens, and this page re-queries through watch(period.range).
// The label filter (TASK-17) is the same shared dimension
// (watch(period.labelQuery)).
const api = useDataApi()
const period = usePeriodStore()
const { markReady } = usePageReady()

const summary = ref<StatsResult | null>(null)
const trendResult = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const loading = ref(false)
const error = ref('')

/** TASK-55: the trend granularity of the selected period (week -> the
 *  week's days, month/year -> months, a custom range -> by its length). */
const gran = computed(() => trendGranularity(period.mode, ...period.range))

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const [from, to] = period.range
  try {
    // month granularity keeps its own monthly_trend window call (6 months
    // through the selected month, trendQuery(5)); it rides first so the
    // primary monthly_overview is the load's last stats call (the Categories
    // ordering). The day/week granularities skip it and reuse the overview's
    // daily_cumulative — in week/range modes that call already covers the
    // very range the bars need, so a second identical call would be waste.
    // (a promise created outside the all would reject unhandled when a
    // sibling call fails first — keep every call inside the single all)
    const [trendTrend, s, r] = await Promise.all([
      gran.value === 'month'
        ? api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(5) })
        : Promise.resolve(null),
      api.getStats(l, { report: 'monthly_overview', ...period.query() }),
      api.listReceipts(l, { from, to, limit: 5, ...(period.labelQuery ? { label_colors: period.labelQuery } : {}) }),
    ])
    const tr = trendTrend ?? s
    if (n !== seq) return
    summary.value = s
    trendResult.value = tr
    recent.value = r.receipts
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
// the period / label filters move from the topbar center bar (TASK-44 §11):
// the same watch(period.range) path the other dashboards use, plus the
// shared label dimension — one array watch so a change that moves both (a
// ledger switch resetting the labels) fetches once
watch([() => period.range, () => period.labelQuery], () => void load())

const totals = computed(() => summary.value?.totals ?? null)
const section = (id: string) => summary.value?.sections.find((s) => s.id === id)?.rows ?? []

/** The trend bars for the current granularity: month rows come from the
 *  monthly_trend section, day/week rows from daily_cumulative. */
const trendRows = computed<StatsRow[]>(() => {
  if (gran.value === 'month') return trendResult.value?.sections[0]?.rows ?? []
  const cum = trendResult.value?.daily_cumulative ?? []
  const [from, to] = period.range
  return gran.value === 'day' ? dailyRows(cum, from, to) : weeklyRows(cum, from, to)
})

/** The highlighted bar: the selected month in month mode, today's day / week
 *  when the charted range holds it (currentTrendKey). */
const trendCurrent = computed(() => currentTrendKey(gran.value, period.mode, ...period.range, period.month))

/** A bar press moves the period to that granularity's unit (TASK-55). */
function onTrendSelect(key: string): void {
  if (gran.value === 'week') period.setWeek(key)
  else period.setMonth(key)
}

/** Spending change vs. the previous period: more spending is the warning side. */
const diff = computed(() => {
  const t = totals.value
  if (!t || t.diff === null || t.compare_value === null) return null
  return {
    text: `${t.diff > 0 ? '+' : t.diff < 0 ? '−' : '±'}${formatYen(Math.abs(t.diff))}`,
    pct: t.diff_pct === null ? '' : `（${t.diff_pct > 0 ? '+' : ''}${t.diff_pct}%）`,
    tone: t.diff > 0 ? 'up' : t.diff < 0 ? 'down' : 'flat',
  }
})

const perDay = computed(() => {
  const t = totals.value
  if (!t) return null
  const [from, to] = period.range
  return Math.round(t.value / periodDays(from, to))
})

// Category breakdown: the top 5 rows + "その他" feed both the donut ring and
// the ranked list (same order, same colors — DonutChart and RankedList with
// `colors` share the palette by index). TASK-74: each row keeps keys[0] (the
// top category id) so the row links into /categories/:top — the 未分類 row
// (keys[0]=null) takes the uncategorized carve-out and その他 stays a plain
// span. TASK-75 §6-4: the legend became this RankedList (one-line rows; at
// 720px- the wrap stacks the 120px donut over the list).
const donutRows = computed<StatsRow[]>(() => {
  const rows = section('categories')
  const top = rows.slice(0, 5).map((r) => ({ ...r, labels: [r.labels[0] ?? '未分類'] }))
  const rest = rows.slice(5).reduce((a, r) => a + r.value, 0)
  if (rest > 0) {
    // the folded row keeps its share (review M1): top5 + rest is the whole
    // section, so rest / total matches the backend rows' own shares and the
    // ranked list shows the % column on every row like the old legend did
    const total = top.reduce((a, r) => a + r.value, 0) + rest
    top.push({ keys: [null], labels: ['その他'], value: rest, share: total ? rest / total : 0 })
  }
  return top
})

/** Ranked row destination (TASK-74 §4-7): the top id from the stats row. */
function categoryTo(row: StatsRow): RouteLocationRaw | null {
  if (row.labels[0] === 'その他') return null
  const query = {
    ...period.urlQuery,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
  if (row.labels[0] === '未分類') return { path: '/categories/uncategorized', query }
  if (typeof row.keys[0] !== 'number') return null
  return { path: `/categories/${row.keys[0]}`, query }
}

const storeRows = computed(() => section('stores'))

/** Store row destination (TASK-74 §4-7): keys[0] is the store id — その他
 * and 店不明 (null) have no page of their own. */
function storeTo(row: StatsRow): RouteLocationRaw | null {
  if (typeof row.keys[0] !== 'number') return null
  return {
    path: `/stores/${row.keys[0]}`,
    query: {
      ...period.urlQuery,
      ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
    },
  }
}

/** Per-receipt feed links carry this screen's period + filter as context. */
const recentQuery = computed(() => {
  const [from, to] = period.range
  return { from, to, ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) }
})

</script>

<template>
  <div class="dashboard">
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <div
      v-if="summary && totals"
      class="dash-grid"
      :class="{ loading }"
    >
      <section
        class="card kpi"
        data-test="kpi"
      >
        <p class="kpi-head">
          <span class="label">{{ period.label }}の支出</span>
          <strong
            class="kpi-value"
            data-test="total"
          >{{ formatYen(totals.value) }}</strong>
          <span
            v-if="diff"
            class="chip"
            :class="`chip-${diff.tone}`"
            data-test="diff"
          >{{ period.compareLabel }}比 {{ diff.text }}{{ diff.pct }}</span>
        </p>
        <p class="kpi-sub">
          レシート <span data-test="receipt-count">{{ totals.receipts }}件</span> ・ 1日あたり {{ formatYen(perDay) }} ・ {{ period.compareLabel }} {{ formatYen(totals.compare_value) }}
        </p>
      </section>

      <section
        class="card trend"
        data-test="trend-card"
      >
        <h2>支出の推移</h2>
        <!-- a bar press moves the shared store (the topbar period chip
             follows at once, TASK-44 §11-5) -->
        <TrendBars
          v-if="trendResult"
          :rows="trendRows"
          :granularity="gran"
          :span="period.range"
          :current="trendCurrent"
          @select="onTrendSelect"
        />
      </section>

      <section
        class="card breakdown"
        data-test="breakdown"
      >
        <div class="card-head">
          <h2>支出の内訳</h2>
          <RouterLink
            :to="{ path: '/categories', query: { ...period.urlQuery } }"
            class="more"
          >
            カテゴリ別に見る
          </RouterLink>
        </div>
        <p
          v-if="donutRows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <div
          v-else
          class="donut-wrap"
        >
          <DonutChart
            :rows="donutRows"
            :total="totals.value"
            caption="支出"
          />
          <RankedList
            :rows="donutRows"
            :to="categoryTo"
            colors
          />
        </div>
      </section>

      <section
        class="card stores"
        data-test="stores"
      >
        <div class="card-head">
          <h2>よく使う店</h2>
          <RouterLink
            :to="{ path: '/stores', query: { ...period.urlQuery } }"
            class="more"
          >
            店別に見る
          </RouterLink>
        </div>
        <p
          v-if="storeRows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <RankedList
          v-else
          :rows="storeRows"
          :to="storeTo"
        />
      </section>

      <section
        class="card recent"
        data-test="recent"
      >
        <div class="card-head">
          <h2>最近のレシート</h2>
          <RouterLink
            :to="{ path: '/receipts', query: { ...period.urlQuery } }"
            class="more"
          >
            すべて見る
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
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
