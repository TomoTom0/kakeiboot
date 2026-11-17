// TASK-104 (design: tmp/tasks/tm-104/design_trend-window.md §1〜§8): the
// trend chart's prev/next window pair. The window state (offset / window /
// granularity / active / canPrev / canNext), the trend fetch and the stacked
// assembly all live in the useTrendWindow composable shared by the four
// screens (Home / Categories / Stores / AxisDetail); TrendWindow.vue wraps
// TrendBars with the chevron pair. Written test-first: the composable and
// the component do not exist yet, so this file is red until the
// implementation lands. The page mounts then pin the wiring — a window move
// re-fetches the trend endpoint only (the breakdown / recent and the
// TASK-103 week fetch stay in load()).
//
// TASK-108 page-turn revision (design: tmp/tasks/tm-108/
// design_trend-window-page.md §4): prev/next step the window by its own
// width (month 6 / year 12 — a page never overlaps the one before), next
// clamps the offset to 0 in one press, and the committed window's identity
// (windowKey, '<from>..<to>') gates the bars' v-if and keys the slide
// transition (direction / transitionName — the first insertion and a
// same-window refetch never slide). Test-first again: the page-turn
// expectations and the windowKey/direction/transitionName tests are red
// until the composable / component revisions land.
//
// TASK-115 continuous-window revision (design: tmp/tasks/tm-115/
// design_trend-continuous-window.md v3 §3-§5): the window move becomes ONE
// graph whose viewport slides — the old and new windows' buckets are
// concatenated (prev [new, old] / next [old, new], slide.dir + axisWindows)
// and translated, trimmed on transitionend (finishSlide); a keyOf(args)
// resultCache serves prev/next without a display fetch, each commit
// prefetches the prev-adjacent window (silent failure, issued-set keeps
// successes only), and flush (mode/range/labelQuery/ledger) clears it all.
// transitionName / slideReady are gone; a focus change never slides anymore.
// Every fetch-count assertion now separates the display fetch from the
// prefetch by the query's `from` (the mock gates below only gate the display
// window's from, so an in-flight prefetch never sticks in the gate).
// Test-first again: the cache / prefetch / slide expectations are red until
// the composable / component revisions land.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TrendWindow from '@/web/components/TrendWindow.vue'
import TrendBars from '@/web/components/TrendBars.vue'
import type { StackedBar } from '@/web/components/TrendBars.vue'
// TASK-162 landed: the series-key / labelMin / stackedOfRows contracts live
// in shared/lib/stackedBars.ts now (the test-first module augmentation that
// typed them before the implementation is gone)
import { allocateStack, stackedOf, stackedOfRows, type StackedSegment } from '@/shared/lib/stackedBars'
import { setDataApi, type AnalysisAxis, type AnalysisTrendQuery, type AnalysisTrendResult, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { useTrendWindow } from '@/web/composables/trendWindow'
import { axisMonthLabels } from '@/web/composables/period'
import { usePeriodStore } from '@/web/stores/period'
import { useSessionStore } from '@/web/stores/session'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

/** A composable bound to the active pinia's stores with ledger 1 selected. */
async function mountWindow(axis: () => AnalysisAxis = () => 'category') {
  const win = useTrendWindow({ axis })
  useSessionStore().selectedLedgerId = 1
  await settle()
  return win
}

/** The calendar months 'YYYY-MM' covering [from, to] inclusive — the
 * page-turn no-overlap proof reads the computed windows, not literals. */
function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.slice(0, 7).split('-').map(Number) as [number, number]
  const [ty, tm] = to.slice(0, 7).split('-').map(Number) as [number, number]
  const months: string[] = []
  for (let t = fy * 12 + fm - 1, end = ty * 12 + tm - 1; t <= end; t++) {
    months.push(`${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`)
  }
  return months
}

/** Calls of a getAnalysisTrend spy whose query.from matches — TASK-115: the
 * display fetch and the commit's prefetch share every condition but the
 * window, so counting by from (and l where ledgers mix) is how the tests
 * tell "the window was re-fetched" from "the adjacent window was
 * prefetched" (design §5-1). */
interface TrendSpy {
  mock: { calls: [number, AnalysisTrendQuery][] }
}
const callsFrom = (spy: TrendSpy, l: number, from: string) => spy.mock.calls.filter(([al, q]) => al === l && q.from === from)

describe('useTrendWindow (composable, TASK-104)', () => {
  it('[covers:web-home.trend-window] 窓計算: month初期窓はtrendQuery(5)と一致・prevでoffset=6の丸ごとページ送り（前ページと月の重複なし）・yearは12か月でperiod.rangeと一致（anchor右端12月）・prevでoffset=12・week/rangeは選択期間のまま', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    // month offset=0: the no-regress initial window (trendQuery(5) itself)
    const q = period.trendQuery(5)
    expect(win.window.value).toEqual([q.from, q.to])
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    expect(win.active.value).toBe(true)
    expect(win.granularity.value).toBe('month')
    expect(trendSpy).toHaveBeenCalledWith(1, {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2026-05-01',
      to: '2026-10-31',
      limit: 5,
    })
    // TASK-115: the initial display fetch is exactly one call, and the commit
    // prefetches the prev-adjacent window (2025-11..2026-04) under the very
    // same conditions — counted by from, never re-issued
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')[0]![1]).toMatchObject({
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      to: '2026-04-30',
      limit: 5,
    })
    // TASK-108: prev turns the whole page — the absolute window swaps to
    // 2025-11..2026-04 (TASK-161: the window IS the {from, to} pair now, the
    // offset model is gone), sharing no month with the page before
    const initialMonths = monthsBetween(win.window.value[0], win.window.value[1])
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(
      initialMonths.filter((m) => monthsBetween(win.window.value[0], win.window.value[1]).includes(m)),
      'a page never overlaps the one before it',
    ).toEqual([])
    // the paged-to window was prefetched, so the press is a cache hit: no
    // re-fetch of 2025-11 — the only new call is the NEXT adjacent prefetch
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'the prefetched window is not re-fetched').toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-05-01')).toHaveLength(1)
    // year mode: the canonical window is the year itself (the December
    // right-edge rule — equals period.range, the v2 REVIEW-21 no-regress
    // guarantee)
    period.mode = 'year'
    await settle()
    expect(win.window.value).toEqual(period.range)
    expect(win.window.value).toEqual(['2026-01-01', '2026-12-31'])
    expect(callsFrom(trendSpy, 1, '2026-01-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-01-01')).toHaveLength(1) // the year window's prev-adjacent prefetch
    const initialYearMonths = monthsBetween(win.window.value[0], win.window.value[1])
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-01-01', '2025-12-31'])
    expect(initialYearMonths.filter((m) => monthsBetween(win.window.value[0], win.window.value[1]).includes(m))).toEqual(
      [],
    )
    expect(callsFrom(trendSpy, 1, '2025-01-01')).toHaveLength(1) // cache hit, no re-fetch
    expect(callsFrom(trendSpy, 1, '2024-01-01')).toHaveLength(1) // the next year-page prefetch
    // week / range: inactive — the window stays the selected period itself
    period.setWeek('2026-10-05')
    await settle()
    expect(win.active.value).toBe(false)
    expect(win.window.value).toEqual(['2026-10-05', '2026-10-11'])
    expect(win.granularity.value).toBe('day')
    // inactive windows never page: the adjacent computation is the same key
    // as the display one, so no prefetch call duplicates the week fetch
    expect(trendSpy.mock.calls.filter(([, q]) => q.granularity === 'day' && q.from === '2026-10-05')).toHaveLength(1)
    period.fromQuery({ from: '2026-10-03', to: '2026-10-15' })
    await settle()
    expect(win.active.value).toBe(false)
    expect(win.window.value).toEqual(['2026-10-03', '2026-10-15'])
  })

  it('[covers:web-home.trend-window] 窓移動の対称性: 初期状態はprev/nextとも有効（絶対窓で未来pagingも解禁）・prev→nextで一発復帰・focus移動（E2a）は窓保持・label変更（E4）は窓保持で再fetch・家計簿切替（E3）は正規窓へ', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    // TASK-161 §1-3: the symmetric all-zero floor — no move history keeps
    // BOTH directions open (the old canNext = offset > 0 pinned the initial
    // window's next shut forever — half of the §0-2 lead closing)
    expect(win.canNext.value).toBe(true)
    expect(win.canPrev.value).toBe(true)
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.canNext.value).toBe(true)
    // TASK-115: the press hit the prefetched cache — the window itself was
    // not re-fetched (only the next adjacent prefetch appears)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    win.next()
    await settle()
    // one press pays the whole span back: the window returns to the initial
    // one directly (the page-turn contract, TASK-108 §1-2)
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1) // the cache return never re-fetches
    win.prev()
    await settle()
    // E2a (TASK-161 §1): a focus move INSIDE the committed window keeps the
    // window — no re-anchor, no re-fetch, the adjacent bars stay
    period.setMonth('2026-01')
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    // E4: a label change keeps the window and re-fetches under the new
    // conditions (the args-keyed cache never serves another condition)
    period.setLabelColors(['red'])
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(callsFrom(trendSpy, 1, '2025-11-01').at(-1)![1]).toMatchObject({ label_colors: ['red'] })
    // E3: a ledger switch resets to the canonical window (right edge = the
    // selected month — January here) and fetches the new ledger
    useSessionStore().selectedLedgerId = 2
    await settle()
    expect(win.window.value).toEqual(['2025-08-01', '2026-01-31'])
    expect(callsFrom(trendSpy, 2, '2025-08-01').at(-1)![1]).toMatchObject({ from: '2025-08-01', to: '2026-01-31' })
  })

  it('[covers:web-home.trend-window] refreshは明示無効化（cache clear+再fetch）: 完了済み同引数は再発行するが進行中の同一引数だけskip（AxisDetailの二重発火は1 fetch）', async () => {
    // bind the real method before the spy: the in-flight gate below calls it
    const orig = api.getAnalysisTrend.bind(api)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    // TASK-161 §1-4 (review 中4): an explicit refresh INVALIDATES — the same
    // args as the last successful fetch re-issue (the lastDone guard is the
    // double-fire suppression for IN-FLIGHT args alone now, and the cleared
    // cache makes the refreshed commit re-prefetch its pages)
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(2)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(2) // the ±span prev re-prefetched
    // while a fetch is in flight, the identical re-fire is skipped —
    // AxisDetail's route watch fires alongside the composable's own watch.
    // TASK-115: the gate lets ONLY the display window's from through it —
    // the commit's prefetch (a different from) must never stick in the gate
    // (design §5-1). TASK-161: the focus move is a k=2 E2b (setMonth
    // 2026-12 from the initial window → 2026-07..12 — an E2a inside move
    // would fetch nothing at all)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (args[1]!.from === '2026-07-01') await gate
      return orig(...args)
    })
    usePeriodStore().setMonth('2026-12')
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-07-01')).toHaveLength(1) // the new window's fetch, in flight
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-07-01')).toHaveLength(1) // identical to the in-flight args
    release()
    await settle()
    // the gated display commit landed; its prefetch of the ±span prev window
    // (2026-01..06) went through ungated — counted by from, exactly once
    expect(callsFrom(trendSpy, 1, '2026-07-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2026-01-01')).toHaveLength(1)
    // completed now: another explicit refresh invalidates and re-issues
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-07-01')).toHaveLength(2)
  })

  it('[covers:web-home.trend-window] ledger未確定（selectedLedgerId=null）ではfetchしない（prefetchもしない）・確定（null→id）で初回fetch+隣接窓prefetch', async () => {
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = useTrendWindow({ axis: () => 'category' })
    await settle() // the immediate watch already fired with no ledger
    expect(trendSpy).not.toHaveBeenCalled()
    expect(win.result.value).toBeNull()
    useSessionStore().selectedLedgerId = 1
    await settle()
    // TASK-115 + TASK-161 §1-2: the first commit brings the display fetch
    // AND its prefetches around the window — the ±span pages both ways plus
    // the ±1-month move windows (month mode) — five calls, one window each
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    expect(trendSpy).toHaveBeenCalledTimes(5)
  })

  it('[covers:web-home.trend-window-slide] windowKey・direction・slide: 初回fetchまでkey=null（TrendBarsのv-if源）・確定でkeyは<from>..<to>と即時描画（slide不発火）・同窓再fetchでkey不変・prev/nextは方向別slide・focus変更はslideなし・連打は最終窓のみ採用・nextはspan未満offsetを0へクランプ', async () => {
    const period = usePeriodStore()
    // bind the real method before the spy: the in-flight gate below calls it
    const orig = api.getAnalysisTrend.bind(api)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = useTrendWindow({ axis: () => 'category' })
    // before the first response the committed window is null (the v-if gate
    // source) and no slide state exists — nothing has been painted yet
    expect(win.windowKey.value).toBe(null)
    expect(win.slide.value).toBeNull()
    useSessionStore().selectedLedgerId = 1
    await settle()
    // the first commit is the range identity (label_colors never in it) and
    // the very first insertion paints instantly: no slide — the first commit
    // carries no slideRequest (TASK-115 §3-1 H1: 初回コミットは除外)
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.slide.value).toBeNull()
    // a same-window refetch (label_colors added) really re-fetches but keeps
    // the key: a recolour of the same window never slides (windowKey 不変)
    period.setLabelColors(['red'])
    await settle()
    expect(trendSpy).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.slide.value).toBeNull()
    // drop the label again so the prefetch cache of the plain windows stays
    // in play for the presses below
    period.setLabelColors([])
    await settle()
    // prev: the direction is recorded and the press commits the prefetched
    // window at once — the slide state is a dir='prev' concatenation whose
    // display order is [new window, old window]
    win.prev()
    await settle()
    expect(win.direction.value).toBe('prev')
    expect(win.windowKey.value).toBe('2025-11-01..2026-04-30')
    expect(win.slide.value?.dir).toBe('prev')
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2025-11-01', '2026-04-30'),
      ...monthsBetween('2026-05-01', '2026-10-31'),
    ])
    win.finishSlide()
    // next: the mirrored direction — [old window, new window]
    win.next()
    await settle()
    expect(win.direction.value).toBe('next')
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.slide.value?.dir).toBe('next')
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2025-11-01', '2026-04-30'),
      ...monthsBetween('2026-05-01', '2026-10-31'),
    ])
    win.finishSlide()
    // the guard records no direction and fires no fetch (a disable-state
    // press never moves the window — the §1-2 contract). TASK-161: the floor
    // is the symmetric zero rule, so the disable state is staged through the
    // ref the chevron reads
    const calls = trendSpy.mock.calls.length
    win.canPrev.value = false
    win.prev()
    win.canPrev.value = true
    await settle()
    expect(win.direction.value).toBe('next')
    expect(trendSpy.mock.calls.length).toBe(calls)
    // a far focus change mid-fetch keeps the OLD key until the response
    // lands (the bars never leave the last committed window) — and when it
    // lands the commit does NOT assemble a slide: the E2c reset cleared the
    // request (TASK-115 M1's focus rule carried over: only an un-interrupted
    // E2b ever slides)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (args[1]!.from === '2027-01-01') await gate // only the display window gates
      return orig(...args)
    })
    period.setMonth('2027-06')
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    release()
    await settle()
    expect(win.windowKey.value).toBe('2027-01-01..2027-06-30')
    expect(win.slide.value).toBeNull()
    // a double prev fires two fetches; the seq guard keeps only the last —
    // the committed key is the second page back (2027-01..06 → 2026-07..12
    // → 2026-01..06), swapped in once. The finished slide is the LAST
    // press's union
    win.prev()
    win.prev()
    await settle()
    expect(win.windowKey.value).toBe('2026-01-01..2026-06-30')
    expect(win.slide.value?.dir).toBe('prev')
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2026-01-01', '2026-06-30'),
      ...monthsBetween('2026-07-01', '2026-12-31'),
    ])
    win.finishSlide()
  })

  // TASK-105 (web-home.trend-window description revised — the window /
  // offset / fetch expectations above and below stay untouched, design
  // §4-1): the stacked assembly reads `seriesColor(s.key, axis)` instead of
  // the old PALETTE array. TASK-123 (design §4-1 / §4-5,
  // web-common.stack-dimension-rules): the assembly is top-3 + the residual
  // 「ほか」now — the fetch stays limit=5 (the contract) and the FRONTEND
  // slices to the top 3, so ranks 4-5 fold into「ほか」; a sub-5%-of-bucket
  // segment folds into「ほか」per bucket as well. The PALETTE constant
  // itself is gone from trendWindow.ts (TASK-105, unchanged).
  it('[covers:web-home.trend-window][covers:web-common.stack-dimension-rules] stacked組立はcomposable集約: series上位3+残余「ほか」（4-5位と5%未満はbucket毎に合算・fetch limit=5は不変）+色はseriesColor写像（残余は--series-rest・値0セグメント省略・ゼロ窓は残余なし）', async () => {
    // seven series in the endpoint's total order (the fetch keeps returning
    // the top-5 contract shape): the top THREE keep their seriesColor slot,
    // the rest folds into the grey rest segment.
    // bucket 2026-05: s0..s2 = 70/60/50 (all >= 5% of 280) stay, ranks 4-7
    //   (40+30+20+10) fold into「ほか」100
    // bucket 2026-06: all zero -> no segment at all
    // bucket 2026-07: total 74; s2=3 is 4.1% < 5% -> folds into「ほか」
    //   (74-70=4), leaving [s0 40, s1 30, ほか 4]
    const vals = (v: number[]): (number | null)[] => v
    const res: AnalysisTrendResult = {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      period: { from: '2026-05-01', to: '2026-10-31', label: '' },
      buckets: ['2026-05', '2026-06', '2026-07'],
      series: [
        { key: 0, label: 's0', values: vals([70, 0, 40]), total: 110 },
        { key: 1, label: 's1', values: vals([60, 0, 30]), total: 90 },
        { key: 2, label: 's2', values: vals([50, 0, 3]), total: 53 },
        { key: 3, label: 's3', values: vals([40, 0, 0]), total: 40 },
        { key: 4, label: 's4', values: vals([30, 0, 0]), total: 30 },
        { key: 5, label: 's5', values: vals([20, 0, 0.5]), total: 20.5 },
        { key: 6, label: 's6', values: vals([10, 0, 0.5]), total: 10.5 },
      ],
      bucket_totals: [280, 0, 74],
      truncated_rows: 0,
    }
    vi.spyOn(api, 'getAnalysisTrend').mockResolvedValue(res)
    const win = await mountWindow()
    expect(win.result.value).toBe(res)
    type Seg = StackedBar['segments'][number]
    expect(win.stacked.value.map((c: StackedBar) => c.key)).toEqual(['2026-05', '2026-06', '2026-07'])
    // top-3 +「ほか」: ranks 4-7 (100) fold into the rest segment
    const segs = win.stacked.value[0]!.segments
    expect(segs.map((s: Seg) => s.label)).toEqual(['s0', 's1', 's2', 'ほか'])
    expect(segs.map((s: Seg) => s.color)).toEqual([
      'var(--series-7)', // key 0: ((0-1) mod 7 + 7) % 7 = 6
      'var(--series-1)',
      'var(--series-2)',
      'var(--series-rest)',
    ])
    expect(segs.at(-1)!.value).toBe(100)
    // a sub-5% top-3 member folds into「ほか」in ITS bucket only: s2=3 of
    // the 74 total (4.1%) joins the residual (4), the other buckets keep it
    const fold = win.stacked.value[2]!.segments
    expect(fold.map((s: Seg) => s.label)).toEqual(['s0', 's1', 'ほか'])
    expect(fold.map((s: Seg) => s.value)).toEqual([40, 30, 4])
    // a zero bucket renders no segment at all: every top series holds 0 and
    // the omitted value-0 assembly leaves the column empty (no rest either)
    expect(win.stacked.value[1]!.segments.map((s: Seg) => s.label)).toEqual([])
  })

  // TASK-123 (design §4-5, web-common.stack-dimension-rules): the dimension
  // allocation as ONE pure function the four stack sites render — written
  // test-first, the contract IS this test (frontend/src/shared/lib/
  // stackedBars.ts gains `allocateStack(segments, length)` alongside
  // stackedOf; `length` is the bar's full allocation size — px for the web
  // bars/rows, viewBox units for the widget). Rules: A (the full length
  // splits by value ratio, no gap subtraction), B (an allocated size below
  // the outline-inclusive minimum 3 folds into「ほか」smallest-first and the
  // remainder is re-split), C (while min x N still exceeds the length, fold
  // the smallest non-「ほか」segment; if even one series +「ほか」does not
  // fit, draw the FIRST series alone as the single-color bar), F (a bar
  // shorter than 3 itself keeps the data-ratio outline and drops the
  // outline — fill only).
  it('[covers:web-common.stack-dimension-rules] allocateStack: 規則A（全寸法を値比率配分・合計=length）・規則B（最小寸法3未満はほかへ合算）・規則C（段階的合算→第一系列単色）・規則F（bar全体3未満は縁取りなし）', () => {
    const seg = (label: string, value: number, color = `var(--series-${label})`) => ({ label, value, color })
    // (a) rule A — the plain ratio split: sizes follow the values and close
    // over the full length exactly
    const plain = allocateStack([seg('a', 60), seg('b', 30), { ...seg('ほか', 10, 'var(--series-rest)') }], 100)
    expect(plain.map((s) => s.label)).toEqual(['a', 'b', 'ほか'])
    expect(plain.map((s) => s.size)).toEqual([60, 30, 10])
    expect(plain.reduce((a, s) => a + s.size, 0)).toBe(100)
    expect(plain.every((s) => s.outline)).toBe(true)
    // (b) rule B — the sub-minimum segments (c 2px, ほか 1px of 100) fold
    // into「ほか」smallest-first; the survivors all clear the 3px minimum
    const folded = allocateStack([seg('a', 70), seg('b', 27), seg('c', 2), { ...seg('ほか', 1, 'var(--series-rest)') }], 100)
    expect(folded.map((s) => s.label)).toEqual(['a', 'b', 'ほか'])
    expect(folded.map((s) => s.value)).toEqual([70, 27, 3])
    expect(folded.map((s) => s.size)).toEqual([70, 27, 3])
    // (c) rule C — min 3 x 4 = 12 exceeds the 10px bar: the smallest
    // non-「ほか」(c 20) folds into「ほか」and the three survivors fit
    const tight = allocateStack([seg('a', 40), seg('b', 30), seg('c', 20), { ...seg('ほか', 10, 'var(--series-rest)') }], 10)
    expect(tight.map((s) => s.label)).toEqual(['a', 'b', 'ほか'])
    expect(tight.map((s) => s.size)).toEqual([4, 3, 3])
    expect(tight.every((s) => s.size >= 3)).toBe(true)
    // (c-terminal) — even one series +「ほか」cannot fit a 5px bar
    // (min 3 x 2 = 6 > 5): the FIRST series alone becomes the single-color
    // bar (not the residual — the top-ranked series is the data's face)
    const single = allocateStack([seg('a', 40), seg('b', 35), { ...seg('ほか', 25, 'var(--series-rest)') }], 5)
    expect(single.map((s) => s.label)).toEqual(['a'])
    expect(single[0]!.size).toBe(5)
    expect(single[0]!.color).toBe('var(--series-a)')
    expect(single[0]!.outline).toBe(true)
    // (f) rule F — a bar shorter than 3 itself keeps the data ratio (the
    // outline would leave the fill under 1px): fill only, sizes by value
    const tiny = allocateStack([seg('a', 60), seg('b', 40)], 2)
    expect(tiny.map((s) => s.label)).toEqual(['a', 'b'])
    expect(tiny.map((s) => s.outline)).toEqual([false, false])
    expect(tiny[0]!.size).toBeCloseTo(1.2, 6)
    expect(tiny[1]!.size).toBeCloseTo(0.8, 6)
    expect(tiny.reduce((a, s) => a + s.size, 0)).toBeCloseTo(2, 6)
    // the boundary: exactly 3 keeps the outline (F fires BELOW 3 only)
    expect(allocateStack([seg('a', 100)], 3).every((s) => s.outline)).toBe(true)
  })

  // PR#4 review 1 (TASK-171): rule C's terminal fires on the BAR-LENGTH
  // budget (minimum x N vs the length) only — never on a series' data-ratio
  // size. The old ratio-basis terminal collapsed a rest-majority bar onto
  // the first series' single color: the rest's money vanished from the
  // drawing and the pct consumers (BarVChart / WeekRows / BreakdownBar,
  // whose denominators close over the ALLOCATED sum) read the lone series
  // as「…（100%）」. The composition mode's principle — never stretch a
  // series to amounts the data never had — now governs the stack mode's
  // lone survivor too: it keeps its data ratio (fill-only under 3px).
  it('[covers:web-common.stack-rule-c-length-basis] 規則C terminal はbar長基準（minimum×N>bar長のみ発火）: rest過半でも単色化せず全segmentがdata比・生存series 1本がmin未満でもdata比fill-onlyのまま・境界（minimum×N=bar長）は単色化しない・金額総和は保存', () => {
    const seg = (label: string, value: number, rest = false) => ({
      label,
      value,
      color: rest ? 'var(--series-rest)' : `var(--series-${label})`,
      rest,
    })
    // (a) rest過半 + the smaller series sub-minimum: rule B folds b, then
    // the LONE a (12% at its data ratio = 2.4px < 3) SURVIVES at its data
    // ratio fill-only — the old code returned [a alone at 20px] here (the
    // terminal), erasing the rest's 80%
    const restMajority = allocateStack([seg('a', 12), seg('b', 8), seg('ほか', 80, true)], 20)
    expect(restMajority.map((s) => s.label)).toEqual(['a', 'ほか'])
    expect(restMajority.reduce((a, s) => a + s.value, 0)).toBe(100) // the money stays
    expect(restMajority[0]!.size).toBeCloseTo(2.4, 6) // 12% of 20 — data ratio
    expect(restMajority[0]!.outline).toBe(false) // sub-3px lone series: fill only
    expect(restMajority[1]!.size).toBeCloseTo(17.6, 6)
    expect(restMajority[1]!.outline).toBe(true)
    // the allocated sum keeps the input total, so the pct consumers' ratio
    // (a's value over the sum) reads 12% — not the terminal's 100%
    expect(Math.round((restMajority[0]!.value / restMajority.reduce((a, s) => a + s.value, 0)) * 100)).toBe(12)
    // (b) 生存series 1本 whose ratio size sits under the minimum on a bar
    // that CAN house minimum x 2: the lone series keeps its data ratio (the
    // composition stop) — the old code returned [a alone at 90px]
    const lone = allocateStack([seg('a', 3), seg('ほか', 97, true)], 90)
    expect(lone.map((s) => s.label)).toEqual(['a', 'ほか'])
    expect(lone[0]!.size).toBeCloseTo(2.7, 6)
    expect(lone[0]!.outline).toBe(false)
    expect(lone[1]!.size).toBeCloseTo(87.3, 6)
    // (c) the length boundary: minimum x N EXACTLY fits the bar (3 x 2 = 6)
    // — no terminal, every segment keeps its data ratio; one unit shorter
    // and the terminal takes over (the existing c-terminal case at length 5)
    const boundary = allocateStack([seg('a', 40), seg('ほか', 60, true)], 6)
    expect(boundary.map((s) => s.label)).toEqual(['a', 'ほか'])
    expect(boundary.reduce((a, s) => a + s.size, 0)).toBeCloseTo(6, 6)
    expect(allocateStack([seg('a', 40), seg('ほか', 60, true)], 5).map((s) => s.label)).toEqual(['a'])
  })

  // TASK-129 (design §4-5, web-common.stack-dimension-rules): the
  // composition mode for the composition-ratio bars (ShareBar) — rules A/B/F
  // apply, rule C does NOT (dropping the residual to stretch the first
  // series would paint amounts the data never had): a series that cannot
  // clear the minimum stays fill-only at its data ratio instead of
  // collapsing. The residual identity is the `rest` FLAG now (the
  // label-string「ほか」test is gone) and a fold the allocator creates
  // carries the caller-supplied name. Written test-first.
  it('[covers:web-common.stack-dimension-rules] composition モード: 規則A/B/F適用・規則C不適用（過密でも単色化しない）・rest フラグ識別（ラベル「その他」へ合流・総和保存）・rest.label での新設', () => {
    const seg = (label: string, value: number, color = `var(--series-${label})`, rest = false) => ({ label, value, color, rest })
    const opts = { mode: 'composition', rest: { label: 'その他' } } as const
    // (a) rules A — the plain composition split closes over the length
    const plain = allocateStack([seg('a', 60), seg('b', 40)], 100, opts)
    expect(plain.map((s) => s.label)).toEqual(['a', 'b'])
    expect(plain.map((s) => s.size)).toEqual([60, 40])
    expect(plain.every((s) => s.outline)).toBe(true)
    // (b) rule B — the sub-minimum series folds into the EXISTING
    // rest-flagged segment (label「その他」, the flag — not the label —
    // decides): the value MOVES (sum preserved), re-split, all >= 3. A
    // rest-flagged segment under the minimum itself never folds away
    const folded = allocateStack([seg('a', 70), seg('b', 27), seg('c', 2), seg('その他', 1, 'var(--series-rest)', true)], 100, opts)
    expect(folded.map((s) => s.label)).toEqual(['a', 'b', 'その他'])
    expect(folded.map((s) => s.value)).toEqual([70, 27, 3])
    expect(folded.map((s) => s.size)).toEqual([70, 27, 3])
    expect(folded.every((s) => s.outline)).toBe(true)
    // (c) rule C does NOT fire in composition: a bar where even the folded
    // composition cannot clear the minimum keeps EVERY series at its data
    // ratio — the sub-minimum survivor drops its outline (the rule-F usage)
    // instead of the stack mode's first-series single-color collapse. The
    // SAME input in the default stack mode proves the contrast.
    const tight = [seg('a', 4), seg('b', 3), seg('その他', 3, 'var(--series-rest)', true)]
    const comp = allocateStack(tight, 5, opts)
    expect(comp.map((s) => s.label)).toEqual(['a', 'その他'])
    expect(comp.map((s) => s.value)).toEqual([4, 6]) // b folded in, sum kept
    expect(comp.map((s) => s.size).reduce((x, y) => x + y, 0)).toBeCloseTo(5, 6)
    const aSeg = comp[0]!
    expect(aSeg.size).toBeCloseTo(2, 6)
    expect(aSeg.outline).toBe(false) // under the minimum → fill only
    expect(comp[1]!.size).toBeCloseTo(3, 6)
    expect(comp[1]!.outline).toBe(true)
    const stackSame = allocateStack(tight, 5)
    expect(stackSame.map((s) => s.label)).toEqual(['a']) // rule C terminal
    expect(stackSame[0]!.size).toBe(5)
    // (f) rule F — the whole bar under 3 keeps the data ratio, fill only
    const tiny = allocateStack([seg('a', 60), seg('b', 40)], 2, opts)
    expect(tiny.map((s) => s.outline)).toEqual([false, false])
    expect(tiny[0]!.size).toBeCloseTo(1.2, 6)
    // (d) rest creation: folding with NO rest-flagged segment creates one
    // carrying the caller's name (the allocator never invents one) — two
    // sub-minimum folds accumulate enough to clear the minimum themselves
    const created = allocateStack([seg('a', 920), seg('b', 30), seg('c', 29)], 96, opts)
    expect(created.map((s) => s.label)).toEqual(['a', 'その他'])
    expect(created.map((s) => s.value)).toEqual([920, 59])
    expect(created.map((s) => s.size)[1]).toBeGreaterThanOrEqual(3)
    const named = allocateStack([seg('a', 920), seg('b', 30), seg('c', 29)], 96, { mode: 'composition', rest: { label: 'ほか' } })
    expect(named.map((s) => s.label)).toEqual(['a', 'ほか'])
    // the flag — not the label — decides: a「ほか」-labeled segment WITHOUT
    // the flag is an ordinary series (it folds INTO the created rest like
    // any other), and the default stack mode keeps creating「ほか」
    const unflagged = allocateStack([seg('a', 70), seg('b', 27), seg('ほか', 2, 'var(--series-rest)')], 100, opts)
    expect(unflagged.map((s) => s.label)).toEqual(['a', 'b', 'その他'])
    expect(unflagged.map((s) => s.value)).toEqual([70, 27, 2])
    const stackDefault = allocateStack([seg('a', 70), seg('b', 27), seg('c', 2)], 100)
    expect(stackDefault.map((s) => s.label)).toEqual(['a', 'b', 'ほか'])
  })

  it('[covers:web-home.trend-window-floor] 全0打ち切り: ページ送り先のoffset=6窓は記録があれば有効のまま・offset=12の全0窓でprev disable・nextでoffset=6へ復帰・初期窓（offset=0）の全0ではdisableしない', async () => {
    // records in 2025-12, 2026-06 and 2026-10 — the two-page structure of
    // TASK-108 §4-6: the offset=6 page (2025-11..2026-04) holds the 2025-12
    // record, the offset=12 page (2025-05..2025-10) is the all-zero floor
    await api.updateReceipt(1, 102, { revision: 1, set: { purchased_on: '2026-06-15' } })
    await api.updateReceipt(1, 103, { revision: 1, set: { purchased_on: '2025-12-10' } })
    const period = usePeriodStore()
    const win = await mountWindow()
    // the initial page (2026-05..2026-10) holds the June / October records
    expect(win.canPrev.value).toBe(true)
    // page 2 (2025-11..2026-04): the 2025-12 record keeps the bucket total
    // > 0 — prev stays enabled (the old offset=1..4 walk collapses into this
    // page)
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.canPrev.value).toBe(true)
    // page 3 (2025-05..2025-10) is all zero: prev alone disables (the
    // practical floor against the zero-filling endpoint — TASK-161 §1-3's
    // symmetric rule). TASK-115: the page was prefetched and cached, so the
    // press commits the cached result at once — canPrev recomputes on the
    // very same expression IMMEDIATELY (no fetch wait)
    win.prev()
    expect(win.canPrev.value).toBe(false)
    await settle()
    expect(win.window.value).toEqual(['2025-05-01', '2025-10-31'])
    expect(win.canPrev.value).toBe(false)
    expect(win.canNext.value).toBe(true) // the floor is direction-local
    // next returns to the 2025-12 page and prev re-enables
    win.next()
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.canPrev.value).toBe(true)
    // an all-zero window with NO move history (the E2c reset to 2025-04's
    // canonical 2024-11..2025-04) never disables either direction — a
    // record-less month must still show the months before
    period.setMonth('2025-04')
    await settle()
    expect(win.window.value).toEqual(['2024-11-01', '2025-04-30'])
    expect(win.canPrev.value).toBe(true)
    expect(win.canNext.value).toBe(true)
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2024-05-01', '2024-10-31'])
    expect(win.canPrev.value).toBe(false) // the paged-to window is all zero
  })

  // PR#4 #4 (web-home.trend-window-floor): a FAILED window move leaves
  // lastMove standing without a commit — the moved-to window's result never
  // lands, so the floor must not fire off that trace. The non-move commit
  // paths (E4 labelQuery / refresh) reset the move memory: their all-zero
  // commits keep both chevrons enabled.
  it('[covers:web-home.trend-window-floor] 失敗したprev移動の残留lastMoveはE4/refreshのall-zero commitでフロアに使わない（移動でないcommitは移動履歴を持たない）', async () => {
    const orig = api.getAnalysisTrend.bind(api)
    let failFrom: string | null = '2025-11-01'
    vi.spyOn(api, 'getAnalysisTrend').mockImplementation(async (...args: Parameters<typeof orig>) => {
      const [l, q] = args
      if (failFrom !== null && q.from === failFrom) throw new Error('window move failed')
      return orig(l, q)
    })
    const period = usePeriodStore()
    const win = await mountWindow()
    // the initial window (2026-05..2026-10, holding the records) commits
    // with no move history — and the prev-adjacent prefetch already failed
    // silently, so the press below cannot land from cache
    expect(win.canPrev.value).toBe(true)
    win.prev()
    await settle()
    // the window moved but NOTHING committed: the display keeps the
    // initial windowKey and lastMove='prev' stands without a floor (canPrev
    // keeps the last committed value — the trace alone disables nothing)
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.canPrev.value).toBe(true)
    // E4: a label change re-fetches the CURRENT window (all zero in the
    // mock) — the commit is not a move, so the leftover trace must not
    // floor ‹ off the all-zero result. The next page (2025-05..) fails
    // from here: the E4 commit's prefetch of it drops silently, so the
    // press below cannot land from cache either
    failFrom = '2025-05-01'
    period.setLabelColors(['red'])
    await settle()
    expect(win.windowKey.value).toBe('2025-11-01..2026-04-30')
    expect(win.canPrev.value).toBe(true)
    // the same leftover after ANOTHER failed move, cleared by refresh():
    // the re-fetched all-zero window keeps ‹ alive too
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-05-01', '2025-10-31'])
    expect(win.canPrev.value).toBe(true)
    failFrom = null
    win.refresh()
    await settle()
    expect(win.windowKey.value).toBe('2025-05-01..2025-10-31')
    expect(win.canPrev.value).toBe(true)
  })

  // [covers:web-home.trend-window-cache-return]
  it('prev発行中にnextで初期窓へ戻る: cache復帰のguardはpending fetchを無効化しstale responseでchartを置き換えない（PR#1 P2・TASK-115でcacheヒット経路へ移植）', async () => {
    // the prev window's responses hang until released — BOTH the prefetch
    // (TASK-115 fires one right after the initial commit) and the prev
    // press's own display fetch share this from, so the adjacent window
    // never lands in the cache and the press really goes to the network
    const orig = api.getAnalysisTrend.bind(api)
    const stale: AnalysisTrendResult = {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      period: { from: '2025-11-01', to: '2026-04-30', label: '' },
      buckets: ['stale-window'],
      series: [],
      bucket_totals: [0],
      truncated_rows: 0,
    }
    let release!: (v: AnalysisTrendResult) => void
    const gate = new Promise<AnalysisTrendResult>((r) => (release = r))
    vi.spyOn(api, 'getAnalysisTrend').mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (args[1]!.from === '2025-11-01') return gate
      return orig(...args)
    })
    const win = await mountWindow()
    const initial = win.result.value
    expect(initial).not.toBeNull()
    win.prev()
    expect(win.loading.value).toBe(true)
    // back to the cached initial window while B is still in flight
    win.next()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    // the cached return took over the pending fetch's cleanup: loading is
    // off and inFlight cleared (a later prev re-issues a real fetch)
    expect(win.loading.value).toBe(false)
    release(stale)
    await settle()
    // the stale B response was invalidated by the seq bump: the chart keeps
    // the cached initial window's result (reference identity, not a copy)
    expect(win.result.value).toBe(initial)
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
  })

  // --- TASK-115 (design §5-1 新規): the cache / prefetch / slide contracts ---

  it('[covers:web-home.trend-window][covers:web-home.trend-window-prefetch] 窓cacheのclearはE3（mode/家計簿）のみ: 復帰で再fetchする・focus移動（E2a）とlabelQuery（E4）はcache保持で同期commit', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    await mountWindow()
    const disp = (from: string) => callsFrom(trendSpy, 1, from)
    // the plain-window baseline: one display fetch + one adjacent prefetch
    expect(disp('2026-05-01')).toHaveLength(1)
    expect(disp('2025-11-01')).toHaveLength(1)
    // ledger: 1 -> 2 -> 1. The return re-fetches the very same args — a
    // surviving cache would serve the window without a call, and a surviving
    // issued-set would skip the prefetch
    useSessionStore().selectedLedgerId = 2
    await settle()
    useSessionStore().selectedLedgerId = 1
    await settle()
    expect(disp('2026-05-01'), 'the ledger return re-fetches (cache flushed)').toHaveLength(2)
    expect(disp('2025-11-01'), 'the adjacent prefetch re-issues (set flushed)').toHaveLength(2)
    // mode: month -> year -> month (same anchor month — the exact same args)
    period.mode = 'year'
    await settle()
    period.mode = 'month'
    await settle()
    expect(disp('2026-05-01')).toHaveLength(3)
    expect(disp('2025-11-01')).toHaveLength(3)
    // focus move INSIDE the window (TASK-161 §1 E2a): no fetch at all — the
    // window never moves for an in-window focus change
    period.setMonth('2026-09')
    await settle()
    period.setMonth('2026-10')
    await settle()
    expect(disp('2026-05-01'), 'an E2a focus move re-fetches nothing').toHaveLength(3)
    expect(disp('2025-11-01')).toHaveLength(3)
    // labelQuery: red -> none -> red. TASK-161 §1-4 (E4): the cache SURVIVES
    // a label change (the args-keyed cache never serves another condition),
    // so the red return commits synchronously off the first red phase's
    // cached response — no re-fetch
    const redDisp = (from: string) =>
      trendSpy.mock.calls.filter(([l, q]) => l === 1 && q.from === from && q.label_colors?.[0] === 'red')
    period.setLabelColors(['red'])
    await settle()
    period.setLabelColors([])
    await settle()
    period.setLabelColors(['red'])
    await settle()
    expect(redDisp('2026-05-01'), 'the label return serves the cached red window').toHaveLength(1)
    expect(redDisp('2025-11-01')).toHaveLength(1)
  })

  it('[covers:web-home.trend-window] cacheヒットコミット: prev押下で表示fetchなし・windowKey即時コミット・loadingにならない・canPrev即時再計算（nextも同様）', async () => {
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1) // the prefetch alone
    // the press commits the cached window SYNCHRONOUSLY: no fetch, no
    // loading, the key is the new page already, and the all-zero prefetched
    // page (the mock keeps every earlier month zero) floors canPrev at once
    win.prev()
    expect(win.windowKey.value).toBe('2025-11-01..2026-04-30')
    expect(win.loading.value).toBe(false)
    expect(win.canPrev.value).toBe(false)
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'no display fetch for the cached window').toHaveLength(1)
    // next returns on the cached initial window the same way
    win.next()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.loading.value).toBe(false)
    expect(win.canPrev.value).toBe(true)
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01'), 'the cached return never re-fetches').toHaveLength(1)
  })

  it('[covers:web-home.trend-window-slide] 連結とトリム: prevのslideは[新窓,旧窓]連結・nextは[旧窓,新窓]・axisWindowsは窓ごとkeys・表示配列は連結→finishSlideでslide=null・新窓のみ（冪等）', async () => {
    const win = await mountWindow()
    const K0 = monthsBetween('2026-05-01', '2026-10-31')
    const K1 = monthsBetween('2025-11-01', '2026-04-30')
    const K2 = monthsBetween('2025-05-01', '2025-10-31')
    // prev (cache hit — the initial commit prefetched K1): the concatenated
    // pair is [new, old] and the display array IS the concatenation — one
    // graph, both windows, nothing vanished
    win.prev()
    const a = win.slide.value!
    expect(a.dir).toBe('prev')
    expect(a.bars.map((b) => b.key)).toEqual([...K1, ...K0])
    expect(a.axisWindows).toEqual([K1, K0])
    expect(win.stacked.value.map((c) => c.key)).toEqual([...K1, ...K0])
    // the K1 commit just issued the offset=12 prefetch (K2) — it can only
    // land in the cache after a tick, so wait here: the second press below
    // must be a cache hit, never a display fetch
    await settle()
    // a second prev concatenates the NEXT page the same way. The press lands
    // while the first slide is still on (no trim yet), so it rides the §3-3
    // 連打 path — trim at once, then the K2 cache hit assembles the new
    // concatenation synchronously (canPrev already floored at K1's zeros;
    // a mid-slide re-press moves regardless — design §3-3)
    win.prev()
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([...K2, ...K1])
    expect(win.slide.value!.axisWindows).toEqual([K2, K1])
    // the trim: finishSlide drops the slide — the display falls back to the
    // committed window alone (the new one), key untouched
    win.finishSlide()
    expect(win.slide.value).toBeNull()
    expect(win.stacked.value.map((c) => c.key)).toEqual(K2)
    expect(win.windowKey.value).toBe('2025-05-01..2025-10-31')
    win.finishSlide() // idempotent — a watchdog racing the event is harmless
    expect(win.slide.value).toBeNull()
    // next: the mirrored assembly — [old, new] over the same pair of pages
    win.next()
    expect(win.slide.value!.dir).toBe('next')
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([...K2, ...K1])
    win.finishSlide()
    expect(win.stacked.value.map((c) => c.key)).toEqual(K1)
  })

  it('[covers:web-home.trend-window-prefetch] prefetch: コミット確定後にprev隣接窓を表示と同一条件で1回・cache済み窓へは発行しない・失敗は静穏（loading・onError不変）し次コミットで再試行・週モードでは発行しない', async () => {
    const period = usePeriodStore()
    const onError = vi.fn()
    const orig = api.getAnalysisTrend.bind(api)
    let failAdjacent = false
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend').mockImplementation(async (...args: Parameters<typeof orig>) => {
      // the gate pins the NO-LABEL ±1 prev-move window alone (the red one of
      // the same months was issued successfully earlier — TASK-161: the
      // prefetch cache is args-keyed, so the two never collide)
      if (failAdjacent && args[1]!.from === '2025-10-01' && (args[1]!.label_colors?.length ?? 0) === 0) {
        throw new Error('prefetch failed')
      }
      return orig(...args)
    })
    // label + subject filters ride BOTH the display fetch and the prefetch
    period.setLabelColors(['red'])
    const win = useTrendWindow({ axis: () => 'category', filters: () => ({ item_query: '牛乳' }), onError })
    useSessionStore().selectedLedgerId = 1
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')[0]![1]).toMatchObject({
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      to: '2026-04-30',
      limit: 5,
      label_colors: ['red'],
      item_query: '牛乳',
    })
    // TASK-161 §1-4 (review 中4): an explicit refresh INVALIDATES — the
    // display window re-fetches and the cleared cache re-prefetches its
    // pages (the suppression covers IN-FLIGHT identical args alone)
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(2)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(2)
    // cached windows are never prefetched again: the refresh's re-prefetch
    // re-cached the adjacent page, so prev's press is a cache HIT whose
    // commit prefetches the NEXT adjacent page (2025-05), then next's commit
    // finds the first adjacent page cached+issued and skips it
    win.prev()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-05-01')).toHaveLength(1)
    win.next()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(2)
    win.prev()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'the cached page is not re-fetched nor re-prefetched').toHaveLength(2)
    // a rejected prefetch is silent: no loading, no onError, the display is
    // untouched — and the failed key is retried on the NEXT commit. TASK-161:
    // the gated key is the window's no-label ±1 prev-move target
    // (2025-10..03 — counted apart from the red-keyed window of the same
    // months); the commit that retries it is the E4 label roundtrip BACK to
    // the same no-label condition (an E2a focus move fetches nothing, so it
    // can never retry a prefetch)
    const plainMove = () =>
      trendSpy.mock.calls.filter(([l, q]) => l === 1 && q.from === '2025-10-01' && (q.label_colors?.length ?? 0) === 0)
    failAdjacent = true
    period.setLabelColors([])
    await settle()
    expect(win.loading.value).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(win.windowKey.value).toBe('2025-11-01..2026-04-30')
    expect(plainMove()).toHaveLength(1) // tried once, failed
    failAdjacent = false
    period.setLabelColors(['red'])
    await settle()
    period.setLabelColors([])
    await settle()
    expect(plainMove()).toHaveLength(2) // retried and landed
    // inactive windows never prefetch: the week window's adjacent computation
    // is the same key as its own display fetch
    period.setWeek('2026-10-05')
    await settle()
    expect(trendSpy.mock.calls.filter(([, q]) => q.granularity === 'day' && q.from === '2026-10-05')).toHaveLength(1)
  })

  it('[covers:web-home.trend-window-slide] 連打: スライド中の再押下は即時トリム（cacheミスならslide=null待ち）→確定後に新slide組み立て・cacheヒットなら即座に差し替え', async () => {
    const win = await mountWindow()
    await settle()
    // first press: cache hit, the slide is on
    win.prev()
    const first = win.slide.value
    expect(first).not.toBeNull()
    // a second press BEFORE any settle: the offset=12 page is neither cached
    // nor resolved — the in-progress slide is trimmed at once (slide null,
    // loading on) and nothing is assembled until the fetch lands
    win.prev()
    expect(win.slide.value).toBeNull()
    expect(win.loading.value).toBe(true)
    await settle()
    const second = win.slide.value!
    expect(second).not.toBe(first)
    expect(second.dir).toBe('prev')
    expect(second.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2025-05-01', '2025-10-31'),
      ...monthsBetween('2025-11-01', '2026-04-30'),
    ])
    // the mirrored rapid press on a CACHED window: trim + immediate assembly
    const cached = second
    win.next()
    expect(win.slide.value).not.toBeNull()
    expect(win.slide.value).not.toBe(cached)
    expect(win.slide.value!.dir).toBe('next')
    win.finishSlide()
  })

  it('[covers:web-home.trend-window-slide] スライド中のfocus変更: 即時trim・slideRequestもクリア（確定コミットでもslide不発火）・label切替（E4）はcache保持', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    win.prev()
    expect(win.slide.value).not.toBeNull()
    // a month-chip focus change lands mid-slide (TASK-161 §1: the interrupted
    // E2b): the slide trims at once, the window still moves its k=5 minimum
    // (2025-11..04 + 5 = 2026-04..09) and the commit swaps in place
    period.setMonth('2026-09')
    expect(win.slide.value).toBeNull()
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.slide.value, 'the focus commit never assembles a slide').toBeNull()
    // the same trim for a label switch mid-slide (E4 — the window stays)
    win.prev()
    expect(win.slide.value).not.toBeNull()
    period.setLabelColors(['red'])
    expect(win.slide.value).toBeNull()
    await settle()
    expect(win.slide.value).toBeNull()
    // TASK-161 §1-4 (E4): the cache SURVIVES the label switch — the red
    // return commits synchronously off the cached red response (the old
    // flush cleared it and re-fetched)
    period.setLabelColors([])
    await settle()
    period.setLabelColors(['red'])
    await settle()
    const redOct = trendSpy.mock.calls.filter(
      ([l, q]) => l === 1 && q.from === '2025-10-01' && q.label_colors?.[0] === 'red',
    )
    expect(redOct, 'the label return serves the cached red window').toHaveLength(1)
  })

  it('[covers:web-home.trend-window-slide] slide不発火経路: 初回コミット・refresh・同窓再fetch（labelQuery）・focus変更はいずれもslideを組まない・対照にprev→nextのcache復帰は表示fetchなしでslide組み立て', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    // the very first commit assembles nothing (no old window to slide from)
    expect(win.slide.value).toBeNull()
    // a same-args refresh (AxisDetail's same-window re-init reduces to this)
    win.refresh()
    await settle()
    expect(win.slide.value).toBeNull()
    // a same-window refetch (label added): the key stays, no slide
    period.setLabelColors(['red'])
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.slide.value).toBeNull()
    // a focus move INSIDE the committed window (TASK-161 §1 E2a): the window
    // never moves, nothing re-fetches — September keeps October's bar
    period.setLabelColors([])
    await settle()
    period.setMonth('2026-09')
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.slide.value).toBeNull()
    // the CONTRAST: a prev/next round trip on the cached pages assembles
    // slides with no display fetch at all
    const adjacent = callsFrom(trendSpy, 1, '2025-11-01').length // the ±span prev prefetch
    win.prev()
    expect(win.slide.value).not.toBeNull()
    win.finishSlide()
    win.next()
    expect(win.slide.value).not.toBeNull()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    win.finishSlide()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'no display fetch beyond the prefetch').toHaveLength(adjacent)
  })
})

describe('TrendWindow (component, TASK-104 / TASK-115)', () => {
  const COL: StackedBar = {
    key: '2026-10',
    title: '2026年10月 948円',
    total: 948,
    segments: [
      { label: '食費', value: 550, color: 'var(--c1)' },
      { label: '日用品', value: 398, color: 'var(--c2)' },
    ],
  }

  /** a slide state shaped as the composable's SlideState (TASK-115 §3-1,
   * TASK-161 §1-2 adds moveCols) — the structural contract the wrapper
   * consumes: dir + the concatenated bars + the per-window bucket keys for
   * the axis computation + the slide's distance in columns */
  interface SlideLike {
    dir: 'prev' | 'next'
    bars: StackedBar[]
    axisWindows: string[][]
    moveCols: number
  }
  const col = (key: string): StackedBar => ({ ...COL, key, title: `${key} 100円` })

  it('[covers:web-home.trend-window] 前次button対（aria-label「前の範囲」「次の範囲」・.trend-nav・disabled受け渡し・select再送出）・windowKey=nullでTrendBars未描画（v-ifゲート）・値で描画・nav=falseでbutton非表示', async () => {
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: false,
        canNext: true,
        windowKey: '2026-05-01..2026-10-31',
        stacked: [COL],
        granularity: 'month',
        span: ['2026-05-01', '2026-10-31'] as [string, string],
        current: '2026-10',
      },
    })
    const prev = w.find('[data-test="trend-prev"]')
    const next = w.find('[data-test="trend-next"]')
    expect(prev.attributes('aria-label')).toBe('前の範囲')
    expect(prev.attributes('title')).toBe('前の範囲')
    expect(prev.classes()).toContain('trend-nav')
    expect(next.attributes('aria-label')).toBe('次の範囲')
    expect(next.attributes('title')).toBe('次の範囲')
    expect(next.classes()).toContain('trend-nav')
    // the disable wiring: canPrev=false / canNext=true
    expect(prev.attributes('disabled')).toBeDefined()
    expect(next.attributes('disabled')).toBeUndefined()
    await next.trigger('click')
    expect(w.emitted('next')).toHaveLength(1)
    await w.setProps({ canPrev: true })
    await prev.trigger('click')
    expect(w.emitted('prev')).toHaveLength(1)
    // a bar press re-emits select through the wrapper
    await w.find('[data-test="bar-2026-10"]').trigger('click')
    expect(w.emitted('select')).toEqual([['2026-10']])
    // the v-if gate (TASK-108 §1-4 / §4-7): until the first window commits
    // (windowKey=null) the bars do not render at all; a committed key draws
    // them (TASK-115: a single un-transitioned TrendBars instance)
    expect(w.find('[data-test="trend"]').exists()).toBe(true)
    await w.setProps({ windowKey: null })
    expect(w.find('[data-test="trend"]').exists()).toBe(false)
    await w.setProps({ windowKey: '2026-05-01..2026-10-31' })
    expect(w.find('[data-test="trend"]').exists()).toBe(true)
    // week / range screens pass nav=false: the pair is gone, the bars stay
    await w.setProps({ nav: false })
    expect(w.find('[data-test="trend-prev"]').exists()).toBe(false)
    expect(w.find('[data-test="trend-next"]').exists()).toBe(false)
    expect(w.find('[data-test="trend"]').exists()).toBe(true)
  })

  it('[covers:web-home.trend-window-slide] slide中のchrome: .bars/.axis-labelsへ同時is-sliding・軸ラベルと.bar-valはaxisWindowsの窓ごと計算（dense化しない）・transitionendでfinish-slide emit・slide=nullで解除', async () => {
    // a 6+6 month concatenation (prev: [new 2025-11..2026-04, old 2026-05..10])
    const NEW = monthsBetween('2025-11-01', '2026-04-30')
    const OLD = monthsBetween('2026-05-01', '2026-10-31')
    const slide: SlideLike = { dir: 'prev', bars: [...NEW, ...OLD].map(col), axisWindows: [NEW, OLD], moveCols: 6 }
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: true,
        canNext: false,
        windowKey: '2025-11-01..2026-04-30',
        slide,
        stacked: slide.bars,
        granularity: 'month',
        span: ['2025-11-01', '2026-04-30'] as [string, string],
        current: null,
      },
    })
    // both transformed elements carry the sliding class together
    expect(w.find('[data-test="trend"]').classes()).toContain('is-sliding')
    expect(w.find('[data-test="trend-axis"]').classes()).toContain('is-sliding')
    // TASK-162 §5-4 (review 3): the YEAR row rides the same slide machinery —
    // .axis-years sits over .axis-labels on the shared grid, carries
    // is-sliding together, and its ticks compute PER WINDOW (the new
    // 2025-11..2026-04 window's start year 2025 + the 2026-01 boundary), so
    // the trim changes nothing about them either
    expect(w.find('[data-test="axis-years"]').exists()).toBe(true)
    expect(w.find('[data-test="axis-years"]').classes()).toContain('is-sliding')
    expect(w.findAll('[data-test="axis-years"] span').map((s) => s.text())).toEqual(['2025', '2026'])
    // the axis labels follow the PER-WINDOW computation (REVIEW-1 M3): each
    // 6-bar window thins [0,2,4,5] on its own — the whole-12 array would
    // thin [0,3,6,9,11] and reshuffle the labels at slide start and trim
    const perWindow = [...(axisMonthLabels(NEW)!.items ?? []), ...(axisMonthLabels(OLD)!.items ?? [])]
    const shown = new Map(perWindow.map((t) => [t.key, t.label]))
    const texts = w.findAll('[data-test="trend-axis"] span').map((s) => s.text())
    expect(texts).toEqual([...NEW, ...OLD].map((k) => shown.get(k) ?? ''))
    // dense never turns on mid-concatenation (REVIEW-2 R1): a 6+6 month pair
    // must not become a dense 12-bar window — every value label stays on
    expect(w.find('.trend-wrap').classes()).not.toContain('dense')
    expect(w.findAll('.bar-val')).toHaveLength(12)
    // the transform's end on the .bars row (the single source, design §3-3)
    // reports the slide done — the page trims through the finish-slide event
    const end = new Event('transitionend')
    Object.defineProperty(end, 'propertyName', { value: 'transform' })
    w.find('[data-test="trend"]').element.dispatchEvent(end)
    expect(w.emitted('finish-slide')!.length).toBeGreaterThanOrEqual(1)
    // the parent clears the slide: the chrome resets (and, with no
    // axisWindows, a 12-bar month window IS dense — the R1 pin's contrast)
    await w.setProps({ slide: undefined, stacked: [...NEW, ...OLD].map(col) })
    expect(w.find('[data-test="trend"]').classes()).not.toContain('is-sliding')
    expect(w.find('.trend-wrap').classes()).toContain('dense')
    expect(w.findAll('.bar-val').length).toBeLessThan(12)
    // the year row resets with the chrome but the ticks themselves are
    // trim-invariant (the concatenated window spans 2025-11..2026-10: the
    // start year + the boundary stay put)
    expect(w.find('[data-test="axis-years"]').classes()).not.toContain('is-sliding')
    expect(w.findAll('[data-test="axis-years"] span').map((s) => s.text())).toEqual(['2025', '2026'])
  })

  // TASK-161 §1-2 (review 中2): an E2b minimal slide's UNION holds months
  // both windows share — the NEW window's thinning decides every month it
  // CONTAINS (a shared month the new window thins out stays unlabelled
  // mid-slide exactly as it will be after the trim); only the old window's
  // LEAVING months (the keys the new window does not hold at all) keep their
  // outgoing labels. The old implementation revived the old window's labels
  // on the shared thinned months (7月・9月 appeared mid-slide and vanished at
  // the trim — the trim-invariance violation).
  it('[covers:web-home.trend-window-min-slide] E2b unionの軸label: 共有月は新窓の間引きが決める（trim前後で不変）・旧窓由来のlabelは去る月のみ', () => {
    const OLD = monthsBetween('2026-05-01', '2026-10-31')
    const NEW = monthsBetween('2026-06-01', '2026-11-30')
    const UNION = [...OLD, '2026-11']
    const w = mount(TrendBars, {
      props: {
        stacked: UNION.map(col),
        granularity: 'month',
        axisWindows: [OLD, NEW],
        axisDir: 'next',
        sliding: true,
      },
    })
    // jsdom (unmeasured) → the count fallback: the NEW window's ticks are
    // [0,2,4,5] of 06..11 → 6月・8月・10月・11月; the OLD window's own ticks
    // ([0,2,4,5] of 05..10) contribute 5月 alone (05 is the only key the new
    // window lacks) — the shared 7月・9月 stay EMPTY exactly as the trimmed
    // window will leave them
    const labels = () => w.findAll('[data-test="trend-axis"] span').map((s) => s.text())
    expect(labels()).toEqual(['5月', '6月', '', '8月', '', '10月', '11月'])
    // the trim: the same labels survive on the surviving months, the leaving
    // month's label leaves with its bar
    const trimmed = mount(TrendBars, { props: { stacked: NEW.map(col), granularity: 'month' } })
    expect(trimmed.findAll('[data-test="trend-axis"] span').map((s) => s.text())).toEqual(['6月', '', '8月', '', '10月', '11月'])
    w.unmount()
    trimmed.unmount()
  })

  /** one rAF hop — the slide's move is a three-hop chain (design §3-3);
   * the interruption tests below step it frame by frame */
  const raf = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

  /** narrows a found node's element to HTMLElement (the tests read inline
   * styles off it; no `as` casts per the TypeScript rule) */
  const asHtml = (el: Element): HTMLElement => {
    if (!(el instanceof HTMLElement)) throw new Error('expected an HTMLElement')
    return el
  }

  /** the pinned grid cell width the wrapper solved (repeat(N, Xpx) → X) —
   * jsdom has no layout, so the pin itself is what the tests can read */
  const trackCell = (el: HTMLElement): number =>
    Number.parseFloat(el.style.gridTemplateColumns.match(/repeat\(\d+, ([\d.]+)px\)/)?.[1] ?? '0')

  it('[covers:web-home.trend-window-slide] 再slide（連打差し替え）の測定: DOMが前回pinのままでもtrack幅は前回測定を再利用（2窓実測幅を1窓分で割らない）・trimでpinを外す（PR#2指摘1）', async () => {
    const OLD = monthsBetween('2026-05-01', '2026-10-31')
    const NEW1 = monthsBetween('2025-11-01', '2026-04-30')
    const NEW2 = monthsBetween('2025-05-01', '2025-10-31')
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: true,
        canNext: false,
        windowKey: '2026-05-01..2026-10-31',
        stacked: OLD.map(col),
        granularity: 'month',
        span: ['2026-05-01', '2026-10-31'] as [string, string],
        current: null,
      },
    })
    // jsdom has no layout: fake the reads the wrapper takes. The bars'
    // offsetWidth follows the pinned inline width once a pin lands — exactly
    // what a rapid re-press measures (the pinned 2-window grid is still on
    // screen when the replacement slide arrives before the trim's cleanup)
    const bars = asHtml(w.find('[data-test="trend"]').element)
    const wrap = asHtml(w.find('.trend-wrap').element)
    Object.defineProperty(bars, 'offsetWidth', {
      configurable: true,
      get: () => Number.parseFloat(bars.style.width) || 360,
    })
    Object.defineProperty(wrap, 'offsetWidth', { configurable: true, get: () => 360 })
    // the first press (prev): the committed 6-bar window measures one cell —
    // (360px − 5 gaps of 4px) / 6 — and the pin writes the 2-window width
    const S1: SlideLike = { dir: 'prev', bars: [...NEW1, ...OLD].map(col), axisWindows: [NEW1, OLD], moveCols: 6 }
    await w.setProps({ slide: S1, stacked: S1.bars, windowKey: '2025-11-01..2026-04-30' })
    await nextTick()
    const first = trackCell(bars)
    expect(first).toBeCloseTo(56.666667, 4)
    expect(bars.style.width, 'the pin writes the 2-window width (12 cells + 11 gaps)').toBe('724px')
    // the rapid re-press: the replacement slide reaches the watcher before
    // the trim's cleanup, so the DOM still wears the pin above — a fresh
    // offsetWidth read there returns the 2-window 724px and would solve
    // ~117px cells. The re-slide must reuse the recorded cell instead
    const S2: SlideLike = { dir: 'prev', bars: [...NEW2, ...NEW1].map(col), axisWindows: [NEW2, NEW1], moveCols: 6 }
    await w.setProps({ slide: S2, stacked: S2.bars, windowKey: '2025-05-01..2025-10-31' })
    await nextTick()
    expect(trackCell(bars), 'the re-slide reuses the recorded cell, not the pinned DOM width').toBeCloseTo(first, 10)
    // the trim drops the pin (the next slide re-measures — a resize between
    // slides re-pins at the true geometry). gridTemplateColumns keeps the
    // committed :style binding the trim's own patch re-wrote: clearing it
    // would strip the grid entirely for the frame the ResizeObserver samples
    // (TrendBars' colW would read a full-width cell and the axis thinning
    // silently stops) — the pin's px template is what must be gone, and the
    // width with it
    await w.setProps({ slide: undefined, stacked: NEW2.map(col) })
    await nextTick()
    expect(trackCell(bars), 'no pinned px cell template survives the trim').toBe(0)
    expect(bars.style.gridTemplateColumns).toBe('repeat(6, minmax(1.25rem, 1fr))')
    expect(bars.style.width).toBe('')
    w.unmount()
  })

  it('[covers:web-home.trend-window-slide] slide中断（focus変更trim）: 旧slideがqueueしたrAF chainはリセット後のchartへ古いtransformを再適用しない（PR#2指摘2）', async () => {
    const OLD = monthsBetween('2026-05-01', '2026-10-31')
    const NEW = monthsBetween('2025-11-01', '2026-04-30')
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: true,
        canNext: false,
        windowKey: '2026-05-01..2026-10-31',
        stacked: OLD.map(col),
        granularity: 'month',
        span: ['2026-05-01', '2026-10-31'] as [string, string],
        current: null,
      },
    })
    const bars = asHtml(w.find('[data-test="trend"]').element)
    // a next slide parks on translateX(0) and its queued hop repaints the
    // target transform — with no layout jsdom solves boundary 0, so the
    // stale re-apply would land as 'translateX(0px)' on a cleared '' style
    const S: SlideLike = { dir: 'next', bars: [...OLD, ...NEW].map(col), axisWindows: [OLD, NEW], moveCols: 6 }
    await w.setProps({ slide: S, stacked: S.bars, windowKey: '2025-11-01..2026-04-30' })
    await nextTick()
    expect(bars.style.transform, 'the next slide parks on the old window').toBe('translateX(0px)')
    // step the move's three rAF hops: after two the target transform is
    // queued but not applied yet
    await raf()
    await raf()
    expect(bars.style.transform).toBe('translateX(0px)')
    // a focus change trims on this very tick: the reset clears the
    // transform, and the queued hop must not repaint it afterwards
    await w.setProps({ slide: undefined, stacked: NEW.map(col) })
    await nextTick()
    expect(bars.style.transform).toBe('')
    await raf()
    await raf()
    expect(bars.style.transform, 'the interrupted slide never re-applies its target').toBe('')
    w.unmount()
  })

  // TASK-158 (web-common.content-swap #14改訂): the windowKey-keyed chart fade
  // is REMOVED. Its designed fire site — a windowKey change with no pane swap
  // — does not exist in the real wiring: a window move rides the slide, a
  // label/ledger switch keeps the key (the window is range-derived), the
  // AxisDetail first commit lands before TrendWindow mounts (the pages'
  // v-if on win.result), and every mode/range change bumps the pane's
  // committedKey on all four screens — the pane's ContentSwap transition is
  // the chart's single motion. The keyed remount instead faded visibly in
  // BOTH race orders of a period step (the trend window commits independently
  // of the page load — the reported 「グラフを移動すると色が消える」). A
  // windowKey change now swaps the chart's content IN PLACE: TrendBars is
  // never re-keyed, the v-if gate alone waits for the first window.
  it('[covers:web-common.content-swap] #14改訂(TASK-158): windowKey変化（単独・slide中とも）はchartのfadeなし・即時差替え（.bars DOM不変）・初回挿入も無演出（移動の演出はslide/paneのみ）', async () => {
    const OLD = monthsBetween('2026-05-01', '2026-10-31')
    const NEXT = monthsBetween('2026-04-01', '2026-09-30')
    const PAGED = monthsBetween('2025-11-01', '2026-04-30')
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: true,
        canNext: false,
        windowKey: '2026-05-01..2026-10-31',
        stacked: OLD.map(col),
        granularity: 'month',
        span: ['2026-05-01', '2026-10-31'] as [string, string],
        current: null,
      },
      global: { stubs: { transition: false } },
    })
    // the fade classes would ride the TrendBars ROOT (.hscroll — the old
    // Transition child); [data-test="trend"] is the .bars row inside it
    const charts = () => w.findAll('.hscroll')
    const noFade = () =>
      charts().every((el) =>
        Array.from(el.element.classList).every((c) => !c.includes('-enter-') && !c.includes('-leave-')),
      )
    // the first insertion paints instantly: no appear on the chart (the
    // pane's motion, when one runs, is the single performance)
    expect(charts()).toHaveLength(1)
    expect(noFade()).toBe(true)

    // a windowKey-only change (a period-move commit — the trend fetch lands
    // around the pane's own): the content swaps in place. The old keyed fade
    // would remount TrendBars (two .hscroll nodes mid-fade, page-enter/leave
    // classes) — none of that
    const barsEl = w.find('[data-test="trend"]').element
    await w.setProps({
      windowKey: '2026-04-01..2026-09-30',
      stacked: NEXT.map(col),
      span: ['2026-04-01', '2026-09-30'] as [string, string],
    })
    await nextTick()
    expect(charts()).toHaveLength(1)
    expect(noFade()).toBe(true)
    expect(w.find('[data-test="trend"]').element).toBe(barsEl)
    // the new window's content actually landed in the surviving DOM (the
    // in-place swap is visible in the bars, not swallowed)
    expect(w.find('[data-test="trend"]').find('.bar-col').attributes('data-test')).toBe(`bar-${NEXT[0]}`)

    // a window move (the slide carries a new windowKey with it — the
    // cache-hit commit lands the key synchronously): the slide is the ONLY
    // motion — no fade classes fire and the .bars DOM node is not remounted
    const S: SlideLike = { dir: 'prev', bars: [...PAGED, ...NEXT].map(col), axisWindows: [PAGED, NEXT], moveCols: 6 }
    await w.setProps({ slide: S, stacked: S.bars, windowKey: '2025-11-01..2026-04-30' })
    await nextTick()
    expect(charts()).toHaveLength(1)
    expect(noFade()).toBe(true)
    // the transformed .bars element (the slide's subject) is the very same
    // DOM node — a keyed remount would break the slide's DOM reuse
    const afterBars = w.find('[data-test="trend"]')
    expect(afterBars.element).toBe(barsEl)
    expect(afterBars.classes()).toContain('is-sliding')
    w.unmount()
  })
})

describe('page wiring (Home / view pages, TASK-104 / TASK-115)', () => {
  /** Finish the trend slide at page level: dispatch the transform's
   * transitionend on the .bars row (its single source, design §3-3) so
   * TrendWindow reports finish-slide and the page trims — jsdom never runs
   * the transform transition and the 270ms watchdog is slower than the
   * deterministic event. */
  async function finishTrendSlide(wrapper: Awaited<ReturnType<typeof mountApp>>['wrapper']): Promise<void> {
    const bars = wrapper.find('[data-test="trend"]')
    expect(bars.exists()).toBe(true)
    const end = new Event('transitionend')
    Object.defineProperty(end, 'propertyName', { value: 'transform' })
    bars.element.dispatchEvent(end)
    await settle()
  }

  it('[covers:web-home.trend-window][covers:web-home.trend-window-prefetch] Home月モード: prev押下で旧窓+新窓の連結が挿入されトリムで新窓6本へ（focus不変・analysis/recent/weekは再fetchなし・cacheヒットで表示fetchなし・次の隣接窓prefetch）・nextで復帰・nextは初期窓でdisable', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const analysisSpy = vi.spyOn(api, 'getAnalysis')
    const listSpy = vi.spyOn(api, 'listReceipts')
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/')
    const keys = () => wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    const INIT = ['bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09', 'bar-2026-10']
    const SLID = ['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04']
    expect(keys()).toEqual(INIT)
    // TASK-161 §1-3: the symmetric floor keeps the initial window's next
    // OPEN (the old canNext = offset > 0 pinned it shut — the future pages
    // freely now, all-zero alone floors a direction)
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeUndefined()
    const monthFrom = (from: string) => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'month' && q.from === from)
    const weekCalls = () => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'week')
    const a0 = analysisSpy.mock.calls.length
    const l0 = listSpy.mock.calls.length
    const w0 = weekCalls().length
    // the initial commit prefetched the adjacent page (TASK-115) — the press
    // below is a cache hit
    expect(monthFrom('2025-11-01')).toHaveLength(1)
    await wrapper.find('[data-test="trend-prev"]').trigger('click')
    // during the slide the DOM holds the CONCATENATION — the old window's
    // bars never leave while the new window's flow in (TASK-115 §1-2)
    expect(keys()).toEqual([...SLID, ...INIT])
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(SLID)
    // the cache hit issued no display fetch for the paged window; the only
    // new request is the NEXT adjacent page's prefetch
    expect(monthFrom('2025-11-01'), 'the prefetched page is not re-fetched').toHaveLength(1)
    expect(monthFrom('2025-05-01'), 'the next adjacent prefetch').toHaveLength(1)
    expect(monthFrom('2025-11-01').at(-1)![1]).toMatchObject({
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2025-11-01',
      to: '2026-04-30',
      limit: 5,
    })
    // the window move re-fetches the trend only: the breakdown / recent and
    // the TASK-103 week fetch (load() resident) never re-run
    expect(analysisSpy.mock.calls.length).toBe(a0)
    expect(listSpy.mock.calls.length).toBe(l0)
    expect(weekCalls()).toHaveLength(w0)
    // the focus (period) is untouched by the slide
    const store = (await import('@/web/stores/period')).usePeriodStore()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2026-10')
    // next returns to the initial window (concatenation, then trim) — a cache
    // hit, so the display fetch never re-runs. TASK-161 §1-3: the floor is
    // symmetric, so the recorded window stays open on both sides (the
    // initial window holds records — all-zero alone floors a direction)
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="trend-next"]').trigger('click')
    expect(keys()).toEqual([...SLID, ...INIT])
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(INIT)
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeUndefined()
    expect(monthFrom('2026-05-01'), 'the cached return never re-fetches').toHaveLength(1)
  })

  it('[covers:web-home.trend-window] 時期チップの月切替はE2b最小slide（窓外k<=span）でtrim後は新月近傍の6本・棒押下の窓内focus（E2a）は窓不変', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const keys = () => wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    const store = (await import('@/web/stores/period')).usePeriodStore()
    await wrapper.find('[data-test="trend-prev"]').trigger('click') // page back, the slide is on
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04'])
    // the period chip's month step (2026-10 -> 2026-09) is a k=5 E2b from
    // the paged window (2025-11..2026-04): the window slides its minimum —
    // the union concatenation shows old+new while it moves, the trim leaves
    // the new window's six bars (2026-04..09, September on the right edge —
    // the same shape as September's canonical window)
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(store.month).toBe('2026-09')
    expect(keys()).toEqual(monthsBetween('2025-11-01', '2026-09-30').map((m) => `bar-${m}`))
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(['bar-2026-04', 'bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09'])
    // picking 2026-10 again: k=1 from the window's right edge — the same
    // minimal slide, trimmed to the initial window
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(store.month).toBe('2026-10')
    expect(keys()).toEqual(monthsBetween('2026-04-01', '2026-10-31').map((m) => `bar-${m}`))
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(['bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09', 'bar-2026-10'])
    // a bar press is a focus move (setMonth): bar-2025-12 sits INSIDE the
    // paged window, so the E2a rule keeps the window untouched (TASK-161 §1:
    // the pressed month's neighbours never vanish — the old reset-around-
    // the-press re-anchored instead)
    await wrapper.find('[data-test="trend-prev"]').trigger('click')
    await finishTrendSlide(wrapper)
    await wrapper.find('[data-test="bar-2025-12"]').trigger('click')
    await settle()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2025-12')
    expect(keys()).toEqual(['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04'])
  })

  it('[covers:web-home.trend-window] 年モードは12本のまま12か月分ページ送り（bar-2025-01〜12・連結は24本→トリムで12本）・週・期間モードは前次buttonなし（窓は選択期間・7本日棒のまま）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // Issue #9: a keyed home URL is no longer a cold-start import — the
    // modes are set through the store's own APIs after a plain mount
    const year = await mountApp('/')
    usePeriodStore().setMode('year')
    await settle()
    const ykeys = () => year.wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    expect(ykeys()).toEqual([
      'bar-2026-01',
      'bar-2026-02',
      'bar-2026-03',
      'bar-2026-04',
      'bar-2026-05',
      'bar-2026-06',
      'bar-2026-07',
      'bar-2026-08',
      'bar-2026-09',
      'bar-2026-10',
      'bar-2026-11',
      'bar-2026-12',
    ])
    await year.wrapper.find('[data-test="trend-prev"]').trigger('click')
    // the dense 12+12 concatenation is trimmed to the paged year's 12 bars
    expect(ykeys()).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `bar-2025-${String(i + 1).padStart(2, '0')}`),
      ...Array.from({ length: 12 }, (_, i) => `bar-2026-${String(i + 1).padStart(2, '0')}`),
    ])
    await finishTrendSlide(year.wrapper)
    expect(ykeys()).toEqual([
      'bar-2025-01',
      'bar-2025-02',
      'bar-2025-03',
      'bar-2025-04',
      'bar-2025-05',
      'bar-2025-06',
      'bar-2025-07',
      'bar-2025-08',
      'bar-2025-09',
      'bar-2025-10',
      'bar-2025-11',
      'bar-2025-12',
    ])
    // week / range: the pair never renders and the window stays the period
    for (const path of ['/?week=2026-10-05', '/?from=2026-10-03&to=2026-10-15']) {
      cleanup()
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      const other = await mountApp('/')
      if (path.startsWith('/?week')) usePeriodStore().setWeek('2026-10-05')
      else usePeriodStore().setRange('2026-10-03', '2026-10-15')
      await settle()
      expect(other.wrapper.find('[data-test="trend-prev"]').exists()).toBe(false)
      expect(other.wrapper.find('[data-test="trend-next"]').exists()).toBe(false)
    }
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const week = await mountApp('/')
    usePeriodStore().setWeek('2026-10-05')
    await settle()
    expect(week.wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(7)
  })

  it('[covers:web-home.trend-window][covers:web-home.trend-window-prefetch] AxisDetail は composable watch と route watch の二重発火でも月粒度 trend fetch は表示1回+隣接窓prefetch 1回の計2回（prefetch も subject filters 込みの同一条件）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    await mountApp('/axes/category/1?month=2026-10')
    const monthCalls = () => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'month')
    // TASK-161 §1-2: display + the four prefetches around the window (±span
    // pages both ways + the ±1-month move windows), no double fire
    expect(monthCalls()).toHaveLength(5)
    const display = monthCalls().find(([, q]) => q.from === '2026-05-01')
    const prefetch = monthCalls().find(([, q]) => q.from === '2025-11-01')
    expect(display).toBeDefined()
    expect(prefetch).toBeDefined()
    // the prefetch carries the subject filters verbatim — every condition but
    // the window is shared with the display fetch (toEqual ignores the
    // undefined from/to keys)
    expect({ ...prefetch![1], from: undefined, to: undefined }).toEqual({ ...display![1], from: undefined, to: undefined })
    expect(prefetch![1].to).toBe('2026-04-30')
  })

  // TASK-158 regression (web-common.content-swap): a period step's trend
  // fetch runs independently of the page load (the composable's flush:'sync'
  // focus watch issues it at the press) and can commit BEFORE the pane — the
  // removed windowKey-keyed fade fired in exactly that gap (and again after
  // the pane settled when the order flipped), blanking the chart on every
  // period move (the reported グラフを移動すると色が消える). The gate holds the
  // page's analysis fetch so the trend commit lands first by construction:
  // the chart stays motionless (same .bars node, zero fade classes) and the
  // pane's slide is the move's only motion.
  it('[covers:web-common.content-swap][covers:web-home.trend-window] 期間stepの並走（trend fetchがpane commitより先に確定）: chartはfadeせずbars DOM不変・確定時のpane slideが唯一の演出', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    let gated = false
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const orig = api.getAnalysis.bind(api)
    vi.spyOn(api, 'getAnalysis').mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (gated) await gate
      return orig(...args)
    })
    const { wrapper } = await mountApp('/', { attach: true, stubs: { transition: false } })
    const charts = () => wrapper.findAll('[data-test="trend-card"] .hscroll')
    const bars = () => wrapper.find('[data-test="trend-card"] [data-test="trend"]')
    const noFade = () =>
      charts().every((el) =>
        Array.from(el.element.classList).every((c) => !c.includes('-enter-') && !c.includes('-leave-')),
      )
    expect(noFade()).toBe(true)
    const before = bars().element

    // step into November through the period dialog: the page's load() parks
    // at the gate while the composable's own month-window fetch commits at
    // once — the race, deterministically ordered (trend first)
    gated = true
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    // mid-race: the reload is still pending (dim, the two-stage render) and
    // the chart already committed the new window — un-remounted, no fade
    // classes of its own. The k=1 E2b committed synchronously off the ±1
    // prefetch, so its slide is already assembled: the display array is the
    // union (the six committed months + the entering 2026-11, one graph
    // moving — TASK-161 §1-2; the trim lands on the transitionend)
    expect(wrapper.find('.view-stack').classes()).toContain('loading')
    expect(bars().findAll('.bar-col').map((b) => b.attributes('data-test'))).toEqual(
      monthsBetween('2026-05-01', '2026-11-30').map((m) => `bar-${m}`),
    )
    expect(charts()).toHaveLength(1)
    expect(noFade()).toBe(true)
    expect(bars().element).toBe(before)

    // TASK-161 §2 (web-common.period-move-voice): a period step never
    // remounts the pane anymore — the committedKey drops the period range
    // so the commit renders in place (no slide-forward/back classes on the
    // pane children; the value-level vocabulary owns the change) and the
    // chart's DOM stays identical through it
    release()
    await flushPromises()
    const kids = Array.from(wrapper.find('.view-stack .content-swap').element.children)
    expect(kids.some((el) => el.classList.contains('slide-forward-enter-active'))).toBe(false)
    expect(kids.some((el) => el.classList.contains('slide-back-enter-active'))).toBe(false)
    expect(noFade()).toBe(true)
    await settle()
    expect(wrapper.find('.period-label').text()).toBe('2026年11月')
  })
})

// TASK-161 (design: tmp/tasks/tm-161/design_period_ui.md v2 §1): the window
// becomes an EXPLICIT absolute {from, to} range — the offset/anchor model is
// gone. A focus move INSIDE the committed window (E2a) keeps the window
// untouched (no re-anchor, no re-fetch — the adjacent month's bar stays: the
// §0-2 bug where focusing September killed October's lead); a focus move
// k ≤ span outside it (E2b) slides the MINIMUM k months over the union
// concatenation; a k > span jump (E2c) resets to the canonical window (right
// edge = the new month) in place, no slide. The floor goes symmetric (both
// enabled with no move history; the direction that paged into an all-zero
// window alone disables) and each commit prefetches the ±1-month move
// windows both ways. Test-first: red until the composable revision lands.
describe('useTrendWindow (composable, TASK-161 absolute window)', () => {
  it('[covers:web-home.trend-window-absolute] E2a窓保持: 窓内focus移動はwindowKey不変・表示fetch再発行なし（隣接月barが消えない）・slide不組立 / E2c: 窓外k>spanはslideなしの正規窓reset（右端=新月）', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    const before = callsFrom(trendSpy, 1, '2026-05-01').length
    // E2a: September sits INSIDE the committed window — the window must not
    // re-anchor (the §0-2 mechanism reset the window on every focus change,
    // which is what closed the October lead)
    period.setMonth('2026-09')
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    expect(callsFrom(trendSpy, 1, '2026-05-01').length).toBe(before) // no re-fetch
    expect(win.slide.value).toBeNull()
    // the adjacent bars stay drawn (指摘2: October never disappears)
    expect(win.stacked.value.map((b) => b.key)).toEqual(monthsBetween('2026-05-01', '2026-10-31'))
    // E2c: k > span (popover / URL jump) resets to the canonical window with
    // the new month on the RIGHT edge — no slide, an in-place swap
    period.setMonth('2027-06')
    await settle()
    expect(win.windowKey.value).toBe('2027-01-01..2027-06-30')
    expect(win.slide.value).toBeNull()
  })

  it('[covers:web-home.trend-window-min-slide] E2b最小slide: 窓外k<=spanのfocus移動はkか月の最小slide（旧窓+新月のbucket和集合の連結・trim後は新窓のみで前月は窓内に残る）', async () => {
    const period = usePeriodStore()
    const win = await mountWindow()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    // k=1 into November: the union concatenation (the 6 committed months +
    // the entering 2026-11, duplicated keys kept once) assembles a slide —
    // the old implementation reset the window instead, leaving slide null
    period.setMonth('2026-11')
    await settle()
    expect(win.slide.value).not.toBeNull()
    expect(win.slide.value?.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2026-05-01', '2026-10-31'),
      '2026-11',
    ])
    win.finishSlide()
    await nextTick()
    // the window moved by exactly k=1: the previous month stays inside
    expect(win.window.value).toEqual(['2026-06-01', '2026-11-30'])
    expect(win.stacked.value.map((b) => b.key)).toEqual(monthsBetween('2026-06-01', '2026-11-30'))
  })

  it('[covers:web-home.trend-window-floor] 対称全zero floor: 移動履歴なしの初期状態はcanPrev/canNextともにtrue（絶対窓化でoffset依存条件は廃止）', async () => {
    const win = await mountWindow()
    // no move history: both directions stay available. The old model derived
    // canNext = offset > 0 and disabled the next chevron on the initial
    // window forever — half of the §0-2 lead closing
    expect(win.canPrev.value).toBe(true)
    expect(win.canNext.value).toBe(true)
  })

  it('[covers:web-home.trend-window-prefetch][covers:web-home.trend-window-min-slide] prefetch双方向化: コミット確定後に未来側（±1か月移動窓）もprefetchされ、k=1のfocus移動は再fetchしない', async () => {
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    await mountWindow()
    await settle()
    // TASK-161 §1-2: every commit prefetches the ±1-month MOVE windows (so
    // the E2b k=1 case commits synchronously from cache) — the future side
    // (from=2026-06-01) is new; the old code prefetched the prev side only
    const future = callsFrom(trendSpy, 1, '2026-06-01').length
    expect(future).toBeGreaterThanOrEqual(1)
    // the k=1 focus move then commits from that cache: no additional fetch
    // for the same window
    const period = usePeriodStore()
    period.setMonth('2026-11')
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-06-01').length).toBe(future)
  })
})

// TASK-162 (design: tmp/tasks/tm-162/design_breakdown_stack.md v2 — §1-6/§1-8/
// §2-2, 指摘1/2): the Home breakdown's one-bar assembly helpers. (1)
// stackedOfRows — the analysis-rows-driven pure helper that keeps the TOP 5
// series +「ほか」with the residual closed against the TOTAL (合計 − kept
// sum, never the tail sum + truncated_rows) and the rest count as the number
// of merged CATEGORIES (not transactions); (2) the series key survives the
// assembly and the allocation (the transition identifier — no label/color
// reverse lookup); (3) allocateStack's opts.labelMin — the fold threshold
// that guarantees every drawn segment houses its (at minimum「○…」) label.
// Test-first: red until shared/lib/stackedBars.ts lands them.
describe('stackedOfRows / series key / allocateStack labelMin (TASK-162)', () => {
  /** one analysis row: a category key + label + value */
  const row = (key: number | string | null, label: string, value: number) => ({
    keys: [key],
    labels: [label],
    value,
  })

  it('[covers:web-common.stacked-of-rows] 上位5+「ほか」: 残余=合計−保持系列和（truncated込みで正確）・件数=分類数・値0系列はsegmentなし・空rowsは空', () => {
    // seven rows totalling 1328: the top FIVE stay series segments, the tail
    // 本50+交通30 closes against the total as rest { value: 80, count: 2 }
    const rows = [
      row(1, '食費', 550),
      row(4, '日用品', 398),
      row(7, '交際', 120),
      row(2, '娯楽', 100),
      row(6, '衣服', 80),
      row(3, '本', 50),
      row(5, '交通', 30),
    ]
    const out = stackedOfRows(rows, 1328)
    expect(out.segments.map((s) => s.label)).toEqual(['食費', '日用品', '交際', '娯楽', '衣服'])
    expect(out.rest.value).toBe(1328 - (550 + 398 + 120 + 100 + 80))
    expect(out.rest.count).toBe(2)
    // the residual closes against the TOTAL, not the tail: a total above the
    // rows' sum (records the limit-50 fetch never returned) still lands in
    // the rest value — the tail-sum reading would under-report it; review 中3:
    // the COUNT merges the truncated rows too (the 6 categories the limit-50
    // fetch never returned join the tail's 2 — value-only verification hid it)
    const sparse = stackedOfRows(rows, 1600)
    expect(sparse.rest.value).toBe(1600 - 1248)
    const sparseTruncated = stackedOfRows(rows, 1600, 6)
    expect(sparseTruncated.rest.value).toBe(1600 - 1248)
    expect(sparseTruncated.rest.count).toBe(2 + 6)
    // a value-0 row draws no segment (the existing zero-omission contract)
    const zero = stackedOfRows([row(1, '食費', 550), row(4, '日用品', 0)], 550)
    expect(zero.segments.map((s) => s.label)).toEqual(['食費'])
    expect(zero.rest.value).toBe(0)
    // empty rows: nothing drawn
    expect(stackedOfRows([], 0).segments).toEqual([])
  })

  it('[covers:web-common.stacked-of-rows] 5%未満の上位系列は「ほか」へ合流（value加算・count+1）し次位が繰り上がる', () => {
    // 交際 40/1328 = 3.0% < 5% folds: the kept five promote 本, and the rest
    // gains the folded value AND the folded category count
    const rows = [
      row(1, '食費', 550),
      row(4, '日用品', 398),
      row(7, '交際', 40),
      row(2, '娯楽', 100),
      row(6, '衣服', 80),
      row(3, '本', 90),
      row(5, '交通', 70),
    ]
    const total = 550 + 398 + 40 + 100 + 80 + 90 + 70
    const out = stackedOfRows(rows, total)
    expect(out.segments.map((s) => s.label)).toEqual(['食費', '日用品', '娯楽', '衣服', '本'])
    expect(out.rest.value).toBe(40 + 70)
    expect(out.rest.count).toBe(2)
  })

  it('[covers:web-common.stack-series-key] 系列keyはstackedOf/stackedOfRowsからallocateStack後まで保持（restはkey=null・label/color逆引き禁止の識別子）', () => {
    // stackedOf: each series segment carries the API key as-is (number,
    // string, and the null 未分類), the「ほか」segment is key=null + rest
    const res: AnalysisTrendResult = {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      period: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
      buckets: ['2026-10'],
      series: [
        { key: 1, label: '食費', values: [550], total: 550 },
        { key: null, label: '未分類', values: [100], total: 100 },
        { key: 'coffee', label: 'コーヒー', values: [50], total: 50 },
      ],
      // 750 = the three series' 700 + a 50 residual the limit-5 fetch never
      // returned as a series row — the「ほか」segment this test reads needs
      // one (an exact-sum fixture would omit it)
      bucket_totals: [750],
      truncated_rows: 0,
    }
    const bars = stackedOf(res)
    const segs = bars[0]!.segments
    const byLabel = (label: string) => segs.find((s) => s.label === label)!
    expect(byLabel('食費').key).toBe(1)
    expect(byLabel('コーヒー').key).toBe('coffee')
    expect(byLabel('未分類').key).toBeNull()
    expect(byLabel('未分類').rest).toBeUndefined()
    expect(byLabel('ほか').key).toBeNull()
    expect(byLabel('ほか').rest).toBe(true)
    // the key survives the allocation (the sizes were computed but the
    // identity did not change)
    const allocated = allocateStack(segs, 400)
    expect(allocated.map((s) => s.key)).toEqual(segs.map((s) => s.key))
    // stackedOfRows keeps the row keys the same way
    const out = stackedOfRows([row(1, '食費', 550), row(4, '日用品', 100)], 650)
    expect(out.segments.map((s) => s.key)).toEqual([1, 4])
  })

  it('[covers:web-common.allocate-label-min] opts.labelMin: labelMin未満セグメントはrestへfold（規則B ladderの基準引き上げ）・rule C terminalも同基準・未指定は現行3px規則のまま', () => {
    const seg = (label: string, value: number): StackedSegment => ({ label, value, color: 'var(--series-1)' })
    // (a) the fold ladder: a 20px-at-ratio segment under labelMin 26 folds
    // into the rest; the survivors all clear 26px (the bar's length is 400:
    // 交際's 50/1000 share draws 20px — the original draft's 1000 was the
    // typo its own "20px-at-ratio" comment pins)
    const a = allocateStack(
      [
        seg('食費', 500),
        seg('日用品', 300),
        seg('交際', 50),
        { label: 'ほか', value: 150, color: 'var(--series-rest)', rest: true },
      ],
      400,
      { labelMin: 26 },
    )
    expect(a.map((s) => s.label)).toEqual(['食費', '日用品', 'ほか'])
    expect(a.find((s) => s.label === 'ほか')!.value).toBe(200)
    for (const s of a) expect(s.size).toBeGreaterThanOrEqual(26)
    // (b) rule C at the raised bar: a bar too short for even 1 series + the
    // rest at labelMin (26 x 2 = 52 > 40) collapses to the first series
    // alone (whose label fits — the single-colour terminal carries ITS
    // label). PR#4 review 1: the BAR LENGTH decides this — never the lone
    // series' data-ratio size
    const b = allocateStack(
      [
        seg('食費', 500),
        seg('日用品', 300),
        { label: 'ほか', value: 150, color: 'var(--series-rest)', rest: true },
      ],
      40,
      { labelMin: 26 },
    )
    expect(b).toHaveLength(1)
    expect(b[0]!.label).toBe('食費')
    expect(b[0]!.size).toBeCloseTo(40, 5)
    // (b2) the contrast: a LONG bar (26 x 2 = 52 <= 400) whose lone series
    // sits under labelMin at its data ratio (50/1000 x 400 = 20px) KEEPS the
    // series at its data ratio — the old ratio-basis terminal stretched 食費
    // to the bar's full 400px here, erasing the rest's 95%. The segment's
    // label degrades through the caller's fit logic (verticalSegLabel:
    // truncate, then colour-only) instead
    const b2 = allocateStack(
      [seg('食費', 50), { label: 'ほか', value: 950, color: 'var(--series-rest)', rest: true }],
      400,
      { labelMin: 26 },
    )
    expect(b2.map((s) => s.label)).toEqual(['食費', 'ほか'])
    expect(b2[0]!.size).toBeCloseTo(20, 5)
    expect(b2[0]!.outline).toBe(true) // 20px >= SEG_MIN keeps the outline
    expect(b2[1]!.size).toBeCloseTo(380, 5)
    // (c) labelMin unset: the current SEG_MIN=3 rule stays (backward
    // compatible — horizontal bars / widget keep the old minimums)
    const c = allocateStack([seg('食費', 500), seg('交際', 5)], 1000)
    expect(c.map((s) => s.label)).toEqual(['食費', '交際'])
    expect(c[1]!.size).toBeGreaterThanOrEqual(3)
    expect(c[1]!.size).toBeLessThan(26)
  })
})
