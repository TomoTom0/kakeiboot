// TASK-53/55 (design: tmp/tasks/tm-53/design_week-and-trend.md §4-1/§4-5/§4-7):
// the pure date/bucket helpers behind the granularity-following trend —
// weekStart (Monday anchor), shortTime, span/trend granularity thresholds
// (62/366 days) and the daily_cumulative → day/week/month row builders
// (zero-filled, Monday-anchored weekly buckets clipped at range edges).
import { describe, expect, it } from 'vitest'
import { shiftDate, shortTime, weekStart } from '@/web/composables/period'
import {
  dailyRows,
  monthlyRows,
  spanGranularity,
  trendGranularity,
  weeklyRows,
} from '@/web/composables/trend'

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

/** cumulative -> {date: delta} */
function cum(entries: [string, number][]): { date: string; value: number }[] {
  let acc = 0
  return entries.map(([date, v]) => {
    acc += v
    return { date, value: acc }
  })
}

describe('daily_cumulative bucket builders (TASK-55)', () => {
  it('[covers:web-receipts.trend-card-granularity] dailyRows は期間の毎日を零埋め・weeklyRows は月曜アンカー・monthlyRows は月ごと', () => {
    const c = cum([
      ['2026-10-05', 150],
      ['2026-10-08', 398],
      ['2026-10-10', 400],
    ])
    const days = dailyRows(c, '2026-10-05', '2026-10-11')
    expect(days).toHaveLength(7)
    expect(days.map((r) => r.keys[0])).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ])
    expect(days[0]).toMatchObject({ value: 150 })
    expect(days[1]).toMatchObject({ value: 0 })
    expect(days[5]).toMatchObject({ value: 400 })

    // weekly buckets over 2026-08-01..10-15: Mondays from 2026-07-27,
    // the last bucket clipped at the range end (10-15)
    const weeks = weeklyRows(c, '2026-08-01', '2026-10-15')
    expect(weeks.map((r) => r.keys[0])).toEqual([
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ])
    expect(weeks.at(-1)).toMatchObject({ value: 0 })
    expect(weeks.find((r) => r.keys[0] === '2026-10-05')).toMatchObject({ value: 948 })

    const months = monthlyRows(c, '2025-01-01', '2026-10-15')
    expect(months).toHaveLength(22)
    expect(months[0]).toMatchObject({ keys: ['2025-01'] })
    expect(months.at(-1)).toMatchObject({ keys: ['2026-10'], value: 948 })
  })
})
