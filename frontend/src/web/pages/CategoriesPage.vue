<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type StatsResult, type StatsRow } from '../api/data'
import DashSkeleton from '../components/DashSkeleton.vue'
import DonutChart from '../components/DonutChart.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { firstString } from '../composables/receiptContext'
import { usePageReady } from '../composables/usePageReady'
import { useCatalogStore } from '../stores/catalog'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

// Category list (read-only, TASK-74 §4-7): the period's total, the category
// ranking (donut + rows) and the trend. The same-page selection section is
// gone — a row press drills into /categories/:top (the 未分類 aggregate into
// /categories/uncategorized; その他 stays a plain row). A legacy ?category=
// deep link resolves through the catalog and replaces into the hierarchy
// route (bookmarks from before TASK-74; the app's own links are the new
// form already). Editing lives in /settings/categories. The period and
// label filters moved to the topbar center bar (TASK-44 §11): they ride on
// the period store (period.query / trendQuery already carry label_colors)
// and this page re-queries through the watches below.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)

const overall = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const error = ref('')
const loading = ref(false)

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  try {
    // the trend query goes first so the primary by_category call (the one
    // carrying the selected month/year key) is the load's last stats call
    const [tr, o] = await Promise.all([
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery() }),
      api.getStats(l, { report: 'by_category', ...period.query() }),
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
watch([() => period.range, () => period.labelQuery], () => void load())

// --- the legacy ?category= gate (§4-7) ----------------------------------------
// resolve the path into its top id and replace into the hierarchy route; an
// unresolvable path stays on the list (no broken redirect). '未分類' has no
// catalog node — it maps to the carve-out route directly.
async function redirectLegacyCategory(): Promise<void> {
  const path = firstString(route.query.category)
  if (!path) return
  try {
    if (path === '未分類') {
      await router.replace({ path: '/categories/uncategorized', query: withoutKey('category') })
      return
    }
    await catalog.load()
    const node = catalog.resolve('item', path)
    if (!node) return
    const topId = catalog.parentIdOf('item', node.id) ?? node.id
    await router.replace({ path: `/categories/${topId}`, query: withoutKey('category') })
  } catch {
    // the catalog fetch failing leaves the list as-is
  }
}
function withoutKey(key: string): LocationQueryRaw {
  const rest: LocationQueryRaw = { ...route.query }
  delete rest[key]
  return rest
}
void redirectLegacyCategory()


// The manage entry lives behind the "..." page menu (TASK-45 §2-4): no
// standalone manage link on a read-only dashboard. TASK-40 rev2 §2-4 adds
// the create entry ("大分類を追加" deep-links the manage screen's top add
// row); viewers get the manage link only — creation stays editor-only.
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

const rows = computed(() => overall.value?.sections[0]?.rows ?? [])
const totals = computed(() => overall.value?.totals ?? null)

/** The context the row links carry down a level: the period in its URL form
 * plus the labels (§4-2 — everything passes down). */
const listQuery = computed(() => ({
  ...period.urlQuery,
  ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
}))

/** A ranking row's destination: keys[0] (the top category id) builds
 * /categories/<topId>; the 未分類 aggregate (keys[0]=null) takes the
 * carve-out; その他 (and any other null key) stays a non-link row. */
function rowTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  if (typeof id === 'number') return { path: `/categories/${id}`, query: { ...listQuery.value } }
  if (row.labels[0] === '未分類') return { path: '/categories/uncategorized', query: { ...listQuery.value } }
  return null
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
      指定されたカテゴリは見つかりません
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
            <dt>カテゴリ数</dt>
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
        data-test="breakdown"
      >
        <h2>カテゴリ別</h2>
        <p
          v-if="rows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <div
          v-else
          class="donut-wrap"
        >
          <DonutChart
            :rows="rows"
            :total="totals.value"
          />
          <RankedList
            :rows="rows"
            :compare-label="period.compareLabel"
            :to="rowTo"
            colors
          />
        </div>
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
