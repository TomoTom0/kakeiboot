<script setup lang="ts">
import { computed } from 'vue'
import { formatYen } from '../composables/format'
import { axisMonthLabels, axisTickIndices, dayLabel, monthLabel, shiftDate, shortDate } from '../composables/period'
import { bucketSpan, type TrendGranularity } from '../composables/trend'
import { compactYen, niceMax } from '@/shared/components/charts/types'

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
export interface StackedSegment {
  label: string
  value: number
  color: string
}
export interface StackedBar {
  key: string
  title: string
  total: number
  segments: StackedSegment[]
}

const props = withDefaults(
  defineProps<{
    current?: string | null
    granularity?: TrendGranularity
    span?: [string, string] | null
    /** the stacked columns (TASK-95: required — this view is stacked-only) */
    stacked: StackedBar[]
  }>(),
  { current: null, granularity: 'month', span: null },
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
  height: number
  current: boolean
  segments: { label: string; value: number; color: string; height: number }[]
}

/** the bar heights' denominator: a nice axis bound (1, 2, 5 x 10^n), so the
 *  y-ticks and the gridlines land on round numbers. niceMax(0) = 1 keeps an
 *  all-zero window drawable (the widget BarVChart behaves the same). */
const nice = computed(() => niceMax(Math.max(...props.stacked.map((b) => b.total), 0)))

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
    const height = Math.max(Math.round((b.value / nice.value) * 100), 2)
    const segments = b.segments.map((s) => ({
      label: s.label,
      value: s.value,
      color: s.color,
      height: total > 0 ? Math.max((s.value / total) * 100, s.value > 0 ? 1 : 0) : 0,
    }))
    return {
      key: b.key,
      title: b.title,
      value: b.value,
      height,
      current: b.key === props.current,
      segments,
    }
  })
})

/** the y-axis ticks: upper bound, half, zero (top to bottom). */
const yTicks = computed(() => [1, 0.5, 0].map((t) => compactYen(t * nice.value)))

/** the thinned axis ticks: month mode uses axisMonthLabels' items (the
 *  year-boundary format rule), day/week thin via axisTickIndices + shortDate.
 *  null when there are no bars (the axis row stays hidden). */
const axis = computed<{ key: string; label: string }[] | null>(() => {
  const keys = bars.value.map((b) => b.key)
  if (props.granularity === 'month') return axisMonthLabels(keys)?.items ?? null
  if (keys.length === 0) return null
  return axisTickIndices(keys.length).map((i) => ({ key: keys[i]!, label: shortDate(keys[i]!) }))
})

/** one span per bar (grid alignment keeps every span under its bar); only
 *  the tick positions carry the label text, the rest render empty. */
const axisTicks = computed(() => {
  if (!axis.value) return []
  const shown = new Map(axis.value.map((t) => [t.key, t.label]))
  return bars.value.map((b) => ({ key: b.key, label: shown.get(b.key) ?? '' }))
})

/** the thinned positions shared by the axis labels and the dense .bar-val. */
const tickIdx = computed(() => new Set(axisTickIndices(bars.value.length)))

/** dense month windows (> 6 bars: year mode, long ranges) fix the wrap to
 *  the container width and equally split the tracks — and thin the value
 *  labels to the tick positions so neighbors cannot overlap. */
const dense = computed(() => props.granularity === 'month' && bars.value.length > 6)

const track = computed(() =>
  props.granularity === 'month' ? (bars.value.length <= 6 ? 'minmax(2rem, 1fr)' : 'minmax(0, 1fr)') : 'minmax(0.25rem, 1fr)',
)

const trackStyle = computed(() => ({ gridTemplateColumns: `repeat(${bars.value.length || 1}, ${track.value})` }))
</script>

<template>
  <div class="hscroll">
    <div
      class="trend-wrap"
      :class="{ dense }"
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
          class="bars"
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
            <span
              v-if="b.segments.length > 0"
              class="bar-stack"
              :style="{ height: `${b.height}%` }"
              aria-hidden="true"
            >
              <span
                v-for="(s, i2) in b.segments"
                :key="i2"
                class="bar-seg"
                :style="{ height: `${s.height}%`, background: s.color }"
                :title="`${s.label} ${formatYen(s.value)}`"
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
