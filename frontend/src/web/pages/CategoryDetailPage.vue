<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery, parseLabelQuery, type Label, type LabelColor } from '@/shared/labels'
import LabelDots from '@/shared/components/LabelDots.vue'
import {
  useDataApi,
  type ItemSummary,
  type ReceiptSummary,
  type StatsQuery,
  type StatsResult,
  type StatsRow,
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
import { usePageReady } from '../composables/usePageReady'
import { useCatalogStore } from '../stores/catalog'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'

// Category detail (TASK-74 §4-7): one component serves the three hierarchy
// routes — the top (/categories/:top), the sub (/categories/:top/:sub) and
// the uncategorized carve-out (/categories/uncategorized, the same shape as
// a sub but with the fixed '未分類' path and no sub ranking / item section,
// which the catalog tree structurally cannot have). The catalog resolves
// the ids: a sub id handed in as a top replaces into the pair route, an
// unknown id replaces back to the list with ?missing=. Navigating between
// the levels reuses this component (the shell key is the first path
// segment), so the watch below re-resolves and reloads instead.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)
// a deep link's labels are adopted into the shared store so the topbar chip
// matches what the numbers were filtered with (the SearchPage pattern)
if ('labels' in route.query) period.setLabelColors(parseLabelQuery(firstString(route.query.labels)))

/** Resolved view of the route params; null until the catalog has answered. */
const view = ref<null | {
  topId: number | null
  subId: number | null
  path: string
  title: string
  parentName: string | null
}>(null)

function isCategoryRoute(): boolean {
  return (
    route.name === 'category' || route.name === 'subcategory' || route.name === 'category-uncategorized'
  )
}

/** Resolve the params through the catalog, replacing away when they are
 * wrong (a sub id as a top -> the pair route; an unknown id -> the list
 * with ?missing=). Returns false when the navigation moved elsewhere. */
async function resolveRoute(): Promise<boolean> {
  if (route.name === 'category-uncategorized') {
    // the backend's filter_sql special-cases the literal path
    view.value = { topId: null, subId: null, path: '未分類', title: '未分類', parentName: null }
    return true
  }
  await catalog.load()
  if (route.name === 'category') {
    const topId = Number(route.params.top)
    const node = catalog.nodeById('item', topId)
    if (!node) {
      await router.replace({ path: '/categories', query: { ...route.query, missing: String(topId) } })
      return false
    }
    const parent = catalog.parentIdOf('item', topId)
    if (parent !== null) {
      await router.replace({ path: `/categories/${parent}/${topId}`, query: { ...route.query } })
      return false
    }
    view.value = {
      topId,
      subId: null,
      path: catalog.pathOf('item', topId) ?? node.name,
      title: node.name,
      parentName: null,
    }
    return true
  }
  if (route.name === 'subcategory') {
    const topId = Number(route.params.top)
    const subId = Number(route.params.sub)
    const topNode = catalog.nodeById('item', topId)
    const subNode = catalog.nodeById('item', subId)
    if (!topNode || !subNode) {
      await router.replace({
        path: '/categories',
        query: { ...route.query, missing: String(topNode ? subId : topId) },
      })
      return false
    }
    const realParent = catalog.parentIdOf('item', subId)
    if (realParent !== topId) {
      const to = realParent === null ? `/categories/${subId}` : `/categories/${realParent}/${subId}`
      await router.replace({ path: to, query: { ...route.query } })
      return false
    }
    view.value = {
      topId,
      subId,
      path: catalog.pathOf('item', subId) ?? subNode.name,
      title: subNode.name,
      parentName: topNode.name,
    }
    return true
  }
  return false
}

// --- the cross filters that ride the URL (§4-2 context carry) ---------------
const storeIdQuery = computed(() => {
  const n = Number(route.query.store_id)
  return Number.isInteger(n) && n > 0 ? n : null
})
const storeCategoryQuery = computed(() => firstString(route.query.store_category))

// --- data --------------------------------------------------------------------
const overview = ref<StatsResult | null>(null)
const subsResult = ref<StatsResult | null>(null)
const byStoreResult = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const items = ref<ItemSummary[]>([])
const recent = ref<ReceiptSummary[]>([])
/** the store chip's name for the store_id 掛け合わせ (listStores is the id->name
 * source); storeNameFor tracks which id the name answers so a cross-link to
 * another store re-looks it up (the component survives level moves) */
const storeName = ref<string | null>(null)
const storeNameFor = ref<number | null>(null)
const error = ref('')
const loading = ref(false)

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid || !view.value) return
  const v = view.value
  const n = ++seq
  loading.value = true
  error.value = ''
  const [from, to] = period.range
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    if (storeIdQuery.value === null) {
      storeName.value = null
      storeNameFor.value = null
    } else if (storeNameFor.value !== storeIdQuery.value) {
      const found = (await api.listStores(l)).find((s) => s.store_id === storeIdQuery.value)
      if (n !== seq) return
      storeNameFor.value = storeIdQuery.value
      storeName.value = found?.name ?? `#${storeIdQuery.value}`
    }
    const base: StatsQuery = {
      category: v.path,
      ...(storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
      ...(storeCategoryQuery.value ? { store_category: storeCategoryQuery.value } : {}),
      ...labels,
    }
    // the sub ranking exists on the top page only; the store cross-section
    // drops the store_id 掛け合わせ (it would collapse the stores to the one
    // store — the KPI keeps it) but keeps store_category and the labels
    const [subs, byStore, trendRes, ov] = await Promise.all([
      v.subId === null && v.topId !== null
        ? api.getStats(l, { report: 'by_category', ...period.query(), ...base })
        : Promise.resolve(null),
      api.getStats(l, {
        report: 'by_store',
        ...period.query(),
        category: v.path,
        ...(storeCategoryQuery.value ? { store_category: storeCategoryQuery.value } : {}),
        ...labels,
      }),
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(), ...base }),
      api.getStats(l, { report: 'monthly_overview', ...period.query(), ...base }),
    ])
    const [itemRows, recentRes] = await Promise.all([
      v.subId !== null
        ? api.searchItems(l, { category: v.path, from, to, limit: 20, ...labels })
        : Promise.resolve(null),
      api.listReceipts(l, {
        from,
        to,
        category: v.path,
        ...(storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
        limit: 5,
        ...labels,
      }),
    ])
    if (n !== seq) return
    subsResult.value = subs
    byStoreResult.value = byStore
    trend.value = trendRes
    overview.value = ov
    items.value = itemRows?.items ?? []
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
// goes back to the list instead of resolving another book's catalog under
// the old heading (the Feed pattern, D28 §4-3).
let ledgerCalls = 0
const ledgerId = useLedger((id) => {
  ledgerCalls++
  if (ledgerCalls === 1) void init(id)
  else void router.replace({ path: '/categories', query: { ...route.query } })
})
async function init(id?: number): Promise<void> {
  if (!isCategoryRoute()) return
  try {
    if (await resolveRoute()) void load(id)
  } catch (e) {
    // the catalog fetch itself failed: the ids cannot be resolved — surface
    // it (the load catch form) instead of an unhandled rejection over the
    // skeleton
    error.value = errorMessage(e)
  }
}
// same-component param changes (top -> sub, the ‹ parent climb) reload
// through here — the page never remounts on its own routes
watch([() => period.range, () => route.fullPath], () => void init())
// the shared label filter also moves through the topbar chip: keep the
// labels= key of this URL in step (the load rides the fullPath change the
// replace causes)
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

// --- derived -----------------------------------------------------------------
const totals = computed(() => overview.value?.totals ?? null)
const totalText = computed(() => (totals.value ? formatYen(totals.value.value) : undefined))
/** the store cross-section: その他 excluded, top 5 (§3-3 案A) */
const storeRows = computed(() =>
  (byStoreResult.value?.sections[0]?.rows ?? []).filter((r) => r.keys[0] !== null).slice(0, 5),
)
const subRows = computed(() => subsResult.value?.sections[0]?.rows ?? [])
const topStore = computed(() => storeRows.value[0]?.labels[0] ?? '-')

/** The context every deeper link carries: the period in its URL form, the
 * labels and the cross filters (§4-2 — everything passes down a level). */
function contextQuery(): Record<string, string | number> {
  return {
    ...period.urlQuery,
    ...(storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
    ...(storeCategoryQuery.value ? { store_category: storeCategoryQuery.value } : {}),
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
}

function subTo(row: StatsRow): RouteLocationRaw | null {
  const v = view.value
  const subId = row.keys[0]
  if (!v || v.topId === null || typeof subId !== 'number') return null
  // a row keyed by the displayed top itself: items attached straight to the
  // big category — there is no level below this page for them
  if (subId === v.topId) return null
  return { path: `/categories/${v.topId}/${subId}`, query: contextQuery() }
}

function storeTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  if (typeof id !== 'number' || !view.value) return null
  // the cross jump hands this category to the store side (store_category is
  // the store's own attribute there, so it does not ride)
  return {
    path: `/stores/${id}`,
    query: {
      ...period.urlQuery,
      category: view.value.path,
      ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
    },
  }
}

/** Feed context of the recent rows and the item rows. */
const feedQuery = computed(() =>
  listQueryToContext({
    from: period.range[0],
    to: period.range[1],
    category: view.value?.path,
    ...(storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
    ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
  }),
)

/** すべて見る: the receipts list with the period and this category (plus the
 * store_id 掛け合わせ and labels — store_category is not a list param, §3-6). */
const allReceiptsTo = computed<RouteLocationRaw>(() => ({
  path: '/receipts',
  query: {
    ...period.urlQuery,
    category: view.value?.path,
    ...(storeIdQuery.value !== null ? { store_id: storeIdQuery.value } : {}),
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  },
}))

// --- chips (§4-7): the page's own subject has no x ---------------------------
const labelsStore = useLabelsStore()
/** Definition of a selected filter color, for the chip label (the ReceiptsPage
 * filter-chip form: the title when the ledger defined one, the color key
 * otherwise — never the raw color key when a title exists). */
const labelDefOf = (c: LabelColor): Label =>
  labelsStore.definitions(ledgerId.value ?? -1).find((l) => l.color === c) ?? { color: c, title: null }

const chips = computed<FilterChip[]>(() => {
  const out: FilterChip[] = [{ key: 'category', label: `カテゴリ: ${view.value?.path ?? ''}`, removable: false }]
  if (storeIdQuery.value !== null && storeName.value) out.push({ key: 'store', label: `店: ${storeName.value}` })
  if (storeCategoryQuery.value) out.push({ key: 'store_category', label: `店カテゴリ: ${storeCategoryQuery.value}` })
  for (const c of period.labelColors) out.push({ key: `label-${c}`, label: labelDefOf(c).title ?? c })
  return out
})

function removeChip(key: string): void {
  if (key === 'store' || key === 'store_category') {
    // the store chip's query key is store_id (the chip key stays short)
    const queryKey = key === 'store' ? 'store_id' : key
    void router.replace({ query: { ...route.query, [queryKey]: undefined } })
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

// --- the heading row -----------------------------------------------------------
const menuItems: PageMenuItem[] = [
  { to: '/settings/categories?kind=item', label: 'カテゴリを管理', icon: 'tag', test: 'manage-link' },
]
const parentTo = computed<RouteLocationRaw>(() =>
  view.value?.subId == null
    ? { path: '/categories', query: { ...route.query } }
    : { path: `/categories/${view.value.topId}`, query: { ...route.query } },
)
const backLabel = computed(() => view.value?.parentName ?? 'カテゴリ一覧')
</script>

<template>
  <div class="view-page">
    <!-- the message also covers the resolve failure (view still null): the
         skeleton must not hide it (TASK-74 review M2) -->
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>
    <template v-if="view">
      <PageHead
        kind-label="カテゴリ"
        :title="view.title"
        :total="totalText"
        :parent-to="parentTo"
        :back-label="backLabel"
        :parent="view.parentName ?? undefined"
      >
        <template #menu>
          <PageMenu
            ariaLabel="その他の操作"
            :items="menuItems"
          />
        </template>
      </PageHead>
      <!-- the chips ride the one-row toolbar under the heading (TASK-75:
           the TASK-74 provisional placement swapped, interface unchanged) -->
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
            レシート {{ totals.receipts }}件 ・ 最多の店 {{ topStore }}
          </p>
        </section>

        <section
          v-if="view.subId === null && view.topId !== null"
          class="card"
          data-test="subs"
        >
          <h2>小カテゴリ別</h2>
          <p
            v-if="subRows.length === 0"
            class="muted empty"
          >
            この期間の記録はありません。
          </p>
          <RankedList
            v-else
            :rows="subRows"
            :to="subTo"
          />
        </section>

        <section
          class="card"
          data-test="by-store"
        >
          <h2>このカテゴリを買った店</h2>
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
          v-if="view.subId !== null && items.length"
          class="card wide"
          data-test="items"
        >
          <h2>品目</h2>
          <ul class="recent-list">
            <li
              v-for="it in items"
              :key="it.item_id"
            >
              <RouterLink
                :to="{ path: `/receipts/${it.receipt_id}`, query: feedQuery }"
                class="search-item-row"
                data-test="category-item"
              >
                <span class="search-item-main">
                  <span class="search-item-name">{{ it.name }}</span>
                  <span class="amount">{{ formatYen(it.amount_incl) }}</span>
                </span>
                <span class="search-item-sub">
                  <span>{{ shortDate(it.purchased_on ?? '') }}</span>
                  <span>{{ it.store_name ?? '店名なし' }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>
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
