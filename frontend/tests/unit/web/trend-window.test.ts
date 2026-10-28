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
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrendWindow from '@/web/components/TrendWindow.vue'
import type { StackedBar } from '@/web/components/TrendBars.vue'
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
    expect(win.offset.value).toBe(0)
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
    // TASK-108: prev turns the whole page — offset += span (month 6): the
    // window swaps to 2025-11..2026-04, sharing no month with the page before
    const initialMonths = monthsBetween(win.window.value[0], win.window.value[1])
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(
      initialMonths.filter((m) => monthsBetween(win.window.value[0], win.window.value[1]).includes(m)),
      'a page never overlaps the one before it',
    ).toEqual([])
    // the paged-to window was prefetched, so the press is a cache hit: no
    // re-fetch of 2025-11 — the only new call is the NEXT adjacent prefetch
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'the prefetched window is not re-fetched').toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-05-01')).toHaveLength(1)
    // year mode: the anchor is the year's December — offset=0 equals
    // period.range exactly (v2 REVIEW-21 no-regress guarantee)
    period.mode = 'year'
    await settle()
    expect(win.window.value).toEqual(period.range)
    expect(win.window.value).toEqual(['2026-01-01', '2026-12-31'])
    expect(callsFrom(trendSpy, 1, '2026-01-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-01-01')).toHaveLength(1) // the year window's prev-adjacent prefetch
    const initialYearMonths = monthsBetween(win.window.value[0], win.window.value[1])
    win.prev()
    await settle()
    expect(win.offset.value).toBe(12)
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

  it('[covers:web-home.trend-window] offset操作: nextはoffset=0で無効（canNext=offset>0・未来方向なし）・prev→offset=6・next→0へ一発復帰（span刻み・中間offset非経由）・focus変更（月・ラベル・家計簿）でoffset=0リセット', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    // the initial window offers no future slide: next is a no-op at 0
    expect(win.canNext.value).toBe(false)
    win.next()
    await settle()
    expect(win.offset.value).toBe(0)
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.canNext.value).toBe(true)
    // TASK-115: the press hit the prefetched cache — the window itself was
    // not re-fetched (only the next adjacent prefetch appears)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    win.next()
    await settle()
    // one press pays the whole span back: 6 -> 0 directly, never through an
    // intermediate offset (the page-turn contract, TASK-108 §1-2)
    expect(win.offset.value).toBe(0)
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1) // the cache return never re-fetches
    // a focus change resets the window to the new month's initial one
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    period.setMonth('2026-09')
    await settle()
    expect(win.offset.value).toBe(0)
    expect(win.window.value).toEqual(['2026-04-01', '2026-09-30'])
    expect(callsFrom(trendSpy, 1, '2026-04-01').at(-1)![1]).toMatchObject({ from: '2026-04-01', to: '2026-09-30' })
    // the label query rides the fetch and resets the offset too
    win.prev()
    await settle()
    period.setLabelColors(['red'])
    await settle()
    expect(win.offset.value).toBe(0)
    expect(callsFrom(trendSpy, 1, '2026-04-01').at(-1)![1]).toMatchObject({ label_colors: ['red'] })
    // a ledger switch resets as well and fetches the new ledger (the window
    // stays anchored to the CURRENT selected month — September here)
    win.prev()
    await settle()
    useSessionStore().selectedLedgerId = 2
    await settle()
    expect(win.offset.value).toBe(0)
    expect(callsFrom(trendSpy, 2, '2026-04-01').at(-1)![1]).toMatchObject({ from: '2026-04-01', to: '2026-09-30' })
  })

  it('[covers:web-home.trend-window] refreshの冪等ガード: 最終成功fetch・進行中fetchと同一引数の再発行はskip（AxisDetailの二重発火でも実fetch1回）', async () => {
    // bind the real method before the spy: the in-flight gate below calls it
    const orig = api.getAnalysisTrend.bind(api)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    // the same args as the last successful fetch: no re-issue
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    // while a fetch is in flight, the identical re-fire is skipped too —
    // AxisDetail's route watch fires alongside the composable's own watch.
    // TASK-115: the gate lets ONLY the display window's from through it —
    // the commit's prefetch (a different from) must never stick in the gate
    // (design §5-1)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (args[1]!.from === '2026-04-01') await gate
      return orig(...args)
    })
    usePeriodStore().setMonth('2026-09')
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-04-01')).toHaveLength(1) // the new window's fetch, in flight
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-04-01')).toHaveLength(1) // identical to the in-flight args
    release()
    await settle()
    // the gated display commit landed; its prefetch of the adjacent window
    // (2025-10..2026-03) went through ungated — counted by from, exactly once
    expect(callsFrom(trendSpy, 1, '2026-04-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-10-01')).toHaveLength(1)
    // completed now: another identical refresh stays skipped
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-04-01')).toHaveLength(1)
  })

  it('[covers:web-home.trend-window] ledger未確定（selectedLedgerId=null）ではfetchしない（prefetchもしない）・確定（null→id）で初回fetch+隣接窓prefetch', async () => {
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = useTrendWindow({ axis: () => 'category' })
    await settle() // the immediate watch already fired with no ledger
    expect(trendSpy).not.toHaveBeenCalled()
    expect(win.result.value).toBeNull()
    useSessionStore().selectedLedgerId = 1
    await settle()
    // TASK-115: the first commit brings the display fetch AND the first
    // prev-adjacent prefetch — two calls, one window each
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    expect(trendSpy).toHaveBeenCalledTimes(2)
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
    expect(win.offset.value).toBe(6)
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
    // the guards record no direction and fire no fetch (a disable-state
    // press never moves the window — the §1-2 contract)
    const calls = trendSpy.mock.calls.length
    win.next() // offset=0: no-op
    win.canPrev.value = false
    win.prev()
    win.canPrev.value = true
    await settle()
    expect(win.direction.value).toBe('next')
    expect(trendSpy.mock.calls.length).toBe(calls)
    // a focus change mid-fetch keeps the OLD key until the response lands
    // (the bars never leave the last committed window) — and when it lands
    // the commit does NOT assemble a slide: the flush cleared the request
    // (TASK-115 M1: focus changes never slide — the direction inheritance
    // of the out-in era is gone)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (args[1]!.from === '2026-04-01') await gate // only the display window gates
      return orig(...args)
    })
    period.setMonth('2026-09')
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    release()
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.slide.value).toBeNull()
    // a double prev fires two fetches; the seq guard keeps only the last —
    // the committed key is the offset=12 page, swapped in once (the page is
    // anchored to September, the month set above: 2025-04..2025-09). The
    // finished slide is the LAST press's concatenation
    win.prev()
    win.prev()
    await settle()
    expect(win.offset.value).toBe(12)
    expect(win.windowKey.value).toBe('2025-04-01..2025-09-30')
    expect(win.slide.value?.dir).toBe('prev')
    expect(win.slide.value!.bars.map((b) => b.key)).toEqual([
      ...monthsBetween('2025-04-01', '2025-09-30'),
      ...monthsBetween('2025-10-01', '2026-03-31'),
    ])
    win.finishSlide()
    // the Math.max clamp guard: a hypothetical sub-span offset (only reachable
    // by a future change) still returns to 0 in one press — and being a
    // next-press window change it slides [old, new]
    win.offset.value = 3
    win.next()
    expect(win.offset.value).toBe(0)
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.slide.value?.dir).toBe('next')
    win.finishSlide()
  })

  // TASK-105 (web-home.trend-window description revised — the window /
  // offset / fetch expectations above and below stay untouched, design
  // §4-1): the stacked assembly reads `seriesColor(s.key, axis)` instead of
  // the old PALETTE array — for this fixture's series keys 0..4 the colors
  // become ['var(--series-7)', 'var(--series-1)', 'var(--series-2)',
  // 'var(--series-3)', 'var(--series-4)'] (key 0: (0-1 mod 7 + 7) % 7 = 6)
  // and the residual「ほか」segment var(--series-rest); value-0 series
  // segments are omitted from the assembly (the zero bucket below then
  // holds only the >0 series); the PALETTE constant itself is gone from
  // trendWindow.ts.
  it('[covers:web-home.trend-window] stacked組立はcomposable集約: series上位5+残余「ほか」segment+色はseriesColor(s.key, axis)写像（残余は--series-rest・値0セグメント省略・ゼロ窓は残余なし）', async () => {
    // seven series in the endpoint's total order: the top five keep their
    // seriesColor slot, the tail (20 + 10) folds into the grey rest segment
    const res: AnalysisTrendResult = {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      period: { from: '2026-05-01', to: '2026-10-31', label: '' },
      buckets: ['2026-05', '2026-06'],
      series: [70, 60, 50, 40, 30, 20, 10].map((v, i) => ({
        key: i,
        label: `s${i}`,
        values: [v, 0],
        total: v,
      })),
      bucket_totals: [280, 0],
      truncated_rows: 0,
    }
    vi.spyOn(api, 'getAnalysisTrend').mockResolvedValue(res)
    const win = await mountWindow()
    expect(win.result.value).toBe(res)
    type Seg = StackedBar['segments'][number]
    expect(win.stacked.value.map((c: StackedBar) => c.key)).toEqual(['2026-05', '2026-06'])
    const segs = win.stacked.value[0]!.segments
    expect(segs.map((s: Seg) => s.label)).toEqual(['s0', 's1', 's2', 's3', 's4', 'ほか'])
    expect(segs.map((s: Seg) => s.color)).toEqual([
      'var(--series-7)', // key 0: ((0-1) mod 7 + 7) % 7 = 6
      'var(--series-1)',
      'var(--series-2)',
      'var(--series-3)',
      'var(--series-4)',
      'var(--series-rest)',
    ])
    expect(segs.at(-1)!.value).toBe(30)
    // a zero bucket renders no segment at all: every top series holds 0 and
    // the omitted value-0 assembly leaves the column empty (no rest either)
    expect(win.stacked.value[1]!.segments.map((s: Seg) => s.label)).toEqual([])
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
    // page 2 (offset=6): the 2025-12 record keeps the bucket total > 0 —
    // prev stays enabled (the old offset=1..4 walk collapses into this page)
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.canPrev.value).toBe(true)
    // page 3 (offset=12) is all zero: prev disables (the practical floor
    // against the zero-filling endpoint). TASK-115: the page was prefetched
    // and cached, so the press commits the cached result at once — canPrev
    // recomputes on the very same expression IMMEDIATELY (no fetch wait)
    win.prev()
    expect(win.canPrev.value).toBe(false)
    await settle()
    expect(win.offset.value).toBe(12)
    expect(win.window.value).toEqual(['2025-05-01', '2025-10-31'])
    expect(win.canPrev.value).toBe(false)
    // next returns to the 2025-12 page and prev re-enables
    win.next()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.canPrev.value).toBe(true)
    // an all-zero INITIAL window (2025-04 selected: 2024-11..2025-04) never
    // disables prev — a record-less month must still show the months before
    period.setMonth('2025-04')
    await settle()
    expect(win.window.value).toEqual(['2024-11-01', '2025-04-30'])
    expect(win.canPrev.value).toBe(true)
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.window.value).toEqual(['2024-05-01', '2024-10-31'])
    expect(win.canPrev.value).toBe(false) // the paged-to window is all zero
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
    expect(win.offset.value).toBe(0)
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

  it('[covers:web-home.trend-window][covers:web-home.trend-window-prefetch] 窓cacheのflush: mode/range/labelQuery/家計簿の各変更と復帰でcache・prefetch発行済みがクリアされ同じ窓でも再fetchする', async () => {
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
    // range source (setMonth): 2026-09 -> 2026-10
    period.setMonth('2026-09')
    await settle()
    period.setMonth('2026-10')
    await settle()
    expect(disp('2026-05-01')).toHaveLength(4)
    expect(disp('2025-11-01')).toHaveLength(4)
    // labelQuery: red -> none -> red. The second red phase returns to the
    // EXACT key of the first — only a cache clear makes it fetch again
    const redDisp = (from: string) =>
      trendSpy.mock.calls.filter(([l, q]) => l === 1 && q.from === from && q.label_colors?.[0] === 'red')
    period.setLabelColors(['red'])
    await settle()
    period.setLabelColors([])
    await settle()
    period.setLabelColors(['red'])
    await settle()
    expect(redDisp('2026-05-01'), 'the label return re-fetches (cache flushed)').toHaveLength(2)
    expect(redDisp('2025-11-01')).toHaveLength(2)
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
    expect(win.offset.value).toBe(6)
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
      if (failAdjacent && args[1]!.from === '2025-10-01') throw new Error('prefetch failed')
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
    // a same-args re-commit (refresh) re-issues neither display nor prefetch
    win.refresh()
    await settle()
    expect(callsFrom(trendSpy, 1, '2026-05-01')).toHaveLength(1)
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    // cached windows are never prefetched again: prev's cache-hit commit
    // prefetches the NEXT adjacent page (2025-05), then next's commit finds
    // the first adjacent page cached+issued and skips it
    win.prev()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-05-01')).toHaveLength(1)
    win.next()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01')).toHaveLength(1)
    win.prev()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-11-01'), 'the cached page is not re-fetched nor re-prefetched').toHaveLength(1)
    // a rejected prefetch is silent: no loading, no onError, the display is
    // untouched — and the failed key is retried on the NEXT commit
    failAdjacent = true
    period.setMonth('2026-09')
    await settle()
    expect(win.loading.value).toBe(false)
    expect(onError).not.toHaveBeenCalled()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(callsFrom(trendSpy, 1, '2025-10-01')).toHaveLength(1) // tried once, failed
    failAdjacent = false
    period.setMonth('2026-10')
    await settle()
    period.setMonth('2026-09')
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-10-01')).toHaveLength(2) // retried and landed
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

  it('[covers:web-home.trend-window-slide] スライド中のfocus変更: flushでslide即null化・slideRequestもクリア（確定コミットでもslide不発火）・cacheもクリア', async () => {
    const period = usePeriodStore()
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    win.prev()
    expect(win.slide.value).not.toBeNull()
    // a month-chip focus change flushes mid-slide: the slide is gone at once
    period.setMonth('2026-09')
    expect(win.slide.value).toBeNull()
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.slide.value, 'the focus commit never assembles a slide').toBeNull()
    // the same for a label switch mid-slide (the other flush source)
    win.prev()
    expect(win.slide.value).not.toBeNull()
    period.setLabelColors(['red'])
    expect(win.slide.value).toBeNull()
    await settle()
    expect(win.slide.value).toBeNull()
    // the flush also cleared the cache: returning to the RED key fetched a
    // moment ago re-fetches it instead of serving the earlier response
    period.setLabelColors([])
    await settle()
    period.setLabelColors(['red'])
    await settle()
    const redApril = trendSpy.mock.calls.filter(
      ([l, q]) => l === 1 && q.from === '2026-04-01' && q.label_colors?.[0] === 'red',
    )
    expect(redApril, 'the flushed cache re-fetches on return').toHaveLength(2)
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
    // a focus change: the key changes but the request was cleared — no slide
    period.setLabelColors([])
    await settle()
    period.setMonth('2026-09')
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.slide.value).toBeNull()
    // the CONTRAST: a prev/next round trip on the cached September windows
    // assembles slides with no display fetch at all
    const adjacent = callsFrom(trendSpy, 1, '2025-10-01').length // the September prefetch
    win.prev()
    expect(win.slide.value).not.toBeNull()
    win.finishSlide()
    win.next()
    expect(win.slide.value).not.toBeNull()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    win.finishSlide()
    await settle()
    expect(callsFrom(trendSpy, 1, '2025-10-01'), 'no display fetch beyond the prefetch').toHaveLength(adjacent)
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

  /** a slide state shaped as the composable's SlideState (TASK-115 §3-1) —
   * the structural contract the wrapper consumes: dir + the concatenated
   * bars + the per-window bucket keys for the axis computation */
  interface SlideLike {
    dir: 'prev' | 'next'
    bars: StackedBar[]
    axisWindows: string[][]
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
    const slide: SlideLike = { dir: 'prev', bars: [...NEW, ...OLD].map(col), axisWindows: [NEW, OLD] }
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
    // the initial window offers no future slide
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeDefined()
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
    // next returns to the initial window (concatenation, then trim) and
    // disables again — a cache hit, so the display fetch never re-runs
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="trend-next"]').trigger('click')
    expect(keys()).toEqual([...SLID, ...INIT])
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(INIT)
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeDefined()
    expect(monthFrom('2026-05-01'), 'the cached return never re-fetches').toHaveLength(1)
  })

  it('[covers:web-home.trend-window] 時期チップの月切替と棒押下はfocus移動として窓を初期化（offset リセット・slideなしの即時差し替え）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const keys = () => wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    const store = (await import('@/web/stores/period')).usePeriodStore()
    await wrapper.find('[data-test="trend-prev"]').trigger('click') // offset=6, the slide is on
    await finishTrendSlide(wrapper)
    expect(keys()).toEqual(['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04'])
    // the period chip's month step (2026-10 -> 2026-09) resets the window to
    // September's initial one — the offset did not survive the focus change,
    // and TASK-115 swaps the chart in instantly (exactly six bars, never a
    // concatenation: a focus change never slides)
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(store.month).toBe('2026-09')
    expect(keys()).toEqual(['bar-2026-04', 'bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09'])
    // picking 2026-10 again restores the initial window
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(store.month).toBe('2026-10')
    expect(keys()).toEqual(['bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09', 'bar-2026-10'])
    // a bar press is a focus move (setMonth): the window resets around the
    // pressed month even from a paged position — bar-2025-12 sits inside the
    // paged window (2025-11..2026-04), a month clearly outside the initial
    // one (TASK-108 §4-8: the old bar-2026-04 press landed on the window
    // edge, where the reset's before/after were indistinguishable)
    await wrapper.find('[data-test="trend-prev"]').trigger('click')
    await finishTrendSlide(wrapper)
    await wrapper.find('[data-test="bar-2025-12"]').trigger('click')
    await settle()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2025-12')
    expect(keys()).toEqual(['bar-2025-07', 'bar-2025-08', 'bar-2025-09', 'bar-2025-10', 'bar-2025-11', 'bar-2025-12'])
  })

  it('[covers:web-home.trend-window] 年モードは12本のまま12か月分ページ送り（bar-2025-01〜12・連結は24本→トリムで12本）・週・期間モードは前次buttonなし（窓は選択期間・7本日棒のまま）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const year = await mountApp('/?year=2026')
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
      const other = await mountApp(path)
      expect(other.wrapper.find('[data-test="trend-prev"]').exists()).toBe(false)
      expect(other.wrapper.find('[data-test="trend-next"]').exists()).toBe(false)
    }
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const week = await mountApp('/?week=2026-10-05')
    expect(week.wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(7)
  })

  it('[covers:web-home.trend-window][covers:web-home.trend-window-prefetch] AxisDetail は composable watch と route watch の二重発火でも月粒度 trend fetch は表示1回+隣接窓prefetch 1回の計2回（prefetch も subject filters 込みの同一条件）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    await mountApp('/axes/category/1?month=2026-10')
    const monthCalls = () => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'month')
    expect(monthCalls()).toHaveLength(2) // display + the adjacent prefetch, no double fire
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
})
