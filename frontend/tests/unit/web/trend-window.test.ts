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

describe('useTrendWindow (composable, TASK-104)', () => {
  it('[covers:web-home.trend-window] 窓計算: month初期窓はtrendQuery(5)と一致・offset=1で両端1か月過去・yearは12か月でperiod.rangeと一致（anchor右端12月）・week/rangeは選択期間のまま', async () => {
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
    // offset=1: both edges move one month into the past
    win.prev()
    await settle()
    expect(win.offset.value).toBe(1)
    expect(win.window.value).toEqual(['2026-04-01', '2026-09-30'])
    // year mode: the anchor is the year's December — offset=0 equals
    // period.range exactly (v2 REVIEW-21 no-regress guarantee)
    period.mode = 'year'
    await settle()
    expect(win.window.value).toEqual(period.range)
    expect(win.window.value).toEqual(['2026-01-01', '2026-12-31'])
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-12-01', '2026-11-30'])
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

  it('[covers:web-home.trend-window] offset操作: nextはoffset=0で無効（canNext=offset>0・未来方向なし）・focus変更（月・ラベル・家計簿）でoffset=0リセット', async () => {
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
    expect(win.canNext.value).toBe(true)
    win.next()
    await settle()
    expect(win.offset.value).toBe(0)
    expect(win.window.value).toEqual(['2026-05-01', '2026-10-31'])
    // a focus change resets the window to the new month's initial one
    win.prev()
    await settle()
    expect(win.offset.value).toBe(1)
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

  it('[covers:web-home.trend-window] stacked組立はcomposable集約: series上位5+残余「ほか」segment+PALETTE割当（--c1〜c5・残余は--c-rest・ゼロ窓は残余なし）', async () => {
    // seven series in the endpoint's total order: the top five keep the
    // palette, the tail (20 + 10) folds into the grey rest segment
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
      'var(--c1)',
      'var(--c2)',
      'var(--c3)',
      'var(--c4)',
      'var(--c5)',
      'var(--c-rest)',
    ])
    expect(segs.at(-1)!.value).toBe(30)
    // a zero bucket keeps the five series cells but grows no rest segment
    expect(win.stacked.value[1]!.segments.map((s: Seg) => s.label)).toEqual(['s0', 's1', 's2', 's3', 's4'])
  })

  it('[covers:web-home.trend-window-floor] 全0打ち切り: offset>=1の窓が総和0でprev disable・nextで復帰・初期窓（offset=0）の全0ではdisableしない', async () => {
    // records in 2026-06 and 2026-10 only: every window through offset=4
    // still holds June; the offset=5 window (2025-12..2026-05) is all zero
    await api.updateReceipt(1, 102, { revision: 1, set: { purchased_on: '2026-06-15' } })
    const period = usePeriodStore()
    const win = await mountWindow()
    expect(win.canPrev.value).toBe(true)
    for (let offset = 1; offset <= 4; offset++) {
      win.prev()
      await settle()
      expect(win.offset.value).toBe(offset)
      expect(win.canPrev.value, `offset=${offset}`).toBe(true)
    }
    // offset=5: the all-zero window shows and prev disables (the practical
    // floor against the zero-filling endpoint)
    win.prev()
    await settle()
    expect(win.window.value).toEqual(['2025-12-01', '2026-05-31'])
    expect(win.canPrev.value).toBe(false)
    // next returns to the June window and prev re-enables
    win.next()
    await settle()
    expect(win.offset.value).toBe(4)
    expect(win.canPrev.value).toBe(true)
    // an all-zero INITIAL window (2026-04 selected, records in 06/10) never
    // disables prev — a record-less month must still show the months before
    period.setMonth('2026-04')
    await settle()
    expect(win.window.value).toEqual(['2025-11-01', '2026-04-30'])
    expect(win.canPrev.value).toBe(true)
    win.prev()
    await settle()
    expect(win.offset.value).toBe(1)
    expect(win.canPrev.value).toBe(false) // the slid-to window is all zero
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

  it('[covers:web-home.trend-window] 前次button対（aria-label「前の範囲」「次の範囲」・.trend-nav・disabled受け渡し・select再送出）・nav=falseでbutton非表示', async () => {
    const w = mount(TrendWindow, {
      props: {
        nav: true,
        canPrev: false,
        canNext: true,
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
    // week / range screens pass nav=false: the pair is gone, the bars stay
    await w.setProps({ nav: false })
    expect(w.find('[data-test="trend-prev"]').exists()).toBe(false)
    expect(w.find('[data-test="trend-next"]').exists()).toBe(false)
    expect(w.find('[data-test="trend"]').exists()).toBe(true)
  })
})

describe('page wiring (Home / view pages, TASK-104)', () => {
  it('[covers:web-home.trend-window] Home月モード: prev押下で棒key群が1か月スライドしfocus不変・analysis/recentとweek fetchは走らない・nextは初期窓でdisable', async () => {
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
    expect(keys()).toEqual(['bar-2026-04', 'bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09'])
    expect(monthCalls()).toHaveLength(2)
    expect(monthCalls().at(-1)![1]).toMatchObject({
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2026-04-01',
      to: '2026-09-30',
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
    await wrapper.find('[data-test="trend-prev"]').trigger('click') // offset=1
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
    // pressed month even from a slid position
    await wrapper.find('[data-test="trend-prev"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="bar-2026-04"]').trigger('click')
    await settle()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2026-04')
    expect(keys()).toEqual(['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04'])
  })

  it('[covers:web-home.trend-window] 年モードは12本のまま1か月スライド・週・期間モードは前次buttonなし（窓は選択期間・7本日棒のまま）', async () => {
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
      'bar-2025-12',
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
