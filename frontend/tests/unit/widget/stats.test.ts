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
    for (const t of ['52,000円', '31件', '+4,000円', '+8.3%']) expect(card).toContain(t)
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
    expect(table.wrapper.find('[data-chart="table"]').text()).toContain('-1,000円')

    const scatter = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    const pts = scatter.wrapper.findAll('[data-chart="scatter_line"] circle.bb-chart__point')
    expect(pts).toHaveLength(3)
    expect(pts[0]!.attributes('r')).toBe('4')
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
