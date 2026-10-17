// TASK-66 (design: tmp/tasks/tm-66/design_home-period.md §1-2 / §2-2 / §4-2):
// the per-day-average divisor, generalized from the current-month rule —
// through today while the period is still running, the full length once it
// has ended, never less than 1. A pure helper (like axisMonthLabels), pinned
// directly: the jsdom tests exercise it only through the KPI numbers.
import { describe, expect, it } from 'vitest'
import { periodDays } from '@/web/composables/period'

describe('periodDays', () => {
  it('[covers:web-home.dashboard-period-modes] 進行中は今日まで・確定期間は全日数・未来は1でガード', () => {
    expect(periodDays('2026-10-01', '2026-10-31', '2026-10-15')).toBe(15) // 当月（現行月規則と同一）
    expect(periodDays('2026-09-01', '2026-09-30', '2026-10-15')).toBe(30) // 過去月
    expect(periodDays('2026-01-01', '2026-12-31', '2026-10-15')).toBe(288) // 当年
    expect(periodDays('2025-01-01', '2025-12-31', '2026-10-15')).toBe(365) // 過去年
    expect(periodDays('2026-10-03', '2026-10-15', '2026-10-15')).toBe(13) // 進行中range（今日込み）
    expect(periodDays('2026-10-01', '2026-10-05', '2026-10-15')).toBe(5) // 確定range
    expect(periodDays('2026-11-01', '2026-11-30', '2026-10-15')).toBe(1) // 未来
  })
})
