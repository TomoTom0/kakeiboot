// TASK-53 (design: tmp/tasks/tm-53/design_week-and-trend.md §4-1/§4-2): the
// period store's week mode — a Monday-anchored 7-day period with its own
// label vocabulary / URL form, stepping by whole weeks. TASK-146 §1
// (design: tmp/tasks/tm-146/design_period_navigation.md §1) removed the
// current-period cap: the week/month/year steps move into the future too,
// and the only bound left is the backend's year acceptance (1900..=9999).
// "today" is 2026-10-15 (Thu), so the current week is 2026-10-12..2026-10-18
// and the previous week 2026-10-05..2026-10-11 holds all three mock receipts.
// TASK-164 (design: tmp/tasks/tm-164/design_back_home.md v4 §1/§2-2-1) adds
// the home re-press reset (resetToDefault — press-time JST recompute, labels
// untouched) and the user/internal API split behind the writeBack
// push/replace discrimination (nextWrite one-shot flag + the residue
// rules). Test-first: the TASK-164 block stays red until it lands.
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

// TASK-164 §1/§2-2-1 (design: tmp/tasks/tm-164/design_back_home.md v4): the
// home re-press reset — resetToDefault() recomputes the default period from
// the JST date AT THE PRESS (the store's thisMonth is a creation-time
// constant, so a session crossing a month boundary still lands on the new
// current month), keeps the label filter untouched (user-confirmed B1) and
// never marks its write as a user one (§1-3: the reset's write-back lands as
// a replace). The user/internal API split carries the writeBack push/replace
// discrimination (§2-2-1): step / setMonth / setWeek / setMode / setRange
// raise the one-shot nextWrite='user' ONLY when the value actually changes
// (residue rule 1), and the internal side (fromQuery / resetToDefault)
// clears a standing flag instead of inheriting it (rule 2). Written
// test-first — these stay red until the implementation lands.
describe('period store reset + user/internal API split (TASK-164)', () => {
  it('[covers:web-shell.home-repress-reset] resetToDefault は全期間次元を当月形（month mode・当月）へ復帰し labels/labelDirty は不変', () => {
    const p = usePeriodStore()
    p.setMonth('2026-05')
    p.setLabelColors(['red'])
    p.resetToDefault()
    expect(p.mode).toBe('month')
    expect(p.month).toBe('2026-10')
    expect(p.week).toBe('2026-10-12')
    expect(p.year).toBe(2026)
    expect(p.from).toBe('2026-10-01')
    expect(p.to).toBe('2026-10-31')
    // B1: the label dimension is not part of the reset
    expect(p.labelColors).toEqual(['red'])
    expect(p.labelDirty).toBe(true)
  })

  it('[covers:web-shell.home-repress-recompute] reset の当月は押下時の JST 日付から再計算する（store 生成時の thisMonth 固定値を使わない）', () => {
    const p = usePeriodStore() // created while "today" is 2026-10-15
    p.setMonth('2026-05')
    // the session crosses a month boundary: 2026-11-02 is a Monday
    vi.setSystemTime(new Date('2026-11-02T03:00:00Z'))
    p.resetToDefault()
    expect(p.month).toBe('2026-11')
    expect(p.from).toBe('2026-11-01')
    expect(p.to).toBe('2026-11-30')
    expect(p.week).toBe('2026-11-02')
  })

  it('[covers:web-shell.period-next-write-flag] 利用者API（step/setMonth/setWeek/setMode/setRange）は値変化時のみ nextWrite=user・内部API（fromQuery/resetToDefault）は立てず既存フラグをクリア', () => {
    const p = usePeriodStore()
    expect(p.nextWrite).toBe('system')
    // the user APIs raise the one-shot flag on a real value change
    p.step(-1)
    expect(p.nextWrite).toBe('user')
    p.setWeek('2026-10-05')
    expect(p.nextWrite).toBe('user')
    p.setMonth('2026-05')
    expect(p.nextWrite).toBe('user')
    // the new user APIs (the PeriodPicker's mode tab / range form ride
    // these instead of the direct writes)
    p.setMode('year')
    expect(p.nextWrite).toBe('user')
    expect(p.mode).toBe('year')
    p.setRange('2026-01-01', '2026-03-31')
    expect(p.mode).toBe('range')
    expect(p.from).toBe('2026-01-01')
    expect(p.to).toBe('2026-03-31')
    expect(p.nextWrite).toBe('user')

    // residue rule 1 — a same-value re-selection does NOT raise the flag (a
    // re-selection the period watch will not fire on leaves nothing standing
    // for a later system write to consume). The no-op guards are PER-MODE
    // (REVIEW-12 #2): the no-op is the value already selected IN that mode —
    // a same-MONTH setMonth from another mode still re-modes and counts as a
    // user change (a monthly bar pressed while the range view is up must not
    // silently swallow the mode switch)
    p.nextWrite = 'system'
    p.setMonth(p.month) // '2026-05' while in range mode: a user change
    expect(p.mode).toBe('month')
    expect(p.nextWrite).toBe('user')
    p.nextWrite = 'system'
    p.setMonth(p.month) // month mode, same month: the true no-op
    expect(p.nextWrite).toBe('system')
    p.setMode('month') // already month: no-op
    expect(p.nextWrite).toBe('system')
    p.setRange('2026-01-01', '2026-03-31') // a real range change: user
    expect(p.nextWrite).toBe('user')
    p.nextWrite = 'system'
    p.setRange('2026-01-01', '2026-03-31') // same range in range mode: no-op
    expect(p.nextWrite).toBe('system')
    p.step(1) // range mode: step touches no value — no change, no flag
    expect(p.nextWrite).toBe('system')

    // residue rule 2 — the internal side clears a standing flag instead of
    // inheriting it: fromQuery (the URL import) ...
    p.nextWrite = 'user'
    p.fromQuery({ month: '2026-09' })
    expect(p.month).toBe('2026-09')
    expect(p.nextWrite).toBe('system')
    // ... and resetToDefault neither raises nor inherits (§1-3: the reset's
    // write-back is a replace)
    p.setMonth('2026-05')
    expect(p.nextWrite).toBe('user')
    p.resetToDefault()
    expect(p.month).toBe('2026-10')
    expect(p.nextWrite).toBe('system')
  })
})
