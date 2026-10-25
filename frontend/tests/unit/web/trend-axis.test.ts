// TASK-42 (design: tmp/tasks/tm-42/design_trend-labels.md §2-1 / §4-3) laid
// down the axis-label helper both trend surfaces share; TASK-100 (design:
// tmp/tasks/tm-100/design_trend-chart-axes.md §1-1 / §4) extends it: the
// axis thins to at most 5 ticks (axisTickIndices) and axisMonthLabels gains
// the `items` array TrendBars renders, with a single year-boundary format
// rule. The jsdom tests (dashboard-shell / view-pages) pin the rendered
// axis; this file pins the thinning and format rules on the helpers.
import { describe, expect, it } from 'vitest'
import { axisMonthLabels, axisTickIndices, shiftMonth } from '@/web/composables/period'

const months = (start: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => shiftMonth(start, i))

describe('axisTickIndices', () => {
  it('[covers:web-browse.trend-axis-minimal] 0→[]・n<=5 は全index・6→[0,2,4,5]', () => {
    expect(axisTickIndices(0)).toEqual([])
    expect(axisTickIndices(1)).toEqual([0])
    expect(axisTickIndices(2)).toEqual([0, 1])
    expect(axisTickIndices(3)).toEqual([0, 1, 2])
    expect(axisTickIndices(5)).toEqual([0, 1, 2, 3, 4])
    expect(axisTickIndices(6)).toEqual([0, 2, 4, 5])
  })

  it('[covers:web-browse.trend-axis-minimal] step=ceil((n-1)/4): 9→[0,2,4,6,8]・12→[0,3,6,9,11]・13→[0,3,6,9,12]・18→[0,5,10,15,17]', () => {
    expect(axisTickIndices(9)).toEqual([0, 2, 4, 6, 8])
    expect(axisTickIndices(12)).toEqual([0, 3, 6, 9, 11])
    expect(axisTickIndices(13)).toEqual([0, 3, 6, 9, 12])
    expect(axisTickIndices(18)).toEqual([0, 5, 10, 15, 17])
  })

  it('[covers:web-browse.trend-axis-minimal] 10→[0,3,6,9]・14→[0,4,8,13]（旧 step=ceil(n/5) は6件になった反例の回帰）', () => {
    expect(axisTickIndices(10)).toEqual([0, 3, 6, 9])
    expect(axisTickIndices(14)).toEqual([0, 4, 8, 13])
  })

  it('[covers:web-browse.trend-axis-minimal] 常に 0 と n-1 を含み件数は5以下（昇順・重複なし）', () => {
    for (let n = 1; n <= 30; n++) {
      const idx = axisTickIndices(n)
      expect(idx.length, `n=${n}`).toBeLessThanOrEqual(5)
      expect(idx[0], `n=${n}`).toBe(0)
      expect(idx[idx.length - 1], `n=${n}`).toBe(n - 1)
      expect(new Set(idx).size, `n=${n}`).toBe(idx.length)
      expect(idx, `n=${n}`).toEqual([...idx].sort((a, b) => a - b))
    }
  })
})

describe('axisMonthLabels', () => {
  it('[covers:web-browse.trend-axis-minimal] 単年窓は全ラベル「M月」・単月は items が「10月」1件で last=null・空は null', () => {
    // a single-year 6-month window: ticks [0,2,4,5], every label short
    expect(axisMonthLabels(months('2026-05', 6))).toEqual({
      first: '5月',
      last: '10月',
      items: [
        { key: '2026-05', label: '5月' },
        { key: '2026-07', label: '7月' },
        { key: '2026-09', label: '9月' },
        { key: '2026-10', label: '10月' },
      ],
    })
    // a single month: items keep the one label, last stays null (the
    // first/last contract ReceiptsPage consumes is unchanged)
    expect(axisMonthLabels(['2026-10'])).toEqual({
      first: '10月',
      last: null,
      items: [{ key: '2026-10', label: '10月' }],
    })
    expect(axisMonthLabels([])).toBeNull()
  })

  it('[covers:web-browse.trend-axis-minimal] 跨年窓は年が変わる表示ラベルのみフル形式・年モード先頭（窓先頭1月）もフル形式', () => {
    // a 12-month cross-year window: the head and the first label of the new
    // year go full, the same-year rest stays short
    expect(axisMonthLabels(months('2025-11', 12))).toEqual({
      first: '2025年11月',
      last: '2026年10月',
      items: [
        { key: '2025-11', label: '2025年11月' },
        { key: '2026-02', label: '2026年2月' },
        { key: '2026-05', label: '5月' },
        { key: '2026-08', label: '8月' },
        { key: '2026-10', label: '10月' },
      ],
    })
    // year mode (Jan..Dec): the window head is January, so the first label
    // goes full even inside a single-year window; the rest stays short
    expect(axisMonthLabels(months('2026-01', 12))).toEqual({
      first: '1月',
      last: '12月',
      items: [
        { key: '2026-01', label: '2026年1月' },
        { key: '2026-04', label: '4月' },
        { key: '2026-07', label: '7月' },
        { key: '2026-10', label: '10月' },
        { key: '2026-12', label: '12月' },
      ],
    })
  })
})
