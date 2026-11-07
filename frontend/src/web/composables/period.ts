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

/** Axis tick indices for n bars (TASK-100): at most 5 ticks, ascending, and
 *  always the first and the last bar. 1..5 bars keep every index; beyond
 *  that the n-1 span is quartered — step = ceil((n-1)/4), which caps the
 *  enumerated points at 4 (the old ceil(n/5) thinned n=10/14 to 6 ticks).
 *  When the last enumerated point lands directly adjacent to n-1 the pair
 *  would crowd the right edge — swap it for the end itself (n=14: the
 *  enumeration 0,4,8,12 yields [0,4,8,13], not 5 points). */
export function axisTickIndices(n: number): number[] {
  if (n <= 0) return []
  if (n <= 5) return Array.from({ length: n }, (_, i) => i)
  const step = Math.ceil((n - 1) / 4)
  const out: number[] = []
  for (let i = 0; i < n - 1; i += step) out.push(i)
  if (out.length === 4 && out[3] === n - 2) out[3] = n - 1
  else out.push(n - 1)
  return out
}

/** The width-based label-thinning positions (TASK-161 §6-2, the副次経路 of
 *  指摘8): show every label whose distance from the last shown one fits its
 *  estimated width + margin — a measured pitch turns the count cap into a
 *  width rule (a wide screen shows all six month labels; a 360px viewport
 *  keeps the every-other set). The LAST position always stays (the TASK-42
 *  window-ends contract) and REPLACES its immediate predecessor when the
 *  pair would crowd the right edge. `widthAt(i)` supplies the width of the
 *  ACTUAL label the caller will draw at index i (measure the real string —
 *  a full "YYYY年M月" at a year boundary, a compactYen value, a short date);
 *  pitch <= 0 (unmeasured: jsdom, the pre-layout frame) falls back to the
 *  count rule (axisTickIndices). Ascending, deduplicated, both ends in. */
export function axisTickIndicesWide(n: number, pitch: number, widthAt: (i: number) => number, margin = 32): number[] {
  if (n <= 1 || pitch <= 0) return axisTickIndices(n)
  const fits = (from: number, to: number): boolean => (to - from) * pitch >= widthAt(to) + margin
  const out = [0]
  for (let i = 1; i < n - 1; i++) {
    if (fits(out[out.length - 1]!, i)) out.push(i)
  }
  const lastShown = out[out.length - 1]!
  if (lastShown !== n - 1) {
    if (fits(lastShown, n - 1) || out.length === 1) out.push(n - 1)
    // out.length === 1 means the FIRST end would be the replaced one — both
    // ends always stay (the TASK-42 contract outranks the spacing there)
    else out[out.length - 1] = n - 1
  }
  return out
}

export interface AxisMonthLabel { key: string; label: string }

/** One year tick (TASK-162 §5-2): the key of the cell the tick sits on (the
 *  window's head, or the January cell where the year turns) + the bare
 *  4-digit year label. */
export interface AxisYearTick { key: string; label: string }

/** Axis labels for a monthly trend ("YYYY-MM" keys, oldest first).
 *  first/last keep the TASK-42 window-ends contract (short "M月" while both
 *  ends are in one year, full "YYYY年M月" across years, last=null for a
 *  single bar) — ReceiptsPage's inline card consumes these. TASK-100 added
 *  `items` for TrendBars; TASK-162 §5 re-shapes them: EVERY items label is
 *  the short "M月" now (the full "YYYY年M月" form is withdrawn — the year
 *  rides its own tick row) and `years` carries that row: the window's START
 *  YEAR on the head cell once, plus EVERY interior year boundary (each
 *  January cell whose year differs from the previous cell's — a multi-year
 *  window carries one boundary per year turn, at most one tick per year, so
 *  ticks never collide at the 12-cell minimum spacing). A January-starting
 *  window (year mode) keeps the head tick alone — the head IS the boundary.
 *  TASK-161 §6-2: the thinning positions arrive as an explicit `ticks`
 *  index array (TrendBars passes its width-based selection — the
 *  count-based axisTickIndices stays the default, the unmeasured
 *  fallback). */
export function axisMonthLabels(
  keys: readonly string[],
  ticks: number[] = axisTickIndices(keys.length),
): {
  first: string
  last: string | null
  items: AxisMonthLabel[]
  years: AxisYearTick[]
} | null {
  if (keys.length === 0) return null
  const first = keys[0]!
  const last = keys[keys.length - 1]!
  const fmt = (k: string) => (first.slice(0, 4) === last.slice(0, 4) ? `${Number(k.slice(5))}月` : monthLabel(k))
  const items = ticks.map((i) => {
    const key = keys[i]!
    return { key, label: `${Number(key.slice(5))}月` }
  })
  // the year row (§5-2): the head's year once + every interior boundary (a
  // January whose year differs from the previous cell's — the head of a
  // January-starting window is the head tick itself, no duplicate)
  const years: AxisYearTick[] = [{ key: first, label: first.slice(0, 4) }]
  for (let i = 1; i < keys.length; i++) {
    if (keys[i]!.slice(0, 4) !== keys[i - 1]!.slice(0, 4)) {
      years.push({ key: keys[i]!, label: keys[i]!.slice(0, 4) })
    }
  }
  return { first: fmt(first), last: keys.length > 1 ? fmt(last) : null, items, years }
}

/** Days elapsed in a period for a per-day average: through today while the
 *  period is still running (the current month rule generalized), the full
 *  length once it has ended, never less than 1. Date-only strings parse as
 *  UTC, so the day math has no TZ drift. */
export function periodDays(from: string, to: string, today: string = jstToday()): number {
  const end = to < today ? to : today
  return Math.max(Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000) + 1, 1)
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

/** "2026-10-05" ± n days -> "YYYY-MM-DD" (UTC math, no TZ drift). */
export function shiftDate(d: string, days: number): string {
  return new Date(Date.parse(d) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Monday of the week containing d ("YYYY-MM-DD"; Sunday joins the previous
 *  Monday). Weeks are Monday-anchored (TASK-53, the JST calendar standard). */
export function weekStart(d: string): string {
  const day = new Date(Date.parse(d)).getUTCDay() // 0 = Sunday
  return shiftDate(d, -((day + 6) % 7))
}

/** "18:30"/"09:05:30" -> "18:30"/"09:05"; null -> "-" (TASK-63/57: the day
 *  group rows show the time — the group head already carries the date). */
export function shortTime(t: string | null | undefined): string {
  if (!t) return '-'
  return t.slice(0, 5)
}

const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

/** "2026-10-05" -> "10月5日（月）". */
export function dayLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const w = WEEKDAY[new Date(Date.UTC(y, m - 1, day)).getUTCDay()]
  return `${m}月${day}日（${w}）`
}
