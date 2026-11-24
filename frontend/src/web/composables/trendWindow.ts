// The trend chart's movable window (TASK-104, design: tmp/tasks/tm-104/
// design_trend-window.md): the window state, the trend fetch and the stacked
// assembly live in this one composable shared by the four trend screens
// (Home / Categories / Stores / AxisDetail). TASK-115 (design: tmp/tasks/
// tm-115/design_trend-continuous-window.md): a window move keeps ONE graph on
// screen — the committed old window and the new one concatenate (slide) and
// the viewport translates over them (finishSlide trims); a keyOf(args)
// resultCache serves a prefetched neighbor at press time and every commit
// prefetches the adjacent windows (silent failure).
//
// TASK-161 (design: tmp/tasks/tm-161/design_period_ui.md v2 §1): the window
// is an EXPLICIT absolute {from, to} range — the offset/anchor model is gone.
// The focus-move events decide the window's fate: E2a (the new month sits
// INSIDE the committed window) keeps the window untouched — no re-anchor, no
// re-fetch, the adjacent bars stay (the §0-2 bug); E2b (outside, distance
// k ≤ span) slides the MINIMUM k months over the union concatenation of the
// old and new windows' buckets; E2c (k > span) resets to the canonical
// window (right edge = the new month) in place, no slide; E3 (mode / ledger)
// resets to the canonical window and clears the cache; E4 (labelQuery) keeps
// the window and re-fetches under the new conditions. The all-zero floor is
// symmetric (the direction that paged into an all-zero window alone
// disables; the initial state has no move history so both stay enabled) and
// each commit prefetches the ±span pages both ways plus the ±1-month move
// windows (month mode — the E2b k=1 commit lands from cache).
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

/** one continuous slide (TASK-115 §3-1, TASK-161 §1-2): the concatenated
 *  old+new columns — the display array TrendBars receives while the viewport
 *  moves. bars is the UNION of the two windows' bucket keys (month-ascending,
 *  a duplicated key kept once — the keyed v-for reuses that DOM; both windows
 *  fetched the shared months under identical conditions so either result
 *  paints the same bars); axisWindows holds each window's own bucket keys in
 *  dir order (prev [new, old] / next [old, new]) so the axis thinning keeps
 *  the NEW window's own labels over the shared keys; moveCols is the slide's
 *  distance in columns (E1 pages by span, E2b by k). */
export interface SlideState {
  dir: 'prev' | 'next'
  bars: StackedBar[]
  axisWindows: string[][]
  moveCols: number
}

export interface TrendWindowState {
  /** the fetched window's result (null until the first response) */
  result: Ref<AnalysisTrendResult | null>
  /** the stacked columns for TrendBars: the slide's concatenation while a
   *  slide runs, the committed window's columns otherwise */
  stacked: ComputedRef<StackedBar[]>
  /** the charted absolute [from, to] (period.range while inactive) */
  window: Ref<[string, string]>
  /** the committed window's identity '<from>..<to>' — null until the first
   *  response: TrendBars' v-if gate (TASK-108) */
  windowKey: Ref<string | null>
  /** the trend granularity of the current window */
  granularity: ComputedRef<TrendGranularity>
  /** month/year only — the prev/next pair renders only while true */
  active: ComputedRef<boolean>
  /** false while the last window move paged into an all-zero window (prev) */
  canPrev: Ref<boolean>
  /** the mirrored floor for the next direction */
  canNext: Ref<boolean>
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

/** the calendar months between two 'YYYY-MM' bounds (inclusive) */
function monthsDiff(a: string, b: string): number {
  const ay = Number(a.slice(0, 4))
  const am = Number(a.slice(5, 7))
  const by = Number(b.slice(0, 4))
  const bm = Number(b.slice(5, 7))
  return by * 12 + bm - (ay * 12 + am)
}

export function useTrendWindow(opts: UseTrendWindowOptions): TrendWindowState {
  const api = useDataApi()
  const period = usePeriodStore()
  const session = useSessionStore()

  // shallow: the response is swapped whole and read only (a deep reactive
  // proxy would mask the raw response reference)
  const result = shallowRef<AnalysisTrendResult | null>(null)
  const loading = ref(false)
  const canPrev = ref(true)
  const canNext = ref(true)

  const active = computed(() => period.mode === 'month' || period.mode === 'year')
  /** the window's own width: month 6, year 12 (a chevron page never overlaps
   *  the one before it, TASK-108). week/range never page (active=false keeps
   *  the window at the selected period itself) */
  const span = computed(() => (period.mode === 'month' ? 6 : 12))
  /** TASK-161 §1: the explicit absolute window [from, to] — the offset/anchor
   *  model is gone. The canonical window's right edge is the selected month
   *  (month mode — offset-0 used to equal trendQuery(5), the no-regress
   *  guarantee) or the year's December (year mode, = period.range) */
  const window = ref<[string, string]>(['', ''])
  /** a fresh tuple copy of the selected period (the inactive modes' window —
   *  a plain destructure keeps the tuple type without a cast) */
  function rangePair(): [string, string] {
    const [f, t] = period.range
    return [f, t]
  }
  function canonicalWindow(): [string, string] {
    if (!active.value) return rangePair()
    if (period.mode === 'month') {
      return [`${shiftMonth(period.month, -(span.value - 1))}-01`, monthEnd(period.month)]
    }
    return [`${period.year}-01-01`, `${period.year}-12-31`]
  }
  const granularity = computed<TrendGranularity>(() =>
    active.value ? 'month' : trendGranularity(period.mode, window.value[0], window.value[1]),
  )
  /** the direction of the last window move ('prev' into the past / 'next'
   *  toward the future) — only the concatenation order reads it; E2a/E2c/E3
   *  leave it, a focus change swaps the window in place */
  const direction = ref<'prev' | 'next'>('prev')
  /** the floor's memory (TASK-161 §1-3): the direction of the last WINDOW
   *  MOVE (E1/E2b) — null after a canonical reset (E3/E2c), so the fresh
   *  initial state keeps both chevrons enabled */
  let lastMove: 'prev' | 'next' | null = null
  /** the committed window's identity '<from>..<to>' — a same-range refetch
   *  (labelQuery change, refresh) keeps it, so the window never slides for a
   *  recolour. null until the first response — TrendWindow renders no bars
   *  yet (v-if) */
  const windowKey = ref<string | null>(null)

  // --- TASK-115 §3-1: the continuous-window state ---
  /** the sliding concatenation — the display array while non-null */
  const slide = ref<SlideState | null>(null)
  /** only prev()/next() and an un-interrupted E2b raise it and only a commit
   *  consumes it (H1): the initial fetch, refresh(), the AxisDetail re-init,
   *  the E2a no-op, the E2c reset and a focus change that interrupted a
   *  running slide (the flush clears it) never assemble a slide */
  let slideRequest: 'prev' | 'next' | null = null
  /** window results keyed by keyOf(args) — the args (not '<from>..<to>')
   *  key the cache, so an AxisDetail subject or a label switch can never
   *  serve another condition's response for the same range */
  const resultCache = new Map<string, AnalysisTrendResult>()
  /** keys a prefetch already issued for: successes keep the key (never
   *  re-issued), failures drop it (retried on the next commit); the E3 flush
   *  clears the whole set so a return re-issues */
  const prefetchIssued = new Set<string>()

  const stacked = computed<StackedBar[]>(() => {
    if (slide.value) return slide.value.bars
    const res = result.value
    if (!res) return []
    return stackedOf(res)
  })

  /** the fetch args for an explicit window (§3-2 generalized): the display
   *  fetch and every prefetch read the very same conditions (granularity,
   *  labelQuery, axis, filters) — only the window differs */
  function buildArgsAt(w: [string, string]): { l: number; query: AnalysisTrendQuery } | null {
    // the old load() guard verbatim: an unresolved ledger or an invalid
    // period (a reversed range) fetches nothing
    const l = session.selectedLedgerId
    if (l === null || !period.valid) return null
    const extra = opts.filters?.()
    if (extra === undefined && opts.filters !== undefined) return null
    return {
      l,
      query: {
        axis: opts.axis(),
        metric: 'amount',
        granularity: active.value ? 'month' : trendGranularity(period.mode, w[0], w[1]),
        from: w[0],
        to: w[1],
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

  /** assemble the old+new union (§1-2): prev parks the new window before the
   *  old one, next appends it after — the month-ascending union keeps a
   *  duplicated key once (the keyed v-for reuses that bar's DOM; the shared
   *  months' values are identical under the same fetch conditions) */
  function assembleSlide(dir: 'prev' | 'next', newRes: AnalysisTrendResult, oldRes: AnalysisTrendResult, moveCols: number): void {
    const nb = stackedOf(newRes)
    const ob = stackedOf(oldRes)
    const seen = new Set<string>()
    const bars = (dir === 'prev' ? [...nb, ...ob] : [...ob, ...nb]).filter((b) => {
      if (seen.has(b.key)) return false
      seen.add(b.key)
      return true
    })
    slide.value = {
      dir,
      bars,
      axisWindows: dir === 'prev' ? [newRes.buckets, oldRes.buckets] : [oldRes.buckets, newRes.buckets],
      moveCols,
    }
  }

  /** the commit both fetch paths share: adopt the result, recompute the
   *  symmetric zero floor and consume a pending slideRequest — the union is
   *  assembled only when the request exists AND the committed window itself
   *  changed (a same-window refetch never slides) */
  function commit(a: { l: number; query: AnalysisTrendQuery }, res: AnalysisTrendResult, key: string): void {
    const prevKey = windowKey.value
    const oldRes = result.value
    result.value = res
    windowKey.value = `${a.query.from}..${a.query.to}`
    lastDone = key
    // the symmetric all-zero floor (§1-3): only the direction that MOVED into
    // an all-zero window disables; a canonical reset cleared the move memory
    // so a record-less initial window keeps both chevrons enabled
    const allZero = res.bucket_totals.reduce<number>((t, v) => t + (v ?? 0), 0) <= 0
    canPrev.value = !(allZero && lastMove === 'prev')
    canNext.value = !(allZero && lastMove === 'next')
    if (lastError !== null) {
      lastError = null
      opts.onError?.(null)
    }
    if (slideRequest !== null && prevKey !== windowKey.value && oldRes !== null && !reducedMotion()) {
      assembleSlide(slideRequest, res, oldRes, moveColsOf(oldRes, res))
    }
    slideRequest = null
  }

  /** the slide's distance in columns (§1-2): E1 pages by span (no shared
   *  months), E2b by k — the count of the new window's months the old window
   *  did not hold */
  function moveColsOf(oldRes: AnalysisTrendResult, newRes: AnalysisTrendResult): number {
    const oldKeys = new Set(oldRes.buckets)
    return newRes.buckets.filter((b) => !oldKeys.has(b)).length
  }

  /** shift the absolute window by k months (E1 pages by span, E2b by k);
   *  inactive modes just re-track the selected period */
  function shiftWindow(dir: 'prev' | 'next', k: number): void {
    if (!active.value) {
      window.value = rangePair()
      return
    }
    const d = dir === 'prev' ? -k : k
    const [f, t] = window.value
    window.value = [`${shiftMonth(f.slice(0, 7), d)}-01`, monthEnd(shiftMonth(t.slice(0, 7), d))]
  }

  /** prefetch one virtual window (§3-2 / §1-2): under the display fetch's
   *  very conditions. Issued only when no cache entry / display fetch /
   *  issued key matches; a failure is dropped silently (no onError, no
   *  loading) and its key leaves the issued set so a later commit whose
   *  target set includes the window retries it. The display state (seq /
   *  inFlight / lastDone / loading) is never touched. */
  async function prefetchAt(target: [string, string]): Promise<void> {
    const a = buildArgsAt(target)
    if (a === null) return
    const key = keyOf(a)
    if (resultCache.has(key) || key === inFlight || key === lastDone || prefetchIssued.has(key)) return
    prefetchIssued.add(key)
    try {
      const res = await api.getAnalysisTrend(a.l, a.query)
      // the await crossed an E3 flush when the key left prefetchIssued (the
      // flush clears the set): a stale-condition entry must not re-enter the
      // cleared cache — §5-1, the same window re-fetches after a flush
      if (prefetchIssued.has(key)) resultCache.set(key, res)
    } catch {
      prefetchIssued.delete(key)
    }
  }

  /** every commit prefetches around itself (§1-2): the ±span pages both ways
   *  (the E1 chevron targets) and, in month mode, the ±1-month move windows
   *  (the E2b k=1 lands from cache). Year mode skips the ±1 windows by
   *  GEOMETRY, not by preference: its focus is always a year's December, so
   *  a step from the canonical window is exactly k=span (a whole page) and
   *  from a paged window it overshoots into an E2c reset — a ±1-month move
   *  window is never the commit target there. week/range (active=false)
   *  never prefetch — the adjacent computation equals the display key
   *  itself. */
  function prefetchAround(): void {
    if (!active.value) return
    const [f, t] = window.value
    const fm = f.slice(0, 7)
    const tm = t.slice(0, 7)
    const targets: [string, string][] = [
      [`${shiftMonth(fm, -span.value)}-01`, monthEnd(shiftMonth(tm, -span.value))],
      [`${shiftMonth(fm, span.value)}-01`, monthEnd(shiftMonth(tm, span.value))],
    ]
    if (span.value <= 6) {
      targets.push([`${shiftMonth(fm, -1)}-01`, monthEnd(shiftMonth(tm, -1))])
      targets.push([`${shiftMonth(fm, 1)}-01`, monthEnd(shiftMonth(tm, 1))])
    }
    for (const t2 of targets) void prefetchAt(t2)
  }

  async function run(): Promise<void> {
    const a = buildArgsAt(window.value)
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
      prefetchAround()
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
        prefetchAround()
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

  // --- the focus-move / flush events (§1-1) --------------------------------
  // E3 (mode / ledger): the canonical window, the cache and the slide all
  // clear — a returning focus re-fetches everything. E4 (labelQuery): the
  // window stays (the cache too — the keyOf change guarantees the refetch),
  // any running slide trims and never re-assembles. E2 (a range change in
  // the same mode): E2a keeps everything, E2b slides the minimum, E2c resets
  // in place. sync: a mid-slide change must trim on the very same tick, and
  // the window must settle before the pages' own watchers reload.
  let prevMode = period.mode
  let prevFrom = period.range[0]
  let prevTo = period.range[1]
  let prevLabels = period.labelQuery
  let prevLedger = session.selectedLedgerId
  let first = true
  function e3Reset(): void {
    window.value = canonicalWindow()
    lastMove = null
    canPrev.value = true
    canNext.value = true
    resultCache.clear()
    prefetchIssued.clear()
    slide.value = null
    slideRequest = null
  }
  watch(
    [() => period.mode, () => period.range, () => period.labelQuery, () => session.selectedLedgerId],
    () => {
      const modeChanged = first || period.mode !== prevMode
      const ledgerChanged = session.selectedLedgerId !== prevLedger
      const labelsChanged = period.labelQuery !== prevLabels
      const rangeChanged = period.range[0] !== prevFrom || period.range[1] !== prevTo
      prevMode = period.mode
      prevFrom = period.range[0]
      prevTo = period.range[1]
      prevLabels = period.labelQuery
      prevLedger = session.selectedLedgerId
      first = false
      if (modeChanged || ledgerChanged) {
        // E3 (the immediate first run included): the canonical reset
        e3Reset()
        void run()
        return
      }
      if (labelsChanged) {
        // E4: the window (and the cache) stay; the refetch re-colours. The
        // move memory resets too (review PR#4 #4): a FAILED move left
        // lastMove standing without a commit, and this path's all-zero
        // commit would then floor a direction nothing paged into — a
        // non-move commit carries no move history
        slide.value = null
        slideRequest = null
        lastMove = null
        void run()
        return
      }
      if (rangeChanged) handleFocusMove()
    },
    { immediate: true, flush: 'sync' },
  )

  /** E2: a focus move inside the same mode (bar press / step / popover /
   *  URL jump — every path lands in the store) */
  function handleFocusMove(): void {
    if (!active.value) {
      // week / range: the window IS the selected period itself
      window.value = rangePair()
      void run()
      return
    }
    const focus = period.mode === 'month' ? period.month : `${period.year}-12`
    const fromM = window.value[0].slice(0, 7)
    const toM = window.value[1].slice(0, 7)
    if (focus >= fromM && focus <= toM) {
      // E2a: the new month sits inside the committed window — the window
      // does not move, nothing re-fetches; only the highlight walks. A
      // running slide trims on the tick (the flush contract)
      slide.value = null
      slideRequest = null
      return
    }
    const dir: 'prev' | 'next' = focus > toM ? 'next' : 'prev'
    const k = dir === 'next' ? monthsDiff(toM, focus) : monthsDiff(focus, fromM)
    // a focus change that interrupts a running slide trims and swaps in
    // place — the interrupted state never re-assembles (the TASK-115 flush
    // contract carried over)
    const interrupted = slide.value !== null
    slide.value = null
    direction.value = dir
    if (k > span.value) {
      // E2c: a far jump (URL direct link / a popover jump) resets to the
      // canonical window in place — no slide, the refetch dims the old one
      window.value = canonicalWindow()
      lastMove = null
      slideRequest = null
      void run()
      return
    }
    // E2b: the minimal k-month slide — the window moves so the new month
    // enters at the near edge
    lastMove = dir
    slideRequest = interrupted ? null : dir
    shiftWindow(dir, k)
    void run()
  }

  function moveBy(dir: 'prev' | 'next', k: number): void {
    // §3-3 連打: a re-press while the slide still runs takes priority over
    // the floor guard — trim at once and move (slide=null keeps the guard: a
    // disable-state press never moves the window)
    direction.value = dir
    lastMove = dir
    slideRequest = dir
    // a slide still in progress trims at once: the press restarts from the
    // committed window (cache miss: keep the old window + fetch; hit: immediate assembly)
    if (slide.value !== null) slide.value = null
    shiftWindow(dir, k)
    void run()
  }
  function prev(): void {
    if (slide.value === null && !canPrev.value) return
    moveBy('prev', span.value)
  }
  function next(): void {
    if (slide.value === null && !canNext.value) return
    moveBy('next', span.value)
  }
  /** TASK-161 §1-4 (review 中4): the EXPLICIT invalidation — the result
   *  cache and the issued set drop and the display window re-fetches (the
   *  lastDone leg of the idempotency guard is spent, so a completed window
   *  really goes to the network again; a prefetched page re-prefetches on
   *  its next commit). A fetch whose identical args are still IN FLIGHT
   *  stays skipped — that leg is the double-fire suppression (AxisDetail's
   *  composable watch and route watch collapse into one fetch), a seq-level
   *  concern, never a cache decision. The E3 flush (mode / ledger) remains
   *  the other cache-clearing path. */
  function refresh(): void {
    resultCache.clear()
    prefetchIssued.clear()
    lastDone = null
    // same move-memory reset as E4 (review PR#4 #4): a refresh commit is
    // not a window move — a failed move's leftover lastMove must not floor
    // a chevron off the re-fetched all-zero result
    lastMove = null
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
