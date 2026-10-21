// TASK-53 (design: tmp/tasks/tm-53/design_week-and-trend.md §4-1/§4-2): the
// period store's week mode — a Monday-anchored 7-day period with its own
// label / compare vocabulary / URL form, stepping by whole weeks capped at
// the current week (the month rule generalized). "today" is 2026-10-15 (Thu),
// so the current week is 2026-10-12..2026-10-18 and the previous week
// 2026-10-05..2026-10-11 holds all three mock receipts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePeriodStore } from '@/web/stores/period'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  setActivePinia(createPinia())
})

describe('period store week mode (TASK-53)', () => {
  it('[covers:web-shell.period-week-mode] 週は月曜始まりの7日・ラベル「YYYY年M月D日の週」・前週・query は from/to・urlQuery は week=', () => {
    const p = usePeriodStore()
    expect(p.mode).toBe('month')
    p.setWeek('2026-10-05')
    expect(p.mode).toBe('week')
    expect(p.range).toEqual(['2026-10-05', '2026-10-11'])
    expect(p.label).toBe('2026年10月5日の週')
    expect(p.labelShort).toBe('10/5週')
    expect(p.compareLabel).toBe('前週')
    expect(p.query()).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(p.trendQuery()).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(p.urlQuery).toEqual({ week: '2026-10-05' })
    expect(p.valid).toBe(true)
  })

  it('[covers:web-shell.period-week-mode] step は±7日で当週より先へ不可・fromQuery の week= は月曜へ正規化し不正日は無視', () => {
    const p = usePeriodStore()
    // the current week (2026-10-12) cannot move forward
    p.setWeek('2026-10-15') // Thursday normalizes to the Monday 2026-10-12
    expect(p.week).toBe('2026-10-12')
    expect(p.canNext).toBe(false)
    p.step(1)
    expect(p.week).toBe('2026-10-12')
    // back and forward again
    p.step(-1)
    expect(p.week).toBe('2026-10-05')
    expect(p.canNext).toBe(true)
    p.step(-1)
    expect(p.week).toBe('2026-09-28')
    p.step(1)
    expect(p.week).toBe('2026-10-05')

    // URL round trip: week= lands on the Monday, month= wins first, a bad
    // week leaves the mode alone, from&to still falls back
    const q = usePeriodStore()
    q.fromQuery({ week: '2026-10-07' })
    expect(q.mode).toBe('week')
    expect(q.week).toBe('2026-10-05')
    q.fromQuery({ month: '2026-09' })
    expect(q.mode).toBe('month')
    expect(q.month).toBe('2026-09')
    q.fromQuery({ week: '2026-13-99' })
    expect(q.mode).toBe('month')
    q.fromQuery({ week: '' })
    expect(q.mode).toBe('month')
    q.fromQuery({ from: '2026-10-03', to: '2026-10-15' })
    expect(q.mode).toBe('range')
  })
})
