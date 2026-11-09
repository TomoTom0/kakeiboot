<script setup lang="ts">
// Horizontal bars (spec §10 by_category / by_store / by_payment_method, §11-7 "横棒中心").
// Labels are text nodes and are truncated in JS (spec §11-6).
//
// TASK-129 (design §4-1/§4-2): the row bars ride the report-level shared
// scale (barScale of the report's aggregated outer amounts — StatsScreen
// passes it; standalone data falls back to the section-local aggregation),
// so the bar length is the value / scale × available width direct mapping
// (the list-local max=100% peg is gone), and the shape itself comes from the
// ONE common renderer (BarSegs): the full-perimeter viewBox-unit stroke, the
// data-end (right) cap alone rounded — the old four-corner rx=2 is gone.
import { computed } from 'vue'
import { formatYen, truncateLabelWidth } from '@/shared/format'
import { seriesColor } from '@/shared/lib/seriesColor'
import { allocateStack, barScale, type AllocatedSegment } from '@/shared/lib/stackedBars'
import BarSegs from './BarSegs.vue'
import { type ChartDatum, seriesColorAt } from './types'

const props = withDefaults(
  defineProps<{ data: ChartDatum[]; scale?: number }>(),
  { scale: undefined },
)

const W = 320
const LABEL_W = 110
const VALUE_W = 70
const ROW = 30
const BAR_W = W - LABEL_W - VALUE_W
/** the row bar's stroke-inclusive height (ROW − 14, unchanged) */
const BAR_H = ROW - 14
/** the label column's type size (viewBox units — .bb-chart text 11px) */
const LABEL_FONT = 11

// TASK-116: the row color is the KEY-based shared mapping (the same color the
// web ranking rows and the bar_v segments paint); keyless data falls back to
// the index slot — never the shared mapping's number path
const scale = computed(() => props.scale ?? barScale(Math.max(0, ...props.data.map((d) => d.value))))
const rows = computed(() =>
  props.data.map((d, i) => {
    const color = d.key === undefined ? seriesColorAt(i) : seriesColor(d.key)
    const value = Math.max(0, d.value)
    // the single-color row bar at the absolute scale, through the shared
    // allocator (rule F owns the sub-3-unit outline drop)
    const width = (value / scale.value) * BAR_W
    return {
      // TASK-161 §6-2: the fixed 9-char cap is gone — the truncation fills
      // the label column's 110 viewBox units by the estimated glyph width
      label: truncateLabelWidth(d.label, LABEL_W, LABEL_FONT),
      full: d.label,
      value: d.value,
      width,
      segs: allocateStack([{ label: d.label, value, color }], width) satisfies AllocatedSegment[],
      y: i * ROW,
      valueText: formatYen(d.value),
    }
  }),
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
      <BarSegs
        :segs="r.segs"
        :length="r.width"
        dir="h"
        :size="BAR_H"
        :base="LABEL_W"
        :cross="6"
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
