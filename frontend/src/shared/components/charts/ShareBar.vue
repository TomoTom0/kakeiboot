<script setup lang="ts">
// 100% stacked composition bar with a legend (spec §10 by_category 構成比, chart=stacked_bar).
import { computed } from 'vue'
import { formatYen } from '@/shared/format'
import { seriesColor } from '@/shared/lib/seriesColor'
import { type ChartDatum, seriesColorAt } from './types'

const props = defineProps<{ data: ChartDatum[] }>()

const W = 320
const H = 18
const total = computed(() => props.data.reduce((s, d) => s + Math.max(0, d.value), 0))
// TASK-116: the segments are key-based (the same shared mapping the bar_h
// rows and the web ranking rows paint); keyless data falls back to the slot
const colorOf = (d: ChartDatum, i: number): string => (d.key === undefined ? seriesColorAt(i) : seriesColor(d.key))
const segs = computed(() => {
  let x = 0
  return props.data.map((d, i) => {
    const share = total.value > 0 ? Math.max(0, d.value) / total.value : 0
    const seg = { key: i, x, w: share * W, color: colorOf(d, i), label: d.label, pct: Math.round(share * 1000) / 10, value: d.value }
    x += seg.w
    return seg
  })
})
</script>

<template>
  <div class="bb-share">
    <svg
      class="bb-chart"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="構成比"
    >
      <rect
        v-for="s in segs"
        :key="s.key"
        :x="s.x"
        y="0"
        :width="s.w"
        :height="H"
        :fill="s.color"
        :data-value="s.value"
      ><title>{{ s.label }}: {{ s.pct }}%</title></rect>
    </svg>
    <ul class="bb-legend">
      <li
        v-for="s in segs"
        :key="s.key"
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
