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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrendWindow from '@/web/components/TrendWindow.vue'
import type { StackedBar } from '@/web/components/TrendBars.vue'
import { setDataApi, type AnalysisAxis, type AnalysisTrendResult, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { useTrendWindow } from '@/web/composables/trendWindow'
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
    expect(trendSpy).toHaveBeenCalledTimes(1)
    expect(trendSpy).toHaveBeenCalledWith(1, {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2026-05-01',
      to: '2026-10-31',
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
    // year mode: the anchor is the year's December — offset=0 equals
    // period.range exactly (v2 REVIEW-21 no-regress guarantee)
    period.mode = 'year'
    await settle()
    expect(win.window.value).toEqual(period.range)
    expect(win.window.value).toEqual(['2026-01-01', '2026-12-31'])
    const initialYearMonths = monthsBetween(win.window.value[0], win.window.value[1])
    win.prev()
    await settle()
    expect(win.offset.value).toBe(12)
    expect(win.window.value).toEqual(['2025-01-01', '2025-12-31'])
    expect(initialYearMonths.filter((m) => monthsBetween(win.window.value[0], win.window.value[1]).includes(m))).toEqual(
      [],
    )
    // week / range: inactive — the window stays the selected period itself
    period.setWeek('2026-10-05')
    await settle()
    expect(win.active.value).toBe(false)
    expect(win.window.value).toEqual(['2026-10-05', '2026-10-11'])
    expect(win.granularity.value).toBe('day')
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
    expect(trendSpy).toHaveBeenCalledTimes(1)
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    expect(win.canNext.value).toBe(true)
    win.next()
    await settle()
    // one press pays the whole span back: 6 -> 0 directly, never through an
    // intermediate offset (the page-turn contract, TASK-108 §1-2)
    expect(win.offset.value).toBe(0)
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    // a focus change resets the window to the new month's initial one
    win.prev()
    await settle()
    expect(win.offset.value).toBe(6)
    period.setMonth('2026-09')
    await settle()
    expect(win.offset.value).toBe(0)
    expect(win.window.value).toEqual(['2026-04-01', '2026-09-30'])
    expect(trendSpy).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-04-01', to: '2026-09-30' }))
    // the label query rides the fetch and resets the offset too
    win.prev()
    await settle()
    period.setLabelColors(['red'])
    await settle()
    expect(win.offset.value).toBe(0)
    expect(trendSpy).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    // a ledger switch resets as well and fetches the new ledger (the window
    // stays anchored to the CURRENT selected month — September here)
    win.prev()
    await settle()
    useSessionStore().selectedLedgerId = 2
    await settle()
    expect(win.offset.value).toBe(0)
    expect(trendSpy).toHaveBeenLastCalledWith(2, expect.objectContaining({ from: '2026-04-01', to: '2026-09-30' }))
  })

  it('[covers:web-home.trend-window] refreshの冪等ガード: 最終成功fetch・進行中fetchと同一引数の再発行はskip（AxisDetailの二重発火でも実fetch1回）', async () => {
    // bind the real method before the spy: the in-flight gate below calls it
    const orig = api.getAnalysisTrend.bind(api)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = await mountWindow()
    expect(trendSpy).toHaveBeenCalledTimes(1)
    // the same args as the last successful fetch: no re-issue
    win.refresh()
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(1)
    // while a fetch is in flight, the identical re-fire is skipped too —
    // AxisDetail's route watch fires alongside the composable's own watch
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    usePeriodStore().setMonth('2026-09')
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(2) // the new window's fetch, in flight
    win.refresh()
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(2) // identical to the in-flight args
    release()
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(2)
    // completed now: another identical refresh stays skipped
    win.refresh()
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(2)
  })

  it('[covers:web-home.trend-window] ledger未確定（selectedLedgerId=null）ではfetchしない・確定（null→id）で初回fetch', async () => {
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = useTrendWindow({ axis: () => 'category' })
    await settle() // the immediate watch already fired with no ledger
    expect(trendSpy).not.toHaveBeenCalled()
    expect(win.result.value).toBeNull()
    useSessionStore().selectedLedgerId = 1
    await settle()
    expect(trendSpy).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-home.trend-window-slide] windowKey・direction・transitionName: 初回fetchまでkey=null（TrendBarsのv-if源）・確定でkeyは<from>..<to>と即時描画のname空文字・同窓再fetchでkey不変・prev/nextは方向別name・focus変更は直近方向を継承・連打は最終窓のみ採用・nextはspan未満offsetを0へクランプ', async () => {
    const period = usePeriodStore()
    // bind the real method before the spy: the in-flight gate below calls it
    const orig = api.getAnalysisTrend.bind(api)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const win = useTrendWindow({ axis: () => 'category' })
    // before the first response the committed window is null (the v-if gate
    // source) and the transition name is '' — nothing has been painted yet
    expect(win.windowKey.value).toBe(null)
    expect(win.transitionName.value).toBe('')
    useSessionStore().selectedLedgerId = 1
    await settle()
    // the first commit is the range identity (label_colors never in it) and
    // the very first insertion paints instantly: no slide (slideReady stays
    // false through the null -> value change, TASK-108 §1-4)
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.transitionName.value).toBe('')
    // a same-window refetch (label_colors added) really re-fetches but keeps
    // the key: a recolour of the same window never slides
    period.setLabelColors(['red'])
    await settle()
    expect(trendSpy).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.transitionName.value).toBe('')
    // prev: the direction is recorded, the key becomes the new page's range
    // and the name turns direction-specific
    win.prev()
    await settle()
    expect(win.direction.value).toBe('prev')
    expect(win.offset.value).toBe(6)
    expect(win.windowKey.value).toBe('2025-11-01..2026-04-30')
    expect(win.transitionName.value).toBe('trend-slide-back')
    // next: the mirrored pair
    win.next()
    await settle()
    expect(win.direction.value).toBe('next')
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.transitionName.value).toBe('trend-slide-forward')
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
    // (the bars never leave the last committed window) and inherits the last
    // recorded direction (no per-focus direction estimation, §1-3)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    trendSpy.mockImplementation(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    period.setMonth('2026-09')
    await settle()
    expect(win.windowKey.value).toBe('2026-05-01..2026-10-31')
    expect(win.transitionName.value).toBe('trend-slide-forward')
    release()
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
    expect(win.transitionName.value).toBe('trend-slide-forward')
    // a double prev fires two fetches; the seq guard keeps only the last —
    // the committed key is the offset=12 page, swapped in once (the page is
    // anchored to September, the month set above: 2025-04..2025-09)
    win.prev()
    win.prev()
    await settle()
    expect(win.offset.value).toBe(12)
    expect(win.windowKey.value).toBe('2025-04-01..2025-09-30')
    expect(win.transitionName.value).toBe('trend-slide-back')
    // the Math.max clamp guard: a hypothetical sub-span offset (only reachable
    // by a future change) still returns to 0 in one press
    win.offset.value = 3
    win.next()
    expect(win.offset.value).toBe(0)
    await settle()
    expect(win.windowKey.value).toBe('2026-04-01..2026-09-30')
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
    // against the zero-filling endpoint)
    win.prev()
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
  it('prev発行中にnextで初期窓へ戻る: cache復帰のguardはpending fetchを無効化しstale responseでchartを置き換えない（PR#1 P2）', async () => {
    const win = await mountWindow()
    const initial = win.result.value
    expect(initial).not.toBeNull()
    // window B's fetch hangs until released
    const stale: AnalysisTrendResult = { ...initial!, buckets: ['stale-window'] }
    let release!: (v: AnalysisTrendResult) => void
    vi.spyOn(api, 'getAnalysisTrend').mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    )
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
})

describe('TrendWindow (component, TASK-104)', () => {
  const COL: StackedBar = {
    key: '2026-10',
    title: '2026年10月 948円',
    total: 948,
    segments: [
      { label: '食費', value: 550, color: 'var(--c1)' },
      { label: '日用品', value: 398, color: 'var(--c2)' },
    ],
  }

  it('[covers:web-home.trend-window] 前次button対（aria-label「前の範囲」「次の範囲」・.trend-nav・disabled受け渡し・select再送出）・windowKey=nullでTrendBars未描画（v-ifゲート）・値で描画・nav=falseでbutton非表示', async () => {
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: false,
        canNext: true,
        windowKey: '2026-05-01..2026-10-31',
        transitionName: '',
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
    // them (both directions pinned — the transition class checks live in the
    // browser spec, @vue/test-utils cannot advance a real transition)
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
})

describe('page wiring (Home / view pages, TASK-104)', () => {
  it('[covers:web-home.trend-window] Home月モード: prev押下で棒key群が窓幅（6か月）ページ送りされfocus不変・analysis/recentとweek fetchは走らない・nextは初期窓でdisable', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const analysisSpy = vi.spyOn(api, 'getAnalysis')
    const listSpy = vi.spyOn(api, 'listReceipts')
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/')
    const keys = () => wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    const INIT = ['bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09', 'bar-2026-10']
    expect(keys()).toEqual(INIT)
    // the initial window offers no future slide
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeDefined()
    const monthCalls = () => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'month')
    const weekCalls = () => trendSpy.mock.calls.filter(([, q]) => q.granularity === 'week')
    const a0 = analysisSpy.mock.calls.length
    const l0 = listSpy.mock.calls.length
    const w0 = weekCalls().length
    await wrapper.find('[data-test="trend-prev"]').trigger('click')
    await settle()
    expect(keys()).toEqual(['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04'])
    expect(monthCalls()).toHaveLength(2)
    expect(monthCalls().at(-1)![1]).toMatchObject({
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
    // next returns to the initial window and disables again
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="trend-next"]').trigger('click')
    await settle()
    expect(keys()).toEqual(INIT)
    expect(wrapper.find('[data-test="trend-next"]').attributes('disabled')).toBeDefined()
  })

  it('[covers:web-home.trend-window] 時期チップの月切替と棒押下はfocus移動として窓を初期化（offset リセット）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const keys = () => wrapper.findAll('[data-test="trend-card"] .bar-col').map((b) => b.attributes('data-test'))
    const store = (await import('@/web/stores/period')).usePeriodStore()
    await wrapper.find('[data-test="trend-prev"]').trigger('click') // offset=6
    await settle()
    // the period chip's month step (2026-10 -> 2026-09) resets the window to
    // September's initial one — the offset did not survive the focus change
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
    await settle()
    await wrapper.find('[data-test="bar-2025-12"]').trigger('click')
    await settle()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2025-12')
    expect(keys()).toEqual(['bar-2025-07', 'bar-2025-08', 'bar-2025-09', 'bar-2025-10', 'bar-2025-11', 'bar-2025-12'])
  })

  it('[covers:web-home.trend-window] 年モードは12本のまま12か月分ページ送り（bar-2025-01〜12）・週・期間モードは前次buttonなし（窓は選択期間・7本日棒のまま）', async () => {
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
    await settle()
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

  it('[covers:web-home.trend-window] AxisDetail は composable watch と route watch の二重発火でも月粒度 trend fetch は1回（呼び出し総数は現行と同一）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    await mountApp('/axes/category/1?month=2026-10')
    expect(trendSpy.mock.calls.filter(([, q]) => q.granularity === 'month')).toHaveLength(1)
  })
})
