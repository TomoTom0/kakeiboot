<script setup lang="ts">
import { computed } from 'vue'
import { formatYen } from '@/shared/format'
import { allocateStack, type AllocatedSegment } from '@/shared/lib/stackedBars'
import BarSegs from './BarSegs.vue'
import { type ChartDatum, compactYen, niceMax } from './types'

// Vertical bars for monthly totals (spec §10 monthly_trend / overview 月次推移).
//
// TASK-116 (design: tmp/tasks/tm-116/design_breakdown-expansion.md §3-3-2):
// a bar whose datum carries `segments` (the stacked composition off
// `_meta.trend_matrix`, assembled by the shared stackedOf) draws as a
// segment column — the bottom shape is the FIRST (top-ranked) series, the
// same correspondence as the web .bar-stack's column-reverse base.
//
// TASK-123 (design: tmp/tasks/tm-123/design_breakdown-visual.md v5 §4-4/
// §4-5): the segment grammar is the outline stroke + the allocation rules
// (the stroke-inclusive outer sizes tile the bar's height, the topmost
// segment alone is the top-rounded cap path). TASK-129 (design §4-3): the
// outline drawing itself moved into the ONE common renderer (BarSegs) with
// BarHChart and ShareBar — this chart keeps the bar math, the axis and the
// titles. The bar math never changes here (height = value / niceMax, 3
// y-ticks, the first/last month labels, the per-bar year-month + amount
// title; the report-level scale source switch is TASK-126's). A
// segment-less bar (no matrix / a bucket-count mismatch) keeps the single
// shape, painted var(--series-1), through the same renderer.
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
    const x = LEFT + i * slot.value + slot.value * 0.15
    const w = slot.value * 0.7
    let segs: AllocatedSegment[] = []
    let titles: string[] = []
    if (d.segments && d.segments.length > 0) {
      // the composition ratios close over the segment set itself (the
      // stackedOf assembly: top-3 + residual = the bucket total) — the real
      // payloads carry rows and matrix under the same conditions, so this
      // equals the row value; a ratio read off d.value would instead break
      // wherever the two drift apart
      const allocated = allocateStack(d.segments, h)
      if (allocated.length > 0) {
        const segTotal = allocated.reduce((a, s) => a + s.value, 0)
        segs = allocated
        titles = allocated.map((s) => `${s.label} ${formatYen(s.value)}（${segTotal > 0 ? Math.round((s.value / segTotal) * 100) : 0}%）`)
      }
    }
    if (segs.length === 0) {
      // the fallback single bar: the SAME grammar through the renderer (the
      // old standalone rx=2 rect is gone), full height, the first series
      // color; its hover title rides the bar's own <title> below
      segs = allocateStack([{ label: d.label, value: Math.max(0, d.value), color: 'var(--series-1)' }], h)
    }
    return {
      key: i,
      x,
      w,
      h,
      segs,
      titles,
      label: d.label,
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
      v-for="(b, i) in bars"
      :key="b.key"
    >
      <title>{{ b.title }}</title>
      <BarSegs
        :segs="b.segs"
        :length="b.h"
        dir="v"
        :size="b.w"
        :base="TOP + plotH"
        :cross="b.x"
        :titles="b.titles"
      />
      <text
        v-if="i === 0"
        class="bb-chart__axis"
        :x="LEFT"
        :y="H - 6"
        text-anchor="start"
      >{{ b.label }}</text>
      <text
        v-else-if="i === bars.length - 1"
        class="bb-chart__axis"
        :x="W"
        :y="H - 6"
        text-anchor="end"
      >{{ b.label }}</text>
    </g>
  </svg>
</template>
