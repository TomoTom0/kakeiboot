// The stacked-bar assembly as one pure function (TASK-116, design: tmp/
// tasks/tm-116/design_breakdown-expansion.md §3-0), generalized out of the
// trend window (TASK-115's stackedOf) and shared by the four stack sites:
// the trend window (trendWindow.ts), the Home week rows, the Receipts
// daily/weekly/monthly bars and the widget's monthly bar_v. The contract is
// the trend's own assembly, unchanged: top-5 series + the residual「ほか」
// (grey rest tone), value-0 segments omitted, colors through the shared
// seriesColor mapping — so the same series key paints the same color at
// every site.
import { SERIES_REST, seriesColor, type SeriesAxis } from './seriesColor'

/** One stack segment: label (hover-title source), value and its color token. */
export interface StackedSegment {
  label: string
  value: number
  color: string
}

/** One stacked column: the bucket key, its hover title (the key itself — the
 * caller's display shaping lives in the view), the bucket total and the
 * assembled segments. */
export interface StackedBar {
  key: string
  title: string
  total: number
  segments: StackedSegment[]
}

/** The structural supertype both matrix producers satisfy: the web REST
 * AnalysisTrendResult and the widget `_meta.trend_matrix` (the same shape by
 * design — TASK-116 §3-3-1). */
export interface StackableTrendResult {
  axis: SeriesAxis
  buckets: string[]
  series: { key: string | number | null; label: string; values: (number | null)[]; total: number }[]
  bucket_totals: (number | null)[]
}

function isSeriesKey(v: unknown): v is string | number | null {
  return v === null || typeof v === 'string' || typeof v === 'number'
}

/** Narrows `_meta.trend_matrix` (an unknown JSON value on the widget path)
 * to the stackable matrix shape. */
export function isStackableTrendResult(v: unknown): v is StackableTrendResult {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o['axis'] === 'string' &&
    Array.isArray(o['buckets']) &&
    o['buckets'].every((b) => typeof b === 'string') &&
    Array.isArray(o['series']) &&
    Array.isArray(o['bucket_totals'])
  )
}

function isSeriesEntry(v: unknown): v is StackableTrendResult['series'][number] {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    isSeriesKey(o['key']) &&
    typeof o['label'] === 'string' &&
    Array.isArray(o['values']) &&
    o['values'].every((x) => x === null || typeof x === 'number') &&
    typeof o['total'] === 'number'
  )
}

/** Top-5 series + the residual「ほか」per bucket, value-0 segments omitted,
 * each colored by seriesColor(s.key, axis) — the identical assembly the four
 * stack sites render. */
export function stackedOf(res: StackableTrendResult): StackedBar[] {
  const axis = res.axis
  const top = res.series.filter(isSeriesEntry).slice(0, 5)
  return res.buckets.map((b, i) => {
    const total = res.bucket_totals[i] ?? 0
    const rest = Math.max(
      total - top.reduce((a, s) => a + (s.values[i] ?? 0), 0),
      0,
    )
    return {
      key: b,
      title: b,
      total,
      segments: [
        // the segment color is the deterministic seriesColor of the series
        // key (the same color the ranked rows / the other stacks paint), the
        // residual「ほか」the fixed rest tone. Value-0 series segments are
        // omitted from the assembly — with the 1px segment borders a 0
        // height element would stack a stray line
        ...top
          .filter((s) => (s.values[i] ?? 0) > 0)
          .map((s) => ({ label: s.label, value: s.values[i] ?? 0, color: seriesColor(s.key, axis) })),
        ...(rest > 0 ? [{ label: 'ほか', value: rest, color: SERIES_REST }] : []),
      ],
    }
  })
}
