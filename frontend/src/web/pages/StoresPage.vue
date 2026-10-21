<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type CategoryNode, type StatsResult, type StatsRow } from '../api/data'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { firstString } from '../composables/receiptContext'
import { currentTrendKey, dailyRows, trendGranularity, weeklyRows } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { useCatalogStore } from '../stores/catalog'
import { usePeriodStore } from '../stores/period'

// Store list (read-only, TASK-74 §4-7): the period's total, the store
// ranking (a row press drills into /stores/:id; その他 / 店不明 stay plain
// rows) and the trend, with the store-category chip row above the ranking
// (D28 §4-1 案1: the ranking is the primary structure, the classification
// narrows it — single select over catalog.store_categories, riding the URL
// as store_category= and reaching getStats through the A1 wiring). A legacy
// ?store=<name> deep link resolves through listStores and replaces into
// /stores/<id>. Renames / merges live in /settings/stores. The period and
// label filters moved to the topbar center bar (TASK-44 §11): they ride on
// the period store and this page re-queries through the watches below.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)

/** TASK-55: the trend granularity of the selected period. */
const gran = computed(() => trendGranularity(period.mode, ...period.range))

const overall = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const error = ref('')
const loading = ref(false)

/** The store-category selection of the chip row (single, from the URL). */
const storeCategory = computed(() => firstString(route.query.store_category))

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const cat = storeCategory.value ? { store_category: storeCategory.value } : {}
  try {
    // the trend query goes first so the primary by_store call (the one
    // carrying the selected month/year key) is the load's last stats call.
    // TASK-55: month granularity keeps monthly_trend; day/week switch to
    // monthly_overview (the store-category filter rides both, review 3)
    const [tr, o] = await Promise.all([
      api.getStats(l, {
        report: gran.value === 'month' ? 'monthly_trend' : 'monthly_overview',
        ...period.trendQuery(),
        ...cat,
      }),
      api.getStats(l, { report: 'by_store', ...period.query(), ...cat }),
    ])
    if (n !== seq) return
    overall.value = o
    trend.value = tr
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
watch([() => period.range, () => period.labelQuery, () => storeCategory.value], () => void load())

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

// --- the legacy ?store= gate (§4-7) -------------------------------------------
async function redirectLegacyStore(): Promise<void> {
  const name = firstString(route.query.store)
  const l = ledgerId.value
  if (!name || l === null) return
  try {
    const hit = (await api.listStores(l)).find((s) => s.name === name)
    if (!hit) return
    const rest: LocationQueryRaw = { ...route.query }
    delete rest.store
    await router.replace({ path: `/stores/${hit.store_id}`, query: rest })
  } catch {
    // a failed lookup leaves the list as-is
  }
}
void redirectLegacyStore()


// The manage entry lives behind the "..." page menu (TASK-45 §2-4): no
// standalone manage link on a read-only dashboard. TASK-40 rev2 §2-4 adds
// the classification entry ("店カテゴリを管理" opens the manage screen's
// store-kind tab); both entries are fine for viewers (read-only there).
const menuItems: PageMenuItem[] = [
  { to: '/settings/stores', label: '店を管理', icon: 'store', test: 'manage-link' },
  { to: '/settings/categories?kind=store', label: '店カテゴリを管理', icon: 'tag', test: 'manage-store-categories-link' },
]

const rows = computed(() => overall.value?.sections[0]?.rows ?? [])
const totals = computed(() => overall.value?.totals ?? null)

/** TASK-57 A5: real stores only — 店不明 and the folded その他 row do not
 *  count (truncated_rows carries how many folded). */
const storeCount = computed(() => {
  const sec = overall.value?.sections[0]
  return (sec?.rows ?? []).filter((r) => typeof r.keys[0] === 'number').length + (sec?.truncated_rows ?? 0)
})

const trendRows = computed<StatsRow[]>(() => {
  if (gran.value === 'month') return trend.value?.sections[0]?.rows ?? []
  const cum = trend.value?.daily_cumulative ?? []
  const [from, to] = period.range
  return gran.value === 'day' ? dailyRows(cum, from, to) : weeklyRows(cum, from, to)
})

const trendCurrent = computed(() => currentTrendKey(gran.value, period.mode, ...period.range, period.month))

/** A bar press moves the period to that granularity's unit (TASK-55). */
function onTrendSelect(key: string): void {
  if (gran.value === 'week') period.setWeek(key)
  else period.setMonth(key)
}

/** The context the row links carry down a level (the store's own category is
 * fixed on the detail page, so store_category does not ride). */
const listQuery = computed(() => ({
  ...period.urlQuery,
  ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
}))

/** A ranking row's destination: keys[0] (the store id) builds /stores/<id>;
 * その他 and 店不明 (keys[0]=null) stay non-link rows. */
function rowTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  if (typeof id !== 'number') return null
  return { path: `/stores/${id}`, query: { ...listQuery.value } }
}

function diffText(d: number | null | undefined): string {
  if (d === null || d === undefined || d === 0) return '±0円'
  return `${d > 0 ? '+' : '−'}${formatYen(Math.abs(d))}`
}
</script>

<template>
  <div class="view-page">
    <!-- the chip-less one-row toolbar (TASK-75 §6-3/§6-5): the "..." menu
         alone rides the row's right end — no standalone menu row above the
         dashboard cards -->
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

    <!-- the detail page's unknown-id redirect lands here with ?missing= -->
    <p
      v-if="firstString(route.query.missing)"
      class="msg msg-error"
      role="alert"
      data-test="missing"
    >
      指定された店は見つかりません
    </p>

    <div
      v-if="overall && totals"
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
            v-if="totals.diff !== null"
            class="chip"
            :class="totals.diff > 0 ? 'chip-up' : totals.diff < 0 ? 'chip-down' : ''"
          >{{ period.compareLabel }}比 {{ diffText(totals.diff) }}</span>
        </p>
        <!-- the 最多 name keeps the full-text title (review L2): the summary
             line ellipsizes, the title is the one way to see the whole name -->
        <p class="kpi-sub">
          利用した店 {{ storeCount }} ・ 最多 <span :title="rows[0]?.labels[0] ?? undefined">{{ rows[0]?.labels[0] ?? '-' }}</span> ・ レシート {{ totals.receipts }}件
        </p>
      </section>

      <section
        class="card"
        data-test="trend-card"
      >
        <h2>支出の推移</h2>
        <TrendBars
          v-if="trend"
          :rows="trendRows"
          :granularity="gran"
          :span="period.range"
          :current="trendCurrent"
          @select="onTrendSelect"
        />
      </section>

      <section
        class="card wide"
        data-test="ranking"
      >
        <h2>店別</h2>
        <!-- the store-category chip row (single select, D28 §4-2): narrows
             the ranking through the A1 store_category wiring -->
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
