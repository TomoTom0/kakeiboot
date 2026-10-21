<script setup lang="ts">
import { computed } from 'vue'
import type { StatsRow } from '../api/data'
import { formatYen } from '../composables/format'
import { axisMonthLabels, dayLabel, monthLabel, shiftDate, shortDate } from '../composables/period'
import { bucketSpan, type TrendGranularity } from '../composables/trend'

// Bars keyed by month ("YYYY-MM"), week start ("YYYY-MM-DD") or day, picked
// by the `granularity` prop (TASK-55: the trend follows the period's
// granularity). Month and week bars are buttons (a press moves the shared
// period to that month / week); day bars are plain spans — there is no day
// period to move to. The `current` key is highlighted. Per-bar labels are
// gone (TASK-42): the axis carries the window ends only, and the value label
// rides the current bar alone (TASK-75 §6-4 — with no selection, no bar
// carries a label). `span` (the charted range) clips the edge weekly
// buckets' titles to what they actually cover.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    current?: string | null
    granularity?: TrendGranularity
    span?: [string, string] | null
  }>(),
  { current: null, granularity: 'month', span: null },
)
const emit = defineEmits<{ select: [key: string] }>()

const keyOf = (r: StatsRow) => String(r.keys[0] ?? r.labels[0] ?? '')

const bars = computed(() => {
  const max = Math.max(...props.rows.map((r) => r.value), 1)
  return props.rows.map((r) => {
    const key = keyOf(r)
    let title: string
    if (props.granularity === 'month') title = `${monthLabel(key)} ${formatYen(r.value)}`
    else if (props.granularity === 'day') title = `${dayLabel(key)} ${formatYen(r.value)}`
    else {
      const [lo, hi] = props.span ? bucketSpan(key, 'week', props.span[0], props.span[1]) : [key, shiftDate(key, 6)]
      title = `${shortDate(lo)}〜${shortDate(hi)} ${formatYen(r.value)}`
    }
    return {
      key,
      title,
      value: r.value,
      height: Math.max(Math.round((r.value / max) * 100), 2),
      current: key === props.current,
    }
  })
})

const axis = computed(() => {
  const keys = bars.value.map((b) => b.key)
  if (props.granularity === 'month') return axisMonthLabels(keys)
  if (keys.length === 0) return null
  const fmt = (k: string) => shortDate(k)
  return { first: fmt(keys[0]!), last: keys.length > 1 ? fmt(keys[keys.length - 1]!) : null }
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
        <template v-if="granularity === 'day'">
          <!-- day bars: plain spans (TASK-55) — there is no day period a
               press could move to, so they carry no button affordance -->
          <span
            v-for="b in bars"
            :key="b.key"
            class="bar-col"
            :class="{ current: b.current }"
            :title="b.title"
            :data-test="`bar-${b.key}`"
          >
            <span
              v-if="b.current"
              class="bar-val"
            >{{ b.value ? (b.value >= 10000 ? `${Math.round(b.value / 1000)}k` : b.value.toLocaleString('ja-JP')) : '' }}</span>
            <span
              class="bar"
              :style="{ height: `${b.height}%` }"
            />
          </span>
        </template>
        <template v-else>
          <button
            v-for="b in bars"
            :key="b.key"
            class="bar-col bar-btn"
            :class="{ current: b.current }"
            :title="b.title"
            :aria-label="b.title"
            :data-test="`bar-${b.key}`"
            @click="emit('select', b.key)"
          >
            <span
              v-if="b.current"
              class="bar-val"
            >{{ b.value ? (b.value >= 10000 ? `${Math.round(b.value / 1000)}k` : b.value.toLocaleString('ja-JP')) : '' }}</span>
            <span
              class="bar"
              :style="{ height: `${b.height}%` }"
            />
          </button>
        </template>
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
