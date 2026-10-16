<script setup lang="ts">
import { computed } from 'vue'
import type { StatsRow } from '../api/data'
import { formatYen } from '../composables/format'

// Share donut: the top 5 rows in palette order + the rest as one grey arc.
// The colors match RankedList with `colors` (same index -> same color).
const props = defineProps<{ rows: StatsRow[]; total: number; caption?: string }>()

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c-rest)']
const R = 52
const CIRC = 2 * Math.PI * R

const arcs = computed(() => {
  const top = props.rows.slice(0, 5).map((r) => r.value)
  const rest = props.rows.slice(5).reduce((a, r) => a + r.value, 0)
  const values = rest > 0 ? [...top, rest] : top
  const sum = values.reduce((a, b) => a + b, 0) || 1
  let offset = 0
  return values.map((v, i) => {
    const len = (v / sum) * CIRC
    const arc = { color: PALETTE[i]!, dash: `${Math.max(len - 2, 0)} ${CIRC}`, offset: -offset }
    offset += len
    return arc
  })
})
</script>

<template>
  <svg
    class="donut"
    viewBox="0 0 140 140"
    role="img"
    :aria-label="`${caption ?? '支出'} 合計${formatYen(total)}`"
  >
    <circle
      cx="70"
      cy="70"
      :r="R"
      class="donut-track"
    />
    <circle
      v-for="(a, i) in arcs"
      :key="i"
      cx="70"
      cy="70"
      :r="R"
      fill="none"
      :stroke="a.color"
      stroke-width="18"
      :stroke-dasharray="a.dash"
      :stroke-dashoffset="a.offset"
      transform="rotate(-90 70 70)"
    />
    <text
      x="70"
      y="64"
      class="donut-caption"
    >{{ caption ?? '支出' }}</text>
    <text
      x="70"
      y="84"
      class="donut-total"
    >{{ total.toLocaleString('ja-JP') }}</text>
  </svg>
</template>
