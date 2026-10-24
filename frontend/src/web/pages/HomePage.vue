<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
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
import DashSkeleton from '../components/DashSkeleton.vue'
import PeriodHeader from '../components/PeriodHeader.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { shortDate } from '../composables/period'
import { currentTrendKey, trendGranularity } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
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
period.fromQuery(useRoute().query)

const analysis = ref<AnalysisResult | null>(null)
const trendRes = ref<AnalysisTrendResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const error = ref('')
const loading = ref(false)

/** TASK-55: the trend granularity of the selected period (week -> the
 *  week's days, month/year -> months, a custom range -> by its length). */
const gran = computed(() => {
  const [from, to] = trendPeriod()
  return trendGranularity(period.mode, from, to)
})

/** the trend window: a 6-month window through the selected month in month
 *  mode (the Home rule), the period itself otherwise */
function trendPeriod(): [string, string] {
  if (period.mode === 'month') {
    const q = period.trendQuery(5)
    return [q.from!, q.to!]
  }
  return period.range
}

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const [a, tr, r] = await Promise.all([
      api.getAnalysis(l, { axis: 'category', metric: 'amount', ...period.query(), ...labels, limit: 50 }),
      api.getAnalysisTrend(l, {
        axis: 'category',
        metric: 'amount',
        granularity: gran.value,
        from: trendPeriod()[0],
        to: trendPeriod()[1],
        ...labels,
        limit: 5,
      }),
      api.listReceipts(l, { from: period.range[0], to: period.range[1], limit: 5, ...labels }),
    ])
    if (n !== seq) return
    analysis.value = a
    trendRes.value = tr
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
// one array watch so a change that moves both (a ledger switch resetting the
// labels) fetches once
watch([() => period.range, () => period.labelQuery], () => void load())

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
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)']
const trendStackedBars = computed(() => {
  const res = trendRes.value
  if (!res) return []
  const top = res.series.slice(0, 5)
  return res.buckets.map((b, i) => {
    const rest = Math.max((res.bucket_totals[i] ?? 0) - top.reduce((a, s) => a + (s.values[i] ?? 0), 0), 0)
    return {
      key: b,
      title: b,
      total: res.bucket_totals[i] ?? 0,
      segments: [
        ...top.map((s, si) => ({ label: s.label, value: s.values[i] ?? 0, color: PALETTE[si] ?? 'var(--c-rest)' })),
        ...(rest > 0 ? [{ label: 'ほか', value: rest, color: 'var(--c-rest)' }] : []),
      ],
    }
  })
})
const trendCurrent = computed(() => {
  const [from, to] = trendPeriod()
  return currentTrendKey(gran.value, period.mode, from, to, period.month)
})

/** A bar press: a day bar opens that day's receipts list, a week/month bar
 *  moves the shared period (TASK-89 §1-(3)). */
function onTrendSelect(key: string): void {
  if (gran.value === 'day') {
    void router.push({
      path: '/receipts',
      query: { from: key, to: key, ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) },
    })
    return
  }
  if (gran.value === 'week') period.setWeek(key)
  else period.setMonth(key)
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
      <PeriodHeader
        :label="`${period.label}の支出`"
        :total="totals.amount"
      />

      <section
        class="zone"
        data-test="trend-card"
      >
        <h2 class="sr-only">
          支出の推移
        </h2>
        <TrendBars
          v-if="trendRes"
          :stacked="trendStackedBars"
          :granularity="gran"
          :span="trendPeriod()"
          :current="trendCurrent"
          @select="onTrendSelect"
        />
      </section>

      <section
        class="zone"
        data-test="breakdown"
      >
        <div class="zone-more">
          <h2 class="sr-only">
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
        />
      </section>

      <section
        class="zone"
        data-test="recent"
      >
        <div class="zone-more">
          <h2 class="sr-only">
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
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
