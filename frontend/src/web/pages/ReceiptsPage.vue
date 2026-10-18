<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import LabelChip from '@/shared/components/LabelChip.vue'
import LabelDots from '@/shared/components/LabelDots.vue'
import { labelIndexOf, parseLabelQuery, type Label, type LabelColor } from '@/shared/labels'
import { useDataApi, type ReceiptListQuery, type ReceiptSummary, type StatsQuery, type StatsResult } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import RankedList from '../components/RankedList.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { usePageReady } from '../composables/usePageReady'
import { dayLabel } from '../composables/period'
import { feedReturn, listQueryToContext } from '../composables/receiptContext'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'

// Receipts dashboard (read-only): the period's total / count / average,
// daily spending and payment methods, then the receipts grouped by day
// (spec_mcp-tools.md 7-8: newest first). Filters (store / item / category
// and the label colors of TASK-17) narrow both the figures and the list;
// links from the other screens set them through the URL query.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)
const rootEl = ref<HTMLElement | null>(null)

const s = (v: unknown) => (typeof v === 'string' ? v : '')
// include_deleted comes back through the URL (the feed round trip returns
// the same context), read the same way receiptContext.ts does
const includeDeletedQuery = s(route.query.include_deleted)
const filters = reactive({
  store: s(route.query.store),
  item: s(route.query.item),
  category: s(route.query.category),
  includeDeleted: includeDeletedQuery === '1' || includeDeletedQuery === 'true',
  labelColors: [] as LabelColor[],
})
// Label filter truth (TASK-17 design 2-5 L3): the URL "labels" key. When it
// is absent, adopt the period store's shared dashboard filter (Home /
// Categories / Stores) into the URL. A deep link's labels are also written
// back into the store so the topbar chip shows the selection the list is
// actually filtering with (TASK-44 §11-3). Later changes arrive from the
// topbar label chip through watch(period.labelQuery) below.
const urlLabels = route.query.labels
if ('labels' in route.query) {
  filters.labelColors = parseLabelQuery(Array.isArray(urlLabels) ? (urlLabels[0] as string) : urlLabels)
  period.setLabelColors(filters.labelColors)
} else if (period.labelColors.length > 0) {
  filters.labelColors = [...period.labelColors]
  void router.replace({ query: listQueryToContext(listQuery()) })
}
const draft = reactive({ ...filters, labelColors: [...filters.labelColors] })
const filtersOpen = ref(false)

const receipts = ref<ReceiptSummary[]>([])
const totalCount = ref(0)
const sumAmount = ref(0)
const nextCursor = ref<string | null>(null)
const overview = ref<StatsResult | null>(null)
const payments = ref<StatsResult | null>(null)
const error = ref('')
const loading = ref(false)
// first load finished at least once: until then the screen shows the
// skeleton; later reloads keep the grid and dim it (TASK-39 D)
const loaded = ref(false)

function listQuery(cursor?: string): ReceiptListQuery {
  const [from, to] = period.range
  return {
    from,
    to,
    store: filters.store.trim() || undefined,
    item_query: filters.item.trim() || undefined,
    category: filters.category.trim() || undefined,
    label_colors: filters.labelColors,
    include_deleted: filters.includeDeleted || undefined,
    limit: 50,
    cursor,
  }
}

function statsFilters(): StatsQuery {
  return {
    ...period.query(),
    ...(filters.store.trim() ? { store: filters.store.trim() } : {}),
    ...(filters.item.trim() ? { item_query: filters.item.trim() } : {}),
    ...(filters.category.trim() ? { category: filters.category.trim() } : {}),
    label_colors: filters.labelColors,
  }
}

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  try {
    const [list, ov, pm] = await Promise.all([
      api.listReceipts(l, listQuery()),
      api.getStats(l, { report: 'monthly_overview', ...statsFilters() }),
      api.getStats(l, { report: 'by_payment_method', ...statsFilters() }),
    ])
    if (n !== seq) return
    receipts.value = list.receipts
    totalCount.value = list.total_count
    sumAmount.value = list.sum_amount
    nextCursor.value = list.next_cursor
    overview.value = ov
    payments.value = pm
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      // settle the render-affecting state first: the scroll lookup below
      // rides the nextTick after this render, and the skeleton branch does
      // not depend on the list refs, so the flip must come first
      loading.value = false
      loaded.value = true
      markReady()
      void scrollToReturned()
    }
  }
}

/** Returning from the feed: scroll its row into view (once). */
async function scrollToReturned(): Promise<void> {
  const id = feedReturn.receiptId
  if (id === null) return
  feedReturn.receiptId = null
  await nextTick()
  // query inside this page's root: the test mount may be off-document
  rootEl.value?.querySelector(`#receipt-${id}`)?.scrollIntoView({ block: 'start' })
}

async function more(): Promise<void> {
  const l = ledgerId.value
  if (l === null || !nextCursor.value) return
  try {
    const list = await api.listReceipts(l, listQuery(nextCursor.value))
    receipts.value = [...receipts.value, ...list.receipts]
    nextCursor.value = list.next_cursor
  } catch (e) {
    error.value = errorMessage(e)
  }
}

const ledgerId = useLedger((id) => load(id))
watch(() => period.range, () => void load())
// the label filter moved to the topbar center bar (TASK-44 §11-3): its
// dialog writes the shared store, this page follows and keeps the labels=
// URL in sync (L3) while re-querying
watch(() => period.labelQuery, (colors) => {
  filters.labelColors = [...(colors ?? [])]
  syncQuery()
  void load()
})

const labelsStore = useLabelsStore()
/** Definition of a selected filter color, for the filter-chip LabelChips. */
const labelDefOf = (c: LabelColor): Label =>
  labelsStore.definitions(ledgerId.value ?? -1).find((l) => l.color === c) ?? { color: c, title: null }

function applyFilters(): void {
  // label colors are toggled immediately and never come from this form
  filters.store = draft.store
  filters.item = draft.item
  filters.category = draft.category
  filters.includeDeleted = draft.includeDeleted
  filtersOpen.value = false
  syncQuery()
  void load()
}

function clearFilter(key: 'store' | 'item' | 'category'): void {
  filters[key] = ''
  draft[key] = ''
  syncQuery()
  void load()
}

function clearLabels(): void {
  // the watch(period.labelQuery) above adopts the emptied store, syncs the
  // URL and re-queries
  period.setLabelColors([])
}

function syncQuery(): void {
  // keep the period and the filters in the URL: rows link back into the feed
  // with this same context
  void router.replace({ query: listQueryToContext(listQuery()) })
}

const activeFilters = computed(() =>
  (
    [
      ['store', '店', filters.store],
      ['item', '品名', filters.item],
      ['category', 'カテゴリ', filters.category],
    ] as const
  ).filter(([, , v]) => v.trim() !== ''),
)

const average = computed(() => (totalCount.value ? Math.round(sumAmount.value / totalCount.value) : 0))

// daily bars from the cumulative series (only for ranges up to ~2 months)
const daily = computed(() => {
  const series = overview.value?.daily_cumulative ?? []
  const [from, to] = period.range
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  if (days > 62) return null
  const byDay = new Map<string, number>()
  let prev = 0
  for (const p of series) {
    byDay.set(p.date, p.value - prev)
    prev = p.value
  }
  const out: { date: string; value: number }[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10)
    out.push({ date: d, value: byDay.get(d) ?? 0 })
  }
  const max = Math.max(...out.map((d) => d.value), 1)
  return out.map((d) => ({ ...d, height: d.value ? Math.max(Math.round((d.value / max) * 100), 3) : 0 }))
})

const groups = computed(() => {
  const out: { date: string; total: number; rows: ReceiptSummary[] }[] = []
  for (const r of receipts.value) {
    const d = r.purchased_on ?? ''
    let g = out[out.length - 1]
    if (!g || g.date !== d) {
      g = { date: d, total: 0, rows: [] }
      out.push(g)
    }
    g.rows.push(r)
    if (!r.deleted_at) g.total += r.amount
  }
  return out
})
</script>

<template>
  <div
    ref="rootEl"
    class="view-page"
  >
    <div class="page-toolbar">
      <button
        class="btn btn-small"
        :aria-expanded="filtersOpen"
        data-test="filters-toggle"
        @click="filtersOpen = !filtersOpen"
      >
        <AppIcon
          name="search"
          :size="16"
        />絞り込み
      </button>
    </div>

    <form
      v-if="filtersOpen"
      class="card filters"
      data-test="filters"
      @submit.prevent="applyFilters"
    >
      <label class="field"><span>店名</span><input
        v-model="draft.store"
        type="search"
        data-test="store"
      ></label>
      <label class="field"><span>品名</span><input
        v-model="draft.item"
        type="search"
        data-test="item"
      ></label>
      <label class="field"><span>カテゴリ（例: 食費、食費/外食、未分類）</span><input
        v-model="draft.category"
        type="search"
        data-test="category"
      ></label>
      <label class="check"><input
        v-model="draft.includeDeleted"
        type="checkbox"
        data-test="include-deleted"
      > 削除済みも一覧に表示</label>
      <div class="actions">
        <button
          class="btn btn-primary"
          type="submit"
          data-test="search"
        >
          適用
        </button>
      </div>
    </form>

    <p
      v-if="activeFilters.length || filters.labelColors.length"
      class="filter-chips"
    >
      <span
        v-for="[key, label, value] in activeFilters"
        :key="key"
        class="filter-chip"
      >{{ label }}: {{ value }}<button
        class="chip-x"
        :aria-label="`${label}の条件を外す`"
        :data-test="`clear-${key}`"
        @click="clearFilter(key)"
      ><AppIcon
        name="close"
        :size="14"
      /></button></span>
      <span
        v-if="filters.labelColors.length"
        class="filter-chip label-filter-chips"
      >ラベル<LabelChip
        v-for="c in filters.labelColors"
        :key="c"
        class="chip-label"
        :label="labelDefOf(c)"
        :index="labelIndexOf(c)"
        size="sm"
      /><button
        class="chip-x"
        aria-label="ラベルの条件を外す"
        data-test="clear-labels"
        @click="clearLabels"
      ><AppIcon
        name="close"
        :size="14"
      /></button></span>
    </p>

    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <DashSkeleton v-if="loading && !loaded" />
    <div
      v-else
      class="dash-grid"
      :class="{ loading }"
    >
      <section
        class="card kpi"
        data-test="summary"
      >
        <span class="label">{{ period.label }}</span>
        <strong class="kpi-value">{{ formatYen(sumAmount) }}</strong>
        <dl class="kpi-sub">
          <div>
            <dt>レシート</dt>
            <dd>{{ totalCount }} 件</dd>
          </div>
          <div>
            <dt>1件あたり</dt>
            <dd>{{ formatYen(average) }}</dd>
          </div>
          <div>
            <dt>{{ period.compareLabel }}</dt>
            <dd>{{ formatYen(overview?.totals.compare_value ?? null) }}</dd>
          </div>
        </dl>
      </section>

      <section
        class="card"
        data-test="payments"
      >
        <h2>支払方法</h2>
        <RankedList
          v-if="(payments?.sections[0]?.rows.length ?? 0) > 0"
          :rows="payments!.sections[0]!.rows"
          :compare-label="period.compareLabel"
          colors
        />
        <p
          v-else
          class="muted empty"
        >
          記録はありません。
        </p>
      </section>

      <section
        v-if="daily"
        class="card wide"
        data-test="daily"
      >
        <h2>日別の支出</h2>
        <div
          class="daily-bars"
          :style="{ gridTemplateColumns: `repeat(${daily.length}, minmax(0.25rem, 1fr))` }"
        >
          <span
            v-for="d in daily"
            :key="d.date"
            class="daily-col"
            :title="`${dayLabel(d.date)} ${formatYen(d.value)}`"
          >
            <span
              class="daily-bar"
              :style="{ height: `${d.height}%` }"
            />
          </span>
        </div>
        <div class="axis-ends muted small">
          <span>{{ dayLabel(daily[0]!.date) }}</span>
          <span>{{ dayLabel(daily[daily.length - 1]!.date) }}</span>
        </div>
      </section>

      <section
        class="card wide"
        data-test="receipts"
      >
        <h2>レシート</h2>
        <p
          v-if="!loading && receipts.length === 0"
          class="empty-state"
          data-test="empty"
        >
          <AppIcon
            name="chat"
            :size="28"
          />
          該当するレシートはありません。ChatGPT でレシートの写真を送ると記録されます。
        </p>
        <div
          v-for="g in groups"
          :key="g.date"
          class="day-group"
        >
          <div class="day-head">
            <span>{{ g.date ? dayLabel(g.date) : '日付なし' }}</span>
            <span class="amount muted">{{ formatYen(g.total) }}</span>
          </div>
          <ul class="recent-list">
            <li
              v-for="r in g.rows"
              :id="`receipt-${r.receipt_id}`"
              :key="r.receipt_id"
              :data-test="`receipt-${r.receipt_id}`"
            >
              <RouterLink
                :to="{ path: `/receipts/${r.receipt_id}`, query: listQueryToContext(listQuery()) }"
                class="recent-row receipt-row"
                :class="{ deleted: r.deleted_at }"
              >
                <span class="recent-icon"><AppIcon
                  :name="r.has_image ? 'image' : 'receipt'"
                  :size="18"
                /></span>
                <span class="recent-main">
                  <span
                    class="recent-store"
                    data-test="store-name"
                  >{{ r.store_name ?? '店名なし' }}</span>
                  <span class="muted small">{{ r.purchased_time ?? '' }} {{ r.item_count }} 品目<span
                    v-if="r.deleted_at"
                    class="badge badge-danger"
                  >削除済み</span><span
                    class="row-labels"
                    data-test="row-labels"
                  ><LabelDots
                    :labels="r.labels ?? []"
                    compact
                  /></span></span>
                </span>
                <span class="amount">{{ formatYen(r.amount) }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
        <button
          v-if="nextCursor"
          class="btn more-btn"
          data-test="more"
          @click="more"
        >
          さらに表示
        </button>
      </section>
    </div>
  </div>
</template>
