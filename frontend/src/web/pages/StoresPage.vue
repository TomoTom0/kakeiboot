<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type CategoryNode, type StatsResult, type StatsRow } from '../api/data'
import DashSkeleton from '../components/DashSkeleton.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { firstString } from '../composables/receiptContext'
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
    // carrying the selected month/year key) is the load's last stats call
    const [tr, o] = await Promise.all([
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(), ...cat }),
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
    <PageMenu
      ariaLabel="その他の操作"
      :items="menuItems"
    />

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
        <dl class="kpi-sub">
          <div>
            <dt>利用した店</dt>
            <dd>{{ rows.length }}</dd>
          </div>
          <div>
            <dt>最多</dt>
            <dd
              :class="{ 'clamp-2': !!rows[0]?.labels[0] }"
              :title="rows[0]?.labels[0] ?? undefined"
            >
              {{ rows[0]?.labels[0] ?? '-' }}
            </dd>
          </div>
          <div>
            <dt>レシート</dt>
            <dd>{{ totals.receipts }} 件</dd>
          </div>
        </dl>
      </section>

      <section
        class="card"
        data-test="trend-card"
      >
        <h2>支出の推移</h2>
        <TrendBars
          v-if="trend"
          :rows="trend.sections[0]?.rows ?? []"
          :current="period.mode === 'month' ? period.month : null"
          @select="period.setMonth"
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
          :compare-label="period.compareLabel"
          :to="rowTo"
        />
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
