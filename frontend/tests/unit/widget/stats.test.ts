import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { statsEnvelope } from '@/widget/fixtures'
import { fakeHost, mountWidget, result } from './helpers'

const num = (v: string | undefined) => Number(v)

describe('stats dashboard', () => {
  it('[covers:widget.stats-chart-values] bar lengths follow the values; totals card shows comparison', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    const bars = wrapper.findAll('[data-section="by_category"] rect.bb-chart__bar')
    const widths = bars.map((b) => num(b.attributes('width')))
    expect(bars.map((b) => num(b.attributes('data-value')))).toEqual([30000, 12000, 10000])
    expect(widths[0]! / widths[1]!).toBeCloseTo(30000 / 12000, 5)
    expect(widths[1]! / widths[2]!).toBeCloseTo(12000 / 10000, 5)
    const vbars = wrapper.findAll('[data-section="monthly_trend"] rect.bb-chart__bar')
    const heights = vbars.map((b) => num(b.attributes('height')))
    expect(heights).toHaveLength(6)
    expect(Math.max(...heights)).toBe(heights[5])
    const card = wrapper.find('[data-test="totals-card"]').text()
    for (const t of ['52,000円', '31件']) expect(card).toContain(t)
  })

  it('[covers:widget.stats-chart-values] chart kinds: stacked_bar, line, table, scatter_line', async () => {
    const stacked = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_category') }))
    const segs = stacked.wrapper.findAll('[data-chart="stacked_bar"] rect[data-value]')
    expect(segs).toHaveLength(3)
    expect(segs.reduce((s, r) => s + num(r.attributes('width')), 0)).toBeCloseTo(320, 5)

    const line = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_trend') }))
    expect(line.wrapper.findAll('[data-chart="line"] circle.bb-chart__point')).toHaveLength(6)
    expect(line.wrapper.find('[data-chart="line"] path.bb-chart__line').attributes('d')).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){5}$/)
    const ys = line.wrapper.findAll('circle.bb-chart__point').map((c) => num(c.attributes('cy')))
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
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    const texts = wrapper.findAll('[data-section="monthly_trend"] text.bb-chart__axis')
    const bottom = texts.filter((t) => t.attributes('y') === '154')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]!.text()).toBe('2026年5月')
    expect(bottom[0]!.attributes('text-anchor')).toBe('start')
    expect(bottom[0]!.attributes('x')).toBe('36')
    expect(bottom[1]!.text()).toBe('2026年10月')
    expect(bottom[1]!.attributes('text-anchor')).toBe('end')
    expect(bottom[1]!.attributes('x')).toBe('320')
    // each bar keeps its full title (label + amount)
    const titles = wrapper.findAll('[data-section="monthly_trend"] g title')
    expect(titles).toHaveLength(6)
    expect(titles[0]!.text()).toBe('2026年5月: 41,000円')

    const one = statsEnvelope('monthly_overview')
    const trend = one.sections.find((s) => s.id === 'monthly_trend')!
    trend.rows = [trend.rows[trend.rows.length - 1]!]
    const single = await mountWidget(fakeHost({ toolOutput: one }))
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
      callTool: async (_n, a) => result(statsEnvelope(a.report as never, '2026年9月')),
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
