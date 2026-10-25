<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type AnalysisResult, type AnalysisTrendResult, type StatsRow } from '../api/data'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PeriodHeader from '../components/PeriodHeader.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { firstString } from '../composables/receiptContext'
import { currentTrendKey, trendGranularity } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

// Category list (read-only, TASK-89 redesign, the compare side removed): the
// period header (the whole-ledger totals), the stacked trend (this axis) and
// the full-category ranking — every real row (limit = stats_max_rows), the
// composition as the inline bar and the muted "ほか n件・計xx円" rest row
// folding the tail. A row press drills into /axes/category/<topId>
// (未分類 into the uncategorized carve-out); editing lives in
// /settings/categories behind the "..." menu. The legacy ?category= deep
// link resolution is gone (TASK-89: no redirect compatibility).
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const session = useSessionStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)

const analysis = ref<AnalysisResult | null>(null)
const trend = ref<AnalysisTrendResult | null>(null)
const error = ref('')
const loading = ref(false)

/** the trend window: a 6-month window (TASK-100) through the selected month
 *  in month mode, the period itself otherwise (the list rule) */
function trendPeriod(): [string, string] {
  if (period.mode === 'month') {
    const q = period.trendQuery(5)
    return [q.from!, q.to!]
  }
  return period.range
}
const gran = computed(() => {
  const [from, to] = trendPeriod()
  return trendGranularity(period.mode, from, to)
})

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const [a, t] = await Promise.all([
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
    ])
    if (n !== seq) return
    analysis.value = a
    trend.value = t
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
watch([() => period.range, () => period.labelQuery], () => void load())

// The manage entry lives behind the "..." page menu (TASK-45 §2-4); the
// create entry ("大分類を追加" deep-links the manage screen's top add row)
// stays editor-only.
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})
const menuItems = computed<PageMenuItem[]>(() => {
  const items: PageMenuItem[] = [
    { to: '/settings/categories?kind=item', label: 'カテゴリを管理', icon: 'tag', test: 'manage-link' },
  ]
  if (canEdit.value) {
    items.push({ to: '/settings/categories?kind=item&new=top', label: '大分類を追加', icon: 'plus', test: 'add-top-link' })
  }
  return items
})

const totals = computed(() => analysis.value?.totals ?? null)

/** the full ranking: every real row (amount desc) + the rest row */
const rows = computed<StatsRow[]>(() => {
  const res = analysis.value
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
    const restAmount = totals.value ? totals.value.amount - sorted.reduce((a, r) => a + r.amount, 0) : 0
    out.push({
      keys: [null],
      labels: [`ほか ${res.truncated_rows}件・計${formatYen(restAmount)}`],
      value: restAmount,
      share: undefined,
    })
  }
  return out
})

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)']
const trendStackedBars = computed(() => {
  const res = trend.value
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

/** A ranking row's destination: keys[0] builds /axes/category/<topId>; the
 *  未分類 aggregate takes the carve-out; the rest row stays non-link. */
function rowTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  const query = {
    ...period.urlQuery,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
  if (typeof id === 'number') return { path: `/axes/category/${id}`, query }
  if (row.labels[0] === '未分類') return { path: '/axes/category/uncategorized', query }
  return null
}
</script>

<template>
  <div class="view-page">
    <BrowseToolbar>
      <template #menu>
        <PageMenu
          ariaLabel="その他の操作"
          :items="menuItems"
        />
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

    <!-- the axis detail's unknown-id redirect lands here with ?missing= -->
    <p
      v-if="firstString(route.query.missing)"
      class="msg msg-error"
      role="alert"
      data-test="missing"
    >
      指定されたカテゴリは見つかりません
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
          v-if="trend"
          :stacked="trendStackedBars"
          :granularity="gran"
          :span="trendPeriod()"
          :current="trendCurrent"
          @select="onTrendSelect"
        />
      </section>

      <section
        class="zone"
        data-test="ranking"
      >
        <h2 class="sr-only">
          カテゴリ別
        </h2>
        <p
          v-if="rows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <RankedList
          v-else
          :rows="rows"
          :to="rowTo"
        />
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
