<script setup lang="ts">
// Vertical bars for monthly totals (spec §10 monthly_trend / overview 月次推移).
import { computed } from 'vue'
import { formatYen, truncateLabel } from '@/shared/format'
import { type ChartDatum, compactYen, niceMax } from './types'

const props = defineProps<{ data: ChartDatum[] }>()

const W = 320
const H = 160
const LEFT = 36
const BOTTOM = 20
const TOP = 8
const plotH = H - BOTTOM - TOP

const max = computed(() => niceMax(Math.max(0, ...props.data.map((d) => d.value))))
const slot = computed(() => (W - LEFT) / Math.max(1, props.data.length))
const bars = computed(() =>
  props.data.map((d, i) => {
    const h = (Math.max(0, d.value) / max.value) * plotH
    return {
      key: i,
      x: LEFT + i * slot.value + slot.value * 0.15,
      w: slot.value * 0.7,
      y: TOP + plotH - h,
      h,
      cx: LEFT + i * slot.value + slot.value / 2,
      label: truncateLabel(d.label, 5),
      value: d.value,
      title: `${d.label}: ${formatYen(d.value)}`,
    }
  }),
)
const ticks = computed(() => [0, 0.5, 1].map((t) => ({ y: TOP + plotH - t * plotH, text: compactYen(t * max.value) })))
</script>

<template>
  <svg
    class="bb-chart"
    :viewBox="`0 0 ${W} ${H}`"
    role="img"
    :aria-label="`縦棒グラフ ${data.length}項目`"
  >
    <g
      v-for="t in ticks"
      :key="t.y"
    >
      <line
        class="bb-chart__grid"
        :x1="LEFT"
        :x2="W"
        :y1="t.y"
        :y2="t.y"
      />
      <text
        class="bb-chart__axis"
        :x="LEFT - 4"
        :y="t.y + 3"
        text-anchor="end"
      >{{ t.text }}</text>
    </g>
    <g
      v-for="b in bars"
      :key="b.key"
    >
      <title>{{ b.title }}</title>
      <rect
        class="bb-chart__bar"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        rx="2"
        fill="var(--bb-series-1)"
        :data-value="b.value"
      />
      <text
        class="bb-chart__axis"
        :x="b.cx"
        :y="H - 6"
        text-anchor="middle"
      >{{ b.label }}</text>
    </g>
  </svg>
</template>
