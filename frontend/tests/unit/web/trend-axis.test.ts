// TASK-42 (design: tmp/tasks/tm-42/design_trend-labels.md §2-1 / §4-3): the
// axis-label helper both trend surfaces (the HomePage inline bars and
// TrendBars) share. The jsdom tests (dashboard-shell / view-pages) pin the
// rendered axis; this file pins the year-boundary format rules on the helper.
import { describe, expect, it } from 'vitest'
import { axisMonthLabels } from '@/web/composables/period'

describe('axisMonthLabels', () => {
  it('[covers:web-browse.trend-axis-minimal] 同年は「M月」・年跨ぎは「YYYY年M月」・単月は first のみ・空は null', () => {
    expect(axisMonthLabels(['2026-05', '2026-06', '2026-10'])).toEqual({ first: '5月', last: '10月' })
    expect(axisMonthLabels(['2025-11', '2026-01', '2026-10'])).toEqual({ first: '2025年11月', last: '2026年10月' })
    expect(axisMonthLabels(['2026-10'])).toEqual({ first: '10月', last: null })
    expect(axisMonthLabels([])).toBeNull()
  })
})
