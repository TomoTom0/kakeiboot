<script setup lang="ts">
// Horizontal bars (spec §10 by_category / by_store / by_payment_method, §11-7 "横棒中心").
// Labels are text nodes and are truncated in JS (spec §11-6).
import { computed } from 'vue'
import { formatYen, truncateLabel } from '@/shared/format'
import { type ChartDatum, niceMax, seriesColor } from './types'

const props = withDefaults(defineProps<{ data: ChartDatum[]; labelChars?: number }>(), {
  labelChars: 9,
})

const W = 320
const LABEL_W = 110
const VALUE_W = 70
const ROW = 30
const BAR_W = W - LABEL_W - VALUE_W

const max = computed(() => niceMax(Math.max(0, ...props.data.map((d) => d.value))))
const rows = computed(() =>
  props.data.map((d, i) => ({
    label: truncateLabel(d.label, props.labelChars),
    full: d.label,
    value: d.value,
    width: (Math.max(0, d.value) / max.value) * BAR_W,
    y: i * ROW,
    color: seriesColor(i),
    valueText: formatYen(d.value),
  })),
)
const height = computed(() => Math.max(ROW, rows.value.length * ROW))
</script>

<template>
  <svg
    class="bb-chart"
    :viewBox="`0 0 ${W} ${height}`"
    role="img"
    :aria-label="`横棒グラフ ${data.length}項目`"
  >
    <g
      v-for="r in rows"
      :key="r.y"
      class="bb-chart__row"
      :transform="`translate(0 ${r.y})`"
    >
      <title>{{ r.full }}: {{ r.valueText }}</title>
      <text
        class="bb-chart__label"
        x="0"
        :y="ROW / 2 + 4"
      >{{ r.label }}</text>
      <rect
        class="bb-chart__bar"
        :x="LABEL_W"
        y="6"
        :width="r.width"
        :height="ROW - 14"
        rx="2"
        :fill="r.color"
        :data-value="r.value"
      />
      <text
        class="bb-chart__value"
        :x="W"
        :y="ROW / 2 + 4"
        text-anchor="end"
      >{{ r.valueText }}</text>
    </g>
  </svg>
</template>
