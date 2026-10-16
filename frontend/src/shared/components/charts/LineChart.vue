<script setup lang="ts">
// Line chart (monthly_trend) and points + line (item_price_history, chart=scatter_line).
// The path `d` is built only from computed numbers, never from labels (spec §11-6).
import { computed } from 'vue'
import { formatYen, truncateLabel } from '@/shared/format'
import { type ChartDatum, compactYen, niceMax } from './types'

const props = withDefaults(defineProps<{ data: ChartDatum[]; points?: boolean }>(), { points: false })

const W = 320
const H = 160
const LEFT = 36
const RIGHT = 8
const BOTTOM = 20
const TOP = 10
const plotH = H - BOTTOM - TOP
const plotW = W - LEFT - RIGHT

const max = computed(() => niceMax(Math.max(0, ...props.data.map((d) => d.value))))
const pts = computed(() =>
  props.data.map((d, i) => {
    const n = props.data.length
    const x = LEFT + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const y = TOP + plotH - (Math.max(0, d.value) / max.value) * plotH
    return {
      key: i,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      value: d.value,
      label: truncateLabel(d.label, 5),
      title: `${d.label}${d.sub ? `（${d.sub}）` : ''}: ${formatYen(d.value)}`,
    }
  }),
)
const path = computed(() => pts.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '))
const ticks = computed(() => [0, 0.5, 1].map((t) => ({ y: TOP + plotH - t * plotH, text: compactYen(t * max.value) })))
const labelEvery = computed(() => Math.max(1, Math.ceil(pts.value.length / 6)))
</script>

<template>
  <svg
    class="bb-chart"
    :viewBox="`0 0 ${W} ${H}`"
    role="img"
    :aria-label="`折れ線グラフ ${data.length}点`"
  >
    <g
      v-for="t in ticks"
      :key="t.y"
    >
      <line
        class="bb-chart__grid"
        :x1="LEFT"
        :x2="W - RIGHT"
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
    <path
      v-if="pts.length > 1"
      class="bb-chart__line"
      :d="path"
    />
    <g
      v-for="p in pts"
      :key="p.key"
    >
      <title>{{ p.title }}</title>
      <circle
        class="bb-chart__point"
        :cx="p.x"
        :cy="p.y"
        :r="points ? 4 : 2.5"
        :data-value="p.value"
      />
      <text
        v-if="p.key % labelEvery === 0"
        class="bb-chart__axis"
        :x="p.x"
        :y="H - 6"
        text-anchor="middle"
      >{{ p.label }}</text>
    </g>
  </svg>
</template>
