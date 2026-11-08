// The stacked-bar assembly as one pure function (TASK-116, design: tmp/
// tasks/tm-116/design_breakdown-expansion.md §3-0), generalized out of the
// trend window (TASK-115's stackedOf) and shared by the four stack sites:
// the trend window (trendWindow.ts), the Home week rows, the Receipts
// daily/weekly/monthly bars and the widget's monthly bar_v. TASK-123
// (design: tmp/tasks/tm-123/design_breakdown-visual.md v5 §4-1/§4-5) tunes
// the assembly and adds the dimension allocator: the assembly is top-3
// series + the residual「ほか」(the REST/trend_matrix limit-5 top-5 contract
// stays untouched — the FRONTEND slices to 3, so ranks 4-5 fold into「ほか」),
// a bucket's own sub-5% top-3 member folds into「ほか」per bucket, and the
// drawn sizes come out of allocateStack (rules A/B/C/F below) — so the same
// series key paints the same color at every site and the bar's shape always
// reflects the value ratios.
import { SERIES_REST, seriesColor, type SeriesAxis } from './seriesColor'

/** One stack segment: label (hover-title source), value and its color token.
 * TASK-129 (design §4-5): the optional `rest` flag marks the residual — the
 * fold target identity is this FLAG now (a「ほか」label without it is an
 * ordinary series), so the widget's「その他」rows and the allocator-created
 * residuals merge under one rule. TASK-162 §1-8 (review 4): the SERIES KEY
 * rides the segment end to end — the transition/press identifier the
 * consumers read (a same-named category, a colour clash: no label/colour
 * reverse lookup). key=null + rest=true = the「ほか」residual, key=null
 * without rest = 未分類, any other key = that series. */
export interface StackedSegment {
  label: string
  value: number
  color: string
  /** the segment's series key as the API returned it (null = 未分類 / the
   * residual); folds into the rest lose theirs (the value/count aggregate
   * preserves the identity) */
  key?: string | number | null
  /** the residual fold-target flag (the API's null-key rows and the
   * allocator-created residuals carry it) */
  rest?: boolean
}

/** One allocated segment: the (possibly folded) segment with its drawn size
 * (the bar's full length splits among the sizes) and whether the 1px outline
 * applies (rule F drops it on a sub-minimum bar). */
export interface AllocatedSegment extends StackedSegment {
  /** the segment's drawn size — px for the web bars/rows, viewBox units for
   * the widget; the outline/border consumes INSIDE it (border-box) */
  size: number
  /** the full-perimeter outline flag (false = fill only, §4-5 rule F) */
  outline: boolean
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

/** the outline-inclusive minimum drawn size (§4-5 rule B: fill 1px + outline
 * 2px); a bar shorter than this itself falls to rule F (fill only) */
const SEG_MIN = 3

/** the per-bucket share under which a top series folds into「ほか」(§4-1) */
const SHARE_FOLD = 0.05

/** The unified absolute scale every bar representation shares (TASK-129
 * design §4-1, web-common.bar-scale): the screen (web) / report (widget)
 * aggregation — the max over each bar's OUTER amount (row value / week total /
 * bucket total / stacked rows sum) — rounds UP through the same nice 1/2/5
 * ladder the y axes' niceMax pins, and every bar then paints
 * value / scale × its available size (the direct money→length mapping; share
 * never enters the bar math). Identical to niceMax over the whole domain
 * (0 / negative / non-finite fall back to 1) — the ladder is duplicated here
 * on purpose so the planning layer stays the single source (charts/types
 * already imports from this module; a back-import would cycle). */
export function barScale(maxValue: number): number {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(maxValue)))
  for (const m of [1, 2, 5, 10]) if (m * exp >= maxValue) return m * exp
  return 10 * exp
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

/** Top-3 series + the residual「ほか」per bucket (TASK-123 §4-1), value-0
 * segments omitted, each colored by seriesColor(s.key, axis) — the identical
 * assembly the four stack sites render. A bucket's own top-3 member under 5%
 * of the bucket total folds into「ほか」too (the absolute-size twin of the
 * ratio threshold lives in allocateStack's minimum rules). */
export function stackedOf(res: StackableTrendResult): StackedBar[] {
  const axis = res.axis
  // the fetch/matrix keeps the top-5 contract; the FRONTEND slices to the
  // top 3 (ranks 4-5 join the residual below)
  const top = res.series.filter(isSeriesEntry).slice(0, 3)
  return res.buckets.map((b, i) => {
    const total = res.bucket_totals[i] ?? 0
    const rest = Math.max(
      total - top.reduce((a, s) => a + (s.values[i] ?? 0), 0),
      0,
    )
    let restValue = rest
    const kept: StackedSegment[] = []
    for (const s of top) {
      const v = s.values[i] ?? 0
      // value-0 series segments are omitted from the assembly — a 0 size
      // element would stack a stray outline line
      if (v <= 0) continue
      // a sub-5% share of the bucket folds into the residual (per bucket)
      if (total > 0 && v / total < SHARE_FOLD) {
        restValue += v
        continue
      }
      kept.push({ label: s.label, value: v, color: seriesColor(s.key, axis), key: s.key })
    }
    return {
      key: b,
      title: b,
      total,
      segments: [...kept, ...(restValue > 0 ? [{ label: 'ほか', value: restValue, color: SERIES_REST, key: null, rest: true }] : [])],
    }
  })
}

/** The analysis-row shape stackedOfRows reads (the getAnalysis rows carry the
 * category key + label + amount; StatsRow is the web-side twin). */
export interface StackableRow {
  keys: (string | number | null)[]
  labels: string[]
  value: number
}

/** The top-5 series +「ほか」assembly off the ANALYSIS rows (TASK-162 §1-2/
 * §1-6, review 5/6 — the Home breakdown's ONE bar): rows arrive amount-desc
 * (the caller's sort); the kept FIVE series carry their keys, every row the
 * five did not keep merges into the residual —
 * - rest.value = `total` − the kept series' sum (closing against the TOTAL,
 *   so rows the limit-50 fetch never returned still land in the residual —
 *   never the returned tail's own sum)
 * - rest.count = the number of merged CATEGORIES (the tail rows + every
 *   folded upper series + `truncated` — the count of rows the limit-50
 *   fetch never returned; a value-0 row joins nothing — the zero-omission
 *   contract)
 * A sub-5%-share row among the kept candidates folds into the residual too
 * and the next row promotes into the five (design §1-6(4)). The dimension
 * folds (allocateStack rules B/C) happen AFTER this helper — the drawing
 * side adds them onto the displayed count (BreakdownBar's rest title). */
export function stackedOfRows(
  rows: StackableRow[],
  total: number,
  truncated = 0,
): { segments: StackedSegment[]; rest: { value: number; count: number } } {
  const segments: StackedSegment[] = []
  let restCount = truncated
  for (const r of rows) {
    const v = r.value
    // value-0 rows draw no segment and join no count (the zero-omission
    // contract the trend assembly shares)
    if (v <= 0) continue
    if (segments.length < 5) {
      // a sub-5% share of the TOTAL folds into the residual (per row) and
      // the next row promotes into the five
      if (total > 0 && v / total < SHARE_FOLD) {
        restCount += 1
        continue
      }
      segments.push({ label: r.labels[0] ?? '', value: v, color: seriesColor(r.keys[0] ?? null, 'category'), key: r.keys[0] ?? null })
      continue
    }
    // past the kept five: the tail merges into the residual wholesale
    restCount += 1
  }
  // the residual's VALUE closes against the TOTAL — the rows the limit-50
  // fetch never returned included (never the returned tail's own sum); the
  // folded values above are subsumed in it. max(0, …) keeps a rows-over-total
  // fixture from going negative
  const kept = segments.reduce((a, s) => a + s.value, 0)
  return { segments, rest: { value: Math.max(total - kept, 0), count: restCount } }
}

/** the rest segment's identity: the fold target every rule merges into —
 * TASK-129 (§4-5): the rest FLAG decides, never the label string (a「ほか」
 * -labeled segment without the flag is an ordinary series) */
const isRest = (s: StackedSegment): boolean => s.rest === true

/** the value-ratio split of the full length (§4-5 rule A — no gap
 * subtraction, the outline consumes inside the sizes) */
function ratioSplit(work: StackedSegment[], length: number): number[] {
  const sum = work.reduce((a, s) => a + s.value, 0)
  if (sum <= 0) return work.map(() => 0)
  return work.map((s) => (s.value / sum) * length)
}

/** folds `from` into the rest-flagged segment (appending one at the end when
 * the input holds no rest yet — carrying the CALLER-supplied `restLabel`, the
 * allocator never invents a name; the stack default stays「ほか」) — the value
 * merges (the money sum is preserved) and the display count drops */
function foldIntoRest(work: StackedSegment[], from: StackedSegment, restLabel: string): StackedSegment[] {
  const rest = work.find(isRest)
  if (rest) {
    rest.value += from.value
    return work.filter((s) => s !== from)
  }
  const merged: StackedSegment = { label: restLabel, value: from.value, color: SERIES_REST, rest: true }
  return [...work.filter((s) => s !== from), merged]
}

/** The allocation options (TASK-129 design §4-5). `mode: 'composition'`
 * serves the composition-ratio bars (ShareBar): rules A/B/F apply but rule C
 * — the folding ladder's first-series single-color terminal — does NOT
 * (dropping the residual to stretch the first series would paint amounts the
 * data never had; a series that cannot clear the minimum stays fill-only at
 * its data ratio instead). `rest` supplies the display name a fold-created
 * residual carries (the caller owns the name; the stack default is「ほか」).
 * TASK-162 §2-2 (review 1): `labelMin` lifts rule B's minimum from the
 * outline-inclusive 3px to "the size a segment needs to house its (at
 * minimum「○…」) label" — a series that cannot clear it folds into the rest,
 * so a drawn series segment carries its label (the LAST surviving series
 * excepts: it keeps its data ratio — rule B's stop below — and its label
 * degrades through the caller's fit logic, never a stretch or a drop).
 * Unset keeps the 3px rules (the horizontal bars / widget — backward
 * compatible). */
export interface AllocateOptions {
  mode?: 'stack' | 'composition'
  rest?: { label: string }
  labelMin?: number
}

/** The dimension allocation the stack sites render (TASK-123 §4-5, the
 * TASK-129 composition mode added). `length` is the bar's full allocation
 * size — px for the web bars/rows, viewBox units for the widget — and the
 * sizes close over it exactly.
 *
 * - rule A: the full length splits by value ratio (the gap/border-top
 *   separations are gone; the outline consumes inside each size)
 * - rule B: an allocated size below the outline-inclusive minimum 3 folds
 *   into the rest segment smallest-first (value order) and the rest re-splits
 * - rule C (stack mode only): the BAR-LENGTH budget — while the minimum x N
 *   (N = the kept segments, the rest included) still exceeds the length,
 *   fold the smallest series; if even one series + the rest cannot fit,
 *   draw the FIRST series alone as the single-color bar (PR#4 review 1: the
 *   terminal never fires on a series' data-ratio size — a rest-majority bar
 *   keeps every segment at its data ratio, the composition mode's "never
 *   paint amounts the data never had")
 * - rule F: a bar whose own outer size is under 3 keeps the data ratio and
 *   drops the outline (fill only — the border would leave the fill under
 *   1px), applied BEFORE the folding ladder */
/** the fold ladder's pick: the smallest-value series (the value order IS the
 * size order — the ratio split is monotone — so rule B's smallest
 * sub-minimum series and rule C's smallest series are the same pick) */
function smallestSeriesOf(series: { seg: StackedSegment }[]): StackedSegment {
  return series.reduce((a, b) => (b.seg.value < a.seg.value ? b : a)).seg
}

export function allocateStack(segments: StackedSegment[], length: number, opts?: AllocateOptions): AllocatedSegment[] {
  const restLabel = opts?.rest?.label ?? 'ほか'
  const composition = opts?.mode === 'composition'
  // the fold ladder's minimum: the outline-inclusive 3px by default, the
  // label-housing size when the caller passes one (§2-2 — labelMin >= SEG_MIN
  // is the premise; the vertical bars pass 26)
  const min = Math.max(opts?.labelMin ?? SEG_MIN, SEG_MIN)
  const positive = segments.filter((s) => s.value > 0).map((s) => ({ ...s }))
  if (positive.length === 0) return []

  // rule F: the bar itself is sub-minimum — the outline's 2px would collapse
  // the fill, so the data ratio wins and every segment paints fill only. (A
  // zero length — the pre-measurement render — lands here too: the elements
  // keep their titles/colors at size 0 until the real length arrives)
  if (length < SEG_MIN) {
    const sum = positive.reduce((a, x) => a + x.value, 0)
    return positive.map((s) => ({ ...s, size: sum > 0 ? (s.value / sum) * length : 0, outline: false }))
  }

  // rule C (stack mode only) runs on the BAR-LENGTH budget: the bar must
  // house every kept segment at the minimum, so while minimum x N (N = the
  // kept segments, the rest included) exceeds the length the smallest series
  // folds — and when even the last series + the rest cannot fit, the FIRST
  // series alone becomes the single-color bar (the top-ranked series is the
  // data's face; its size is the bar's full length). The bar length — never
  // a series' data-ratio size — decides the terminal (PR#4 review 1): the
  // old ratio-basis terminal collapsed a rest-majority bar onto the first
  // series' color, erasing the rest's money from the drawing and reading the
  // lone series as 100% at the pct consumers.
  //
  // rule B then folds a series whose data-ratio size sits under the minimum,
  // smallest first — but the LAST surviving series never folds itself away:
  // it keeps its data ratio (fill-only under SEG_MIN at the map below),
  // because stretching it to the full length or folding it into the rest
  // would paint amounts the data never had — the same stop the composition
  // mode makes (its lone series keeps its data ratio too). A sub-minimum
  // rest alone never triggers a fold either: the residual keeps its data
  // ratio even when it renders under the minimum (the widget's 24%-scale
  // 「ほか」segment pins this).
  let work = positive
  for (;;) {
    const sizes = ratioSplit(work, length)
    const entries = work.map((s, i) => ({ seg: s, size: sizes[i]! }))
    const series = entries.filter((e) => !isRest(e.seg))
    if (!composition && min * work.length > length) {
      // rule C terminal: even one series + the rest cannot clear the
      // minimum — the FIRST series alone becomes the single-color bar
      if (series.length <= 1) {
        const first = series[0]?.seg ?? entries[0]!.seg
        return [{ ...first, size: length, outline: true }]
      }
      work = foldIntoRest(work, smallestSeriesOf(series), restLabel)
      continue
    }
    if (series.length > 1 && series.some((e) => e.size < min)) {
      work = foldIntoRest(work, smallestSeriesOf(series), restLabel)
      continue
    }
    break
  }
  const sizes = ratioSplit(work, length)
  // the ladder guarantees every kept series but possibly the LAST cleared
  // the minimum (the rest is exempt), so every shape is outlined except a
  // lone sub-3px series — it keeps its data ratio fill-only (rule F's usage
  // per segment; both modes stop the same way)
  return work.map((s, i) => ({ ...s, size: sizes[i]!, outline: isRest(s) || sizes[i]! >= SEG_MIN }))
}
