<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { useDataApi, type ItemSummary, type ReceiptListQuery, type ReceiptSummary } from '../api/data'
import AppearList from '../components/AppearList.vue'
import ContentSwap from '../components/ContentSwap.vue'
import DataRow from '../components/DataRow.vue'
import { errorMessage, formatYen, topItemsText } from '../composables/format'
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
// the deep-linked period / labels keys arrive through the shell-level URL
// sync (TASK-124 D2) before this page sets up — on /search it keeps labels=
// in the URL always and the period keys only while scope=period (D1), so
// the pages never write those keys themselves

const q = computed(() => qOf(route.query))
const tab = computed(() => (firstString(route.query.tab) === 'items' ? 'items' : 'receipts'))
const scope = computed(() => (firstString(route.query.scope) === 'period' ? 'period' : 'all'))

function qOf(query: Record<string, unknown>): string | undefined {
  return firstString(query.q)?.trim() || undefined
}

/** Query without the period keys (scope=all never carries them, D1). */
function dropPeriodQuery(query: LocationQueryRaw): LocationQueryRaw {
  const rest: Record<string, LocationQueryRaw[string]> = { ...query }
  delete rest.month
  delete rest.week
  delete rest.year
  delete rest.from
  delete rest.to
  return rest
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
// the topbar period chip while scoped: re-query (the URL's period keys are
// the shell-level URL sync's, TASK-124 D2 — it replaces them with the
// store's current shape on its own)
watch(
  () => period.range,
  () => {
    if (scope.value !== 'period') return
    void load()
  },
)
// the label filter: re-query (labels= in the URL is the URL sync's too)
watch(
  () => period.labelQuery,
  () => {
    void load()
  },
)

function setTab(next: 'receipts' | 'items'): void {
  if (tab.value === next) return
  void router.replace({ query: { ...route.query, tab: next === 'items' ? 'items' : undefined } })
}

function toggleScope(): void {
  const next = scope.value === 'period' ? 'all' : 'period'
  // the toggle seats the store's current period keys ONLY on the narrowing
  // direction (TASK-145 D1-3): back to all, dropPeriodQuery's result stands
  // — no seat-then-strip round trip on our own transition (a stray old-URL
  // shape is the shell write-back's to correct, not this replace's);
  // keeping the seated keys current from then on is the URL sync's, which
  // writes them only while scope=period (TASK-124 D1)
  const rest = dropPeriodQuery({ ...route.query, scope: undefined })
  void router.replace({
    query: { ...rest, ...(next === 'period' ? { scope: 'period', ...period.urlQuery } : {}) },
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

// TASK-146 §3: the results' committed key (bumped at the load commit).
// TASK-161 §2 (web-common.period-move-voice): the period part of pageQuery
// drops out — a period step never remounts the results pane
const committedKey = ref('')

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
    // the results' committed identity (the tab rides along — a tab switch is
    // a content swap too, but through the fade: the query has no order);
    // TASK-161 §2: the PERIOD part alone drops out of the key (the query
    // itself keeps it)
    committedKey.value = `${l}|${tab.value}|${JSON.stringify({ ...pageQuery(), from: undefined, to: undefined })}`
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

// REVIEW-15 裁断（2026-11-07）: the in-row category links are gone (the row
// keeps its single action, D-4 — the category route rides the feed's own
// cat-link); the catalog load stays so a failed fetch surfaces through the
// page's error message instead of an unhandled rejection
void catalog.load().catch((e) => {
  error.value = errorMessage(e)
})
</script>

<template>
  <div class="view-page search-page">
    <div class="search-head">
      <input
        v-model="draft"
        type="search"
        class="search-input"
        autofocus
        maxlength="200"
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

    <!-- TASK-146 §3: the results block crosses through the shared content
         transition at the load commit (a term / tab / scope / label change
         is a swap — the query has no order to move along) -->
    <ContentSwap
      v-if="q"
      :swap-key="committedKey"
    >
      <div class="content-pane">
        <!-- TASK-146 §3 #18 + review MED2: the appended rows appear through
             the shared bb-appear grammar (the loaded rows never move), and
             the pane rebuild's rows mount silent — AppearList carries both -->
        <AppearList
          v-if="tab === 'receipts'"
          class="recent-list search-list"
        >
          <li
            v-for="r in receipts"
            :key="r.receipt_id"
          >
            <DataRow
              :to="{ path: `/receipts/${r.receipt_id}`, query: listQueryToContext(rowContext()) }"
              data-test="search-row"
              :name="r.store_name ?? '店名なし'"
              :amount="formatYen(r.amount)"
              :sub-text="topItemsText(r.top_items)"
              :sub-figure="rowDate(r.purchased_on)"
              :labels="r.labels ?? []"
            />
          </li>
        </AppearList>
        <AppearList
          v-else
          class="recent-list search-list"
        >
          <li
            v-for="it in items"
            :key="it.item_id"
          >
            <!-- REVIEW-15 中1 (TASK-167 D-13): the item tab's rows ride the
                 shared .data-row grammar too — the main line is the item name
                 + the amount, the sub line keeps the date / store data. The
                 category rides as plain muted text (指揮裁断 2026-11-07: the
                 row keeps its single action, D-4 — an in-row link would nest
                 anchors; the category route rides the feed's own cat-link) -->
            <DataRow
              :to="{ path: `/receipts/${it.receipt_id}`, query: listQueryToContext(rowContext()) }"
              data-test="search-item-row"
              :name="it.name"
              :amount="formatYen(it.amount_incl)"
            >
              <template #sub>
                <span>{{ rowDate(it.purchased_on) }}</span>
                <span>{{ it.store_name ?? '店名なし' }}</span>
                <span
                  v-if="it.category"
                  data-test="search-item-category"
                >{{ it.category }}</span>
              </template>
            </DataRow>
          </li>
        </AppearList>
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
      </div>
    </ContentSwap>
    <p
      v-else
      class="empty-state"
      data-test="search-empty"
    >
      検索語を入力してください
    </p>
  </div>
</template>
