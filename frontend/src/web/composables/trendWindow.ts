// The trend chart's movable window (TASK-104, design: tmp/tasks/tm-104/
// design_trend-window.md): the offset/window state, the trend fetch and the
// stacked assembly live in this one composable shared by the four trend
// screens (Home / Categories / Stores / AxisDetail). month/year slide their
// window one bucket (a month) into the past per prev press without touching
// the focus (the period store); week/range keep the selected period itself.
// The window is ephemeral: mode/range/labelQuery/ledger changes reset it to
// the initial one (offset=0).
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import { useDataApi, type AnalysisAxis, type AnalysisFilters, type AnalysisTrendQuery, type AnalysisTrendResult } from '../api/data'
import type { StackedBar } from '../components/TrendBars.vue'
import { errorMessage } from './format'
import { monthEnd, shiftMonth } from './period'
import { trendGranularity, type TrendGranularity } from './trend'
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
  /** the trend granularity of the current window */
  granularity: ComputedRef<TrendGranularity>
  /** month/year only — the prev/next pair renders only while true */
  active: ComputedRef<boolean>
  offset: Ref<number>
  /** false while the last fetched window (offset>=1) was all-zero */
  canPrev: Ref<boolean>
  /** offset > 0 */
  canNext: ComputedRef<boolean>
  loading: Ref<boolean>
  prev(): void
  next(): void
  refresh(): void
}

/** the segment palette of the top-5 series (the one place a stable
 *  series-color mapping would land) */
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)']

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
  const window = computed<[string, string]>(() => {
    if (!active.value) return period.range
    // the anchor is the window's RIGHT edge: the selected month, or the
    // year's December (offset=0 equals trendQuery(5) / period.range — the
    // no-regress guarantee of §1)
    const anchor = period.mode === 'month' ? period.month : `${period.year}-12`
    const span = period.mode === 'month' ? 6 : 12
    const right = shiftMonth(anchor, -offset.value)
    const left = shiftMonth(anchor, -(offset.value + span - 1))
    return [`${left}-01`, monthEnd(right)]
  })
  const granularity = computed(() =>
    active.value ? 'month' : trendGranularity(period.mode, window.value[0], window.value[1]),
  )
  const canNext = computed(() => offset.value > 0)

  const stacked = computed<StackedBar[]>(() => {
    const res = result.value
    if (!res) return []
    const top = res.series.slice(0, 5)
    return res.buckets.map((b, i) => {
      const rest = Math.max((res.bucket_totals[i] ?? 0) - top.reduce((a, s) => a + (s.values[i] ?? 0), 0), 0)
      return {
        key: b,
        title: b,
        total: res.bucket_totals[i] ?? 0,
        segments: [
          ...top.map((s, si) => ({ label: s.label, value: s.values[i] ?? 0, color: PALETTE[si] ?? 'var(--c-rest)' })),
          ...(rest > 0 ? [{ label: 'ほか', value: rest, color: 'var(--c-rest)' }] : []),
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
    if (key === inFlight || key === lastDone) return
    inFlight = key
    loading.value = true
    const n = ++seq
    try {
      const res = await api.getAnalysisTrend(a.l, a.query)
      if (n === seq) {
        result.value = res
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
  // reference comparison — the range computed always returns a fresh array)
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
    offset.value++
    void run()
  }
  function next(): void {
    if (offset.value <= 0) return
    offset.value--
    void run()
  }
  function refresh(): void {
    void run()
  }

  return { result, stacked, window, granularity, active, offset, canPrev, canNext, loading, prev, next, refresh }
}
