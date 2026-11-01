// TASK-53 (design: tmp/tasks/tm-53/design_week-and-trend.md §4-1/§4-2): the
// period store's week mode — a Monday-anchored 7-day period with its own
// label vocabulary / URL form, stepping by whole weeks. TASK-146 §1
// (design: tmp/tasks/tm-146/design_period_navigation.md §1) removed the
// current-period cap: the week/month/year steps move into the future too,
// and the only bound left is the backend's year acceptance (1900..=9999).
// "today" is 2026-10-15 (Thu), so the current week is 2026-10-12..2026-10-18
// and the previous week 2026-10-05..2026-10-11 holds all three mock receipts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePeriodStore } from '@/web/stores/period'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  setActivePinia(createPinia())
})

describe('period store week mode (TASK-53 + TASK-146 §1)', () => {
  it('[covers:web-shell.period-week-mode] 週は月曜始まりの7日・ラベル「YYYY年M月D日の週」・前週・query は from/to・urlQuery は week=', () => {
    const p = usePeriodStore()
    expect(p.mode).toBe('month')
    p.setWeek('2026-10-05')
    expect(p.mode).toBe('week')
    expect(p.range).toEqual(['2026-10-05', '2026-10-11'])
    expect(p.label).toBe('2026年10月5日の週')
    expect(p.labelShort).toBe('10/5週')
    expect(p.query()).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(p.trendQuery()).toEqual({ from: '2026-10-05', to: '2026-10-11' })
    expect(p.urlQuery).toEqual({ week: '2026-10-05' })
    expect(p.valid).toBe(true)
  })

  it('[covers:web-shell.period-week-mode] step は±7日で未来へも移動・fromQuery の week= は月曜へ正規化し不正日は無視', () => {
    const p = usePeriodStore()
    // TASK-146 §1: the current-week cap is gone — › steps into the future
    p.setWeek('2026-10-15') // Thursday normalizes to the Monday 2026-10-12
    expect(p.week).toBe('2026-10-12')
    expect(p.canNext).toBe(true)
    p.step(1)
    expect(p.week).toBe('2026-10-19')
    // back and forward again
    p.step(-1)
    expect(p.week).toBe('2026-10-12')
    p.step(-1)
    expect(p.week).toBe('2026-10-05')
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

  it('[covers:web-shell.period-uncapped-step] 月・年も未来へstep可・year の上限は backend 受理上限の 9999 のみ（到達で › 無効）', () => {
    const p = usePeriodStore()
    // month: today is 2026-10 — the current month steps forward freely now
    expect(p.canNext).toBe(true)
    p.step(1)
    expect(p.month).toBe('2026-11')
    p.step(1)
    expect(p.month).toBe('2026-12')
    // year: the only bound left is the backend's Year 1900..=9999 acceptance
    p.mode = 'year'
    p.year = 2026
    expect(p.canNext).toBe(true)
    p.step(1)
    expect(p.year).toBe(2027)
    p.year = 9998
    expect(p.canNext).toBe(true)
    p.step(1)
    expect(p.year).toBe(9999)
    expect(p.canNext).toBe(false)
    // a press at the bound keeps the year (the UI's › is disabled here)
    p.step(1)
    expect(p.year).toBe(9999)
    // the lower end of the same acceptance: 1900 is the floor (a press past
    // it keeps the year)
    p.year = 1900
    p.step(-1)
    expect(p.year).toBe(1900)
  })
})
