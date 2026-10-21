// Granularity-following trend rows (TASK-55, design:
// tmp/tasks/tm-53/design_week-and-trend.md §4-5/§4-7): pure builders that
// turn a monthly_overview `daily_cumulative` (cumulative sums, filters
// applied server-side) into zero-filled bar rows. Month-granularity rows come
// from the backend monthly_trend sections instead — these helpers only own
// the day/week/month buckets of a date range.
import type { StatsRow } from '../api/data'
import type { PeriodMode } from '../stores/period'
import { jstToday, monthEnd, shiftDate, shiftMonth, weekStart } from './period'

export type TrendGranularity = 'month' | 'week' | 'day'

/** Granularity of a period by its length alone (the receipts card rule: a
 *  month period keeps its daily bars, so the mode is not consulted). */
export function spanGranularity(from: string, to: string): TrendGranularity {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
  if (days <= 62) return 'day'
  if (days <= 366) return 'week'
  return 'month'
}

/** Granularity of the trend chart for a period mode: week -> the selected
 *  week's days, month/year -> months, a custom range -> by its length. */
export function trendGranularity(mode: PeriodMode, from: string, to: string): TrendGranularity {
  if (mode === 'week') return 'day'
  if (mode === 'month' || mode === 'year') return 'month'
  return spanGranularity(from, to)
}

type Cum = readonly { date: string; value: number }[]

/** Per-day deltas of a cumulative series, keyed by date (zero-filled over
 *  [from, to], oldest first). */
export function dailyRows(cum: Cum, from: string, to: string): StatsRow[] {
  const byDay = deltas(cum)
  const out: StatsRow[] = []
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    out.push({ keys: [d], labels: [d], value: byDay.get(d) ?? 0 })
    if (d === to) break
  }
  return out
}

/** Monday-anchored weekly buckets clipped to the range ends (keys = bucket
 *  start, zero-filled; the first/last buckets may hold fewer than 7 days). */
export function weeklyRows(cum: Cum, from: string, to: string): StatsRow[] {
  const byDay = deltas(cum)
  const out: StatsRow[] = []
  for (let w = weekStart(from); w <= to; w = shiftDate(w, 7)) {
    let value = 0
    for (let d = w; d <= to && d < shiftDate(w, 7); d = shiftDate(d, 1)) {
      if (d < from) continue
      value += byDay.get(d) ?? 0
    }
    out.push({ keys: [w], labels: [w], value })
  }
  return out
}

/** Monthly buckets (keys "YYYY-MM", zero-filled). */
export function monthlyRows(cum: Cum, from: string, to: string): StatsRow[] {
  const byDay = deltas(cum)
  const out: StatsRow[] = []
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) {
    let value = 0
    for (let d = `${m}-01`; d <= to && d <= monthEnd(m); d = shiftDate(d, 1)) {
      if (d < from) continue
      value += byDay.get(d) ?? 0
    }
    out.push({ keys: [m], labels: [m], value })
  }
  return out
}

/** cumulative [{date, value}] -> per-day deltas. */
function deltas(cum: Cum): Map<string, number> {
  const out = new Map<string, number>()
  let prev = 0
  for (const p of cum) {
    out.set(p.date, p.value - prev)
    prev = p.value
  }
  return out
}

/** The bar title/axis span of a bucket: the week's actual clipped range
 *  ("10/5〜10/11") or the single day, for titles. */
export function bucketSpan(key: string, granularity: TrendGranularity, from: string, to: string): [string, string] {
  if (granularity === 'day') return [key, key]
  const lo = key < from ? from : key
  const hi = shiftDate(key, 6) > to ? to : shiftDate(key, 6)
  return [lo, hi]
}

/** The highlighted bar's key (the pages share this rule): the selected month
 *  in month mode (year / range keep no highlight), today's day or week-start
 *  when the charted range holds it. */
export function currentTrendKey(
  granularity: TrendGranularity,
  mode: PeriodMode,
  from: string,
  to: string,
  month: string,
  today: string = jstToday(),
): string | null {
  if (granularity === 'month') return mode === 'month' ? month : null
  if (granularity === 'day') return from <= today && today <= to ? today : null
  const ws = weekStart(today)
  return from <= ws && ws <= to ? ws : null
}
