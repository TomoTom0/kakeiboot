<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import {
  useDataApi,
  type AnalysisMetric,
  type AnalysisResult,
  type AnalysisTrendResult,
  type CategoryNode,
  type StatsRow,
} from '../api/data'
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
import { useCatalogStore } from '../stores/catalog'
import { usePeriodStore } from '../stores/period'

// Store list (read-only, TASK-89 redesign, the compare side removed): the
// period header, the stacked trend (this axis) and the full-store ranking,
// with the store-category
// chip row above the ranking (D28 §4-1 案1: the ranking is the primary
// structure, the classification narrows it — single select over
// catalog.store_categories, riding the URL as store_category=). A row press
// drills into /axes/store/<id>; the rest and 店不明 rows stay plain rows.
// The legacy ?store=<name> deep link resolution is gone (TASK-89).
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)

const analysis = ref<AnalysisResult | null>(null)
const trend = ref<AnalysisTrendResult | null>(null)
const error = ref('')
const loading = ref(false)

/** The store-category selection of the chip row (single, from the URL). */
const storeCategory = computed(() => firstString(route.query.store_category))

const trendMetric = ref<AnalysisMetric>('amount')
const trendStackedView = ref(true)
const METRIC_TABS: { id: AnalysisMetric; label: string }[] = [
  { id: 'amount', label: '金額' },
  { id: 'count', label: '件数' },
  { id: 'unit', label: '単価' },
]
const metricFormat = computed<Record<AnalysisMetric, (v: number) => string>>(() => ({
  amount: formatYen,
  count: (v) => `${Math.round(v).toLocaleString('ja-JP')}件`,
  unit: (v) => `${(Math.round(v * 10) / 10).toLocaleString('ja-JP')}円`,
}))

function trendPeriod(): [string, string] {
  if (period.mode === 'month') {
    const q = period.trendQuery()
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
  const cat = storeCategory.value ? { store_category: storeCategory.value } : {}
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const [a, t] = await Promise.all([
      api.getAnalysis(l, { axis: 'store', metric: 'amount', ...period.query(), ...cat, ...labels, limit: 50 }),
      api.getAnalysisTrend(l, {
        axis: 'store',
        metric: trendMetric.value,
        granularity: gran.value,
        from: trendPeriod()[0],
        to: trendPeriod()[1],
        ...cat,
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
watch(
  [() => period.range, () => period.labelQuery, () => storeCategory.value, trendMetric],
  () => void load(),
)

// --- the store-category chip row ----------------------------------------------
void catalog.load().catch((e) => {
  // the chip row needs the catalog; a failed fetch leaves the ranking itself
  // working but must surface (the load catch form), not reject unhandled
  error.value = errorMessage(e)
})
/** The catalog's store categories flattened depth-first with their paths. */
const storeCategories = computed(() => {
  const flat = (nodes: CategoryNode[], prefix: string): string[] =>
    nodes.flatMap((n) => {
      const path = prefix ? `${prefix}/${n.name}` : n.name
      return [path, ...flat(n.children, path)]
    })
  return flat(catalog.trees('store'), '')
})

function toggleStoreCategory(path: string): void {
  const rest: LocationQueryRaw = { ...route.query }
  if (storeCategory.value === path) delete rest.store_category
  else rest.store_category = path
  void router.replace({ query: rest })
}

// The manage entries live behind the "..." page menu (TASK-45 §2-4).
const menuItems: PageMenuItem[] = [
  { to: '/settings/stores', label: '店を管理', icon: 'store', test: 'manage-link' },
  { to: '/settings/categories?kind=store', label: '店カテゴリを管理', icon: 'tag', test: 'manage-store-categories-link' },
]

const totals = computed(() => analysis.value?.totals ?? null)

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
const trendSingle = computed<StatsRow[]>(() =>
  (trend.value?.buckets ?? []).map((b, i) => ({ keys: [b], labels: [b], value: trend.value?.bucket_totals[i] ?? 0 })),
)
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

/** The context the row links carry down a level. */
const listQuery = computed(() => ({
  ...period.urlQuery,
  ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
}))

/** A ranking row's destination: keys[0] (the store id) builds
 *  /axes/store/<id>; the rest and 店不明 rows stay non-link. */
function rowTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  if (typeof id !== 'number') return null
  return { path: `/axes/store/${id}`, query: { ...listQuery.value } }
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
      指定された店は見つかりません
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
        <div class="card-head">
          <h2>支出の推移</h2>
          <div class="trend-controls">
            <div
              class="tabs trend-mode-tabs"
              role="tablist"
              aria-label="推移の表示"
            >
              <button
                type="button"
                class="tab"
                :class="{ active: trendStackedView }"
                role="tab"
                :aria-selected="trendStackedView"
                data-test="trend-stacked"
                @click="trendStackedView = true"
              >
                積み上げ
              </button>
              <button
                type="button"
                class="tab"
                :class="{ active: !trendStackedView }"
                role="tab"
                :aria-selected="!trendStackedView"
                data-test="trend-total"
                @click="trendStackedView = false"
              >
                合計
              </button>
            </div>
            <div
              class="tabs trend-metric-tabs"
              role="tablist"
              aria-label="数値軸"
            >
              <button
                v-for="m in METRIC_TABS"
                :key="m.id"
                type="button"
                class="tab"
                :class="{ active: trendMetric === m.id }"
                role="tab"
                :aria-selected="trendMetric === m.id"
                :data-test="`trend-metric-${m.id}`"
                @click="trendMetric = m.id"
              >
                {{ m.label }}
              </button>
            </div>
          </div>
        </div>
        <TrendBars
          v-if="trend"
          :rows="trendSingle"
          :stacked="trendStackedView ? trendStackedBars : null"
          :granularity="gran"
          :span="trendPeriod()"
          :current="trendCurrent"
          :format="metricFormat[trendMetric]"
          @select="onTrendSelect"
        />
      </section>

      <section
        class="zone"
        data-test="ranking"
      >
        <h2>店別</h2>
        <!-- the store-category chip row (single select, D28 §4-2): narrows
             the ranking through the store_category wiring -->
        <div
          v-if="storeCategories.length"
          class="store-cats"
          data-test="store-categories"
          role="group"
          aria-label="店カテゴリ"
        >
          <button
            v-for="p in storeCategories"
            :key="p"
            type="button"
            class="filter-chip-btn store-cat"
            :aria-pressed="storeCategory === p"
            data-test="store-category"
            @click="toggleStoreCategory(p)"
          >
            {{ p }}
          </button>
        </div>
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
