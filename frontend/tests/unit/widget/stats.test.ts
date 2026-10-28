import { describe, expect, it } from 'vitest'
import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type { ReportKind } from '@/shared/types'
import { statsEnvelope, statsMeta, trendMatrix } from '@/widget/fixtures'
import { fakeHost, mountWidget, result } from './helpers'

const num = (v: string | undefined) => Number(v)

// TASK-116: the bar_v stack's segment rects — painted with seriesColor(key)
// CSS variable refs (var(--series-*) / var(--series-rest))
const segRects = (w: VueWrapper) =>
  w.findAll('[data-section="monthly_trend"] rect').filter((r) => (r.attributes('fill') ?? '').startsWith('var(--series'))
const segTitle = (r: DOMWrapper<Element>) => r.element.querySelector('title')?.textContent ?? ''

describe('stats dashboard', () => {
  it('[covers:widget.stats-chart-values] bar lengths follow the values; bar_v stacks its series (bottom = first series)', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    // bar_h: the widths still follow the row values and the row colors are the
    // key-based mapping (1=食費 s1, 2=日用品 s2, keys=[null] rest)
    const bars = wrapper.findAll('[data-section="by_category"] rect.bb-chart__bar')
    const widths = bars.map((b) => num(b.attributes('width')))
    expect(bars.map((b) => num(b.attributes('data-value')))).toEqual([30000, 12000, 10000])
    expect(widths[0]! / widths[1]!).toBeCloseTo(30000 / 12000, 5)
    expect(widths[1]! / widths[2]!).toBeCloseTo(12000 / 10000, 5)
    expect(bars.map((b) => b.attributes('fill'))).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])
    // bar_v (TASK-116): each bar is a segment rect column off the matrix —
    // every month holds 食費+日用品+ほか except 2026-07 (日用品 value 0 is
    // omitted): 5 bars x 3 segments + 1 bar x 2 = 17
    const segs = segRects(wrapper)
    expect(segs).toHaveLength(17)
    // every segment carries the share-form hover title「名称 金額（n%）」
    const titleTexts = segs.map((s) => segTitle(s))
    expect(titleTexts.every((t) => /^(食費|日用品|ほか) [\d,]+円（\d+%）$/.test(t))).toBe(true)
    // the same key paints the identical token as the bar_h rows: the 2026-10
    // bar (rightmost x) holds all three — 食費 s1 / 日用品 s2 / ほか rest
    const xs = [...new Set(segs.map((s) => s.attributes('x')))]
    expect(xs).toHaveLength(6)
    const last = segs.filter((s) => s.attributes('x') === xs.at(-1))
    expect(last.map((s) => s.attributes('fill')).sort()).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])
    // the bar's own title (year-month + amount) survives the segmentation
    const titles = wrapper.findAll('[data-section="monthly_trend"] g > title')
    expect(titles).toHaveLength(6)
    expect(titles.at(-1)!.text()).toBe('2026年10月: 52,000円')
    const card = wrapper.find('[data-test="totals-card"]').text()
    for (const t of ['52,000円', '31件']) expect(card).toContain(t)
  })

  it('[covers:widget.stats-chart-values] bar_v segment geometry: bottom-first accumulation, >=2 units, 1-unit gaps, value-0 omitted', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    const segs = segRects(wrapper)
    // every drawn segment keeps the 2-unit minimum height
    expect(segs.map((s) => num(s.attributes('height'))).every((h) => h >= 2)).toBe(true)
    // per bar (same x): the bottom segment (max y + height) is the first
    // series (食費 = var(--series-1)) and neighbours sit exactly 1 unit apart
    const byX = new Map<string, typeof segs>()
    for (const s of segs) {
      const x = s.attributes('x') ?? ''
      byX.set(x, [...(byX.get(x) ?? []), s])
    }
    for (const [, col] of byX) {
      const sorted = [...col].sort((a, b) => num(b.attributes('y')) - num(a.attributes('y')))
      // bottom of the column = the top-ranked series
      const bottom = sorted[0]!
      expect(bottom.attributes('fill')).toBe('var(--series-1)')
      // the adjacent segments keep the 1-unit background gap
      for (let i = 1; i < sorted.length; i++) {
        const lower = sorted[i - 1]!
        const upper = sorted[i]!
        expect(num(lower.attributes('y'))).toBeCloseTo(num(upper.attributes('y')) + num(upper.attributes('height')) + 1, 3)
      }
    }
    // the value-0 series month (2026-07: 日用品 0) draws no s2 rect: that bar
    // holds exactly 2 segments (食費 + ほか) while the others hold 3
    const counts = [...byX.values()].map((col) => col.length).sort()
    expect(counts).toEqual([2, 3, 3, 3, 3, 3])
    // and the tallest month (2026-10, 52000) tops out highest: its topmost
    // segment's y is the smallest of all bars
    const topOf = (col: typeof segs) => Math.min(...col.map((s) => num(s.attributes('y'))))
    const tops = [...byX.values()].map(topOf)
    expect(Math.min(...tops)).toBe(topOf(byX.get([...byX.keys()].at(-1)!)!))
    // the smallest month (2026-07, 39000) tops out lowest
    expect(Math.max(...tops)).toBe(topOf(byX.get([...byX.keys()][2]!)!))
  })

  it('[covers:widget.stats-chart-values] bar_v without a matrix (or with a mismatched one) keeps the single-rect fallback', async () => {
    // no _meta at all (backend not yet shipping the matrix / a meta-less host)
    const bare = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(segRects(bare.wrapper)).toHaveLength(6)
    expect(bare.wrapper.findAll('[data-section="monthly_trend"] rect title')).toHaveLength(0)
    expect(segRects(bare.wrapper).every((r) => r.attributes('fill') === 'var(--series-1)')).toBe(true)

    // a matrix whose buckets disagree with the section rows (6 rows vs 7
    // months) also drops the segments — one rect per bar
    const mismatched = trendMatrix()
    mismatched.buckets = [...mismatched.buckets, '2026-11']
    const m = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: { trend_matrix: mismatched } }))
    expect(segRects(m.wrapper)).toHaveLength(6)
    expect(m.wrapper.findAll('[data-section="monthly_trend"] rect title')).toHaveLength(0)
  })

  it('[covers:widget.stats-chart-values] chart kinds: stacked_bar, line (test-only section), table, scatter_line', async () => {
    const stacked = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_category') }))
    const segs = stacked.wrapper.findAll('[data-chart="stacked_bar"] rect[data-value]')
    expect(segs).toHaveLength(3)
    expect(segs.reduce((s, r) => s + num(r.attributes('width')), 0)).toBeCloseTo(320, 5)
    // the stacked_bar segments are key-based too (1 / 2 / null)
    expect(segs.map((r) => r.attributes('fill'))).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])

    // line: no real report emits it anymore (the monthly trend is bar_v), so
    // the renderer coverage rides the test-only 'monthly_trend_line' fixture
    // section (TASK-116) — same expectations as before
    const line = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(line.wrapper.findAll('[data-chart="line"] circle.bb-chart__point')).toHaveLength(6)
    expect(line.wrapper.find('[data-chart="line"] path.bb-chart__line').attributes('d')).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){5}$/)
    const ys = line.wrapper.findAll('[data-chart="line"] circle.bb-chart__point').map((c) => num(c.attributes('cy')))
    expect(Math.min(...ys)).toBe(ys[5]) // largest value (52000) is drawn highest

    const table = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_payment_method') }))
    expect(table.wrapper.findAll('[data-chart="table"] tr')).toHaveLength(2)
    expect(table.wrapper.find('[data-chart="table"]').text()).toContain('40,000円')

    const scatter = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    const pts = scatter.wrapper.findAll('[data-chart="scatter_line"] circle.bb-chart__point')
    expect(pts).toHaveLength(3)
    expect(pts[0]!.attributes('r')).toBe('4')
  })

  it('[covers:widget.stats-chart-axis-ends] bar_v labels: axis ends only, full form, single bar', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    const texts = wrapper.findAll('[data-section="monthly_trend"] text.bb-chart__axis')
    const bottom = texts.filter((t) => t.attributes('y') === '154')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]!.text()).toBe('2026年5月')
    expect(bottom[0]!.attributes('text-anchor')).toBe('start')
    expect(bottom[0]!.attributes('x')).toBe('36')
    expect(bottom[1]!.text()).toBe('2026年10月')
    expect(bottom[1]!.attributes('text-anchor')).toBe('end')
    expect(bottom[1]!.attributes('x')).toBe('320')
    // each bar keeps its full title (label + amount). TASK-116: the segments
    // carry their own <title> inside each rect, so the bar count limits the
    // search to the bar titles (direct g children) — still exactly 6
    const titles = wrapper.findAll('[data-section="monthly_trend"] g > title')
    expect(titles).toHaveLength(6)
    expect(titles[0]!.text()).toBe('2026年5月: 41,000円')

    const one = statsEnvelope('monthly_overview')
    const trend = one.sections.find((s) => s.id === 'monthly_trend')!
    trend.rows = [trend.rows[trend.rows.length - 1]!]
    const single = await mountWidget(fakeHost({ toolOutput: one, meta: statsMeta('monthly_overview') }))
    const bottomOne = single.wrapper.findAll('[data-section="monthly_trend"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(bottomOne).toHaveLength(1)
    expect(bottomOne[0]!.text()).toBe('2026年10月')
    expect(bottomOne[0]!.attributes('text-anchor')).toBe('start')
  })

  it('[covers:widget.stats-scatter-axis-ends] scatter_line labels: axis ends, JA dates, dup/single guards', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    const bottom = wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]!.text()).toBe('2026年8月2日')
    expect(bottom[0]!.attributes('text-anchor')).toBe('start')
    expect(bottom[0]!.attributes('x')).toBe('36')
    expect(bottom[1]!.text()).toBe('2026年10月5日')
    expect(bottom[1]!.attributes('text-anchor')).toBe('end')
    expect(bottom[1]!.attributes('x')).toBe('320')
    // each point keeps its title, rebuilt from the converted label
    const titles = wrapper.findAll('[data-chart="scatter_line"] g title')
    expect(titles).toHaveLength(3)
    expect(titles[0]!.text()).toBe('2026年8月2日（スーパーみどり 駅前店）: 238円')

    const dup = statsEnvelope('item_price_history')
    // 3 points kept; the last row is set to the first's date so the dup guard hides the end label
    dup.sections[0]!.rows[2]!.labels[0] = '2026-08-02'
    const dupW = await mountWidget(fakeHost({ toolOutput: dup }))
    const dupBottom = dupW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(dupBottom).toHaveLength(1)
    expect(dupBottom[0]!.text()).toBe('2026年8月2日')
    expect(dupBottom[0]!.attributes('text-anchor')).toBe('start')

    const one = statsEnvelope('item_price_history')
    one.sections[0]!.rows = [one.sections[0]!.rows[0]!]
    const oneW = await mountWidget(fakeHost({ toolOutput: one }))
    const oneBottom = oneW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(oneBottom).toHaveLength(1)
    expect(oneBottom[0]!.text()).toBe('2026年8月2日')
    expect(oneBottom[0]!.attributes('text-anchor')).toBe('start')

    const raw = statsEnvelope('item_price_history')
    raw.sections[0]!.rows[0]!.labels[0] = '8/2'
    const rawW = await mountWidget(fakeHost({ toolOutput: raw }))
    expect(rawW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')[0]!.text()).toBe('8/2')
  })

  it('[covers:widget.stats-period-switch] period / report switch re-runs summarize_spending', async () => {
    const host = fakeHost({
      toolOutput: statsEnvelope('monthly_overview'),
      callTool: async (_n, a) => result(statsEnvelope((a as { report: ReportKind }).report, '2026年9月')),
    })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'monthly_overview', period: { preset: 'last_month' } })
    expect(wrapper.find('[data-test="totals-card"]').text()).toContain('2026年9月')
    await wrapper.find('[data-test="report-select"]').setValue('by_store')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'by_store' })
    expect(wrapper.find('[data-section="by_store"]').exists()).toBe(true)
  })

  it('[covers:widget.stats-period-switch] a period switch swaps _meta (trend_matrix) along with the envelope', async () => {
    // the re-run returns a consistently doubled matrix (series AND totals, so
    // the shares stay the same): only the segment amounts change — proof the
    // new response's meta took over the screen, not the initial one
    const doubled = trendMatrix()
    doubled.series = doubled.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2), total: s.total * 2 }))
    doubled.bucket_totals = doubled.bucket_totals.map((v) => v * 2)
    const host = fakeHost({
      toolOutput: statsEnvelope('monthly_overview'),
      meta: statsMeta('monthly_overview'),
      callTool: async (_n, a) =>
        result(statsEnvelope((a as { report: ReportKind }).report, '2026年9月'), { meta: { trend_matrix: doubled } }),
    })
    const { wrapper } = await mountWidget(host)
    // the LAST 食費 segment = the newest month (2026-10, 38,000); the bars
    // render in ascending month order so find() would pick 2026-05 instead
    const segTitleOfFood = (w: VueWrapper) =>
      segRects(w)
        .map((s) => segTitle(s))
        .filter((t) => t.startsWith('食費'))
        .at(-1)!
    expect(segTitleOfFood(wrapper)).toBe('食費 38,000円（73%）')
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(segTitleOfFood(wrapper)).toBe('食費 76,000円（73%）')
  })

  it('[covers:widget.stats-period-switch] explicit ledger is kept, item history needs its filter', async () => {
    const explicit = { ...statsEnvelope('by_store'), ledger: { id: 2, name: '実家', source: 'explicit' as const } }
    const host = fakeHost({ toolOutput: explicit, callTool: async () => result(explicit) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="period-select"]').setValue('this_year')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'by_store', period: { preset: 'this_year' }, ledger_id: 2 })

    const noFilter = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    expect(noFilter.wrapper.find('[data-test="period-select"]').attributes('disabled')).toBeDefined()

    const withFilter = { ...statsEnvelope('item_price_history'), filters: { item_query: '牛乳' } }
    const h2 = fakeHost({ toolOutput: withFilter, callTool: async () => result(withFilter) })
    const m2 = await mountWidget(h2)
    await m2.wrapper.find('[data-test="period-select"]').setValue('last_6_months')
    await flushPromises()
    expect(h2.callTool).toHaveBeenLastCalledWith('summarize_spending', {
      report: 'item_price_history',
      period: { preset: 'last_6_months' },
      filters: { item_query: '牛乳' },
    })
  })

  it('[covers:widget.fullscreen-toggle] fullscreen button toggles the display mode', async () => {
    const host = fakeHost({ toolOutput: statsEnvelope() })
    const { wrapper } = await mountWidget(host)
    const btn = () => wrapper.find('[data-test="fullscreen-button"]')
    expect(btn().text()).toBe('全画面')
    await btn().trigger('click')
    expect(host.requestDisplayMode).toHaveBeenLastCalledWith('fullscreen')
    expect(btn().text()).toBe('戻す')
    await btn().trigger('click')
    expect(host.requestDisplayMode).toHaveBeenLastCalledWith('inline')
    expect(btn().text()).toBe('全画面')
  })
})
