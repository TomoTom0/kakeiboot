<script setup lang="ts">
import { computed } from 'vue'
import { formatYen } from '../composables/format'
import { axisMonthLabels, dayLabel, monthLabel, shiftDate, shortDate } from '../composables/period'
import { bucketSpan, type TrendGranularity } from '../composables/trend'

// Bars keyed by month ("YYYY-MM"), week start ("YYYY-MM-DD") or day, picked
// by the `granularity` prop. TASK-89: every bar is a button now — a day bar
// press emits select too and the parent routes to that day's receipts list
// (/receipts?from=d&to=d); month/week presses still move the shared period.
// The `current` key is highlighted. Per-bar labels are gone (TASK-42): the
// axis carries the window ends only, and the value label rides the current
// bar alone. `span` (the charted range) clips the edge weekly buckets'
// titles to what they actually cover.
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

/** a value label for the current bar: big amounts compress to "12k". */
function valLabel(v: number): string {
  if (v === 0) return ''
  if (v >= 10000) return `${Math.round(v / 1000)}k`
  return Math.round(v).toLocaleString('ja-JP')
}

interface BarView {
  key: string
  title: string
  value: number
  height: number
  current: boolean
  segments: { label: string; value: number; color: string; height: number }[]
}

const bars = computed<BarView[]>(() => {
  const raw = props.stacked.map((b) => {
    let title: string
    if (props.granularity === 'month') title = monthLabel(b.key)
    else if (props.granularity === 'day') title = dayLabel(b.key)
    else {
      const [lo, hi] = props.span ? bucketSpan(b.key, 'week', props.span[0], props.span[1]) : [b.key, shiftDate(b.key, 6)]
      title = `${shortDate(lo)}〜${shortDate(hi)}`
    }
    return { key: b.key, title, value: b.total, segments: b.segments }
  })
  const max = Math.max(...raw.map((b) => b.value), 1)
  return raw.map((b) => {
    const total = b.value
    const height = Math.max(Math.round((b.value / max) * 100), 2)
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

const axis = computed(() => {
  const keys = bars.value.map((b) => b.key)
  if (props.granularity === 'month') return axisMonthLabels(keys)
  if (keys.length === 0) return null
  const fmtKey = (k: string) => shortDate(k)
  return { first: fmtKey(keys[0]!), last: keys.length > 1 ? fmtKey(keys[keys.length - 1]!) : null }
})

const track = computed(() =>
  props.granularity === 'month' ? 'minmax(2rem, 1fr)' : 'minmax(0.25rem, 1fr)',
)

const note = computed(() => {
  const v = bars.value.filter((b) => b.value > 0)
  if (props.granularity === 'day') {
    // the day bars' sum is the period total (the KPI's per-day average is
    // its own number — an average over record days would mislead)
    return `合計 ${formatYen(bars.value.reduce((a, b) => a + b.value, 0))}`
  }
  const unit = props.granularity === 'week' ? '週' : '月'
  const avg = v.length ? Math.round(v.reduce((a, b) => a + b.value, 0) / v.length) : 0
  return `${unit}平均 ${formatYen(avg)}（記録のある${unit}）`
})
</script>

<template>
  <div class="hscroll">
    <div class="trend-wrap">
      <div
        class="bars"
        :style="{ gridTemplateColumns: `repeat(${bars.length || 1}, ${track})` }"
        data-test="trend"
      >
        <!-- TASK-89: every bar is a button — a day bar press routes to that
             day's receipts (the parent decides where select goes) -->
        <button
          v-for="b in bars"
          :key="b.key"
          class="bar-col bar-btn"
          :class="{ current: b.current, stacked: b.segments.length > 0 }"
          :title="b.title"
          :aria-label="b.title"
          :data-test="`bar-${b.key}`"
          @click="emit('select', b.key)"
        >
          <span
            v-if="b.current"
            class="bar-val"
          >{{ valLabel(b.value) }}</span>
          <span
            v-if="b.segments.length > 0"
            class="bar-stack"
            :style="{ height: `${b.height}%` }"
            aria-hidden="true"
          >
            <span
              v-for="(s, i) in b.segments"
              :key="i"
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
      <div
        v-if="axis"
        class="axis-ends muted small"
        data-test="trend-axis"
      >
        <span>{{ axis.first }}</span>
        <span v-if="axis.last">{{ axis.last }}</span>
      </div>
    </div>
  </div>
  <p class="muted small trend-note">
    {{ note }}
  </p>
</template>
