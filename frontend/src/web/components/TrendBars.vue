<script setup lang="ts">
import { computed } from 'vue'
import type { StatsRow } from '../api/data'
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
// TASK-89 extensions: `stacked` swaps the single-series rows for stacked
// columns (top segments + the parent-built grey rest segment — the parent
// shapes the data, this component only draws); `format` swaps the
// number rendering of the axis/note/title/value label (default formatYen;
// counts are integers, unit prices one decimal).
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
    rows: StatsRow[]
    current?: string | null
    granularity?: TrendGranularity
    span?: [string, string] | null
    /** stacked columns instead of the single-series rows */
    stacked?: StackedBar[] | null
    /** number rendering (labels / titles / the current bar's value) */
    format?: (v: number) => string
  }>(),
  { current: null, granularity: 'month', span: null, stacked: null, format: undefined },
)
const emit = defineEmits<{ select: [key: string] }>()

const fmt = computed(() => props.format ?? formatYen)

const keyOf = (r: StatsRow) => String(r.keys[0] ?? r.labels[0] ?? '')

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
  const stacked = props.stacked
  const raw =
    stacked !== null && stacked !== undefined
      ? stacked.map((b) => {
          let title: string
          if (props.granularity === 'month') title = `${monthLabel(b.key)}`
          else if (props.granularity === 'day') title = dayLabel(b.key)
          else {
            const [lo, hi] = props.span ? bucketSpan(b.key, 'week', props.span[0], props.span[1]) : [b.key, shiftDate(b.key, 6)]
            title = `${shortDate(lo)}〜${shortDate(hi)}`
          }
          return { key: b.key, title, value: b.total, segments: b.segments }
        })
      : props.rows.map((r) => {
          const key = keyOf(r)
          let title: string
          if (props.granularity === 'month') title = `${monthLabel(key)} ${fmt.value(r.value)}`
          else if (props.granularity === 'day') title = `${dayLabel(key)} ${fmt.value(r.value)}`
          else {
            const [lo, hi] = props.span ? bucketSpan(key, 'week', props.span[0], props.span[1]) : [key, shiftDate(key, 6)]
            title = `${shortDate(lo)}〜${shortDate(hi)} ${fmt.value(r.value)}`
          }
          return { key, title, value: r.value, segments: null }
        })
  const max = Math.max(...raw.map((b) => b.value), 1)
  return raw.map((b) => {
    const total = b.value
    const height = Math.max(Math.round((b.value / max) * 100), 2)
    const segments = (b.segments ?? []).map((s) => ({
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
    return `合計 ${fmt.value(bars.value.reduce((a, b) => a + b.value, 0))}`
  }
  const unit = props.granularity === 'week' ? '週' : '月'
  const avg = v.length ? Math.round(v.reduce((a, b) => a + b.value, 0) / v.length) : 0
  return `${unit}平均 ${fmt.value(avg)}（記録のある${unit}）`
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
              :title="`${s.label} ${fmt(s.value)}`"
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
