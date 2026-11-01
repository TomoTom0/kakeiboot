<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { barScale } from '@/shared/lib/stackedBars'
import {
  useDataApi,
  type AnalysisResult,
  type CategoryNode,
  type StatsRow,
} from '../api/data'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import ContentSwap from '../components/ContentSwap.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PeriodHeader from '../components/PeriodHeader.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendWindow from '../components/TrendWindow.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { usePeriodMove } from '../composables/periodMove'
import { firstString } from '../composables/receiptContext'
import { currentTrendKey } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { useTrendWindow } from '../composables/trendWindow'
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
// the deep-linked period / labels keys arrive through the shell-level URL
// sync (TASK-124 D2) before this page sets up

const analysis = ref<AnalysisResult | null>(null)
const error = ref('')
const loading = ref(false)

// TASK-146 §3: the pane's committed key (bumped at the load commit) and the
// move's direction off the shared period store
const committedKey = ref('')
const move = usePeriodMove(committedKey)

/** The store-category selection of the chip row (single, from the URL). */
const storeCategory = computed(() => firstString(route.query.store_category))

// the trend's movable window (TASK-104): the composable owns the trend
// fetch and the stacked assembly; the store-category narrowing rides the
// filters getter (read at fetch time, so the URL chip re-fetches through
// the page watch below)
const win = useTrendWindow({
  axis: () => 'store',
  filters: () => (storeCategory.value ? { store_category: storeCategory.value } : {}),
  onError: (m) => (error.value = m ?? ''),
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
    const a = await api.getAnalysis(l, { axis: 'store', metric: 'amount', ...period.query(), ...cat, ...labels, limit: 50 })
    if (n !== seq) return
    analysis.value = a
    committedKey.value = `${l}|${period.mode}|${period.range[0]}|${period.range[1]}|${period.labelQuery?.join(',') ?? ''}|${storeCategory.value ?? ''}`
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
// storeCategory is not a composable watch source (its getter is read at
// fetch time), so the chip re-fetch rides this watch like AxisDetail's route
// watch — identical to the composable's own fetch, the guard keeps it one
watch(
  [() => period.range, () => period.labelQuery, () => storeCategory.value],
  () => {
    void load()
    win.refresh()
  },
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

// TASK-129 (web-common.bar-scale): the screen's ONE absolute scale — the max
// over the ranking rows' values (each row bar's outer amount). The trend
// bars join this aggregation at TASK-126.
const screenScale = computed(() => barScale(Math.max(0, ...rows.value.map((r) => r.value))))

const trendCurrent = computed(() =>
  currentTrendKey(win.granularity.value, period.mode, win.window.value[0], win.window.value[1], period.month),
)
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
      <!-- TASK-146 §3: the content transition fires at the load commit -->
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
                class="zone zone--list"
                data-test="ranking"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    店別
                  </h2>
                </div>
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
                  axis="store"
                  :scale="screenScale"
                />
              </section>
            </div>
          </div>
        </div>
      </ContentSwap>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
