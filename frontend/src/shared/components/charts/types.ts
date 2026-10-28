import type { StackedSegment } from '@/shared/lib/stackedBars'

export type ChartDatum = {
  label: string
  value: number
  sub?: string | null
  /** the row's series key (StatsRow.keys[0], null included). TASK-116: the
   *  bar_h / stacked_bar rows and the bar_v segments paint the SAME key the
   *  same color as the web app (the shared seriesColor mapping); a datum
   *  without a key falls back to the index slot below — the shared mapping's
   *  NUMBER path is never fed an index ((id-1) mod 7 would shift by one) */
  key?: string | number | null
  /** the stacked composition (TASK-116): present => BarVChart draws the bar
   *  as a segment rect column instead of the single rect */
  segments?: StackedSegment[]
}

/** The index-slot fallback palette (7 + rest, the web tokens — the values
 *  live in style.css, TASK-116 unified them with the web app). */
export const SERIES = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
]

/** The INDEX-based fallback (i % 7, index 0 -> the first color) for data
 *  rows that carry no key. Keyed rows use the shared seriesColor(key)
 *  mapping instead (frontend/src/shared/lib/seriesColor.ts). */
export function seriesColorAt(index: number): string {
  return SERIES[index % SERIES.length] ?? 'var(--series-rest)'
}

/** Nice upper bound for an axis (1, 2, 5 x 10^n). */
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(max)))
  for (const m of [1, 2, 5, 10]) if (m * exp >= max) return m * exp
  return 10 * exp
}

/** Compact yen label for axes (e.g. 12000 -> "1.2万"). */
export function compactYen(v: number): string {
  const a = Math.abs(v)
  if (a >= 10000) return `${Math.round((v / 10000) * 10) / 10}万`
  if (a >= 1000) return `${Math.round((v / 100) / 10)}千`
  return String(v)
}
