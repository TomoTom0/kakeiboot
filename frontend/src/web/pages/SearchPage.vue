<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter, type LocationQueryRaw, type RouteLocationRaw } from 'vue-router'
import LabelDots from '@/shared/components/LabelDots.vue'
import { formatLabelQuery, parseLabelQuery } from '@/shared/labels'
import { useDataApi, type ItemSummary, type ReceiptListQuery, type ReceiptSummary } from '../api/data'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { jstToday, shortDate } from '../composables/period'
import { firstString, listQueryToContext } from '../composables/receiptContext'
import { usePageReady } from '../composables/usePageReady'
import { useCatalogStore } from '../stores/catalog'
import { usePeriodStore } from '../stores/period'

// /search (TASK-41, design 2-2): the URL is the single source of truth — q /
// tab / scope (and the shared period keys / labels) all live in the query and
// the page only holds the input draft. The input commits with Enter at once
// plus a 300ms debounce (IME-safe: no timer while composing, the committing
// Enter is a no-op), and every commit is a router.replace so refining the
// term does not pile up history. The period scope chip narrows the query to
// the period store's range ("{label}のみ"); label filtering follows the
// shared store like on the other browsing screens.
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const catalog = useCatalogStore()
const { markReady } = usePageReady()
period.fromQuery(route.query)
// a deep link's labels are adopted into the store so the topbar chip shows
// the selection the results are actually filtering with (§11-3); with no
// labels key the store's current value stands and later changes ride the
// watch below into the URL
if ('labels' in route.query) period.setLabelColors(parseLabelQuery(firstString(route.query.labels)))

const q = computed(() => qOf(route.query))
const tab = computed(() => (firstString(route.query.tab) === 'items' ? 'items' : 'receipts'))
const scope = computed(() => (firstString(route.query.scope) === 'period' ? 'period' : 'all'))

function qOf(query: Record<string, unknown>): string | undefined {
  return firstString(query.q)?.trim() || undefined
}

/** Current period keys (month/year/from/to) with the stale shape dropped. */
function withPeriodQuery(query: LocationQueryRaw): LocationQueryRaw {
  const rest: Record<string, LocationQueryRaw[string]> = { ...query }
  delete rest.month
  delete rest.year
  delete rest.from
  delete rest.to
  return { ...rest, ...period.urlQuery }
}

// --- input draft: Enter at once + a 300ms debounce, IME-safe ----------------
const draft = ref(firstString(route.query.q) ?? '')
const composing = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

function commit(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  const term = draft.value.trim()
  void router.replace({ query: { ...route.query, q: term || undefined } })
}

function commitSoon(): void {
  if (composing.value) return // no timer while composing
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    commit()
  }, 300)
}

function onEnter(e: KeyboardEvent): void {
  if (e.isComposing) return // the Enter that commits an IME conversion
  commit()
}

function onCompositionStart(): void {
  composing.value = true
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

function onCompositionEnd(): void {
  composing.value = false
  commitSoon() // browsers that fire no input after the conversion
}

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null
})

// --- the shared filters ride the URL both ways ------------------------------
watch(
  () => route.query.q,
  (v) => {
    // the dialog run (or a back-navigation) changed the term underneath:
    // follow it and stop a pending debounce from overwriting it with the
    // stale draft
    draft.value = firstString(v) ?? ''
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  },
)
// any committed q / tab / scope re-runs the search — the multi-source form
// compares the entries, so a labels=/period-only query replace (a fresh
// route.query object each time) does not re-fire this (REVIEW-3 指摘1)
watch([() => route.query.q, () => route.query.tab, () => route.query.scope], () => void load())
// the topbar period chip while scoped: re-query and keep the URL's period
// keys in the store's current shape
watch(
  () => period.range,
  () => {
    if (scope.value !== 'period') return
    void router.replace({ query: withPeriodQuery({ ...route.query }) })
    void load()
  },
)
// the label filter: re-query and reflect labels= in the URL (url-restore
// stays consistent with what the results were filtered by)
watch(
  () => period.labelQuery,
  () => {
    void router.replace({
      query: {
        ...route.query,
        labels: period.labelColors.length ? formatLabelQuery(period.labelColors) : undefined,
      },
    })
    void load()
  },
)

function setTab(next: 'receipts' | 'items'): void {
  if (tab.value === next) return
  void router.replace({ query: { ...route.query, tab: next === 'items' ? 'items' : undefined } })
}

function toggleScope(): void {
  const next = scope.value === 'period' ? 'all' : 'period'
  void router.replace({
    query: withPeriodQuery({ ...route.query, scope: next === 'period' ? 'period' : undefined }),
  })
}

// --- results -----------------------------------------------------------------
const receipts = ref<ReceiptSummary[]>([])
const items = ref<ItemSummary[]>([])
const totalCount = ref(0)
const sumAmount = ref(0)
const nextCursor = ref<string | null>(null)
const error = ref('')
const loading = ref(false)

/** Query of the active tab's page (load and "さらに表示" share it); the
 *  receipts query and the item query share these keys. */
function pageQuery(cursor?: string): ReceiptListQuery {
  const [from, to] = scope.value === 'period' ? period.range : [undefined, undefined]
  return {
    q: qOf(route.query),
    from,
    to,
    label_colors: period.labelQuery,
    limit: 50,
    cursor,
  }
}

/** Feed context of a row link: the term plus the scoped period and labels. */
function rowContext(): ReceiptListQuery {
  const [from, to] = scope.value === 'period' ? period.range : [undefined, undefined]
  return { q: qOf(route.query), from, to, label_colors: period.labelQuery }
}

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null) return
  const n = ++seq
  if (!q.value) {
    // before the first search (or after clearing the term): no API call
    receipts.value = []
    items.value = []
    totalCount.value = 0
    sumAmount.value = 0
    nextCursor.value = null
    error.value = ''
    loading.value = false
    markReady()
    return
  }
  if (!period.valid) return
  loading.value = true
  error.value = ''
  try {
    if (tab.value === 'items') {
      const res = await api.searchItems(l, pageQuery())
      if (n !== seq) return
      items.value = res.items
      receipts.value = []
      totalCount.value = res.total_count
      sumAmount.value = res.sum_amount
      nextCursor.value = res.next_cursor
    } else {
      const res = await api.listReceipts(l, pageQuery())
      if (n !== seq) return
      receipts.value = res.receipts
      items.value = []
      totalCount.value = res.total_count
      sumAmount.value = res.sum_amount
      nextCursor.value = res.next_cursor
    }
  } catch (e) {
    if (n !== seq) return
    error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      loading.value = false
      markReady()
    }
  }
}

async function more(): Promise<void> {
  const l = ledgerId.value
  const cursor = nextCursor.value
  // no paging while a (re)load is in flight — bumping seq here would orphan
  // that load's response and leave loading stuck true
  if (l === null || !cursor || loading.value) return
  // rides the same seq as load: a term committed while this fetch is in
  // flight (or a second press) must not append stale/duplicate pages on
  // top of the fresh results (REVIEW-3 指摘3)
  const n = ++seq
  try {
    if (tab.value === 'items') {
      const res = await api.searchItems(l, pageQuery(cursor))
      if (n !== seq) return
      items.value = [...items.value, ...res.items]
      nextCursor.value = res.next_cursor
    } else {
      const res = await api.listReceipts(l, pageQuery(cursor))
      if (n !== seq) return
      receipts.value = [...receipts.value, ...res.receipts]
      nextCursor.value = res.next_cursor
    }
  } catch (e) {
    if (n !== seq) return
    error.value = errorMessage(e)
  }
}

const ledgerId = useLedger((id) => void load(id))

const rowCount = computed(() => (tab.value === 'items' ? items.value.length : receipts.value.length))

/** "M/D", or "YYYY/M/D" when the date falls outside the current JST year. */
function rowDate(d: string | null | undefined): string {
  if (!d) return '-'
  const y = Number(d.slice(0, 4))
  return y === Number(jstToday().slice(0, 4)) ? shortDate(d) : `${y}/${shortDate(d)}`
}

/** Category link of an item row (TASK-74 §4-7): the catalog resolves the
 * path into the hierarchy route ids; an unresolvable path keeps the list
 * destination with the legacy category query (the list's own gate tries the
 * same resolution). The query carries the period only while the scope is
 * period — a whole-history search has no period to hand down. */
void catalog.load().catch((e) => {
  // the category links need the catalog; a failed fetch leaves the results
  // themselves working but must surface (the load catch form), not reject
  // unhandled
  error.value = errorMessage(e)
})
function categoryQuery(): Record<string, string> {
  return {
    ...(scope.value === 'period' ? period.urlQuery : {}),
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
}
function categoryTo(path: string): RouteLocationRaw {
  const node = catalog.resolve('item', path)
  if (!node) return { path: '/categories', query: { category: path, ...categoryQuery() } }
  const parent = catalog.parentIdOf('item', node.id)
  const target = parent === null ? `/categories/${node.id}` : `/categories/${parent}/${node.id}`
  return { path: target, query: categoryQuery() }
}
</script>

<template>
  <div class="view-page search-page">
    <div class="search-head">
      <input
        v-model="draft"
        type="search"
        class="search-input"
        autofocus
        aria-label="検索語"
        data-test="search-input"
        @input="commitSoon"
        @keydown.enter="onEnter"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      >
      <button
        type="button"
        class="filter-chip-btn search-scope"
        :aria-pressed="scope === 'period'"
        :aria-label="`期間スコープ: ${scope === 'period' ? `${period.label}のみ` : '全期間'}`"
        data-test="search-scope"
        @click="toggleScope"
      >
        {{ scope === 'period' ? `${period.label}のみ` : '全期間' }}
      </button>
    </div>
    <div
      class="tabs search-tabs"
      role="tablist"
      aria-label="検索対象"
    >
      <button
        type="button"
        class="tab"
        :class="{ active: tab === 'receipts' }"
        role="tab"
        :aria-selected="tab === 'receipts'"
        data-test="search-tab-receipts"
        @click="setTab('receipts')"
      >
        レシート
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: tab === 'items' }"
        role="tab"
        :aria-selected="tab === 'items'"
        data-test="search-tab-items"
        @click="setTab('items')"
      >
        品物
      </button>
    </div>

    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>
    <p
      v-else-if="q && !loading"
      class="search-meta"
      data-test="search-meta"
    >
      {{ totalCount }}件・合計 {{ formatYen(sumAmount) }}
    </p>

    <template v-if="q">
      <ul
        v-if="tab === 'receipts'"
        class="recent-list search-list"
      >
        <li
          v-for="r in receipts"
          :key="r.receipt_id"
        >
          <RouterLink
            :to="{ path: `/receipts/${r.receipt_id}`, query: listQueryToContext(rowContext()) }"
            class="recent-row search-row"
            data-test="search-row"
          >
            <span class="recent-date">{{ rowDate(r.purchased_on) }}</span>
            <span class="recent-main">
              <span class="recent-store">{{ r.store_name ?? '店名なし' }}</span>
              <span class="row-labels"><LabelDots
                :labels="r.labels ?? []"
                compact
              /></span>
            </span>
            <span class="amount">{{ formatYen(r.amount) }}</span>
          </RouterLink>
        </li>
      </ul>
      <ul
        v-else
        class="recent-list search-list"
      >
        <li
          v-for="it in items"
          :key="it.item_id"
        >
          <!-- the row press (name / amount) leads to the receipt's feed; the
               category is a separate link beside it, never nested in the a -->
          <div
            class="search-item-row"
            data-test="search-item-row"
          >
            <RouterLink
              :to="{ path: `/receipts/${it.receipt_id}`, query: listQueryToContext(rowContext()) }"
              class="search-item-main"
            >
              <span class="search-item-name">{{ it.name }}</span>
              <span class="amount">{{ formatYen(it.amount_incl) }}</span>
            </RouterLink>
            <div class="search-item-sub">
              <span>{{ rowDate(it.purchased_on) }}</span>
              <span>{{ it.store_name ?? '店名なし' }}</span>
              <RouterLink
                v-if="it.category"
                class="search-item-category"
                data-test="search-item-category"
                :to="categoryTo(it.category)"
                @click.stop
              >
                {{ it.category }}
              </RouterLink>
            </div>
          </div>
        </li>
      </ul>
      <p
        v-if="!error && !loading && rowCount === 0"
        class="empty-state"
        data-test="search-empty"
      >
        見つかりませんでした
      </p>
      <button
        v-if="nextCursor && !error"
        class="btn more-btn"
        :disabled="loading"
        data-test="search-more"
        @click="more"
      >
        さらに表示
      </button>
    </template>
    <p
      v-else
      class="empty-state"
      data-test="search-empty"
    >
      検索語を入力してください
    </p>
  </div>
</template>
