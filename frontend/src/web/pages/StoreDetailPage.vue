<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery, parseLabelQuery, type Label, type LabelColor } from '@/shared/labels'
import LabelDots from '@/shared/components/LabelDots.vue'
import {
  useDataApi,
  type ReceiptSummary,
  type StatsQuery,
  type StatsResult,
  type StatsRow,
  type StoreRow,
} from '../api/data'
import DashSkeleton from '../components/DashSkeleton.vue'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import type { FilterChip } from '../components/FilterChips.vue'
import PageHead from '../components/PageHead.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { shortDate } from '../composables/period'
import { firstString, listQueryToContext } from '../composables/receiptContext'
import { currentTrendKey, dailyRows, trendGranularity, weeklyRows } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'

// Store detail (TASK-74 §4-7): /stores/:id resolves the store through
// listStores (the id's own existence check — an unknown id replaces back to
// the list with ?missing=), then shows the KPI narrowed by store_id, the
// category cross-section (by_category store_id=, その他 excluded, top 5 —
// the 未分類 row links to the uncategorized carve-out), the trend, the
// recent receipts and the すべて見る link into the receipts list. The
// store's own info (its category as the heading sub, the lifetime count and
// the last purchase date in the KPI dl) folds into the existing card shapes.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)
if ('labels' in route.query) period.setLabelColors(parseLabelQuery(firstString(route.query.labels)))

const storeId = computed(() => {
  const n = Number(route.params.id)
  return Number.isInteger(n) && n > 0 ? n : null
})

/** Resolved store row; null until listStores answers. */
const store = ref<StoreRow | null>(null)

async function resolveStore(l: number): Promise<boolean> {
  const rows = await api.listStores(l)
  const found = rows.find((s) => s.store_id === storeId.value)
  if (!found) {
    await router.replace({ path: '/stores', query: { ...route.query, missing: String(storeId.value) } })
    return false
  }
  store.value = found
  return true
}

// the category 掛け合わせ (a category page's cross row lands here with ?category=)
const categoryQuery = computed(() => firstString(route.query.category))

/** TASK-55: the trend granularity of the selected period. */
const gran = computed(() => trendGranularity(period.mode, ...period.range))

const overview = ref<StatsResult | null>(null)
const byCategoryResult = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const error = ref('')
const loading = ref(false)

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid || storeId.value === null) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const [from, to] = period.range
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const base: StatsQuery = {
      store_id: storeId.value,
      ...(categoryQuery.value ? { category: categoryQuery.value } : {}),
      ...labels,
    }
    // the category cross-section drops the category 掛け合わせ (it would
    // collapse the categories to the one — the KPI keeps it). TASK-55: month
    // granularity keeps its own monthly_trend call; the other granularities
    // reuse the overview response below (daily rows ride daily_cumulative)
    const [byCat, trendTrend, ov] = await Promise.all([
      api.getStats(l, { report: 'by_category', ...period.query(), store_id: storeId.value, ...labels }),
      gran.value === 'month'
        ? api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(), ...base })
        : Promise.resolve(null),
      api.getStats(l, { report: 'monthly_overview', ...period.query(), ...base }),
    ])
    const trendRes = trendTrend ?? ov
    const recentRes = await api.listReceipts(l, {
      from,
      to,
      store_id: storeId.value,
      ...(categoryQuery.value ? { category: categoryQuery.value } : {}),
      limit: 5,
      ...labels,
    })
    if (n !== seq) return
    byCategoryResult.value = byCat
    trend.value = trendRes
    overview.value = ov
    recent.value = recentRes.receipts
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      loading.value = false
      markReady()
    }
  }
}

// The ledger is snapshotted for the heading: switching it on the detail page
// goes back to the list instead of showing another book's data under the old
// store heading (the Feed pattern, D28 §4-3 — the name / store category of
// the id may not even exist there).
let ledgerCalls = 0
const ledgerId = useLedger((id) => {
  ledgerCalls++
  if (ledgerCalls === 1) void init(id)
  else void router.replace({ path: '/stores', query: { ...route.query } })
})
async function init(id?: number): Promise<void> {
  if (route.name !== 'store' || storeId.value === null) return
  const l = id ?? ledgerId.value
  if (l === null) return
  try {
    if (store.value?.store_id !== storeId.value && !(await resolveStore(l))) return
  } catch (e) {
    // listStores itself failed: the id cannot be resolved — surface it (the
    // load catch form) instead of an unhandled rejection over the skeleton
    error.value = errorMessage(e)
    return
  }
  void load(l)
}
// the labelQuery rides the fullPath: its watch below replaces the labels= key
// and this watch reloads once on that change (no double load)
watch([() => period.range, () => route.fullPath], () => void init())

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

const totals = computed(() => overview.value?.totals ?? null)
const totalText = computed(() => (totals.value ? formatYen(totals.value.value) : undefined))
/** the category cross-section: その他 excluded, top 5 (§3-3 案A) — the
 * 未分類 row is null-keyed but carries its own destination (§3-5) */
const catRows = computed(() =>
  (byCategoryResult.value?.sections[0]?.rows ?? [])
    .filter((r) => r.keys[0] !== null || r.labels[0] === '未分類')
    .slice(0, 5),
)

/** Context of the cross rows: this store passes down (the store's own
 * category is fixed here, so store_category never rides). */
function crossQuery(): Record<string, string | number> {
  return {
    ...period.urlQuery,
    store_id: storeId.value!,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
}

function catTo(row: StatsRow): RouteLocationRaw | null {
  // the 未分類 aggregate (keys[0]=null) links to the carve-out — the one
  // null-keyed row with a destination of its own (§3-5)
  if (row.labels[0] === '未分類') return { path: '/categories/uncategorized', query: crossQuery() }
  const topId = row.keys[0]
  if (typeof topId !== 'number') return null
  return { path: `/categories/${topId}`, query: crossQuery() }
}

const feedQuery = computed(() =>
  listQueryToContext({
    from: period.range[0],
    to: period.range[1],
    store_id: storeId.value ?? undefined,
    ...(categoryQuery.value ? { category: categoryQuery.value } : {}),
    ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
  }),
)

/** すべて見る: the receipts list with the period and this store (plus the
 * category 掛け合わせ and labels — store_category is not a list param, §3-6). */
const allReceiptsTo = computed<RouteLocationRaw>(() => ({
  path: '/receipts',
  query: {
    ...period.urlQuery,
    store_id: storeId.value ?? undefined,
    ...(categoryQuery.value ? { category: categoryQuery.value } : {}),
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  },
}))

// --- chips: the store itself is the heading row, its category is fixed ------
const labelsStore = useLabelsStore()
/** Definition of a selected filter color, for the chip label (the ReceiptsPage
 * filter-chip form: the title when the ledger defined one, the color key
 * otherwise — never the raw color key when a title exists). */
const labelDefOf = (c: LabelColor): Label =>
  labelsStore.definitions(ledgerId.value ?? -1).find((l) => l.color === c) ?? { color: c, title: null }

const chips = computed<FilterChip[]>(() => {
  const out: FilterChip[] = []
  if (categoryQuery.value) out.push({ key: 'category', label: `カテゴリ: ${categoryQuery.value}` })
  for (const c of period.labelColors) out.push({ key: `label-${c}`, label: labelDefOf(c).title ?? c })
  return out
})

function removeChip(key: string): void {
  if (key === 'category') {
    void router.replace({ query: { ...route.query, category: undefined } })
    return
  }
  if (key.startsWith('label-')) {
    const rest = period.labelColors.filter((c) => c !== (key.slice(6) as LabelColor))
    period.setLabelColors(rest)
    void router.replace({
      query: { ...route.query, labels: rest.length ? formatLabelQuery(rest) : undefined },
    })
  }
}

// keep labels= in step with the shared store (the topbar chip moves it too)
watch(
  () => period.labelQuery,
  () => {
    void router.replace({
      query: {
        ...route.query,
        labels: period.labelColors.length ? formatLabelQuery(period.labelColors) : undefined,
      },
    })
  },
)

const menuItems: PageMenuItem[] = [
  { to: '/settings/stores', label: '店を管理', icon: 'store', test: 'manage-link' },
  { to: '/settings/categories?kind=store', label: '店カテゴリを管理', icon: 'tag', test: 'manage-store-categories-link' },
]
</script>

<template>
  <div class="view-page">
    <!-- the message also covers the resolve failure (store still null): the
         skeleton must not hide it (TASK-74 review M2) -->
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>
    <template v-if="store">
      <PageHead
        kind-label="店"
        :title="store.name"
        :total="totalText"
        :sub="store.category ?? undefined"
        :parent-to="{ path: '/stores', query: { ...route.query } }"
        back-label="店一覧"
      >
        <template #menu>
          <PageMenu
            ariaLabel="その他の操作"
            :items="menuItems"
          />
        </template>
      </PageHead>
      <!-- the chips ride the one-row toolbar under the heading (TASK-75:
           the TASK-74 provisional placement swapped, interface unchanged —
           a chip-less store detail renders no row at all) -->
      <BrowseToolbar
        :chips="chips"
        @remove="removeChip"
      />

      <div
        v-if="overview && totals"
        class="dash-grid"
        :class="{ loading }"
      >
        <section
          class="card kpi"
          data-test="kpi"
        >
          <p class="kpi-sub">
            レシート {{ totals.receipts }}件 ・ 累計件数 {{ store.receipt_count }}件 ・ 最終購入日 {{ store.last_purchased_on ? shortDate(store.last_purchased_on) : '-' }}
          </p>
        </section>

        <section
          class="card"
          data-test="by-category"
        >
          <h2>この店で買ったカテゴリ</h2>
          <p
            v-if="catRows.length === 0"
            class="muted empty"
          >
            この期間の記録はありません。
          </p>
          <RankedList
            v-else
            :rows="catRows"
            :to="catTo"
          />
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
          data-test="recent"
        >
          <div class="card-head">
            <h2>最近のレシート</h2>
            <RouterLink
              :to="allReceiptsTo"
              class="more"
              data-test="all-receipts"
            >
              すべて見る
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
      <DashSkeleton v-else-if="loading" />
    </template>
    <DashSkeleton v-else />
  </div>
</template>
