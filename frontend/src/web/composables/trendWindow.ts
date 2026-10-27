// The trend chart's movable window (TASK-104, design: tmp/tasks/tm-104/
// design_trend-window.md): the offset/window state, the trend fetch and the
// stacked assembly live in this one composable shared by the four trend
// screens (Home / Categories / Stores / AxisDetail). month/year page their
// window by its own width (month 6 / year 12 months — TASK-108: a page never
// overlaps the one before it) per prev press without touching the focus (the
// period store); week/range keep the selected period itself. The window is
// ephemeral: mode/range/labelQuery/ledger changes reset it to the initial one
// (offset=0). TASK-108 adds the committed window's identity (windowKey) and
// the direction record: the window swap slides (direction-named transition)
// only when the committed range itself changes — a same-window refetch
// (labelQuery, refresh) and the very first insertion never slide.
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import { useDataApi, type AnalysisAxis, type AnalysisFilters, type AnalysisTrendQuery, type AnalysisTrendResult } from '../api/data'
import type { StackedBar } from '../components/TrendBars.vue'
import { errorMessage } from './format'
import { monthEnd, shiftMonth } from './period'
import { trendGranularity, type TrendGranularity } from './trend'
import { SERIES_REST, seriesColor } from '../lib/seriesColor'
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

export interface TrendWindowState {
  /** the fetched window's result (null until the first response) */
  result: Ref<AnalysisTrendResult | null>
  /** the stacked columns for TrendBars: top-5 series + the grey rest segment */
  stacked: ComputedRef<StackedBar[]>
  /** the charted [from, to] (offset applied; period.range while inactive) */
  window: ComputedRef<[string, string]>
  /** the committed window's identity '<from>..<to>' — null until the first
   *  response: TrendBars' v-if gate and the slide transition key (TASK-108) */
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
  /** the direction of the last window move — the transitionName source
   *  (TASK-108: focus changes inherit the last recorded direction) */
  direction: Ref<'prev' | 'next'>
  /** '' until the first window has painted, then the direction's slide name */
  transitionName: ComputedRef<string>
  loading: Ref<boolean>
  prev(): void
  next(): void
  refresh(): void
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
  const window = computed<[string, string]>(() => {
    if (!active.value) return period.range
    // the anchor is the window's RIGHT edge: the selected month, or the
    // year's December (offset=0 equals trendQuery(5) / period.range — the
    // no-regress guarantee of §1)
    const anchor = period.mode === 'month' ? period.month : `${period.year}-12`
    const right = shiftMonth(anchor, -offset.value)
    const left = shiftMonth(anchor, -(offset.value + span.value - 1))
    return [`${left}-01`, monthEnd(right)]
  })
  const granularity = computed(() =>
    active.value ? 'month' : trendGranularity(period.mode, window.value[0], window.value[1]),
  )
  const canNext = computed(() => offset.value > 0)
  /** the direction of the last window move ('prev' into the past / 'next'
   *  back toward the initial window) — the transitionName source (§1-3).
   *  Focus changes (month chip, bar press, label/ledger switch) inherit the
   *  last recorded direction: their entry points are too varied to define a
   *  direction of their own */
  const direction = ref<'prev' | 'next'>('prev')
  /** the committed window's identity '<from>..<to>' — the slide fires only
   *  when this changes: a same-range refetch (labelQuery change, refresh)
   *  keeps it, so the bars never slide for a recolour of the same window.
   *  null until the first response — TrendWindow renders no bars yet (v-if) */
  const windowKey = ref<string | null>(null)
  /** false until the first window has been painted — the very first v-if
   *  insertion must not slide (Vue runs an enter transition on a v-if
   *  insertion even without appear); every later window swap slides */
  const slideReady = ref(false)
  watch(windowKey, (_nv, ov) => {
    if (ov !== null) slideReady.value = true
  })
  /** '' = no transition classes (instant paint) until after the first insert */
  const transitionName = computed(() =>
    slideReady.value ? (direction.value === 'prev' ? 'trend-slide-back' : 'trend-slide-forward') : '',
  )

  const stacked = computed<StackedBar[]>(() => {
    const res = result.value
    if (!res) return []
    const axis = opts.axis()
    const top = res.series.slice(0, 5)
    return res.buckets.map((b, i) => {
      const rest = Math.max((res.bucket_totals[i] ?? 0) - top.reduce((a, s) => a + (s.values[i] ?? 0), 0), 0)
      return {
        key: b,
        title: b,
        total: res.bucket_totals[i] ?? 0,
        segments: [
          // TASK-105: the segment color is the deterministic seriesColor of
          // the series key (the same color the ranked rows paint), the
          // residual「ほか」the fixed rest tone. Value-0 series segments are
          // omitted from the assembly — with the 1px segment borders a 0
          // height element would stack a stray line
          ...top
            .filter((s) => (s.values[i] ?? 0) > 0)
            .map((s) => ({ label: s.label, value: s.values[i] ?? 0, color: seriesColor(s.key, axis) })),
          ...(rest > 0 ? [{ label: 'ほか', value: rest, color: SERIES_REST }] : []),
        ],
      }
    })
  })

  function buildArgs(): { l: number; query: AnalysisTrendQuery } | null {
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
        granularity: granularity.value,
        from: window.value[0],
        to: window.value[1],
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

  async function run(): Promise<void> {
    const a = buildArgs()
    if (a === null) return
    const key = keyOf(a)
    if (key === inFlight) return
    if (key === lastDone) {
      // returning to the cached window must still invalidate a pending
      // fetch for other args (prev pressed, then next before the response
      // lands): the plain early return leaves seq untouched, so the stale
      // response passes the sequence check and replaces the cached chart.
      // Bump seq past it and take over the cleanup its finally would have
      // done — loading off, inFlight clear (PR#1 P2)
      if (inFlight !== null) {
        seq++
        inFlight = null
        loading.value = false
      }
      return
    }
    inFlight = key
    loading.value = true
    const n = ++seq
    try {
      const res = await api.getAnalysisTrend(a.l, a.query)
      if (n === seq) {
        result.value = res
        // the committed identity swaps with the result itself (label_colors
        // never in it): the slide fires only on a committed range change
        windowKey.value = `${a.query.from}..${a.query.to}`
        lastDone = key
        if (lastError !== null) {
          lastError = null
          opts.onError?.(null)
        }
        // the all-zero floor applies to slid-to windows only: an all-zero
        // initial window must keep prev available (a record-less month still
        // needs the months before it)
        canPrev.value = offset.value >= 1 ? res.bucket_totals.reduce<number>((t, v) => t + (v ?? 0), 0) > 0 : true
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
  // flight): TrendBars keeps drawing the old window until the response lands
  watch(
    [() => period.mode, () => period.range, () => period.labelQuery, () => session.selectedLedgerId],
    () => {
      offset.value = 0
      canPrev.value = true
      void run()
    },
    { immediate: true },
  )

  function prev(): void {
    if (!canPrev.value) return
    direction.value = 'prev'
    offset.value += span.value
    void run()
  }
  function next(): void {
    if (offset.value <= 0) return
    direction.value = 'next'
    offset.value = Math.max(0, offset.value - span.value)
    void run()
  }
  function refresh(): void {
    void run()
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
    transitionName,
    loading,
    prev,
    next,
    refresh,
  }
}
