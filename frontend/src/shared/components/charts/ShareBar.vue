<script setup lang="ts">
// The stacked composition bar (spec §10 by_category 構成比, chart=stacked_bar).
//
// TASK-129 (design §4-5): the bar is no longer the always-full 100% stack —
// its full length is the rows SUM over the report-level shared scale
// (StatsScreen passes it; standalone data falls back to barScale of the sum),
// the inner split runs allocateStack's composition mode (rules A/B/F; rule C
// never fires — the API-assembled lineup stands, no top-3 slicing and no 5%
// fold), the null-key rows map to the rest flag (the fold target, keeping
// their own display name) and a fold-created residual carries the
// caller-supplied「その他」. The legend follows the bar's REAL composition:
// a fold moves the value to the target segment, so the money sum stays the
// rows' own. The shapes come from the ONE common renderer (BarSegs).
import { computed } from 'vue'
import { formatYen } from '@/shared/format'
import { seriesColor } from '@/shared/lib/seriesColor'
import { allocateStack, barScale } from '@/shared/lib/stackedBars'
import BarSegs from './BarSegs.vue'
import { type ChartDatum, seriesColorAt } from './types'

const props = defineProps<{ data: ChartDatum[]; scale?: number }>()

const W = 320
const H = 18

const total = computed(() => props.data.reduce((s, d) => s + Math.max(0, d.value), 0))
const scale = computed(() => props.scale ?? barScale(total.value))
/** the bar's full length: the rows sum over the report scale (never the
 * always-full stack — a sum past the scale cannot happen, the scale
 * aggregates the sum itself) */
const full = computed(() => (total.value > 0 ? (total.value / scale.value) * W : 0))
// TASK-116: the segments are key-based (the same shared mapping the bar_h
// rows and the web ranking rows paint); keyless data falls back to the slot.
// TASK-129: the null key is the residual identity (未分類 / the API's
// 「その他」row) — it maps to the rest FLAG, not a label
const segs = computed(() =>
  props.data.map((d, i) => ({
    label: d.label,
    value: Math.max(0, d.value),
    color: d.key === undefined ? seriesColorAt(i) : seriesColor(d.key),
    rest: d.key === null,
  })),
)
const allocated = computed(() => allocateStack(segs.value, full.value, { mode: 'composition', rest: { label: 'その他' } }))
const segTotal = computed(() => allocated.value.reduce((s, x) => s + x.value, 0))
const legend = computed(() =>
  allocated.value.map((s) => ({
    label: s.label,
    color: s.color,
    value: s.value,
    // the bar's inner composition ratio (one decimal)
    pct: Math.round((segTotal.value > 0 ? s.value / segTotal.value : 0) * 1000) / 10,
  })),
)
const titles = computed(() => legend.value.map((l) => `${l.label}: ${l.pct}%`))
</script>

<template>
  <div class="bb-share">
    <svg
      class="bb-chart"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="構成比"
    >
      <BarSegs
        :segs="allocated"
        :length="full"
        dir="h"
        :size="H"
        :base="0"
        :cross="0"
        :titles="titles"
      />
    </svg>
    <ul class="bb-legend">
      <li
        v-for="(s, i) in legend"
        :key="i"
      >
        <svg
          width="10"
          height="10"
          aria-hidden="true"
        ><rect
          width="10"
          height="10"
          :fill="s.color"
        /></svg>
        <span>{{ s.label }}</span>
        <span class="bb-legend__val">{{ s.pct }}% / {{ formatYen(s.value) }}</span>
      </li>
    </ul>
  </div>
</template>
