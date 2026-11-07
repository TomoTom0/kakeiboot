<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatYen } from '../composables/format'
import { axisMonthLabels, axisTickIndicesWide, dayLabel, monthLabel, shiftDate, shortDate } from '../composables/period'
import { bucketSpan, type TrendGranularity } from '../composables/trend'
import { compactYen, niceMax } from '@/shared/components/charts/types'
import { axisTicksOf, type AxisTick } from '@/shared/lib/axisTicks'
import { seriesInk } from '@/shared/lib/seriesColor'
import { barWidthCap } from '@/shared/lib/barWidth'
import { estimateTextWidth, verticalSegLabel } from '@/shared/format'
// TASK-116 (design §3-0): the stacked types moved to shared/lib (stackedOf's
// contract); re-exported here so the existing importers (TrendWindow.vue,
// trendWindow.ts, trend-window.test.ts) keep compiling unchanged
import { allocateStack, type AllocatedSegment, type StackedBar, type StackedSegment } from '@/shared/lib/stackedBars'
export type { StackedBar, StackedSegment }

// Bars keyed by month ("YYYY-MM"), week start ("YYYY-MM-DD") or day, picked
// by the `granularity` prop. TASK-89: every bar is a button now — a day bar
// press emits select too and the parent routes to that day's receipts list
// (/receipts?from=d&to=d); month/week presses still move the shared period.
// The `current` key is highlighted. TASK-100: the axis thins to at most 5
// ticks under the bars (axisTickIndices) with a left y-axis (niceMax scale,
// 3 compactYen ticks) and hairline gridlines, and the value label rides
// EVERY bar (TASK-75's current-only rule is withdrawn — dense month windows
// past 6 bars thin the labels to the tick positions; the amount stays on
// every bar via title/aria-label). No per-bar month labels (TASK-42) and no
// note line — the numbers live on the bars themselves. `span` (the charted
// range) clips the edge weekly buckets' titles to what they actually cover.
//
// TASK-95: the card is the stacked money view only — `stacked` is required
// (top segments + the parent-built grey rest segment; the parent shapes
// the data, this component only draws) and the numbers are always formatYen.
//
// TASK-115 (design: tmp/tasks/tm-115/design_trend-continuous-window.md
// §3-3): the window move translates .bars and .axis-labels as ONE viewport
// over the concatenated old+new pair. This component is the transform's
// receiving end: `sliding` carries the .is-sliding class (the 220ms
// transform transition + the wrap/scroll clipping) and `noAnim` parks or
// resets the transform without a move; `axisWindows` (the per-window bucket
// keys) switches the axis/val-label thinning and the dense flag to a
// PER-WINDOW computation, so the concatenated graph keeps each window's
// own thinning positions, year format and density — the trim changes
// nothing about the labels.

const props = withDefaults(
  defineProps<{
    current?: string | null
    granularity?: TrendGranularity
    span?: [string, string] | null
    /** the stacked columns (TASK-95: required — this view is stacked-only) */
    stacked: StackedBar[]
    /** the sliding windows' bucket keys (TASK-115): null computes the axis
     *  over the whole key list (the committed window), an array computes
     *  per window and concatenates — each window keeps the thinning and the
     *  year format its trimmed single window will have. TASK-161 §1-2: the
     *  union's shared months take the NEW window's labels (trim invariance),
     *  the old window's leaving months keep their own */
    axisWindows?: string[][] | null
    /** the slide's direction (TASK-161 §1-2): which axisWindows entry is the
     *  NEW window ('prev' the first, 'next' the last) — the shared keys'
     *  thinning basis */
    axisDir?: 'prev' | 'next'
    /** the viewport move is on: .bars/.axis-labels translate under one
     *  class and the wrap clips the concatenated overflow */
    sliding?: boolean
    /** the transform parks/resets without the 220ms transition */
    noAnim?: boolean
  }>(),
  { current: null, granularity: 'month', span: null, axisWindows: null, axisDir: 'prev', sliding: false, noAnim: false },
)
const emit = defineEmits<{ select: [key: string] }>()

/** a value label for every bar: big amounts compress to "1.2万"/"948". */
function valLabel(v: number): string {
  return v === 0 ? '' : compactYen(v)
}

interface BarView {
  key: string
  title: string
  value: number
  /** the zero-bucket fallback .bar's % height (its 2% floor stays — the
   *  empty placeholder is not a data bar) */
  height: number
  /** the stack's own % height — the RAW value ratio, unrounded (TASK-123
   *  §4-5: no min floor; the allocation always fits by construction) */
  stackHeight: number
  current: boolean
  segments: AllocatedSegmentView[]
  /** the top segment's corner radius: the cap arithmetic min(2px, width/4)
   *  (§4-3) off the measured bar width */
  radius: number
}

interface AllocatedSegmentView {
  label: string
  value: number
  color: string
  /** the drawn height in px (allocateStack's size — the 1px outline
   *  consumes inside it, border-box) */
  size: number
  /** the §4-5 rule-F flag: false drops the outline (fill only) */
  outline: boolean
  /** the visual TOP segment (DOM last under column-reverse) — the only one
   *  that rounds (the data end; §4-3) */
  top: boolean
  // the hover title's share「名称 〜円（n%）」(TASK-105): null on a
  // zero-total bar (no 0/0)
  pct: number | null
  /** TASK-162 §2: the fitted VERTICAL in-segment label (full name → … tail),
   *  null on the colour-only fallbacks — a bar under 26px (例外A), a
   *  sub-26px residual (例外B), the unmeasured environments */
  vLabel: string | null
}

/** the bar heights' denominator: a nice axis bound (1, 2, 5 x 10^n), so the
 *  y-ticks and the gridlines land on round numbers. niceMax(0) = 1 keeps an
 *  all-zero window drawable (the widget BarVChart behaves the same). */
const nice = computed(() => niceMax(Math.max(...props.stacked.map((b) => b.total), 0)))

// TASK-123 (design §4-5 rule E): the segment sizes are explicit px values
// off the shared allocateStack, which needs the bar's real px length — the
// bars track's content height (below the 1rem label headroom) and one bar's
// width (min(2px, width/4) for the corner cap). TASK-162 §6-1 (review 11):
// the width cap reads the CSS variable --trend-bar-w through getComputedStyle
// — the token and the measured value share ONE source (the JS mirror's 34
// literal is gone). TASK-161 §6-2 adds the column PITCH (one cell + the row
// gap) — the width base of the axis/value-label thinning. Measured at mount /
// on resize; jsdom keeps 0 and the thinning falls back to the count rule,
// the segments render at size 0 with their titles and colors until then.
const barsEl = ref<HTMLElement | null>(null)
const trackH = ref(0)
const segW = ref(0)
/** one column's width and the column-to-column pitch (cell + row gap); the
 *  thinning treats colW<=0 as unmeasured (jsdom) and falls back to count —
 *  the PITCH alone cannot carry that flag (a 0-width cell still yields the
 *  gap-only 4px, which once slipped the width rule in) */
const colW = ref(0)
const pitch = ref(0)
/** the thinning's pitch input: 0 until the cell itself measured */
const measuredPitch = computed(() => (colW.value > 0 ? pitch.value : 0))
let ro: ResizeObserver | null = null
function measure(): void {
  const el = barsEl.value
  const col = el?.querySelector('.bar-col') ?? null
  if (!col) return
  trackH.value = col.clientHeight - parseFloat(getComputedStyle(col).paddingTop || '0')
  // TASK-162 §6-1: the cap reads the shared token helper (styles.css owns the
  // value — the single source every vertical-bar DOM reads)
  segW.value = Math.min(col.clientWidth, barWidthCap(el))
  colW.value = col.clientWidth
  const gapRaw = el ? Number.parseFloat(getComputedStyle(el).columnGap || getComputedStyle(el).gap || '4') : 4
  pitch.value = col.clientWidth + (Number.isFinite(gapRaw) ? gapRaw : 4)
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(measure)
  if (barsEl.value) ro.observe(barsEl.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** TASK-162 §2-2: the fold bar the vertical bars pass allocateStack — a
 *  series segment that cannot house even「○…」(11px × 2 + the 4px end
 *  paddings) folds into「ほか」, so every DRAWN series segment carries its
 *  label by construction. The same 26px rules the two label exceptions read:
 *  例外A (the whole bar under it carries no labels) and 例外B (a sub-26px
 *  residual stays colour-only). */
const LABEL_MIN_H = 26

const bars = computed<BarView[]>(() => {
  const raw = props.stacked.map((b) => {
    let title: string
    if (props.granularity === 'month') title = monthLabel(b.key)
    else if (props.granularity === 'day') title = dayLabel(b.key)
    else {
      const [lo, hi] = props.span ? bucketSpan(b.key, 'week', props.span[0], props.span[1]) : [b.key, shiftDate(b.key, 6)]
      title = `${shortDate(lo)}〜${shortDate(hi)}`
    }
    // the amount rides every bar's title/aria-label (ReceiptsPage's inline
    // card uses the same "period amount" shape) — the value label on the
    // bar itself may be thinned in dense month windows, the title never is
    return { key: b.key, title: `${title} ${formatYen(b.total)}`, value: b.total, segments: b.segments }
  })
  return raw.map((b) => {
    const total = b.value
    const ratio = nice.value > 0 ? total / nice.value : 0
    // the stack's px length (raw ratio — the old 2% min floor is gone);
    // allocateStack always closes the sizes over it exactly (§4-5 rule A),
    // at the §2-2 label fold bar (sub-26px series join「ほか」)
    const length = ratio * trackH.value
    const allocated: AllocatedSegment[] = total > 0 ? allocateStack(b.segments, length, { labelMin: LABEL_MIN_H }) : []
    const segTotal = allocated.reduce((a, s) => a + s.value, 0)
    // 例外A: a bar whose own length cannot house the smallest label draws
    // none at all (the bar itself is beneath readability); the unmeasured
    // environments (trackH 0) keep the colour-only fallback
    const labelable = length >= LABEL_MIN_H
    return {
      key: b.key,
      title: b.title,
      value: total,
      height: Math.max(Math.round(ratio * 100), 2),
      stackHeight: ratio * 100,
      current: b.key === props.current,
      radius: Math.min(2, segW.value / 4),
      segments: allocated.map((s, i) => ({
        label: s.label,
        value: s.value,
        color: s.color,
        size: s.size,
        outline: s.outline,
        top: i === allocated.length - 1,
        pct: segTotal > 0 ? Math.round((s.value / segTotal) * 100) : null,
        // the vertical label: a series segment is guaranteed its「○…」by the
        // fold (§2-2); the residual labels only above the same bar (例外B —
        // the fold has no further target, the money stays at its ratio)
        vLabel: labelable && s.size >= LABEL_MIN_H ? verticalSegLabel(s.label, s.size) : null,
      })),
    }
  })
})

/** the y-axis ticks (TASK-161 §5-4): the shared axisTicksOf helper's ladder
 *  at steps=2 — the same 3-point 0・1/2・1 vocabulary as before, now drawn as
 *  N ratio-placed ticks off the one subdivision rule (the scale source stays
 *  the bar-column max until TASK-126 switches it to the screen barScale). */
const yTicks = computed<AxisTick[]>(() => axisTicksOf(nice.value, 2))
/** top-to-bottom render order (max first — the DOM order the tests read) */
const yTicksDown = computed<AxisTick[]>(() => [...yTicks.value].reverse())
/** the plot's hairlines: every tick above the baseline (ratio 0 IS the
 *  baseline — the plot's bottom edge draws it) */
const gridTicks = computed<AxisTick[]>(() => yTicks.value.filter((t) => t.ratio > 0))
/** a tick's vertical offset inside the bar area: the headroom (1rem) tops
 *  the max line, ratio 0 sits on the zero baseline (the plot's bottom) */
const tickTop = (ratio: number): string => `calc(${1 - ratio} * (100% - 1rem) + 1rem)`

/** the axis fonts' working em (the .axis-labels / value labels' 0.85rem band
 *  and the narrow 0.65rem one average out; the fit estimate errs wide) */
const TICK_FONT = 14

/** the label-thinning positions (TASK-161 §6-2): the shared width rule over
 *  the ACTUAL label strings — TASK-162 §5-1 makes every month label the
 *  SHORT "M月" (the year rides its own tick row, so the estimate measures
 *  one uniform form — the thinning stabilizes with it), a day/week axis its
 *  shortDate; the value labels measure their compactYen strings. The
 *  unmeasured environments (jsdom, the pre-layout frame) fall back to the
 *  count rule; both ends always stay */
function monthAxisTicks(keys: string[]): number[] {
  return axisTickIndicesWide(keys.length, measuredPitch.value, (i) =>
    estimateTextWidth(`${Number(keys[i]!.slice(5))}月`, TICK_FONT),
  )
}

/** one window's axis labels as a pure function (TASK-115 §3-3): month uses
 *  axisMonthLabels' items (the window's own year-boundary format rule) at
 *  the width-based positions, day/week thin the same way + shortDate — the
 *  same computation the window gets alone once the slide trims */
function windowAxis(g: TrendGranularity, keys: string[]): { key: string; label: string }[] {
  if (g === 'month') {
    return axisMonthLabels(keys, monthAxisTicks(keys))?.items ?? []
  }
  return axisTickIndicesWide(keys.length, measuredPitch.value, (i) => estimateTextWidth(shortDate(keys[i]!), TICK_FONT)).map(
    (i) => ({ key: keys[i]!, label: shortDate(keys[i]!) }),
  )
}

/** the thinned axis ticks as a key→label map (TASK-161 §1-2): while sliding,
 *  the NEW window's own thinning decides EVERY month it contains — the
 *  shared months a later window thins out stay UNLABELLED mid-slide exactly
 *  as they will be after the trim (the review-中2 rule: only the OLD window's
 *  leaving months, the keys the new window does not hold at all, keep their
 *  outgoing labels); over the whole key list otherwise. null when there are
 *  no bars (the axis row stays hidden). */
const axis = computed<{ key: string; label: string }[] | null>(() => {
  const windows = props.axisWindows?.filter((w) => w.length > 0)
  if (windows && windows.length > 0) {
    const newKeys = windows[props.axisDir === 'next' ? windows.length - 1 : 0]!
    const newBuckets = new Set(newKeys)
    const shown = new Map(windowAxis(props.granularity, newKeys).map((t) => [t.key, t.label]))
    for (const w of windows) {
      if (w === newKeys) continue
      for (const t of windowAxis(props.granularity, w)) {
        if (!newBuckets.has(t.key) && !shown.has(t.key)) shown.set(t.key, t.label)
      }
    }
    return shown.size > 0 ? [...shown.entries()].map(([key, label]) => ({ key, label })) : null
  }
  const keys = bars.value.map((b) => b.key)
  if (keys.length === 0) return null
  const items = windowAxis(props.granularity, keys)
  return items.length > 0 ? items : null
})

/** one span per bar (grid alignment keeps every span under its bar); only
 *  the tick positions carry the label text, the rest render empty. */
const axisTicks = computed(() => {
  if (!axis.value) return []
  const shown = new Map(axis.value.map((t) => [t.key, t.label]))
  return bars.value.map((b) => ({ key: b.key, label: shown.get(b.key) ?? '' }))
})

/** the YEAR tick row's spans (TASK-162 §5-2, web-browse.trend-year-ticks):
 *  month axes only — each tick is the bare 4-digit year on its cell (the
 *  window's start year at the head + EVERY January boundary inside — a
 *  multi-year window carries one tick per year turn, at most one per year;
 *  the month row's own thinning never moves them). Computed PER WINDOW while
 *  sliding (axisMonthLabels' own years, the NEW window's reading deciding —
 *  a leaving window contributes only the years the new one does not show),
 *  so the trim changes nothing about the ticks; over the whole key list
 *  otherwise. Each span pins its own grid column (the sparse row keeps the
 *  tick on its month's cell). `edge` marks the ticks on the ROW'S END CELLS
 *  by CELL POSITION (§5-3's端部overflow rule — never the DOM order, which
 *  the per-window slide reading reorders): the end ticks take the month
 *  row's own end-flush grammar so a ~28px year label on a narrow end cell
 *  cannot hang past the plot's edge. */
interface YearTickView {
  key: string
  label: string
  col: number
  edge: 'start' | 'end' | null
}
const yearTicks = computed<YearTickView[]>(() => {
  if (props.granularity !== 'month') return []
  const keys = bars.value.map((b) => b.key)
  if (keys.length === 0) return []
  const yearsOf = (ks: string[]): { key: string; label: string }[] => axisMonthLabels(ks)?.years ?? []
  let own: { key: string; label: string }[]
  const windows = props.axisWindows?.filter((w) => w.length > 0)
  if (windows && windows.length > 0) {
    const newKeys = windows[props.axisDir === 'next' ? windows.length - 1 : 0]!
    const shown = new Map<string, { key: string; label: string }>()
    for (const y of yearsOf(newKeys)) shown.set(y.label, y)
    for (const w of windows) {
      if (w === newKeys) continue
      for (const y of yearsOf(w)) if (!shown.has(y.label)) shown.set(y.label, y)
    }
    own = [...shown.values()]
  } else {
    own = yearsOf(keys)
  }
  return own.map((y): YearTickView | null => {
    const col = keys.indexOf(y.key)
    if (col < 0) return null
    const at = col + 1
    return { ...y, col: at, edge: at === 1 ? 'start' : at === keys.length ? 'end' : null }
  }).filter((y): y is YearTickView => y !== null)
})

/** the thinned positions shared by the axis labels and the dense .bar-val —
 *  the tick KEYS' positions in the rendered array: while sliding the NEW
 *  window's own ticks (the same trim invariance as the axis); whole-array
 *  otherwise, measured on the value labels' own compactYen strings (a zero
 *  bar draws no label at all, so its width is 0 and never blocks) */
const tickIdx = computed(() => {
  const windows = props.axisWindows?.filter((w) => w.length > 0)
  const set = new Set<number>()
  if (windows && windows.length > 0) {
    const newKeys = windows[props.axisDir === 'next' ? windows.length - 1 : 0]!
    const ticks = new Set(windowAxis(props.granularity, newKeys).map((t) => t.key))
    bars.value.forEach((b, i) => {
      if (ticks.has(b.key)) set.add(i)
    })
    return set
  }
  const idx =
    bars.value.length > 0
      ? axisTickIndicesWide(
          bars.value.length,
          measuredPitch.value,
          (i) => (bars.value[i]!.value > 0 ? estimateTextWidth(compactYen(bars.value[i]!.value), TICK_FONT) : 0),
        )
      : []
  for (const i of idx) set.add(i)
  return set
})

/** the COMMIT window's bar count (TASK-115 §3-3, REVIEW-2 R1): while
 *  sliding, axisWindows[0].length — a 6+6 month concatenation must not
 *  turn dense (the trim would flicker the value labels and the end-tick
 *  rules back on) */
const commitCount = computed(() => {
  const first = props.axisWindows?.find((w) => w.length > 0)
  return first ? first.length : bars.value.length
})

/** dense month windows (> 6 bars: year mode, long ranges) fix the wrap to
 *  the container width and equally split the tracks — and thin the value
 *  labels to the tick positions so neighbors cannot overlap. */
const dense = computed(() => props.granularity === 'month' && commitCount.value > 6)

// TASK-104: the window's chevron pair takes 96px of the zone width, so the
// 6-bar month window's track minimum (with the bars gap) must keep the wrap
// inside the middle column at the 360px floor; wider viewports stretch 1fr
const track = computed(() =>
  props.granularity === 'month' ? (commitCount.value <= 6 ? 'minmax(1.25rem, 1fr)' : 'minmax(0, 1fr)') : 'minmax(0.25rem, 1fr)',
)

const trackStyle = computed(() => ({ gridTemplateColumns: `repeat(${bars.value.length || 1}, ${track.value})` }))
</script>

<template>
  <div
    class="hscroll"
    :class="{ 'is-sliding': sliding }"
  >
    <div
      class="trend-wrap"
      :class="{ dense, 'is-sliding': sliding }"
    >
      <div
        class="y-axis muted"
        aria-hidden="true"
      >
        <span
          v-for="t in yTicksDown"
          :key="t.ratio"
          :style="{ top: tickTop(t.ratio) }"
        >{{ t.label }}</span>
      </div>
      <div class="plot">
        <span
          v-for="t in gridTicks"
          :key="t.ratio"
          class="gridline"
          :style="{ top: tickTop(t.ratio) }"
        />
        <div
          ref="barsEl"
          class="bars"
          :class="{ 'is-sliding': sliding, 'no-anim': noAnim }"
          :style="trackStyle"
          data-test="trend"
        >
          <!-- TASK-89: every bar is a button — a day bar press routes to that
               day's receipts (the parent decides where select goes) -->
          <button
            v-for="(b, i) in bars"
            :key="b.key"
            class="bar-col bar-btn"
            :class="{ current: b.current, stacked: b.segments.length > 0 }"
            :title="b.title"
            :aria-label="b.title"
            :data-test="`bar-${b.key}`"
            @click="emit('select', b.key)"
          >
            <span
              v-if="!dense || tickIdx.has(i)"
              class="bar-val"
            >{{ valLabel(b.value) }}</span>
            <!-- TASK-123: the segments carry explicit px heights off the
                 shared allocateStack (the sizes close over the stack's own
                 length exactly — no flex shrink, no clip), the full-perimeter
                 1px outline (border-box inner consumption; rule F drops it
                 inline) and the top segment's cap radius. TASK-162 §2: every
                 segment houses its UPRIGHT VERTICAL series label (the labelMin
                 fold guarantees the room; 例外A/B and the unmeasured
                 environments keep the colour-only fallback) — the title keeps
                 the full information either way -->
            <span
              v-if="b.segments.length > 0"
              class="bar-stack"
              :style="{ height: `${b.stackHeight}%` }"
              aria-hidden="true"
            >
              <span
                v-for="(s, i2) in b.segments"
                :key="i2"
                class="bar-seg"
                :style="{
                  height: `${s.size}px`,
                  background: s.color,
                  ...(s.outline ? {} : { border: 'none' }),
                  ...(s.top ? { borderRadius: `${b.radius}px ${b.radius}px 0 0` } : {}),
                  ...(s.vLabel !== null ? { color: seriesInk(s.color) } : {}),
                }"
                :title="`${s.label} ${formatYen(s.value)}${s.pct !== null ? `（${s.pct}%）` : ''}`"
              ><span
                v-if="s.vLabel !== null"
                class="bar-seg-label"
              >{{ s.vLabel }}</span></span>
            </span>
            <span
              v-else
              class="bar"
              :style="{ height: `${b.height}%` }"
            />
          </button>
        </div>
      </div>
      <!-- TASK-162 §5: the YEAR tick row — one bare 4-digit year per cell
           boundary over the month row's own grid, independent of the month
           thinning; rides the slide machinery with .bars/.axis-labels -->
      <div
        v-if="yearTicks.length > 0"
        class="axis-years muted"
        :class="{ 'is-sliding': sliding, 'no-anim': noAnim }"
        data-test="axis-years"
        :style="trackStyle"
      >
        <span
          v-for="y in yearTicks"
          :key="y.key"
          :class="{ 'is-edge-start': y.edge === 'start', 'is-edge-end': y.edge === 'end' }"
          :data-test="`axis-year-${y.label}`"
          :style="{ gridColumn: String(y.col) }"
        >{{ y.label }}</span>
      </div>
      <div
        v-if="axis"
        class="axis-labels muted"
        :class="{ 'is-sliding': sliding, 'no-anim': noAnim }"
        data-test="trend-axis"
        :style="trackStyle"
      >
        <span
          v-for="t in axisTicks"
          :key="t.key"
        >{{ t.label }}</span>
      </div>
    </div>
  </div>
</template>
