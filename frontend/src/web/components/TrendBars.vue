<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatYen } from '../composables/format'
import { axisMonthLabels, axisTickIndices, dayLabel, monthLabel, shiftDate, shortDate } from '../composables/period'
import { bucketSpan, type TrendGranularity } from '../composables/trend'
import { compactYen, niceMax } from '@/shared/components/charts/types'
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
     *  year format its trimmed single window will have */
    axisWindows?: string[][] | null
    /** the viewport move is on: .bars/.axis-labels translate under one
     *  class and the wrap clips the concatenated overflow */
    sliding?: boolean
    /** the transform parks/resets without the 220ms transition */
    noAnim?: boolean
  }>(),
  { current: null, granularity: 'month', span: null, axisWindows: null, sliding: false, noAnim: false },
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
}

/** the bar heights' denominator: a nice axis bound (1, 2, 5 x 10^n), so the
 *  y-ticks and the gridlines land on round numbers. niceMax(0) = 1 keeps an
 *  all-zero window drawable (the widget BarVChart behaves the same). */
const nice = computed(() => niceMax(Math.max(...props.stacked.map((b) => b.total), 0)))

// TASK-123 (design §4-5 rule E): the segment sizes are explicit px values
// off the shared allocateStack, which needs the bar's real px length — the
// bars track's content height (below the 1rem label headroom) and one bar's
// width (min(2px, width/4) for the corner cap; the CSS max-width is 34px,
// mirrored here). Measured at mount / on resize; jsdom keeps 0 and the
// segments render at size 0 with their titles and colors until then.
const barsEl = ref<HTMLElement | null>(null)
const trackH = ref(0)
const segW = ref(0)
let ro: ResizeObserver | null = null
function measure(): void {
  const el = barsEl.value
  const col = el?.querySelector('.bar-col') ?? null
  if (!col) return
  trackH.value = col.clientHeight - parseFloat(getComputedStyle(col).paddingTop || '0')
  segW.value = Math.min(col.clientWidth, 34)
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
    // allocateStack always closes the sizes over it exactly (§4-5 rule A)
    const length = ratio * trackH.value
    const allocated: AllocatedSegment[] = total > 0 ? allocateStack(b.segments, length) : []
    const segTotal = allocated.reduce((a, s) => a + s.value, 0)
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
      })),
    }
  })
})

/** the y-axis ticks: upper bound, half, zero (top to bottom). */
const yTicks = computed(() => [1, 0.5, 0].map((t) => compactYen(t * nice.value)))

/** one window's axis labels as a pure function (TASK-115 §3-3): month uses
 *  axisMonthLabels' items (the window's own year-boundary format rule),
 *  day/week thin via axisTickIndices + shortDate — the same computation the
 *  window gets alone once the slide trims */
function windowAxis(g: TrendGranularity, keys: string[]): { key: string; label: string }[] {
  if (g === 'month') return axisMonthLabels(keys)?.items ?? []
  return axisTickIndices(keys.length).map((i) => ({ key: keys[i]!, label: shortDate(keys[i]!) }))
}

/** the thinned axis ticks: per window while sliding (axisWindows — each
 *  window thins on its own, concatenated), over the whole key list
 *  otherwise. null when there are no bars (the axis row stays hidden). */
const axis = computed<{ key: string; label: string }[] | null>(() => {
  const windows = props.axisWindows?.filter((w) => w.length > 0)
  if (windows && windows.length > 0) {
    const items = windows.flatMap((w) => windowAxis(props.granularity, w))
    return items.length > 0 ? items : null
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

/** the thinned positions shared by the axis labels and the dense .bar-val —
 *  per window while sliding (each window thins on its own, offset into the
 *  concatenated array), whole-array otherwise */
const tickIdx = computed(() => {
  const windows = props.axisWindows?.filter((w) => w.length > 0)
  if (windows && windows.length > 0) {
    const set = new Set<number>()
    let base = 0
    for (const w of windows) {
      for (const i of axisTickIndices(w.length)) set.add(base + i)
      base += w.length
    }
    return set
  }
  return new Set(axisTickIndices(bars.value.length))
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
        <span>{{ yTicks[0] }}</span>
        <span>{{ yTicks[1] }}</span>
        <span>{{ yTicks[2] }}</span>
      </div>
      <div class="plot">
        <span
          class="gridline"
          style="top: 1rem"
        />
        <span
          class="gridline"
          style="top: calc(50% + 0.5rem)"
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
                 inline) and the top segment's cap radius -->
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
                }"
                :title="`${s.label} ${formatYen(s.value)}${s.pct !== null ? `（${s.pct}%）` : ''}`"
              />
            </span>
            <span
              v-else
              class="bar"
              :style="{ height: `${b.height}%` }"
            />
          </button>
        </div>
      </div>
      <div
        v-if="axis"
        class="axis-labels muted small"
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
