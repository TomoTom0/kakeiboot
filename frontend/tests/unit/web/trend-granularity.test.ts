// TASK-53/55 (design: tmp/tasks/tm-53/design_week-and-trend.md §4-1/§4-5/§4-7,
// TASK-89: the data moved to the analysis trend endpoint — its buckets and
// bucket_totals arrive zero-filled server-side, so only the pure date rules
// and the granularity thresholds stay tested here):
// weekStart (Monday anchor), shortTime, span/trend granularity thresholds
// (62/366 days).
import { describe, expect, it } from 'vitest'
import { shiftDate, shortTime, weekStart } from '@/web/composables/period'
import { spanGranularity, trendGranularity } from '@/web/composables/trend'

describe('week / time helpers (TASK-53/57)', () => {
  it('[covers:web-shell.period-week-mode] weekStart は月曜を返し shortTime は HH:MM（無しは -）', () => {
    expect(weekStart('2026-10-15')).toBe('2026-10-12') // Thu -> Mon
    expect(weekStart('2026-10-18')).toBe('2026-10-12') // Sun -> the same Mon
    expect(weekStart('2026-10-19')).toBe('2026-10-19') // Mon stays
    expect(shiftDate('2026-10-12', 6)).toBe('2026-10-18')
    expect(shiftDate('2026-10-05', -7)).toBe('2026-09-28')
    expect(shortTime('18:30')).toBe('18:30')
    expect(shortTime('09:05:30')).toBe('09:05')
    expect(shortTime(null)).toBe('-')
  })
})

describe('trend granularity thresholds (TASK-55)', () => {
  it('[covers:web-home.trend-granularity] 粒度は 週モード=日・月/年=月・range は 62/366 日の閾値で決まる', () => {
    expect(trendGranularity('week', '2026-10-05', '2026-10-11')).toBe('day')
    expect(trendGranularity('month', '2026-10-01', '2026-10-31')).toBe('month')
    expect(trendGranularity('year', '2026-01-01', '2026-12-31')).toBe('month')
    expect(trendGranularity('range', '2026-10-03', '2026-10-15')).toBe('day') // 13d
    expect(trendGranularity('range', '2026-08-01', '2026-10-15')).toBe('week') // 76d
    expect(trendGranularity('range', '2025-01-01', '2026-10-15')).toBe('month') // >366d
    // the receipts card rule ignores the mode entirely (a month period keeps
    // its 31 daily bars): span-only
    expect(spanGranularity('2026-10-01', '2026-10-31')).toBe('day')
    expect(spanGranularity('2026-01-01', '2026-12-31')).toBe('week') // 365d
    expect(spanGranularity('2025-09-01', '2026-10-15')).toBe('month') // 410d
    expect(spanGranularity('2026-10-01', '2026-10-01')).toBe('day')
  })
})
