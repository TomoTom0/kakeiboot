<script setup lang="ts">
import { computed, inject, nextTick, onUnmounted, ref, watch, type Ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  useDataApi,
  type ReceiptListQuery,
  type ReceiptSummary,
} from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import LabelPicker from '../components/LabelPicker.vue'
import ReceiptPanel from '../components/ReceiptPanel.vue'
import { useLedger } from '../composables/ledger'
import { monthEnd, shortDate } from '../composables/period'
import {
  contextKeyOf,
  contextToListQuery,
  feedReturn,
  listQueryToContext,
} from '../composables/receiptContext'

// Receipt feed (TASK-16 item 1, TASK-27 §5): /receipts/:id shows the
// receipt and its neighbors in the list order of the URL context (period +
// filters), so one scroll reads through them — plain scrolling with no
// snap. Prev / next buttons and arrow keys move between panels (each
// landing below the sticky topbar and the feed nav via scroll-margin-top),
// and the visible receipt is reflected in the URL via router.replace (no
// history entries). Editing suspends moving and URL updates.
const props = defineProps<{ id: number }>()
const api = useDataApi()
const route = useRoute()
const router = useRouter()
// the shell's drawer state (App.vue): while it is open the feed must not
// move on arrow keys — the background is inert, but key events from the
// focused sidebar still reach the window listener
const drawerModal = inject<Ref<boolean>>('drawer-modal', ref(false))

const MAX_PAGES = 4
const WINDOW = 2

// --- feed state -------------------------------------------------------------
const feedEl = ref<HTMLElement | null>(null)
const activeLedger = ref<number | null>(null)
const sequence = ref<ReceiptSummary[]>([])
const nextCursor = ref<string | null>(null)
const currentId = ref<number | null>(null)
/** id of the replace this feed itself issued last (its echo is ignored) */
let lastReplacedId: number | null = null
/** total_count of the context list (the position denominator, not the loaded count) */
const total = ref(1)
const fallbackNote = ref(false)
const loadError = ref(false)
const effectiveCtx = ref<ReceiptListQuery>({})
const loadingMore = ref(false)
let loadSeq = 0
/** generation of the latest move (the loadSeq recipe, TASK-19 2-7): a
 * compensation whose loaded-wait resolves after its move was superseded
 * must not scrollBy */
let moveSeq = 0
/** an upward-expansion compensation is between its wait and its scrollBy:
 * IO deliveries are ignored (the layout above is transient — onIntersect) */
let compPending = false

const contextQuery = computed(() => listQueryToContext(effectiveCtx.value))
const ctxKey = computed(() => contextKeyOf(route.query))

const currentIdx = computed(() => sequence.value.findIndex((s) => s.receipt_id === currentId.value))
const winStart = computed(() => Math.max(0, currentIdx.value - WINDOW))
const winEnd = computed(() =>
  currentIdx.value < 0 ? -1 : Math.min(sequence.value.length - 1, currentIdx.value + WINDOW),
)
/** receipt ids currently mounting a real panel (the render window) */
const windowIds = computed(() =>
  currentIdx.value < 0 ? [] : sequence.value.slice(winStart.value, winEnd.value + 1).map((s) => s.receipt_id),
)
const editingIds = ref(new Set<number>())
const editing = computed(() => editingIds.value.size > 0)

const positionText = computed(() => {
  if (currentIdx.value < 0) return '-'
  return `${currentIdx.value + 1} / ${total.value}`
})
const atStart = computed(() => currentIdx.value <= 0)
const atEnd = computed(() => currentIdx.value < 0 || currentIdx.value >= sequence.value.length - 1)

function inWindow(i: number): boolean {
  return i >= winStart.value && i <= winEnd.value
}

function panelEl(id: number): HTMLElement | null {
  return feedEl.value?.querySelector(`[data-test="receipt-panel-${id}"]`) ?? null
}

async function settleTicks(): Promise<void> {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

// --- loading ----------------------------------------------------------------

function placeholder(id: number): ReceiptSummary {
  return {
    receipt_id: id,
    purchased_on: null,
    purchased_time: null,
    store_name: null,
    amount: 0,
    item_count: 0,
    has_image: false,
    deleted_at: null,
  }
}

function setSingle(id: number, withNote: boolean): void {
  moveSeq++ // this reset supersedes any pending compensation
  sequence.value = [placeholder(id)]
  nextCursor.value = null
  currentId.value = id
  fallbackNote.value = withNote
  total.value = 1
}

/** Load the context sequence until the anchor receipt is on a page (max 4). */
async function loadSequence(l: number, ctx: ReceiptListQuery, anchor: number): Promise<void> {
  const n = ++loadSeq
  moveSeq++ // this reload supersedes any pending compensation
  loadError.value = false
  const all: ReceiptSummary[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await api.listReceipts(l, { ...ctx, limit: 50, cursor })
      if (n !== loadSeq) return
      all.push(...res.receipts)
      if (res.receipts.some((r) => r.receipt_id === anchor)) {
        sequence.value = all
        total.value = res.total_count
        nextCursor.value = res.next_cursor
        currentId.value = anchor
        fallbackNote.value = false
        void ensureObserved()
        return
      }
      if (!res.next_cursor) break
      cursor = res.next_cursor
    }
  } catch {
    // the list call failed (401 / network): this receipt alone + a note
    if (n === loadSeq) {
      loadError.value = true
      setSingle(anchor, false)
      void ensureObserved()
    }
    return
  }
  // not found within the look-back limit: this receipt alone
  setSingle(anchor, true)
  void ensureObserved()
}

async function maybeLoadMore(): Promise<void> {
  const l = activeLedger.value
  if (l === null || loadingMore.value || !nextCursor.value) return
  if (currentIdx.value < sequence.value.length - WINDOW) return
  loadingMore.value = true
  const n = loadSeq
  try {
    const res = await api.listReceipts(l, { ...effectiveCtx.value, limit: 50, cursor: nextCursor.value })
    if (n === loadSeq && res.receipts.length) {
      sequence.value = [...sequence.value, ...res.receipts]
      total.value = res.total_count
      nextCursor.value = res.next_cursor
      void ensureObserved()
    }
  } catch {
    loadError.value = true
  } finally {
    loadingMore.value = false
  }
}

async function reinitialize(id: number): Promise<void> {
  const l = activeLedger.value
  if (l === null) return
  let ctx = contextToListQuery(route.query)
  if (Object.keys(ctx).length === 0) {
    // direct link without a context: the receipt's purchase month is it.
    // NB: this getReceipt duplicates the anchor panel's own fetch; accepted
    // so the panel stays self-contained and the month needs no plumbing
    try {
      const r = await api.getReceipt(l, id)
      if (!r.purchased_on) {
        setSingle(id, false)
        return
      }
      const m = r.purchased_on.slice(0, 7)
      ctx = { from: `${m}-01`, to: monthEnd(m) }
    } catch {
      setSingle(id, false)
      return
    }
  }
  effectiveCtx.value = ctx
  await loadSequence(l, ctx, id)
}

// The ledger is snapshotted for the panels: switching it on the feed goes
// back to the list instead of reading another book's receipts here.
let ledgerCalls = 0
useLedger((id) => {
  ledgerCalls++
  if (ledgerCalls === 1) {
    activeLedger.value = id
    void reinitialize(props.id)
  } else {
    void router.replace({ path: '/receipts', query: contextQuery.value })
  }
})

// --- visible panel tracking ---------------------------------------------------

let observer: IntersectionObserver | null = null
const observed = new Set<Element>()

async function ensureObserved(): Promise<void> {
  await nextTick()
  const root = feedEl.value
  if (!root) return
  observer ??= new IntersectionObserver(onIntersect)
  for (const el of root.querySelectorAll('[data-test^="receipt-panel-"]')) {
    if (!observed.has(el)) {
      observed.add(el)
      observer.observe(el)
    }
  }
}
watch([() => sequence.value.length, winStart, winEnd], () => void ensureObserved())
onUnmounted(() => {
  observer?.disconnect()
  observer = null
  observed.clear()
})

/** The more visible of two intersecting panels; exact ties go to the top
 * nearest the feed nav (entries arrive in observation order, which is not a
 * position order). */
function moreCurrent(a: IntersectionObserverEntry, b: IntersectionObserverEntry): IntersectionObserverEntry {
  if (a.intersectionRatio !== b.intersectionRatio) return a.intersectionRatio > b.intersectionRatio ? a : b
  const line = feedEl.value?.querySelector('.feed-nav')?.getBoundingClientRect().bottom ?? 0
  return Math.abs(a.boundingClientRect.top - line) <= Math.abs(b.boundingClientRect.top - line) ? a : b
}

function onIntersect(entries: IntersectionObserverEntry[]): void {
  // While an upward-expansion compensation is pending, the layout above the
  // visible panel is transient (panels growing from the placeholder height).
  // The growth itself flips panels' intersecting flags, so partial IO
  // deliveries arrive whose only candidate is a barely-visible panel above;
  // re-currenting on one would expand the window further and corrupt both
  // compensations' baselines. Entries are ignored until the compensation
  // lands (fresh deliveries arrive after its scrollBy).
  if (compPending) return
  const visible = entries.filter((e) => e.isIntersecting)
  if (!visible.length) return
  // A delivery can also be stale after the compensation landed: entries
  // generated mid-transient may arrive once the position is restored,
  // pointing at a panel that has since left the viewport. Validate the
  // candidates against the live layout when it is measurable (jsdom rects
  // are all zero there: trust the entries).
  const vh = window.innerHeight
  const live = visible.filter((e) => {
    const r = e.target.getBoundingClientRect()
    return r.height === 0 || (r.top < vh && r.bottom > 0)
  })
  if (!live.length) return
  const best = live.reduce(moreCurrent)
  const m = /^receipt-panel-(\d+)$/.exec(best.target.getAttribute('data-test') ?? '')
  if (!m) return
  const id = Number(m[1])
  if (editing.value || id === currentId.value) return
  if (id !== lastReplacedId) {
    lastReplacedId = id
    void router.replace({ name: 'receipt', params: { id }, query: contextQuery.value })
  }
  void handleCurrent(id)
}

// Panel load tracking (TASK-19 2-7): ReceiptPanel emits loaded when its
// detail fetch settles (success or error). The upward-expansion
// compensation waits for the newly mounted panels' loaded so the growth
// from the 18rem placeholder to the real height is measured in one piece
// (`.receipt-panel-body:empty` holds the placeholder height until then).
const loadedIds = new Set<number>()
const loadedWaiters = new Map<number, Set<() => void>>()

function onPanelLoaded(id: number): void {
  // a late emit can land after the panel left the render window (the purge
  // watch already dropped its mark): don't re-add it — a remount refetches
  if (!windowIds.value.includes(id)) return
  loadedIds.add(id)
  const waiters = loadedWaiters.get(id)
  if (!waiters) return
  loadedWaiters.delete(id)
  for (const w of waiters) w()
}

/** Resolve true when every `ids` panel has emitted loaded; false when the
 * straggler cap hits first (a measurement then would be pre-growth: the
 * caller must not compensate on it). */
function waitForPanelLoaded(ids: number[], timeoutMs: number): Promise<boolean> {
  const pending = ids.filter((id) => !loadedIds.has(id))
  if (!pending.length) return Promise.resolve(true)
  return new Promise((resolve) => {
    let remaining = pending.length
    const timer = setTimeout(() => {
      unregister()
      resolve(false)
    }, timeoutMs)
    function unregister(): void {
      clearTimeout(timer)
      for (const id of pending) {
        const ws = loadedWaiters.get(id)
        if (!ws) continue
        ws.delete(tick)
        if (!ws.size) loadedWaiters.delete(id)
      }
    }
    // one tick per pending id: true only after all of them
    function tick(): void {
      remaining -= 1
      if (remaining > 0) return
      unregister()
      resolve(true)
    }
    for (const id of pending) {
      const ws = loadedWaiters.get(id) ?? new Set()
      ws.add(tick)
      loadedWaiters.set(id, ws)
    }
  })
}

// a panel leaving the window unmounts; when it comes back it refetches, so
// its loaded mark must not survive (the wait would resolve early)
watch(windowIds, (ids) => {
  const inWin = new Set(ids)
  for (const id of loadedIds) {
    if (!inWin.has(id)) loadedIds.delete(id)
  }
})

async function handleCurrent(id: number): Promise<void> {
  const seq = ++moveSeq
  const beforeStart = winStart.value
  const beforeIds = new Set(windowIds.value)
  const el = panelEl(id)
  const beforeTop = el?.getBoundingClientRect().top ?? null
  currentId.value = id
  if (beforeStart > winStart.value) {
    // panels are mounting above the visible one: keep it in place (iOS
    // Safari has no scroll anchoring). Their detail fetch settles after
    // mount: wait for the newly mounted ones before measuring, so the whole
    // growth is compensated in one scrollBy (a straggler cap aborts: a
    // pre-growth measurement would mis-scroll). IO deliveries are ignored
    // while this is pending (onIntersect).
    compPending = true
    try {
      const mounted = windowIds.value.filter((x) => !beforeIds.has(x))
      const settled = await waitForPanelLoaded(mounted, 1_000)
      if (seq !== moveSeq) return
      // the straggler cap does not abort: the delta is measured as it
      // stands (pre-growth it is ~0 and harmless; landed growth is
      // restored — the rest falls back to the un-compensated behavior)
      if (settled) await settleTicks()
      if (seq !== moveSeq) return
      const afterTop = panelEl(id)?.getBoundingClientRect().top ?? null
      if (beforeTop !== null && afterTop !== null && afterTop !== beforeTop) {
        window.scrollBy({ top: afterTop - beforeTop, behavior: 'auto' })
      }
    } finally {
      compPending = false
    }
  }
  void maybeLoadMore()
}

// --- navigation (route prop / URL sync) --------------------------------------

watch([() => props.id, ctxKey], ([id, key], [prevId, prevKey]) => {
  // our own replace echoes back through the id prop: ignore it
  if (key === prevKey && (id === lastReplacedId || id === prevId)) return
  // a direct link fills the context lazily: the first replace adopts it
  const keyChanged = key !== prevKey && key !== JSON.stringify(contextQuery.value)
  if (keyChanged) {
    void reinitialize(id)
    return
  }
  if (id !== prevId && id !== lastReplacedId) {
    if (sequence.value.some((s) => s.receipt_id === id)) {
      moveSeq++ // this move supersedes any pending compensation
      currentId.value = id
      void scrollTo(id)
    } else {
      void reinitialize(id)
    }
  }
})

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

async function scrollTo(id: number): Promise<void> {
  await nextTick()
  panelEl(id)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
}

async function goTo(id: number): Promise<void> {
  if (editing.value || id === currentId.value) return
  moveSeq++ // this move supersedes any pending compensation
  currentId.value = id
  // a button / key move rewrites the URL itself: onIntersect early-returns
  // for the new currentId, so the panels crossing the viewport mid-scroll
  // must not leave the URL on the pre-move (or intermediate) receipt
  if (id !== lastReplacedId) {
    lastReplacedId = id
    void router.replace({ name: 'receipt', params: { id }, query: contextQuery.value })
  }
  void maybeLoadMore()
  await nextTick()
  panelEl(id)?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' })
  const heading = panelEl(id)?.querySelector<HTMLElement>('.detail-title')
  heading?.focus()
}

function move(delta: -1 | 1): void {
  const idx = currentIdx.value
  if (idx < 0) return
  const target = sequence.value[idx + delta]
  if (!target || editing.value) return
  void goTo(target.receipt_id)
}

function onKeydown(e: KeyboardEvent): void {
  if (drawerModal.value) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (editing.value) return
  const t = e.target
  if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea, select'))) return
  const idx = currentIdx.value
  if (idx < 0) return
  const target = e.key === 'ArrowRight' ? sequence.value[idx + 1] : sequence.value[idx - 1]
  if (!target) return
  e.preventDefault()
  void goTo(target.receipt_id)
}

window.addEventListener('keydown', onKeydown)
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function onEditingChange(id: number, value: boolean): void {
  const s = new Set(editingIds.value)
  if (value) s.add(id)
  else s.delete(id)
  editingIds.value = s
}

function goBack(): void {
  feedReturn.receiptId = currentId.value
}
</script>

<template>
  <div
    ref="feedEl"
    class="view-page receipt-feed"
  >
    <nav
      class="feed-nav"
      aria-label="レシートフィード"
    >
      <RouterLink
        class="feed-back"
        :to="{ path: '/receipts', query: contextQuery }"
        data-test="feed-back"
        @click="goBack"
      >
        <AppIcon
          name="chevron-left"
          :size="16"
        />一覧
      </RouterLink>
      <span
        class="feed-position muted small"
        data-test="feed-position"
      >{{ positionText }}</span>
      <span class="feed-nav-buttons">
        <button
          type="button"
          class="icon-btn"
          aria-label="前のレシート（新しい）"
          data-test="feed-prev"
          :disabled="editing || atStart"
          @click="move(-1)"
        >
          <AppIcon name="chevron-left" />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label="次のレシート（古い）"
          data-test="feed-next"
          :disabled="editing || atEnd"
          @click="move(1)"
        >
          <AppIcon name="chevron-right" />
        </button>
      </span>
    </nav>
    <p
      v-if="fallbackNote"
      class="msg msg-info small"
      data-test="feed-fallback"
    >
      前後のレシートを特定できなかったため、このレシートだけを表示しています。
    </p>
    <p
      v-if="loadError"
      class="msg msg-error small"
      role="alert"
      data-test="feed-error"
    >
      レシート一覧の取得に失敗しました。時間をおいて再読み込みしてください。
    </p>
    <template
      v-for="(s, i) in sequence"
      :key="s.receipt_id"
    >
      <article
        class="receipt-panel"
        :data-test="`receipt-panel-${s.receipt_id}`"
        :style="inWindow(i) ? undefined : { minHeight: '18rem' }"
      >
        <ReceiptPanel
          v-if="inWindow(i) && activeLedger !== null"
          :ledger-id="activeLedger"
          :receipt-id="s.receipt_id"
          @editing-change="(v) => onEditingChange(s.receipt_id, v)"
          @loaded="onPanelLoaded(s.receipt_id)"
        >
          <!-- TASK-17: immediate label toggles in the viewing panel. The slot
               props carry the panel's receipt, the ledger, editability and
               applyReceipt; deletions and restores keep the panel in place. -->
          <template #labels="labelProps">
            <LabelPicker v-bind="labelProps" />
          </template>
        </ReceiptPanel>
        <p
          v-else
          class="receipt-panel-placeholder muted small"
        >
          {{ shortDate(s.purchased_on) }} {{ s.store_name ?? '店名なし' }}
        </p>
      </article>
    </template>
  </div>
</template>
