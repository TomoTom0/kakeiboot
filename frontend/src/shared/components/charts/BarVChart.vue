<script setup lang="ts">
// Vertical bars for monthly totals (spec §10 monthly_trend / overview 月次推移).
//
// TASK-116 (design: tmp/tasks/tm-116/design_breakdown-expansion.md §3-3-2):
// a bar whose datum carries `segments` (the stacked composition off
// `_meta.trend_matrix`, assembled by the shared stackedOf) draws as a
// segment rect column — the bottom rect is the FIRST (top-ranked) series,
// the same correspondence as the web .bar-stack's column-reverse base.
// Value-0 segments are omitted upstream; a >0 segment keeps a 2-viewBox-unit
// minimum height and neighbours sit exactly 1 unit apart (a background gap).
// Each bar clips through its own rounded clipPath (rx=2), so a min-height
// overshoot cuts from the TOP — the top-ranked series survives at the base.
// The bar math itself never changes (height = value / niceMax, 3 y-ticks,
// the first/last month labels, the per-bar year-month + amount title).
// A segment-less bar (no matrix / a bucket-count mismatch) keeps the single
// rect, now painted var(--series-1) — the unified palette's first series.
import { computed } from 'vue'
import { formatYen } from '@/shared/format'
import { type ChartDatum, compactYen, niceMax } from './types'

const props = defineProps<{ data: ChartDatum[] }>()

const W = 320
const H = 160
const LEFT = 36
const BOTTOM = 20
const TOP = 8
const plotH = H - BOTTOM - TOP
/** a >0 segment's minimum height (viewBox units) and the inter-segment gap */
const SEG_MIN = 2
const SEG_GAP = 1

// unique per instance: the clip ids stay distinct when several charts mount
const uid = `barv-${Math.random().toString(36).slice(2, 8)}`

const max = computed(() => niceMax(Math.max(0, ...props.data.map((d) => d.value))))
const slot = computed(() => (W - LEFT) / Math.max(1, props.data.length))

interface SegView {
  y: number
  h: number
  color: string
  title: string
}
const bars = computed(() =>
  props.data.map((d, i) => {
    const h = (Math.max(0, d.value) / max.value) * plotH
    const x = LEFT + i * slot.value + slot.value * 0.15
    const w = slot.value * 0.7
    const y = TOP + plotH - h
    const segs: SegView[] = []
    if (d.segments && d.segments.length > 0) {
      // the composition ratios close over the segment set itself (the
      // stackedOf assembly: top-5 + residual = the bucket total) — the real
      // payloads carry rows and matrix under the same conditions, so this
      // equals the row value; a ratio read off d.value would instead break
      // wherever the two drift apart
      const segTotal = d.segments.reduce((a, s) => a + Math.max(0, s.value), 0)
      if (segTotal > 0) {
        // stack from the bar's base upward: cursor walks the bottom edge
        let cursor = TOP + plotH
        for (const s of d.segments) {
          if (s.value <= 0) continue
          const sh = Math.max((s.value / segTotal) * h, SEG_MIN)
          const sy = cursor - sh
          const pct = Math.round((s.value / segTotal) * 100)
          segs.push({ y: sy, h: sh, color: s.color, title: `${s.label} ${formatYen(s.value)}（${pct}%）` })
          cursor = sy - SEG_GAP
        }
      }
    }
    return {
      key: i,
      x,
      w,
      y,
      h,
      segs,
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
      <!-- the per-bar rounded clip: segments and the fallback rect share it,
           so an overshoot cuts from the top while the base stays rounded -->
      <clipPath :id="`${uid}-${i}`">
        <rect
          :x="b.x"
          :y="b.y"
          :width="b.w"
          :height="b.h"
          rx="2"
        />
      </clipPath>
      <template v-if="b.segs.length > 0">
        <rect
          v-for="(s, j) in b.segs"
          :key="j"
          class="bb-chart__bar"
          :x="b.x"
          :y="s.y"
          :width="b.w"
          :height="s.h"
          :fill="s.color"
          :data-value="b.value"
          :clip-path="`url(#${uid}-${i})`"
        ><title>{{ s.title }}</title></rect>
      </template>
      <rect
        v-else
        class="bb-chart__bar"
        :x="b.x"
        :y="b.y"
        :width="b.w"
        :height="b.h"
        rx="2"
        fill="var(--series-1)"
        :data-value="b.value"
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
