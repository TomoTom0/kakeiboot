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
import { usePeriodStore, type PeriodOperation } from '@/web/stores/period'

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

  it('[covers:web-shell.period-uncapped-step] 月・年も未来へstep可・year の上下限は backend 受理上限の 1900..=9999 のみ（到達で ‹ › 無効）', () => {
    const p = usePeriodStore()
    // month: today is 2026-10 — the current month steps forward freely now
    expect(p.canNext).toBe(true)
    expect(p.canPrev).toBe(true) // month / week have no floor at all
    p.step(1)
    expect(p.month).toBe('2026-11')
    p.step(1)
    expect(p.month).toBe('2026-12')
    // year: the only bound left is the backend's Year 1900..=9999 acceptance
    p.mode = 'year'
    p.year = 2026
    expect(p.canNext).toBe(true)
    expect(p.canPrev).toBe(true)
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
    // it keeps the year) — and ‹ carries the same disabled state as ›
    // (PR#4 #2: the clamp used to no-op silently with ‹ left looking alive)
    p.year = 1900
    expect(p.canPrev).toBe(false)
    expect(p.canNext).toBe(true)
    p.step(-1)
    expect(p.year).toBe(1900)
    p.year = 1901
    expect(p.canPrev).toBe(true)
    p.step(-1)
    expect(p.year).toBe(1900)
    // month / week keep both chevrons alive (no 1900-side floor)
    p.mode = 'month'
    expect(p.canPrev).toBe(true)
    p.mode = 'week'
    expect(p.canPrev).toBe(true)
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
})

// TASK-174 (design: tmp/tasks/tm-174/design_url-history-entries.md v4 D1):
// the one-shot nextWrite flag is replaced by a typed completion notification
// — every VALID public user API (step / setMonth / setWeek / setMode /
// setRange) fires ONE synchronous notification after its whole field update
// completes (never mid-apply), carrying a monotonically increasing
// operationId, the cause (user / import / system), the normalized period
// keys and a labels copy. A same-value re-selection, an invalid range, a
// step in range mode and a year-boundary step that changes nothing are ZERO
// operations. The shell subscribes synchronously and keeps every payload in
// its FIFO — same-tick sequences are NOT collapsed (that withdrawal is the
// heart of TASK-174). Written test-first: these stay red until it lands.
describe('period store operation notifications (TASK-174 D1)', () => {
  /** Collect the store's operation notifications into a sink. */
  function collect(p: ReturnType<typeof usePeriodStore>): { ops: PeriodOperation[]; off: () => void } {
    const ops: PeriodOperation[] = []
    const off = p.subscribeOperations((op: PeriodOperation) => ops.push(op))
    return { ops, off }
  }

  it('[covers:web-shell.period-next-write-flag] 有効な利用者APIごとに1件の完了通知（cause=user・operationId単調増加）・同値/無効range/rangeモードstep/年境界step は0件・import/reset/labels は user でない', () => {
    const p = usePeriodStore()
    const { ops, off } = collect(p)
    // every VALID user API notifies exactly once with cause='user' and a
    // monotonically increasing operationId (D1-2: the notification fires
    // once AFTER the API's whole field update completes)
    p.step(-1)
    p.setWeek('2026-10-05')
    p.setMonth('2026-05')
    p.setMode('year')
    p.setRange('2026-01-01', '2026-03-31')
    expect(ops).toHaveLength(5)
    expect(ops.every((o) => o.cause === 'user')).toBe(true)
    for (let i = 1; i < ops.length; i++) expect(ops[i]!.operationId).toBeGreaterThan(ops[i - 1]!.operationId)

    // the ZERO-operation sides of the same APIs notify nothing: the same
    // range re-committed IN range mode, an empty/reversed range, a step in
    // range mode
    ops.length = 0
    p.setRange('2026-01-01', '2026-03-31')
    p.setRange('', '2026-03-31')
    p.setRange('2026-03-31', '2026-01-01')
    p.step(1)
    expect(ops).toHaveLength(0)
    // a re-mode is real (one notification) ... then its own no-ops: the
    // same mode again and the same month IN month mode
    p.setMode('month')
    expect(ops).toHaveLength(1)
    ops.length = 0
    p.setMode('month')
    p.setMonth(p.month)
    expect(ops).toHaveLength(0)
    // the year-boundary step that changes nothing (9999 cap) is zero too
    p.setMode('year')
    p.year = 9999
    ops.length = 0
    p.step(1)
    expect(ops).toHaveLength(0)

    // import / reset / labels are NOT user causes (D1-2: fromQuery notifies
    // as 'import', resetToDefault and label changes as 'system')
    ops.length = 0
    p.fromQuery({ month: '2026-09' })
    expect(ops).toHaveLength(1)
    expect(ops[0]!.cause).toBe('import')
    expect(ops[0]!.keys).toEqual({ month: '2026-09' })
    ops.length = 0
    p.resetToDefault()
    expect(ops).toHaveLength(1)
    expect(ops[0]!.cause).toBe('system')
    expect(ops[0]!.keys).toEqual({ month: '2026-10' })
    ops.length = 0
    p.setLabelColors(['red'])
    expect(ops).toHaveLength(1)
    expect(ops[0]!.cause).toBe('system')
    expect(ops[0]!.labels).toEqual(['red'])
    // an import that changes nothing notifies nothing
    ops.length = 0
    p.fromQuery({ month: '2026-10' })
    expect(ops).toHaveLength(0)
    off()
  })

  it('[covers:web-browse.url-operation-capture] 同tickのA→B→C・A→B→Aは各2操作として保存（watchバッチングで消さない）・mode/rangeの複数field更新は1操作・payloadは通知時点のsnapshot', () => {
    const p = usePeriodStore()
    const { ops, off } = collect(p)
    // A→B→C in one tick: TWO saved operations — the intermediate B must not
    // vanish into watch batching (the old value watch observed only C)
    p.setMonth('2026-05')
    p.setMonth('2026-04')
    expect(ops).toHaveLength(2)
    expect(ops[0]!.keys).toEqual({ month: '2026-05' })
    expect(ops[1]!.keys).toEqual({ month: '2026-04' })
    // the payload is a snapshot: a later operation never rewrites it
    p.setMonth('2026-03')
    expect(ops[0]!.keys).toEqual({ month: '2026-05' })

    // A→B→A in one tick is two operations too — the value returns, but both
    // round-trip legs stand as history demands
    ops.length = 0
    p.setMonth('2026-02')
    p.setMonth('2026-03')
    expect(ops).toHaveLength(2)
    expect(ops[0]!.keys).toEqual({ month: '2026-02' })
    expect(ops[1]!.keys).toEqual({ month: '2026-03' })

    // an API touching MANY fields at once is ONE operation: setRange writes
    // mode/from/to together, and the labels copy rides the payload
    ops.length = 0
    p.setRange('2026-01-01', '2026-03-31')
    expect(ops).toHaveLength(1)
    expect(ops[0]!.keys).toEqual({ from: '2026-01-01', to: '2026-03-31' })
    expect(ops[0]!.labels).toEqual([])
    p.setLabelColors(['blue'])
    expect(ops[ops.length - 1]!.labels).toEqual(['blue'])
    // the same-value re-selection is zero
    ops.length = 0
    p.setRange('2026-01-01', '2026-03-31')
    expect(ops).toHaveLength(0)
    off()
  })
})

// Issue #9: lastActivityAt — the freshness clock the browsing URL sync
// compares a home entry against (HOME_FRESH_WINDOW_MS). It starts at the
// store's creation and moves ONLY with a notified operation (any cause:
// user / import / system); a no-op call that notifies nothing leaves it
// untouched, so an idle period ages from its last real change.
describe('period store last activity (Issue #9)', () => {
  const T0 = new Date('2026-10-15T03:00:00Z').getTime()

  it('[covers:web-shell.home-fresh-window] lastActivityAt は生成時刻で初期化され通知を伴う操作（user/import/system）ごとに更新され無変化の呼出では動かない', () => {
    const p = usePeriodStore()
    expect(p.lastActivityAt).toBe(T0)

    // a user operation moves the clock to the operation's time
    vi.setSystemTime(new Date(T0 + 5 * 60 * 1000))
    p.setMonth('2026-05')
    expect(p.lastActivityAt).toBe(T0 + 5 * 60 * 1000)

    // a no-op (the same month re-selected) notifies nothing and the
    // clock stays — the period keeps aging from its last real change
    vi.setSystemTime(new Date(T0 + 9 * 60 * 1000))
    p.setMonth('2026-05')
    expect(p.lastActivityAt).toBe(T0 + 5 * 60 * 1000)

    // import and system operations count as activity too
    p.fromQuery({ month: '2026-09' })
    expect(p.lastActivityAt).toBe(T0 + 9 * 60 * 1000)
    vi.setSystemTime(new Date(T0 + 12 * 60 * 1000))
    p.resetToDefault()
    expect(p.lastActivityAt).toBe(T0 + 12 * 60 * 1000)
    vi.setSystemTime(new Date(T0 + 15 * 60 * 1000))
    p.setLabelColors(['red'])
    expect(p.lastActivityAt).toBe(T0 + 15 * 60 * 1000)
  })
})
