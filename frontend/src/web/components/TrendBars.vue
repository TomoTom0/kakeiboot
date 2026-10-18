<script setup lang="ts">
import { computed } from 'vue'
import type { StatsRow } from '../api/data'
import { formatYen } from '../composables/format'
import { axisMonthLabels, monthLabel } from '../composables/period'

// Monthly bars (rows keyed by "YYYY-MM", oldest first). The `current` month
// is highlighted; clicking a bar emits its month. Per-bar month labels are
// gone (TASK-42): the axis under the bars carries the window ends only, and
// the value label rides the selected month's bar alone (TASK-75 §6-4 — with
// no selection, year / range modes included, no bar carries a label).
const props = withDefaults(defineProps<{ rows: StatsRow[]; current?: string | null }>(), { current: null })
const emit = defineEmits<{ select: [month: string] }>()

const bars = computed(() => {
  const max = Math.max(...props.rows.map((r) => r.value), 1)
  return props.rows.map((r) => {
    const key = String(r.keys[0] ?? r.labels[0] ?? '')
    return {
      key,
      title: `${monthLabel(key)} ${formatYen(r.value)}`,
      value: r.value,
      height: Math.max(Math.round((r.value / max) * 100), 2),
      current: key === props.current,
    }
  })
})
const axis = computed(() => axisMonthLabels(bars.value.map((b) => b.key)))
const average = computed(() => {
  const v = bars.value.filter((b) => b.value > 0)
  return v.length ? Math.round(v.reduce((a, b) => a + b.value, 0) / v.length) : 0
})
</script>

<template>
  <div class="hscroll">
    <div class="trend-wrap">
      <div
        class="bars"
        :style="{ gridTemplateColumns: `repeat(${bars.length || 1}, minmax(2rem, 1fr))` }"
        data-test="trend"
      >
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
    月平均 {{ formatYen(average) }}（記録のある月）
  </p>
</template>
