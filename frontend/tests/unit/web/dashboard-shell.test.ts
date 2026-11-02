import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PeriodHeader from '@/web/components/PeriodHeader.vue'
import RankedList from '@/web/components/RankedList.vue'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, fireMediaChange, mockFetch, mountApp, patchTrackWidth, setMediaMatches, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

describe('HomePage (dashboard, TASK-89 redesign)', () => {
  it('[covers:web-home.period-header] 期間ヘッダ: 期間label+特大合計のみ（対比・diff・KPIカード形式なし）でanalysis は1fetch', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/')
    // the four loads (TASK-103 adds the month-mode week fetch): the category
    // analysis (the period header total and the breakdown), the stacked
    // trend, the week rows and the recent receipts
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(1, { axis: 'category', metric: 'amount', month: '2026-10', limit: 50 })
    expect(trendSpy).toHaveBeenCalledWith(1, {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2026-05-01',
      to: '2026-10-31',
      limit: 5,
    })
    // TASK-103: the month mode's fourth load — the selected month's week
    // buckets. TASK-116 (design §3-1): the week rows carry the series
    // breakdown now, so the fetch lifts limit 1 -> 5 (top-5 series + the
    // bucket_totals the row amounts read). TASK-146 §2: the range crosses the
    // month now — the Monday of the week holding the 1st (2026-09-28) through
    // the Sunday of the week holding the 31st (2026-11-01), so every row is a
    // full 7-day week.
    // TASK-115 §3-2 (design tmp/tasks/tm-115/design_trend-continuous-window.md):
    // the month window's initial commit prefetches its prev-adjacent window
    // (from=2025-11-01 — trend-window.test.ts expects the same prefetch), so
    // the trend endpoint sees three calls: display, prefetch, week
    expect(trendSpy).toHaveBeenCalledTimes(3)
    expect(trendSpy).toHaveBeenCalledWith(1, {
      axis: 'category',
      metric: 'amount',
      granularity: 'week',
      from: '2026-09-28',
      to: '2026-11-01',
      limit: 5,
    })
    // the period header: the period label and the big total — no compare
    // selector, no diff values, no KPI card
    const head = wrapper.find('.period-head')
    expect(head.find('.period-label').text()).toBe('2026年10月の支出')
    expect(head.find('[data-test="period-total"]').text()).toBe('948円')
    expect(wrapper.find('[data-test="compare-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-test^="compare-diff-"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="kpi"]').exists()).toBe(false)
    expect(wrapper.find('.kpi-value').exists()).toBe(false)
  })

  // TASK-105 (design tmp/tasks/tm-105/design_dashboard-visual.md §1): the
  // zone headings left the sr-only form for visible h2.zone-title text riding
  // the .zone-head row — the wording stays the TASK-95 copy verbatim (data
  // names only, no new invention), and the guide icon links sit at the
  // heading row's right end (the standalone .zone-more row is gone).
  it('[covers:web-common.zone-headings-visible] zone見出しは可視h2.zone-title（.zone-head行・sr-onlyなし・文言はTASK-95流用）・誘導icon linkは見出し行の右端', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // every zone heading is a visible .zone-title inside the .zone-head row,
    // keeping the TASK-95 wording as-is (no invented copy)
    const headings = wrapper.findAll('.zone .zone-head h2.zone-title')
    expect(headings.map((h) => h.text())).toEqual(['支出の推移', '週ごとの支出', '支出の内訳', '最近のレシート'])
    // no zone heading stays sr-only and none sits outside a .zone-head
    expect(wrapper.find('.zone h2.sr-only').exists()).toBe(false)
    expect(wrapper.findAll('.zone h2.zone-title').length).toBe(wrapper.findAll('.zone .zone-head h2.zone-title').length)
    // the section links are icon-only (chevron), not word links — and they
    // ride the heading row as its last child (the .zone-more row is gone)
    const cat = wrapper.find('[data-test="breakdown-more"]')
    expect(cat.attributes('aria-label')).toBe('カテゴリ別に見る')
    expect(new URL(cat.attributes('href')!, 'http://localhost').pathname).toBe('/categories')
    expect(cat.element.closest('.zone-head')!.lastElementChild).toBe(cat.element)
    const all = wrapper.find('[data-test="recent-more"]')
    expect(all.attributes('aria-label')).toBe('すべて見る')
    expect(new URL(all.attributes('href')!, 'http://localhost').pathname).toBe('/receipts')
    expect(all.element.closest('.zone-head')!.lastElementChild).toBe(all.element)
    expect(wrapper.find('.zone-more').exists()).toBe(false)
  })


  // TASK-149 D3 (web-common.fixed-guidance-names-both-services): the recent
  // zone's empty-state guidance names both services (the corpus copy policy)
  it('[covers:web-common.fixed-guidance-names-both-services] 最近のレシート空状態の案内は ChatGPT と Claude を併記', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'listReceipts').mockResolvedValue({ total_count: 0, sum_amount: 0, receipts: [], next_cursor: null })
    const { wrapper } = await mountApp('/')
    const empty = wrapper.find('[data-test="recent"] .empty-state')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('ChatGPT')
    expect(empty.text()).toContain('Claude')
  })

  // TASK-105 (web-home.breakdown-rest-row revised + web-common.series-color-
  // assignment, design §4-2): every row — top rows AND the「ほか」rest row —
  // carries the leading 12px round swatch `.ranked-swatch`; RankedList sets
  // `--rank-color` = seriesColor(row.keys[0] ?? null, axis) on each row, the
  // top rows' swatch + in-row bar carry the series color and the「ほか n件・
  // 計xx円」row resolves to var(--series-rest).
  it('[covers:web-home.breakdown-rest-row] 内訳ランキング: 上位5行+「ほか n件・計xx円」の残余集計行（全行swatch・上位行は系列色・残余行はrest色）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // seven top categories this month (five extra items on receipt 102)
    await api.updateReceipt(1, 102, {
      revision: 1,
      upsert_items: [
        { item_id: 1003, category: '日用品' },
        { name: 'シャンプー', amount: 300, category: '日用品' },
        { name: '電池', amount: 200, category: '交通費' },
        { name: '雑誌', amount: 350, category: '趣味' },
        { name: 'ティッシュ', amount: 150, category: null },
        { name: '歯ブラシ', amount: 120, category: null },
        { name: 'ガム', amount: 120, category: 'その他' },
      ],
    })
    const { wrapper } = await mountApp('/')
    const rows = wrapper.findAll('[data-test="breakdown"] .ranked-row')
    // six real categories (日用品698・食費550・趣味350・未分類270・交通費200・
    // その他120) fold into top-5 + the rest row (その他 120)
    expect(rows.length).toBe(6)
    const rest = rows.at(-1)!
    // REVIEW-13 M-1: the exact rest-row text — formatYen already appends 円
    // (the old label doubled it) and the amount cell holds the rest amount,
    // never the truncated row count
    expect(rest.find('.ranked-label').text()).toBe('ほか 1件・計120円')
    expect(rest.find('.amount').text()).toBe('120円')
    expect(rest.element.tagName).not.toBe('A')
    // every row renders the leading swatch (the legend the graph never
    // grows), rest rows included — the swatch paints var(--rank-color) and
    // the rest row's color resolves to the unattributed rest token
    expect(rows.map((r) => r.find('.ranked-swatch').exists())).toEqual([true, true, true, true, true, true])
    expect((rest.attributes('style') ?? '')).toContain('--rank-color: var(--series-rest)')
    // the top rows keep their drill links into /axes/category/<id> and carry
    // a series slot color (日用品 is catalog id 4 -> var(--series-4), the
    // same token the trend segment paints)
    expect(new URL(rows[0]!.attributes('href')!, 'http://localhost').pathname).toBe('/axes/category/4')
    expect((rows[0]!.attributes('style') ?? '')).toContain('--rank-color: var(--series-4)')
    // TASK-129 (web-home.breakdown-rest-row): the share-less rest row paints
    // its bar from its own VALUE on the screen's absolute scale — the
    // segment exists in the rest grey and its length ratio against the top
    // row equals the value ratio (120/698), regardless of the scale itself
    const restore = patchTrackWidth(300)
    try {
      const remounted = await mountApp('/')
      const rerows = remounted.wrapper.findAll('[data-test="breakdown"] .ranked-row')
      const widthOf = (s: { attributes: (k: string) => string | undefined }) =>
        Number.parseFloat(/width:\s*([\d.]+)px/.exec(s.attributes('style') ?? '')?.[1] ?? 'NaN')
      const restSeg = rerows.at(-1)!.find('.row-bar .row-seg')
      const topSeg = rerows[0]!.find('.row-bar .row-seg')
      expect(restSeg.exists()).toBe(true)
      expect(restSeg.attributes('style') ?? '').toContain('background: var(--series-rest)')
      expect(widthOf(restSeg) / widthOf(topSeg)).toBeCloseTo(120 / 698, 3)
    } finally {
      restore()
    }
  })

  // TASK-129 (web-common.bar-scale, the HomePage wiring + the u1 same-scale
  // proof): the screen scale aggregates every bar's outer amount — the
  // breakdown rows (Food 550 / Daily necessities 398) and the week totals
  // (max 948) — into barScale(948) = 1000. Every row bar then renders at
  // value/1000 × track, so the same amount paints the same length wherever
  // it appears on the screen (the week's Food segment and the breakdown's
  // Food row hold the identical px over the identical track width).
  it('[covers:web-common.bar-scale][covers:web-home.week-card] Home の画面scaleは内訳行と週行の外形金額の集約（barScale(948)=1000）で同一金額=同一長さ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const restore = patchTrackWidth(300)
    try {
      const { wrapper } = await mountApp('/')
      const widthOf = (s: { attributes: (k: string) => string | undefined }) =>
        Number.parseFloat(/width:\s*([\d.]+)px/.exec(s.attributes('style') ?? '')?.[1] ?? 'NaN')
      // the week bar: the 948 yen week = 948/1000 × 300 = 284.4px (NOT the
      // full track — the old list-max 100% peg is gone)
      const weekBar = wrapper.find('[data-test="week-card"] [data-test="row-2026-10-05"] .row-bar')
      expect(widthOf(weekBar)).toBeCloseTo((948 / 1000) * 300, 1)
      // the breakdown rows: 食費 550 → 165px, 日用品 398 → 119.4px
      const ranked = wrapper.findAll('[data-test="breakdown"] .ranked-row')
      expect(ranked[0]!.find('.ranked-label').text()).toBe('食費')
      expect(widthOf(ranked[0]!.find('.row-seg'))).toBeCloseTo((550 / 1000) * 300, 1)
      expect(widthOf(ranked[1]!.find('.row-seg'))).toBeCloseTo((398 / 1000) * 300, 1)
      // same scale, same value, same track width ⇒ same length: the week
      // bar's 食費 segment (550 of the 948 week) and the breakdown's 食費
      // row paint the identical px (the "same measure" the design §4-1
      // guarantees — a dependent property of equal available sizes)
      const weekFoodSeg = weekBar.findAll('.row-seg')[0]!
      expect(weekFoodSeg.attributes('title')).toBe('食費 550円（58%）')
      expect(widthOf(weekFoodSeg)).toBeCloseTo(widthOf(ranked[0]!.find('.row-seg')), 1)
      expect(widthOf(weekFoodSeg)).toBeCloseTo((550 / 1000) * 300, 1)
    } finally {
      restore()
    }
  })

  // TASK-105 (web-home.stacked-trend-fixed revised, design §4-1): the
  // segment colors are seriesColor(s.key, axis) CSS variable refs — the
  // mock's current month holds 食費 (id 1) -> var(--series-1) and 日用品
  // (id 4) -> var(--series-4) — the residual「ほか」segment is
  // var(--series-rest), the hover titles carry the share form「名称 〜円
  // （n%）」, value-0 series segments are omitted from the assembly.
  // TASK-123 (design tmp/tasks/tm-123/design_breakdown-visual.md §4-4):
  // the segment separation is the full-perimeter 1px var(--seg-outline)
  // border now (the old 1px surface border-top is gone — the real-paint
  // checks live in styles.test.ts and verify.spec.ts; jsdom cannot compute
  // stylesheet rules) and the assembly is top-3 +「ほか」(web-common.
  // stack-dimension-rules — proven in trend-window.test.ts's 7-series
  // fixture; this mock month only holds two series so the count stays 2).
  it('[covers:web-home.stacked-trend-fixed] 推移カード: 積み上げ金額の1形固定（mode/metric chromeなし・セグメントは金額+構成比title・色はseriesColor写像）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const card = wrapper.find('[data-test="trend-card"]')
    // no mode / metric chrome anywhere in the card (TASK-95: the chart is
    // the only expression — total height = the period total, colors = the
    // composition, no word tabs)
    expect(card.find('[data-test="trend-stacked"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-total"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-metric-count"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-metric-unit"]').exists()).toBe(false)
    // every column is the stacked money view: the current month holds both
    // series segments (value-0 series are omitted), each titled with the
    // money + share form and painted the seriesColor of its key
    const col = card.find('[data-test="bar-2026-10"]')
    expect(col.classes()).toContain('stacked')
    const segs = col.findAll('.bar-seg')
    expect(segs.length).toBe(2)
    expect(segs.every((s) => /円（\d+%）$/.test(s.attributes('title') ?? ''))).toBe(true)
    const byLabel = (l: string) => segs.find((s) => (s.attributes('title') ?? '').startsWith(l))!
    expect(byLabel('食費').attributes('style')).toContain('background: var(--series-1)')
    expect(byLabel('日用品').attributes('style')).toContain('background: var(--series-4)')
    // TASK-100: every bar carries its value label (the TASK-75 current-only
    // rule is withdrawn; compactYen — 万/千 compression, no "k" suffix — and
    // the zero months render the empty string)
    const vals = card.findAll('.bar-col .bar-val')
    expect(vals).toHaveLength(6)
    expect(vals.map((v) => v.text())).toEqual(['', '', '', '', '', '948'])
  })

  it('[covers:web-home.trend-day-bar-receipts] 日粒度の棒は button で押下可・押下でその日のレシート一覧（/receipts?from=d&to=d）へ・月棒は period 移動', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/')
    // month mode: 6 month bars, a press moves the shared period
    await wrapper.find('[data-test="bar-2026-05"]').trigger('click')
    await settle()
    const store = (await import('@/web/stores/period')).usePeriodStore()
    expect(store.month).toBe('2026-05')
    // week mode: 7 day bars as buttons; the 10-10 bar routes to that day
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const week = await mountApp('/?week=2026-10-05')
    const bar = week.wrapper.find('[data-test="bar-2026-10-10"]')
    expect(bar.element.tagName).toBe('BUTTON')
    expect(bar.classes()).toContain('bar-btn')
    await bar.trigger('click')
    await settle()
    expect(week.router.currentRoute.value.path).toBe('/receipts')
    expect(week.router.currentRoute.value.query).toMatchObject({ from: '2026-10-10', to: '2026-10-10' })
    void router
  })

  it('[covers:web-home.week-card] 週ごとの支出zone: 月モードは選択月の各週（月曜アンカー）の全幅button行で押下は週モードへ、週/年/rangeはzoneなし・ラベル絞り込みは週fetchへ流れる', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/')
    const zone = () => wrapper.find('[data-test="week-card"]')
    // month mode: the selected month's weeks as Monday-anchored rows —
    // TASK-146 §2: the fetch range crosses the month, so the edge rows are
    // FULL 7-day weeks whose labels write the month crossing as-is. The
    // month's three receipts (948円) all sit in the 10/5 week (the zero rows
    // keep their 0円 stubs)
    expect(zone().exists()).toBe(true)
    const rows = zone().findAll('button.week-row')
    expect(rows.map((b) => b.attributes('data-test'))).toEqual([
      'row-2026-09-28',
      'row-2026-10-05',
      'row-2026-10-12',
      'row-2026-10-19',
      'row-2026-10-26',
    ])
    expect(rows.map((b) => b.find('.week-label').text())).toEqual([
      '9/28〜10/4',
      '10/5〜10/11',
      '10/12〜10/18',
      '10/19〜10/25',
      '10/26〜11/1',
    ])
    expect(rows.map((b) => b.find('.amount').text())).toEqual(['0円', '948円', '0円', '0円', '0円'])
    // TASK-123 (design §4-7, web-home.week-row-stack-bar): the row's inline
    // bar is a DOM stacked bar now — TASK-129 routes it through the shared
    // component (.row-bar flex row + .row-seg children), so the TASK-116
    // multi-stop gradient string is gone. The 948円 week (all three
    // receipts) splits into the month's top series 食費 (id 1) and 日用品
    // (id 4), sharing the exact seriesColor tokens the breakdown ranking
    // rows paint, each segment titled with the share form
    const filled = zone().find('[data-test="row-2026-10-05"]')
    const bar = filled.find('.row-bar')
    expect(bar.exists()).toBe(true)
    const segs = bar.findAll('.row-seg')
    expect(segs.length).toBe(2)
    // array order = left = top-ranked first (the trend stack's bottom = the
    // first series correspondence, laid out horizontally)
    expect(segs[0]!.attributes('style')).toContain('background: var(--series-1)')
    expect(segs[1]!.attributes('style')).toContain('background: var(--series-4)')
    // 食費 550円（58%）/ 日用品 398円（42%）of the 948円 week
    expect(segs[0]!.attributes('title')).toBe('食費 550円（58%）')
    expect(segs[1]!.attributes('title')).toBe('日用品 398円（42%）')
    // the week row left the shared ranked-row gradient: no background-image
    // on the row itself anymore (the bar elements carry the composition)
    expect(filled.attributes('style') ?? '').not.toContain('background-image')
    // the breakdown ranking's row for the same key paints the identical
    // token (same key = same color across the week bar and the legend rows)
    const ranked = wrapper.findAll('[data-test="breakdown"] .ranked-row')
    expect((ranked[0]!.attributes('style') ?? '')).toContain('--rank-color: var(--series-1)')
    expect(ranked[0]!.find('.ranked-label').text()).toBe('食費')
    // zero-total weeks draw no bar element at all (the meaningless 1% accent
    // sliver is gone)
    for (const t of ['row-2026-09-28', 'row-2026-10-12', 'row-2026-10-19', 'row-2026-10-26']) {
      expect(zone().find(`[data-test="${t}"] .row-bar`).exists(), t).toBe(false)
    }
    // today (2026-10-15) highlights the row of the week holding it
    expect(zone().find('[data-test="row-2026-10-12"]').classes()).toContain('current')
    // a label filter rides the week fetch too (label_colors like the others)
    await wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(trendSpy).toHaveBeenCalledWith(1, expect.objectContaining({
      granularity: 'week',
      from: '2026-09-28',
      to: '2026-11-01',
      limit: 5,
      label_colors: ['red'],
    }))
    // a row press moves the shared period into that week's week mode and the
    // month-only zone disappears with the mode itself
    await zone().find('[data-test="row-2026-10-05"]').trigger('click')
    await settle()
    const store = (await import('@/web/stores/period')).usePeriodStore()
    expect(store.mode).toBe('week')
    expect(store.week).toBe('2026-10-05')
    expect(zone().exists()).toBe(false)
    // week / year / range modes never mount the zone and never run the
    // week-bucket fetch (day or month granularity only). TASK-115 §3-2
    // (design tmp/tasks/tm-115/design_trend-continuous-window.md): a
    // month/year commit prefetches its prev-adjacent window, so only the
    // year mount holds a second call (from=2025-01-01 — trend-window.test.ts
    // expects the same prefetch); the inactive week/range windows' adjacent
    // key equals their own display key, so no prefetch issues for them
    const trendCallsByPath: [string, number][] = [
      ['/?week=2026-10-05', 1],
      ['/?year=2026', 2],
      ['/?from=2026-10-03&to=2026-10-15', 1],
    ]
    for (const [path, calls] of trendCallsByPath) {
      cleanup()
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      const other = vi.spyOn(api, 'getAnalysisTrend')
      const m = await mountApp(path)
      expect(m.wrapper.find('[data-test="week-card"]').exists()).toBe(false)
      expect(other).toHaveBeenCalledTimes(calls)
    }
    // a range spanning exactly the month draws the zone again once the month
    // tab returns (the mode change must re-run the load)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const back = await mountApp('/?from=2026-10-01&to=2026-10-31')
    expect(back.wrapper.find('[data-test="week-card"]').exists()).toBe(false)
    await back.wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await back.wrapper.find('[data-test="mode-month"]').trigger('click')
    await settle()
    expect(back.wrapper.find('[data-test="week-card"]').exists()).toBe(true)
  })

  // TASK-146 §2 (web-home.week-card current continuation): the current-week
  // highlight survives onto the edge row whose Monday sits in the ADJACENT
  // month. Today = 2026-10-01 (Thu): its week is 2026-09-28..10-04, so with
  // October selected the first row IS the current week — the old month-clip
  // rule (range within the month) dropped the highlight there.
  it('[covers:web-home.week-card] 当週が隣接月側にいても current 強調は継続（今日=10/1 で row-2026-09-28 が当週）', async () => {
    vi.setSystemTime(new Date('2026-10-01T03:00:00Z'))
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/?month=2026-10')
    const zone = () => wrapper.find('[data-test="week-card"]')
    expect(zone().exists()).toBe(true)
    expect(zone().find('[data-test="row-2026-09-28"]').classes()).toContain('current')
    // the rest of the rows are not the current week
    for (const t of ['row-2026-10-05', 'row-2026-10-12', 'row-2026-10-19', 'row-2026-10-26']) {
      expect(zone().find(`[data-test="${t}"]`).classes(), t).not.toContain('current')
    }
    // the month's records (all in the 10/5 week) keep their amounts — the
    // extended range changes the WEEK DEFINITION, not the mock's data
    expect(zone().find('[data-test="row-2026-10-05"] .amount').text()).toBe('948円')
  })

  // TASK-146 §1 (web-shell.period-uncapped-step): a future month renders with
  // the existing empty vocabulary — the data talks (0円 / no records), no
  // "future" labeling or grey-out is added
  it('[covers:web-shell.period-uncapped-step] 未来月は既存の空表現のまま（0円・記録なし・recent 空状態・週行0円・barなし）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/?month=2026-11')
    expect(wrapper.find('[data-test="period-total"]').text()).toBe('0円')
    expect(wrapper.find('[data-test="breakdown"]').text()).toContain('この期間の記録はありません。')
    expect(wrapper.find('[data-test="recent"] .empty-state').exists()).toBe(true)
    // November 2026 spans six overlapping weeks (10/26 .. 11/30 Mondays) —
    // all zero, no bars, and nothing explains the future
    const rows = wrapper.findAll('[data-test="week-card"] button.week-row')
    expect(rows.map((b) => b.attributes('data-test'))).toEqual([
      'row-2026-10-26',
      'row-2026-11-02',
      'row-2026-11-09',
      'row-2026-11-16',
      'row-2026-11-23',
      'row-2026-11-30',
    ])
    expect(rows.every((b) => b.find('.amount').text() === '0円')).toBe(true)
    expect(wrapper.findAll('[data-test="week-card"] .row-bar')).toHaveLength(0)
    expect(wrapper.find('.period-label').text()).toBe('2026年11月の支出')
  })

  // TASK-146 §3 #11 (web-common.content-swap): the skeleton -> data handover
  // is the ContentSwap's appear fade, and it is the ONLY motion — the trend
  // chart inside the appearing pane carries no enter classes of its own
  it('[covers:web-common.content-swap] 初回確定（skeleton→実データ）は appear fade で現れる・chart は自分の fade を持たない（単一演出）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const orig = api.getAnalysis.bind(api)
    vi.spyOn(api, 'getAnalysis').mockImplementation(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    const { wrapper } = await mountApp('/', { attach: true, stubs: { transition: false } })
    // mid-load: the skeleton holds the shape (the two-stage render stands).
    // The skeleton itself paints a .view-stack silhouette — the REAL stack
    // (the non-skeleton one) is what must not exist yet
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(true)
    expect(wrapper.find('.view-stack:not(.skeleton)').exists()).toBe(false)
    release()
    await flushPromises()
    // the first content commit appears through the fade vocabulary: the
    // content-swap wrapper's child carries the appear fade's enter classes
    const swap = wrapper.find('.view-stack .content-swap')
    expect(swap.exists()).toBe(true)
    expect(swap.element.children).toHaveLength(1)
    const child = swap.element.firstElementChild!
    expect(child.classList.contains('page-enter-active')).toBe(true)
    expect(child.classList.contains('page-enter-from')).toBe(true)
    // single motion: the pane's appear is the only animation — after the
    // settle the trend chart itself carries no enter classes of its own
    await settle()
    const chart = wrapper.find('[data-test="trend"]')
    expect(chart.exists()).toBe(true)
    expect(
      Array.from(chart.element.classList).some((c) => c.includes('-enter-') || c.includes('-leave-')),
    ).toBe(false)
  })

  // TASK-146 §3 #6/#7 (web-common.content-swap): the content transition fires
  // at the LOAD COMMIT, not at the press. Mid-load the old content stays
  // (dimmed, swap key unmoved — the two-stage render of
  // web-shell.loading-skeleton survives); the commit then slides by the
  // step's direction, and a mode switch crosses through the fade vocabulary.
  it('[covers:web-common.content-swap] 期間stepはload確定時に発火（押下直後は旧内容のままdim・確定でslide-forward）・mode切替はfade', async () => {
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
    const swap = () => wrapper.find('.view-stack .content-swap')
    expect(swap().exists()).toBe(true)
    const children = () => Array.from(swap().element.children)
    const still = () =>
      children().every((el) =>
        Array.from(el.classList).every((c) => !c.includes('-enter-') && !c.includes('-leave-')),
      )

    // press › into the future month (TASK-146 §1) through the period dialog;
    // the re-fetch is held at the gate
    gated = true
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.view-stack').classes()).toContain('loading')
    expect(wrapper.find('[data-test="period-total"]').text()).toBe('948円')
    expect(still()).toBe(true)
    // the commit fires the directional slide: the from date moved up, so the
    // entering content comes from the right and the old one parks leaving
    release()
    await flushPromises()
    const entering = children().find((el) => el.classList.contains('slide-forward-enter-active'))
    const leaving = children().find((el) => el.classList.contains('slide-forward-leave-active'))
    expect(entering).toBeDefined()
    expect(leaving).toBeDefined()
    expect(entering?.classList.contains('slide-forward-enter-from')).toBe(true)
    await settle()
    expect(swap().element.children).toHaveLength(1)
    expect(wrapper.find('.period-label').text()).toBe('2026年11月の支出')

    // a mode switch (month -> week) has no order to move along: the fade
    // vocabulary carries the swap (the dialog stays open through both)
    gated = false
    await wrapper.find('[data-test="mode-week"]').trigger('click')
    await flushPromises()
    const fading = children().find((el) => el.classList.contains('page-enter-active'))
    expect(fading).toBeDefined()
    const fadingOut = children().find((el) => el.classList.contains('page-leave-active'))
    expect(fadingOut).toBeDefined()
    await settle()
    expect(wrapper.find(".period-label").text()).toBe('2026年10月12日の週の支出')
  })

  // REVIEW-3 Low-1's non-vacuity (a second, heavier recorded week so the
  // light row's bar really sits below the max) carries over to the TASK-129
  // absolute scale: the bars no longer peg the list max at 100% — the screen
  // scale = barScale(max(breakdown rows 食費1600/日用品398, week totals
  // 798/1200)) = barScale(1600) = 2000, so the light week renders at
  // 798/2000 = 0.399 of the track and even the max week sits at 0.6. The
  // px-level proof with a REAL track width lives in verify.spec.ts; here the
  // unit side pins the math over the patched 300px track plus the
  // composition of both weeks under the reseeded month.
  it('[covers:web-home.week-row-stack-bar][covers:web-common.bar-scale] 記録2週でもbar長は絶対scale（画面scale=2000・max週も全長でない）で軽い週のbarも両系列を維持', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // move receipt 103 (おにぎり・食費) into the 10/12 week and raise it to
    // 1200円: the 10/5 week keeps both series (食費400 + 日用品398 = 798円)
    // while the month max moves to 食費 1600円 (breakdown) — the screen
    // scale therefore comes from the RANKING max, not the week max
    await api.updateReceipt(1, 103, {
      revision: 1,
      set: { purchased_on: '2026-10-13' },
      upsert_items: [{ item_id: 1004, amount: 1200 }],
    })
    const restore = patchTrackWidth(300)
    try {
      const { wrapper } = await mountApp('/')
      const zone = () => wrapper.find('[data-test="week-card"]')
      expect(zone().findAll('button.week-row').map((b) => b.find('.amount').text())).toEqual([
        '0円', '798円', '1,200円', '0円', '0円',
      ])
      // the light week keeps BOTH series in the DOM bar — the series lineup
      // follows the month-total order (食費 series-1 then 日用品 series-4),
      // the bucket's own composition splits the segments and every recorded
      // segment carries the share title
      const lightSegs = zone().find('[data-test="row-2026-10-05"] .row-bar').findAll('.row-seg')
      expect(lightSegs.length).toBe(2)
      expect(lightSegs[0]!.attributes('style')).toContain('background: var(--series-1)')
      expect(lightSegs[1]!.attributes('style')).toContain('background: var(--series-4)')
      expect(lightSegs[0]!.attributes('title')).toBe('食費 400円（50%）')
      expect(lightSegs[1]!.attributes('title')).toBe('日用品 398円（50%）')
      // the heavier week (single 食費 1200円) draws its own one segment bar
      const maxSegs = zone().find('[data-test="row-2026-10-12"] .row-bar').findAll('.row-seg')
      expect(maxSegs.length).toBe(1)
      expect(maxSegs[0]!.attributes('style')).toContain('background: var(--series-1)')
      expect(maxSegs[0]!.attributes('title')).toBe('食費 1,200円（100%）')
      // TASK-129 absolute scale (web-common.bar-scale): the bar lengths are
      // value/2000×300 — the light week 119.7px, the max week 180px (NOT the
      // full track: the old max=100% peg is gone) and the breakdown's 食費
      // 1600円 row paints 240px on the SAME screen scale
      const widthOf = (s: { attributes: (k: string) => string | undefined }) =>
        Number.parseFloat(/width:\s*([\d.]+)px/.exec(s.attributes('style') ?? '')?.[1] ?? 'NaN')
      expect(widthOf(zone().find('[data-test="row-2026-10-05"] .row-bar'))).toBeCloseTo((798 / 2000) * 300, 1)
      expect(widthOf(zone().find('[data-test="row-2026-10-12"] .row-bar'))).toBeCloseTo((1200 / 2000) * 300, 1)
      const foodRow = wrapper.findAll('[data-test="breakdown"] .ranked-row')[0]!
      expect(foodRow.find('.ranked-label').text()).toBe('食費')
      expect(widthOf(foodRow.find('.row-seg'))).toBeCloseTo((1600 / 2000) * 300, 1)
      // the zero weeks still draw no bar at all
      for (const t of ['row-2026-09-28', 'row-2026-10-19', 'row-2026-10-26']) {
        expect(zone().find(`[data-test="${t}"] .row-bar`).exists(), t).toBe(false)
      }
    } finally {
      restore()
    }
  })

  it('[covers:web-home.trend-granularity][covers:web-browse.trend-axis-minimal][covers:web-browse.trend-y-axis][covers:web-browse.trend-note-removed] 推移は期間の粒度に追従（月/年=月棒・range は 62/366 日閾値）・軸ラベルは間引き・値ラベルは全棒', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // month mode: a 6-month window, no per-bar labels, thinned axis ticks
    // and a value label on every bar (6 bars = non-dense)
    expect(wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(6)
    expect(wrapper.find('[data-test="bar-2026-10"]').classes()).toContain('current')
    expect(wrapper.findAll('[data-test="trend-card"] .bar-col .bar-val')).toHaveLength(6)
    expect(
      wrapper
        .find('[data-test="trend-axis"]')
        .findAll('span')
        .map((s) => s.text())
        .filter(Boolean),
    ).toEqual(['5月', '7月', '9月', '10月'])
    // the y-axis: three compactYen ticks (mock max 948 -> niceMax 1000)
    expect(wrapper.find('[data-test="trend-card"] .y-axis').attributes('aria-hidden')).toBe('true')
    expect(
      wrapper
        .find('[data-test="trend-card"] .y-axis')
        .findAll('span')
        .map((s) => s.text()),
    ).toEqual(['1千', '500', '0'])
    // the note line is gone (TASK-100 removes the trend-note entirely)
    expect(wrapper.find('[data-test="trend-card"] .trend-note').exists()).toBe(false)
    // a 13-day range gives day bars (the analysis trend endpoint ships the
    // buckets; the span rules live in trendGranularity/spanGranularity)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const range = await mountApp('/?from=2026-10-03&to=2026-10-15')
    expect(range.wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(13)
    expect(
      range.wrapper
        .find('[data-test="trend-axis"]')
        .findAll('span')
        .map((s) => s.text())
        .filter(Boolean),
    ).toEqual(['10/3', '10/6', '10/9', '10/12', '10/15'])
  })

  it('[covers:web-shell.loading-skeleton] 初回 loading は view-stack 同形の skeleton（aria-hidden + sr-only 文言）、再取得は既存 stack の dim', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const resolvers: ((v: never) => void)[] = []
    vi.spyOn(api, 'getAnalysis').mockImplementation(
      () => new Promise((r) => resolvers.push(r)) as never,
    )
    const { wrapper } = await mountApp('/')
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="loading"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[data-test="loading"] .sr-only').text()).toContain('読み込んでいます')
    for (const r of resolvers) r({} as never)
    await settle()
    // the settled load drops the skeleton (the empty object fails the
    // data check and renders nothing — the skeleton is gone either way)
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
  })

  it('[covers:web-dashboard.label-filter] 検索dialog下段のラベル選択は Home の analysis 再取得へ label_colors で流れる', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const { wrapper } = await mountApp('/')
    expect(spy).not.toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    await wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'], limit: 50 }))
  })
})

describe('PeriodHeader (component)', () => {
  it('期間labelと合計のみを描画する（diff・選択器の部位を持たない）', () => {
    const w = mount(PeriodHeader, {
      props: {
        label: '2026年10月の支出',
        total: 948,
      },
    })
    expect(w.find('.period-label').text()).toBe('2026年10月の支出')
    expect(w.find('[data-test="period-total"]').text()).toBe('948円')
    expect(w.find('[data-test^="compare-"]').exists()).toBe(false)
  })
})

describe('RankedList (component)', () => {
  it('残余行は to が null を返す行として span（非リンク）・上位行は RouterLink', () => {
    const w = mount(RankedList, {
      props: {
        rows: [
          { keys: [1], labels: ['食費'], value: 550, share: 0.58 },
          { keys: [null], labels: ['ほか 2件・計270円'], value: 270, share: undefined },
        ],
        to: (r) => (typeof r.keys[0] === 'number' ? { path: '/axes/category/1' } : null),
        scale: 1000,
      },
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>', props: ['to'] },
        },
      },
    })
    expect(w.findAll('.ranked-row')[0]!.element.tagName).toBe('A')
    expect(w.findAll('.ranked-row')[1]!.element.tagName).toBe('SPAN')
  })
})

function accountItems(w: VueWrapper) {
  return w.findAll('[data-test="account-menu"] [role="menuitem"]')
}

function keydown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** jsdom exposes `inert` as a property or only as an attribute. */
const isInert = (el: Element | undefined) =>
  !!el && ((el as HTMLElement).inert === true || el.hasAttribute('inert'))

describe('App shell', () => {
  it('[covers:web-shell.navigation] 主ナビはデータ4節＋区切り付きで設定（sidebar に brand 見出しなし）、表題は SECTION_TITLES からアイコン併記', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    const side = wrapper.find('[data-test="sidebar"]')
    for (const n of ['home', 'receipts', 'categories', 'stores']) {
      expect(side.find(`[data-test="nav-${n}"] svg`).exists()).toBe(true)
    }
    // TASK-56: the sidebar's side-links are the four data sections plus the
    // settings entry of the separated second group
    expect(side.findAll('.side-link')).toHaveLength(5)
    // the sidebar is nav + user only: no brand heading (TASK-27)
    expect(side.find('.sidebar-head').exists()).toBe(false)
    expect(side.find('a.brand').exists()).toBe(false)
    expect(wrapper.find('[data-test="nav-apps"]').exists()).toBe(false)
    expect(side.find('[data-test="nav-home"]').classes()).toContain('active')
    // the tabbar keeps the four data sections only (TASK-56)
    const tabbar = wrapper.find('[data-test="tabbar"]')
    const tabs = tabbar.findAll('a')
    expect(tabs.map((t) => t.text())).toEqual(['ホーム', 'レシート', 'カテゴリ', '店'])
    for (const t of tabs) expect(t.find('svg').exists()).toBe(true)
    expect(tabbar.attributes('style')).toMatch(/--tab-count:\s*4/)
    // home: no page title in the top bar (neither text nor icon)
    const homeTitle = wrapper.find('.topbar-title')
    expect(homeTitle.exists() ? homeTitle.text() : '').toBe('')
    expect(wrapper.find('.topbar-title svg').exists()).toBe(false)

    await router.push('/settings')
    await settle()
    // the settings screen shows; the account number is nowhere in the web UI
    // (TASK-38 real-device follow-up removed the display itself)
    expect(wrapper.find('[data-test="settings-nav"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="account-number"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="kpi"]').exists()).toBe(false)
    expect(wrapper.find('.topbar-title').text()).toBe('設定')
    // the title carries the section icon (TASK-35), identified by its path d
    // like the menu-button glyph check above
    const settingsSvg = wrapper.find('.topbar-title svg')
    expect(settingsSvg.exists()).toBe(true)
    expect(settingsSvg.attributes('aria-hidden')).toBe('true')
    expect(settingsSvg.html()).toContain('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z') // the "settings" gear
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))
    expect(settingsItem?.attributes('aria-current')).toBe('page')
    // the receipt detail belongs to the receipts section
    await router.push('/receipts/101')
    await settle()
    expect(wrapper.find('[data-test="nav-receipts"]').classes()).toContain('active')
    expect(wrapper.find('.topbar-title').text()).toBe('レシート')
    const receiptsSvg = wrapper.find('.topbar-title svg')
    expect(receiptsSvg.exists()).toBe(true)
    expect(receiptsSvg.attributes('aria-hidden')).toBe('true')
    expect(receiptsSvg.html()).toContain('M5 3h14v18l-2.5-1.5') // the "receipt" glyph
  })

  it('[covers:web-shell.sidebar-settings-nav] sidebar 主 nav の下に区切り付きの設定 nav（tabbar とアカウントメニューは不変）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    const side = wrapper.find('[data-test="sidebar"]')
    // the settings link rides in a separated second group under the main nav
    const settingsLink = side.find('[data-test="nav-settings"]')
    expect(settingsLink.exists()).toBe(true)
    expect(settingsLink.attributes('href')).toBe('/settings')
    expect(settingsLink.classes()).toContain('side-link')
    expect(settingsLink.find('svg').exists()).toBe(true)
    expect(settingsLink.text()).toBe('設定')
    expect(side.find('.side-nav-secondary').exists()).toBe(true)
    // the settings link rides in the separated second group inside the same
    // nav (below the four data links), and home is not active while on /
    expect(side.find('.side-nav [data-test="nav-settings"]').exists()).toBe(true)
    expect(side.find('.side-nav > [data-test="nav-settings"]').exists()).toBe(false)
    expect(side.find('.side-nav-secondary [data-test="nav-settings"]').exists()).toBe(true)
    // on / the home entry is active and the settings entry is not
    expect(side.find('[data-test="nav-home"]').classes()).toContain('active')
    expect(settingsLink.classes()).not.toContain('active')

    // pressing it navigates to /settings and the entry turns active
    await settingsLink.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/settings/general')
    expect(wrapper.find('[data-test="nav-settings"]').classes()).toContain('active')
    // the manage screens inherit the settings section (TASK-74) — active too
    await router.push('/settings/labels')
    await settle()
    expect(wrapper.find('[data-test="nav-settings"]').classes()).toContain('active')

    // the tabbar keeps the four data tabs and the account menu keeps its
    // settings item (TASK-56: no removal, both entries live on)
    const tabbar = wrapper.find('[data-test="tabbar"]')
    expect(tabbar.findAll('a')).toHaveLength(4)
    expect(tabbar.attributes('style')).toMatch(/--tab-count:\s*4/)
    expect(tabbar.find('[data-test="nav-settings"]').exists()).toBe(false)
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))
    expect(settingsItem?.attributes('aria-current')).toBe('page')
  })

  it('[covers:web-shell.section-from-meta] section・ledgerScoped は route.meta から（/search の表題・ledger スコープ・nav active・manage-* の settings 継承）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/search')
    // the /search title was empty since TASK-41: the section now comes from
    // route.meta and SECTION_TITLES carries search (TASK-74 §4-2)
    expect(wrapper.find('.topbar-title').text()).toBe('検索')
    expect(wrapper.find('.topbar-title svg').exists()).toBe(true)
    // search joins the ledger-scoped browsing routes: the band is on and the
    // switcher rides the account menu (TASK-101: no topbar trigger)
    expect(wrapper.find('header.topbar').classes()).toContain('ledger-scoped')
    await wrapper.find('[data-test="account-button"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"] [data-test="ledger-option-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(false)
    // search is no nav section: none of the four tabs claims it
    for (const n of ['home', 'receipts', 'categories', 'stores']) {
      expect(wrapper.find(`[data-test="nav-${n}"]`).classes()).not.toContain('active')
    }
    // the browsing routes carry their section / depth / ledgerScoped meta
    // (TASK-74 §4-2 route table; the hierarchy routes landed in stage 5)
    const m = (p: string) => router.resolve(p).meta
    expect(m('/')).toMatchObject({ section: 'home', depth: 1, ledgerScoped: true })
    expect(m('/receipts')).toMatchObject({ section: 'receipts', depth: 1, ledgerScoped: true })
    expect(m('/receipts/101')).toMatchObject({ section: 'receipts', depth: 2, ledgerScoped: true })
    expect(m('/categories')).toMatchObject({ section: 'categories', depth: 1, ledgerScoped: true })
    expect(m('/axes/category/1')).toMatchObject({ section: 'categories', depth: 2, ledgerScoped: true })
    expect(m('/axes/category/1/2')).toMatchObject({ section: 'categories', depth: 3, ledgerScoped: true })
    expect(m('/axes/category/uncategorized')).toMatchObject({ section: 'categories', depth: 2, ledgerScoped: true })
    expect(m('/stores')).toMatchObject({ section: 'stores', depth: 1, ledgerScoped: true })
    expect(m('/axes/store/1')).toMatchObject({ section: 'stores', depth: 2, ledgerScoped: true })
    // the name-keyed axes light the home section (their lists do not exist)
    expect(m('/axes/item/牛乳')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/axes/label/red')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/axes/payment/cash')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/search')).toMatchObject({ section: 'search', depth: 1, ledgerScoped: true })
    // manage-* inherits the settings section from the /settings parent record
    // but keeps the ledger scope; the plain settings tabs have no scope
    expect(m('/settings/categories')).toMatchObject({ section: 'settings', ledgerScoped: true })
    expect(m('/settings/general').section).toBe('settings')
    expect(m('/settings/general').ledgerScoped).toBeFalsy()
    expect(m('/apps').section).toBe('apps')
    expect(m('/usage/connect').section).toBe('usage')

    // the manage screen keeps the settings title with its ledger section in
    // the account menu; usage is not ledger scoped
    await router.push('/settings/categories')
    await settle()
    expect(wrapper.find('.topbar-title').text()).toBe('設定')
    await wrapper.find('[data-test="account-button"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"] [data-test="ledger-option-1"]').exists()).toBe(true)
    await router.push('/usage')
    await settle()
    expect(wrapper.find('.topbar-title').text()).toBe('使い方')
    await wrapper.find('[data-test="account-button"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"] [data-test="ledger-option-1"]').exists()).toBe(false)
  })

  it('[covers:web-shell.menus] 左上 menu ボタンで drawer を開閉（aria・アイコン・フォーカス・inert・scrim）、右上アカウントメニューからログアウト', async () => {
    const f = mockFetch({
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
      'POST /api/auth/logout': { status: 204 },
    })
    const { wrapper, router } = await mountApp('/receipts/101', { attach: true })
    const topbar = wrapper.find('header.topbar')
    const menuBtn = () => wrapper.find('[data-test="menu-button"]')
    expect(topbar.element.firstElementChild?.getAttribute('data-test')).toBe('menu-button')
    // closed: the button offers to open the drawer it controls
    expect(menuBtn().attributes('aria-controls')).toBe('app-sidebar')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを開く')
    expect(menuBtn().find('svg').html()).toContain('M4 6h16') // the "menu" glyph

    // open: the same button at the same spot becomes the close control
    // (TASK-52: the glyph points where the panel goes — a left chevron, not
    // the close X that read as a second hamburger)
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('true')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを閉じる')
    expect(menuBtn().find('svg').html()).toContain('M15 18l-6-6 6-6') // the "chevron-left" glyph
    // focus lands on the active section's link (receipts, not the first item)
    expect(document.activeElement).toBe(wrapper.find('[data-test="nav-receipts"]').element)
    // no separate close button; the content columns are inert, the topbar is not
    expect(wrapper.find('.drawer-close').exists()).toBe(false)
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(true)
    expect(isInert(topbar.element)).toBe(false)

    // Escape closes and returns the focus to the menu button
    keydown('Escape')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを開く')
    expect(document.activeElement).toBe(menuBtn().element)

    // a section without a nav entry (usage): the first link takes the focus
    // (settings gained its own sidebar entry in TASK-56)
    await router.push('/usage')
    await settle()
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(document.activeElement).toBe(wrapper.find('[data-test="nav-home"]').element)
    // the scrim closes too (through closeDrawer, so the focus returns)
    await wrapper.find('.scrim').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(document.activeElement).toBe(menuBtn().element)

    // pressing the button while open closes it as well
    await menuBtn().trigger('click')
    await settle()
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(document.activeElement).toBe(menuBtn().element)

    // navigating to another route closes the drawer
    await menuBtn().trigger('click')
    await settle()
    await router.push('/stores')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')

    // ledger switching is the account menu's radio section, not a select
    // and not a topbar trigger (TASK-101)
    expect(wrapper.find('[data-test="ledger-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(false)

    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
    const accountBtn = wrapper.find('[data-test="account-button"]')
    expect(accountBtn.attributes('aria-haspopup')).toBe('menu')
    await accountBtn.trigger('click')
    // /stores is ledger scoped: the switcher rides the menu as radio rows
    expect(wrapper.find('[data-test="account-menu"] [data-test="ledger-option-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="account-menu"]').text()).not.toContain(ME.account_number)
    expect(wrapper.find('[data-test="account-menu"]').text()).toContain(ME.display_name)
    const labels = accountItems(wrapper).map((i) => i.text().trim())
    // TASK-37: 使い方 sits between the apps item and logout
    expect(labels).toHaveLength(4)
    expect(labels[0]).toContain('設定')
    expect(labels[1]).toContain('接続中のアプリ')
    expect(labels[2]).toContain('使い方')
    expect(labels[3]).toContain('ログアウト')
    await wrapper.find('[data-test="menu-logout"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/auth/logout')).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/login')
    // the shell is gone with the route swap (atomic logout, TASK-39)
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="login"]').exists()).toBe(true)
  })

  it('[covers:web-shell.nav-open-state-on-resize][covers:web-shell.sidebar-default-closed] 900px 以上へリサイズしてもナビは開いたまま（modal 効果の inert・drawer-lock は解ける）、desktop のボタンで同じ overlay を閉じ・開ける（初期は全幅で閉じている）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    // TASK-89: the drawer starts closed at every width (desktop default-open
    // is gone)
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(wrapper.find('[data-test="menu-button"]').attributes('aria-expanded')).toBe('false')
    await wrapper.find('[data-test="menu-button"]').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(true)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(true)
    // crossing into desktop (>= 900px) keeps the open state: the sidebar
    // stays open as the desktop overlay and only the mobile-only modal
    // effects (inert, drawer-lock, scrim) end — the open flag survives
    fireMediaChange('(min-width: 900px)', true)
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(true)
    expect(isInert(wrapper.find('.main-col').element)).toBe(false)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(false)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(false)
    // on desktop the same button slides the overlay closed and back (the
    // old grid-column fold / sidebar-collapsed class is gone)
    const btn = wrapper.find('[data-test="menu-button"]')
    expect(btn.attributes('aria-expanded')).toBe('true')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-label')).toBe('メニューを開く')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(btn.attributes('aria-label')).toBe('メニューを閉じる')
    // crossing back below 900px with the sidebar open restores the modal
    // effects — the state itself never reset
    fireMediaChange('(min-width: 900px)', false)
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(true)
  })

  it('[covers:web-shell.sidebar-overlay][covers:web-shell.sidebar-default-closed] desktop の初期は closed・開ければ非モーダル（inert・drawer-lock なし）だが scrim 外タップ・Escape・遷移でも閉じる（TASK-89）', async () => {
    // mount inside the desktop viewport class: the shell starts closed
    setMediaMatches('(min-width: 900px)', true)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    const btn = wrapper.find('[data-test="menu-button"]')
    expect(btn.attributes('aria-expanded')).toBe('false')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    // the desktop overlay is not modal: main stays interactive
    expect(isInert(wrapper.find('.main-col').element)).toBe(false)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(false)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(false)
    // TASK-89: the scrim shows at every width now — an outside tap closes
    // the desktop overlay too
    await wrapper.find('.scrim').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    // Escape closes it as well (the topbar carries the handler)
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    keydown('Escape', wrapper.find('[data-test="sidebar"]').element)
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    // and a navigation from the sidebar closes it (no persistent overlay)
    await btn.trigger('click')
    await settle()
    await wrapper.find('[data-test="nav-stores"]').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
  })

  it('[covers:web-shell.menus-stay-on-query-change] receipt ルート内の id 変化・query だけの変化ではメニューを閉じない', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/receipts/101')
    // account menu stays open across the feed's own URL updates
    await wrapper.find('[data-test="account-button"]').trigger('click')
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)
    await router.replace('/receipts/102?from=2026-10-01&to=2026-10-31')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)
    // the drawer too
    await wrapper.find('[data-test="menu-button"]').trigger('click')
    await router.replace('/receipts/103?from=2026-10-01&to=2026-10-31')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')

    // the account menu (with the ledger section inside, TASK-101) stays open
    // on a query-only change
    await router.push('/receipts')
    await settle()
    await wrapper.find('[data-test="account-button"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="account-menu"] [data-test="ledger-option-1"]').exists()).toBe(true)
    await router.replace({ path: '/receipts', query: { item: '牛乳' } })
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)

    // another path closes everything
    await router.push('/stores')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')

    // a menu item click closes the menu explicitly
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))!
    await settingsItem.trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
  })

  it('[covers:web-shell.popover-menu] PopoverMenu: 矢印キー移動・Escape・外側クリックで閉じフォーカスはトリガへ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    // the top-right account menu is a PopoverMenu; on a ledgerScoped screen
    // (TASK-101) it opens with the two ledger radio rows above the four
    // plain items (TASK-37 added 使い方)
    const trigger = () => wrapper.find('[data-test="account-button"]')
    ;(trigger().element as HTMLElement).focus()
    await trigger().trigger('click')
    await settle()
    const menu = wrapper.find('[role="menu"]')
    expect(menu.exists()).toBe(true)
    expect(trigger().attributes('aria-expanded')).toBe('true')
    const items = () => wrapper.findAll('[role="menu"] [role^="menuitem"]').map((i) => i.element)
    expect(items()).toHaveLength(6)
    keydown('ArrowDown')
    await settle()
    // the first landing is the leading ledger row, the second the next one
    expect(document.activeElement).toBe(items()[0])
    expect(items()[0]!.getAttribute('data-test')).toBe('ledger-option-1')
    keydown('ArrowDown')
    await settle()
    expect(document.activeElement).toBe(items()[1])
    expect(items()[1]!.getAttribute('data-test')).toBe('ledger-option-2')
    keydown('ArrowUp')
    await settle()
    expect(document.activeElement).toBe(items()[0])
    keydown('Escape')
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger().element)
    expect(trigger().attributes('aria-expanded')).toBe('false')

    // outside click
    await trigger().trigger('click')
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    const outside = wrapper.find('.app-main').element
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger().element)
  })
})

describe('Brand logo (TASK-16 / TASK-27)', () => {
  it('[covers:web-shell.topbar-logo-responsive] topbar に full と compact を出し分けクラス付きで両方、sidebar にロゴ無し', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // both variants sit in the topbar behind their show/hide classes
    // (the 520px switch over these classes is checked in styles.test.ts)
    for (const { sel, word } of [
      { sel: '.topbar-logo-full', word: 'Kakei' },
      { sel: '.topbar-logo-compact', word: 'kb' },
    ] as const) {
      const logos = wrapper.findAll(`header.topbar ${sel}`)
      expect(logos, sel).toHaveLength(1)
      expect(logos[0]!.attributes('role')).toBe('img')
      expect(logos[0]!.attributes('aria-label')).toBe('kakeiboot')
      // the topbar full logo shortens its wordmark to "Kakei" (word prop);
      // the login-screen logo outside the header keeps the default "kakeiboot"
      expect(logos[0]!.find('.logo-word').text(), sel).toBe(word)
    }
    // the sidebar carries neither a brand link nor a logo
    expect(wrapper.find('[data-test="sidebar"] a.brand').exists()).toBe(false)
    expect(wrapper.find('[data-test="sidebar"] [aria-label="kakeiboot"]').exists()).toBe(false)
  })
})
