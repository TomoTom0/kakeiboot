// JST calendar helpers shared by the dashboard, analysis and receipt screens.
// Months are "YYYY-MM" strings; dates are "YYYY-MM-DD".

const JST_OFFSET_MS = 9 * 3_600_000

/** Today's date in JST ("YYYY-MM-DD"). */
export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The current JST month ("YYYY-MM"). */
export function jstMonth(now: Date = new Date()): string {
  return jstToday(now).slice(0, 7)
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const t = y * 12 + (m - 1) + delta
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${y}年${m}月`
}

/** First/last axis labels for a monthly trend ("YYYY-MM" keys, oldest first).
 *  Short "M月" while both ends are in one year, full "YYYY年M月" across years,
 *  null when there are no bars, last=null for a single bar. */
export function axisMonthLabels(keys: readonly string[]): { first: string; last: string | null } | null {
  if (keys.length === 0) return null
  const first = keys[0]!
  const last = keys[keys.length - 1]!
  const fmt = (k: string) => (first.slice(0, 4) === last.slice(0, 4) ? `${Number(k.slice(5))}月` : monthLabel(k))
  return { first: fmt(first), last: keys.length > 1 ? fmt(last) : null }
}

/** Last day of the month ("YYYY-MM-DD"). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** "2026-10-05" -> "10/5"; null -> "-". */
export function shortDate(d: string | null | undefined): string {
  if (!d) return '-'
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

/** "2026-10-05" -> "10月5日（月）". */
export function dayLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const w = WEEKDAY[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]
  return `${m}月${day}日（${w}）`
}
