export type ChartDatum = { label: string; value: number; compare?: number | null; sub?: string | null }

/** Series colors are CSS variables (spec §11-7). */
export const SERIES = ['var(--bb-series-1)', 'var(--bb-series-2)', 'var(--bb-series-3)', 'var(--bb-series-4)', 'var(--bb-series-5)', 'var(--bb-series-6)']

export function seriesColor(i: number): string {
  return SERIES[i % SERIES.length] ?? 'var(--bb-accent)'
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
  if (a >= 1000) return `${Math.round(v / 100) / 10}千`
  return String(v)
}
