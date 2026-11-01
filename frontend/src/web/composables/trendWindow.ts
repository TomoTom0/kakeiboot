// The trend chart's movable window (TASK-104, design: tmp/tasks/tm-104/
// design_trend-window.md): the offset/window state, the trend fetch and the
// stacked assembly live in this one composable shared by the four trend
// screens (Home / Categories / Stores / AxisDetail). month/year page their
// window by its own width (month 6 / year 12 months — TASK-108: a page never
// overlaps the one before it) per prev press without touching the focus (the
// period store); week/range keep the selected period itself. The window is
// ephemeral: mode/range/labelQuery/ledger changes reset it to the initial one
// (offset=0). TASK-115 (design: tmp/tasks/tm-115/
// design_trend-continuous-window.md): a window move keeps ONE graph on
// screen — the committed old window and the new one concatenate (slide, the
// [new, old] / [old, new] pair) and the viewport translates over them
// (finishSlide trims). A keyOf(args) resultCache serves a prefetched
// neighbor at press time (no display fetch, synchronous commit) and every
// commit prefetches the prev-adjacent window (silent failure). Flush clears
// the cache, the issued set, the slide and its request.
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import { useDataApi, type AnalysisAxis, type AnalysisFilters, type AnalysisTrendQuery, type AnalysisTrendResult } from '../api/data'
import type { StackedBar } from '../components/TrendBars.vue'
import { errorMessage } from './format'
import { monthEnd, shiftMonth } from './period'
import { prefersReducedMotion } from './reducedMotion'
import { trendGranularity, type TrendGranularity } from './trend'
// TASK-116 (design §3-0): the assembly moved to shared/lib as the pure
// stackedOf the four stack sites share (trend window / week rows / Receipts
// daily / widget monthly); this composable delegates and keeps its contract
import { stackedOf } from '@/shared/lib/stackedBars'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

export interface UseTrendWindowOptions {
  /** the trend's axis (Home/Categories/Stores: fixed; AxisDetail: the screen's stack axis) */
  axis: () => AnalysisAxis
  /** extra subject filters read at fetch time; returning undefined defers the
   *  fetch (AxisDetail until its subject resolves) */
  filters?: () => AnalysisFilters | undefined
  /** route failures into the page's error banner; null clears the banner
   *  after the next successful fetch (keeps the current UX) */
  onError?: (message: string | null) => void
}

/** one continuous slide (TASK-115 §3-1): the concatenated old+new pair —
 *  the display array TrendBars receives while the viewport moves. bars is
 *  dir='prev' ? [new, old] : [old, new] (step=span keeps the bucket keys
 *  unique, so the keyed v-for reuses the old bars' DOM); axisWindows holds
 *  each window's bucket keys so the axis thinning computes per window and
 *  never reshuffles mid-slide. */
export interface SlideState {
  dir: 'prev' | 'next'
  bars: StackedBar[]
  axisWindows: string[][]
}

export interface TrendWindowState {
  /** the fetched window's result (null until the first response) */
  result: Ref<AnalysisTrendResult | null>
  /** the stacked columns for TrendBars: the slide's concatenation while a
   *  slide runs, the committed window's columns otherwise */
  stacked: ComputedRef<StackedBar[]>
  /** the charted [from, to] (offset applied; period.range while inactive) */
  window: ComputedRef<[string, string]>
  /** the committed window's identity '<from>..<to>' — null until the first
   *  response: TrendBars' v-if gate (TASK-108) */
  windowKey: Ref<string | null>
  /** the trend granularity of the current window */
  granularity: ComputedRef<TrendGranularity>
  /** month/year only — the prev/next pair renders only while true */
  active: ComputedRef<boolean>
  offset: Ref<number>
  /** false while the last fetched window (offset>=1) was all-zero */
  canPrev: Ref<boolean>
  /** offset > 0 */
  canNext: ComputedRef<boolean>
  /** the direction of the last window move — the concatenation order's
   *  reference (TASK-115: a focus change no longer inherits a slide) */
  direction: Ref<'prev' | 'next'>
  /** the sliding concatenation — non-null only between an assembly and its
   *  trim (transitionend / watchdog / focus change / a rapid re-press) */
  slide: Ref<SlideState | null>
  loading: Ref<boolean>
  prev(): void
  next(): void
  refresh(): void
  finishSlide(): void
}

export function useTrendWindow(opts: UseTrendWindowOptions): TrendWindowState {
  const api = useDataApi()
  const period = usePeriodStore()
  const session = useSessionStore()

  // shallow: the response is swapped whole and read only (a deep reactive
  // proxy would mask the raw response reference)
  const result = shallowRef<AnalysisTrendResult | null>(null)
  const offset = ref(0)
  const loading = ref(false)
  const canPrev = ref(true)

  const active = computed(() => period.mode === 'month' || period.mode === 'year')
  /** the page-turn step — the window's own width: a page never overlaps the
   *  previous one (TASK-108). month slides 6 months, year 12. week/range
   *  never page (active=false keeps the window and prev/next away from it) */
  const span = computed(() => (period.mode === 'month' ? 6 : 12))
  /** the charted [from, to] at a page offset (TASK-115 §3-2: the pure
   *  windowAt under buildArgsAt — the display fetch reads offset.value, the
   *  prefetch the offset+span virtual window; inactive modes return the
   *  selected period itself, so their adjacent key equals the display one) */
  function windowAt(off: number): [string, string] {
    if (!active.value) return period.range
    // the anchor is the window's RIGHT edge: the selected month, or the
    // year's December (offset=0 equals trendQuery(5) / period.range — the
    // no-regress guarantee of §1)
    const anchor = period.mode === 'month' ? period.month : `${period.year}-12`
    const right = shiftMonth(anchor, -off)
    const left = shiftMonth(anchor, -(off + span.value - 1))
    return [`${left}-01`, monthEnd(right)]
  }
  const window = computed<[string, string]>(() => windowAt(offset.value))
  function granularityAt(off: number): TrendGranularity {
    if (active.value) return 'month'
    const [from, to] = windowAt(off)
    return trendGranularity(period.mode, from, to)
  }
  const granularity = computed(() => granularityAt(offset.value))
  const canNext = computed(() => offset.value > 0)
  /** the direction of the last window move ('prev' into the past / 'next'
   *  back toward the initial window) — TASK-115: only the concatenation
   *  order reads it; a focus change swaps the window instantly (no slide) */
  const direction = ref<'prev' | 'next'>('prev')
  /** the committed window's identity '<from>..<to>' — a same-range refetch
   *  (labelQuery change, refresh) keeps it, so the window never slides for
   *  a recolour. null until the first response — TrendWindow renders no
   *  bars yet (v-if) */
  const windowKey = ref<string | null>(null)

  // --- TASK-115 §3-1: the continuous-window state ---
  /** the sliding concatenation — the display array while non-null */
  const slide = ref<SlideState | null>(null)
  /** only prev()/next() raise it and only a commit consumes it (H1): the
   *  initial fetch, refresh(), the AxisDetail re-init and the focus-change
   *  refetch (flush clears it) never assemble a slide */
  let slideRequest: 'prev' | 'next' | null = null
  /** window results keyed by keyOf(args) — the args (not '<from>..<to>')
   *  key the cache, so an AxisDetail subject or a label switch can never
   *  serve another condition's response for the same range */
  const resultCache = new Map<string, AnalysisTrendResult>()
  /** keys a prefetch already issued for: successes keep the key (never
   *  re-issued), failures drop it (retried on the next commit); flush
   *  clears the whole set so a return re-issues */
  const prefetchIssued = new Set<string>()

  /** the stacked assembly as a pure function of a result (§3-1): top-3
   *  series + the residual「ほか」(seriesColor mapping, value-0 segments
   *  omitted) — the slide concatenation and the committed window share it.
   *  TASK-116: the body lives in shared/lib stackedOf (res.axis keys the
   *  color mapping — always this composable's own axis, the query echoes
   *  it). TASK-123: the fetch keeps limit=5 while the FRONTEND assembly
   *  slices to the top 3 (ranks 4-5 and the sub-5% members fold into
   *  「ほか」) — the allocation lives in the view components */

  const stacked = computed<StackedBar[]>(() => {
    if (slide.value) return slide.value.bars
    const res = result.value
    if (!res) return []
    return stackedOf(res)
  })

  /** buildArgs generalized to a page offset (§3-2): the display fetch and
   *  the prefetch read the very same conditions (granularity, labelQuery,
   *  axis, filters) — only the window differs */
  function buildArgsAt(off: number): { l: number; query: AnalysisTrendQuery } | null {
    // the old load() guard verbatim: an unresolved ledger or an invalid
    // period (a reversed range) fetches nothing
    const l = session.selectedLedgerId
    if (l === null || !period.valid) return null
    const extra = opts.filters?.()
    if (extra === undefined && opts.filters !== undefined) return null
    const [from, to] = windowAt(off)
    return {
      l,
      query: {
        axis: opts.axis(),
        metric: 'amount',
        granularity: granularityAt(off),
        from,
        to,
        ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
        ...(extra ?? {}),
        limit: 5,
      },
    }
  }

  let seq = 0
  // the last failure this composable routed out (null after a success): the
  // banner clear fires only when our own failure is still on it, so a page
  // load's analysis failure survives a successful window fetch
  let lastError: string | null = null
  // the idempotency guard (REVIEW-21 指摘2): a fetch identical to the
  // in-flight one or the last successful one is not re-issued — AxisDetail's
  // composable watch and route watch can both fire, only one fetch runs
  let inFlight: string | null = null
  let lastDone: string | null = null
  const keyOf = (a: { l: number; query: AnalysisTrendQuery }): string => JSON.stringify([a.l, a.query])

  /** a reduce preference skips the slide itself: the commit swaps the
   *  window instantly (§3-3; the CSS block is the second guard). The probe
   *  lives in reducedMotion.ts since TASK-146 §3 (one shared read) */
  function reducedMotion(): boolean {
    return prefersReducedMotion()
  }

  /** assemble the old+new concatenation (§3-1): prev parks the new window
   *  before the old one, next appends it after — the step=span guarantee
   *  keeps the bucket keys unique across the pair */
  function assembleSlide(dir: 'prev' | 'next', newRes: AnalysisTrendResult, oldRes: AnalysisTrendResult): void {
    const nb = stackedOf(newRes)
    const ob = stackedOf(oldRes)
    slide.value =
      dir === 'prev'
        ? { dir, bars: [...nb, ...ob], axisWindows: [newRes.buckets, oldRes.buckets] }
        : { dir, bars: [...ob, ...nb], axisWindows: [oldRes.buckets, newRes.buckets] }
  }

  /** the commit both fetch paths share: adopt the result, recompute the
   *  zero floor and consume a pending slideRequest — the concatenation is
   *  assembled only when the request exists AND the committed window itself
   *  changed (a same-window refetch never slides) */
  function commit(a: { l: number; query: AnalysisTrendQuery }, res: AnalysisTrendResult, key: string): void {
    const prevKey = windowKey.value
    const oldRes = result.value
    result.value = res
    windowKey.value = `${a.query.from}..${a.query.to}`
    lastDone = key
    // the all-zero floor applies to slid-to windows only: an all-zero
    // initial window must keep prev available (a record-less month still
    // needs the months before it)
    canPrev.value = offset.value >= 1 ? res.bucket_totals.reduce<number>((t, v) => t + (v ?? 0), 0) > 0 : true
    if (lastError !== null) {
      lastError = null
      opts.onError?.(null)
    }
    if (slideRequest !== null && prevKey !== windowKey.value && oldRes !== null && !reducedMotion()) {
      assembleSlide(slideRequest, res, oldRes)
    }
    slideRequest = null
  }

  /** prefetch the prev-adjacent window (§3-2): the offset+span virtual
   *  window under the display fetch's very conditions. Issued only when no
   *  cache entry / display fetch / issued key matches; a failure is dropped
   *  silently (no onError, no loading) and its key leaves the issued set so
   *  the next commit retries. The display state (seq / inFlight / lastDone /
   *  loading) is never touched. */
  async function prefetchPrev(): Promise<void> {
    const a = buildArgsAt(offset.value + span.value)
    if (a === null) return
    const key = keyOf(a)
    if (resultCache.has(key) || key === inFlight || key === lastDone || prefetchIssued.has(key)) return
    prefetchIssued.add(key)
    try {
      const res = await api.getAnalysisTrend(a.l, a.query)
      // the await crossed a flush when the key left prefetchIssued (flush
      // clears the set): a stale-condition entry must not re-enter the
      // cleared cache — §5-1, the same window re-fetches after a flush
      if (prefetchIssued.has(key)) resultCache.set(key, res)
    } catch {
      prefetchIssued.delete(key)
    }
  }

  async function run(): Promise<void> {
    const a = buildArgsAt(offset.value)
    if (a === null) return
    const key = keyOf(a)
    // the cache hit goes FIRST (§3-2): a prefetched neighbor commits
    // synchronously — no fetch, no loading — and still invalidates a
    // pending fetch for other args (PR#1 P2, moved onto this path): bump
    // seq past its response and take over the cleanup its finally would
    // have done — loading off, inFlight clear
    const cached = resultCache.get(key)
    if (cached !== undefined) {
      if (inFlight !== null && inFlight !== key) {
        seq++
        inFlight = null
        loading.value = false
      }
      commit(a, cached, key)
      void prefetchPrev()
      return
    }
    if (key === inFlight) return
    if (key === lastDone) return
    inFlight = key
    loading.value = true
    const n = ++seq
    try {
      const res = await api.getAnalysisTrend(a.l, a.query)
      if (n === seq) {
        resultCache.set(key, res)
        commit(a, res, key)
        void prefetchPrev()
      }
    } catch (e) {
      if (n === seq) {
        lastError = errorMessage(e)
        opts.onError?.(lastError)
      }
    } finally {
      if (n === seq) {
        loading.value = false
        if (inFlight === key) inFlight = null
      }
    }
  }

  // focus changes reset the window to the initial one and refetch. mode is an
  // explicit source (the reload on a mode change must not ride on range's
  // reference comparison — the range computed always returns a fresh array).
  // windowKey stays at its last committed value through the reset (fetch in
  // flight): TrendBars keeps drawing the old window until the response lands.
  // TASK-115: the flush also clears the result cache, the issued set, the
  // slide and its request — a returning focus re-fetches everything. sync:
  // a mid-slide focus change must trim on the very same tick.
  watch(
    [() => period.mode, () => period.range, () => period.labelQuery, () => session.selectedLedgerId],
    () => {
      offset.value = 0
      canPrev.value = true
      resultCache.clear()
      prefetchIssued.clear()
      slide.value = null
      slideRequest = null
      void run()
    },
    { immediate: true, flush: 'sync' },
  )

  function prev(): void {
    // §3-3 連打: a re-press while the slide still runs takes priority over
    // the canPrev guard — trim at once and move (slide=null keeps the guard:
    // a disable-state press never moves the window)
    if (slide.value === null && !canPrev.value) return
    direction.value = 'prev'
    slideRequest = 'prev'
    // a slide still in progress trims at once: the press restarts from the
    // committed window (cache miss: dim + fetch; hit: immediate assembly)
    if (slide.value !== null) slide.value = null
    offset.value += span.value
    void run()
  }
  function next(): void {
    if (slide.value === null && offset.value <= 0) return
    direction.value = 'next'
    slideRequest = 'next'
    if (slide.value !== null) slide.value = null
    offset.value = Math.max(0, offset.value - span.value)
    void run()
  }
  function refresh(): void {
    void run()
  }
  /** the trim (§3-3): drop the concatenation — the display falls back to the
   *  committed window alone. Idempotent: the transitionend and the watchdog
   *  can race harmlessly */
  function finishSlide(): void {
    slide.value = null
  }

  return {
    result,
    stacked,
    window,
    windowKey,
    granularity,
    active,
    offset,
    canPrev,
    canNext,
    direction,
    slide,
    loading,
    prev,
    next,
    refresh,
    finishSlide,
  }
}
