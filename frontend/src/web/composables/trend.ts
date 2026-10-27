// Granularity rules of the trend charts (TASK-55; TASK-89 moved the data to
// the analysis trend endpoint — its buckets/bucket_totals already come
// zero-filled server-side, so only the granularity decisions and the bucket
// helpers remain here).
import type { PeriodMode } from '../stores/period'
import { jstToday, shiftDate, weekStart } from './period'

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
