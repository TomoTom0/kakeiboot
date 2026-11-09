<script setup lang="ts">
// The ONE common SVG segment renderer (TASK-129 design §4-3,
// widget.stats-seg-renderer): BarVChart, BarHChart and ShareBar route every
// segment outline through it — the chart components keep only their data
// assembly, axes, labels and titles, never a per-chart outline/cap fork.
//
// Geometry: the AllocatedSegment sizes tile the bar's `length` starting at
// `base` toward the data end (dir 'v': bottom-up with the cap on the TOP
// segment — the bar_v grammar; dir 'h': left-to-right with the cap on the
// RIGHT one), `size` is the bar's stroke-inclusive cross dimension and
// `cross` its cross-axis coordinate. Every shape carries class bb-seg and its
// outer size as data-size (an SVG path carries no width attribute — the
// allocation's observation point). An outlined shape is the allocation minus
// 2 units (the viewBox-unit stroke of width 2 consumes ±1 inside it, §4-8's
// proportional grammar — never non-scaling); a rule-F shape keeps the FULL
// allocation with no stroke; the data-end shape alone is the cap path (radius
// min(2, cross/4), the base end square). The component's root is its own
// <svg> — an exact 1:1 viewport over the geometry's extent, so the shapes'
// user-unit coordinates are identical nested inside a chart's <svg> or
// standing alone.
import { computed } from 'vue'
import type { AllocatedSegment } from '@/shared/lib/stackedBars'

interface SegShape {
  key: number
  /** false = the data-end cap path */
  rect: boolean
  /** the shape's x / y / width / height (viewBox units) */
  x: number
  y: number
  w: number
  h: number
  /** the cap path's `d` (data-end shapes only) */
  d: string
  /** the segment's stroke-inclusive outer size (rides data-size) */
  size: number
  color: string
  outline: boolean
  title: string | null
}

const props = withDefaults(
  defineProps<{
    segs: AllocatedSegment[]
    /** the bar's full drawn length along its direction (the sizes' sum) */
    length: number
    dir: 'v' | 'h'
    /** the bar's cross dimension — the stroke-inclusive thickness */
    size: number
    /** the bar's start along its direction ('v': the baseline y, 'h': the left x) */
    base: number
    /** the cross-axis coordinate ('v': the bar's left x, 'h': the bar's top y) */
    cross: number
    /** per-shape hover titles, aligned with segs (missing entries render none) */
    titles?: string[] | null
  }>(),
  { titles: null },
)

const r2 = (v: number): number => Math.round(v * 100) / 100

/** the cap radius off the bar's short (cross) side — §4-3: min(2, cross/4) */
const capR = computed(() => Math.min(2, props.size / 4))

/** the 'v' data-end cap: the same box a rect would occupy with the two TOP
 * corners arced and the baseline side square — the stroke follows the
 * outline around the arcs */
function capTop(x: number, y: number, w: number, h: number): string {
  const r = capR.value
  const x2 = r2(x + w)
  const y2 = r2(y + h)
  const xr = r2(r)
  const xi = r2(x)
  const yi = r2(y)
  return `M${xi} ${y2} L${xi} ${r2(y + r)} A${xr} ${xr} 0 0 1 ${r2(x + r)} ${yi} L${r2(x + w - r)} ${yi} A${xr} ${xr} 0 0 1 ${x2} ${r2(y + r)} L${x2} ${y2} Z`
}

/** the 'h' data-end cap: the two RIGHT corners arced, the base (left) side
 * square — the horizontal twin of capTop */
function capRight(x: number, y: number, w: number, h: number): string {
  const r = capR.value
  const x2 = r2(x + w)
  const y2 = r2(y + h)
  const xr = r2(r)
  const xi = r2(x)
  const yi = r2(y)
  return `M${xi} ${yi} L${r2(x2 - r)} ${yi} A${xr} ${xr} 0 0 1 ${x2} ${r2(y + r)} L${x2} ${r2(y2 - r)} A${xr} ${xr} 0 0 1 ${r2(x2 - r)} ${y2} L${xi} ${y2} Z`
}

const shapes = computed<SegShape[]>(() => {
  let cursor = props.base
  return props.segs.map((s, i) => {
    const inset = s.outline ? 1 : 0
    const dataEnd = i === props.segs.length - 1
    let x = 0
    let y = 0
    let w = 0
    let h = 0
    let d = ''
    if (props.dir === 'v') {
      // bottom-up: the first segment anchors the baseline, the sizes stack
      const outerTop = cursor - s.size
      cursor = outerTop
      x = props.cross + inset
      w = Math.max(props.size - 2 * inset, 0)
      y = outerTop + inset
      h = Math.max(s.size - 2 * inset, 0)
      if (dataEnd) d = capTop(x, y, w, h)
    } else {
      // left-to-right: the first segment anchors the base (left) end
      const outerLeft = cursor
      cursor += s.size
      x = outerLeft + inset
      w = Math.max(s.size - 2 * inset, 0)
      y = props.cross + inset
      h = Math.max(props.size - 2 * inset, 0)
      if (dataEnd) d = capRight(x, y, w, h)
    }
    return { key: i, rect: !dataEnd, x, y, w, h, d, size: s.size, color: s.color, outline: s.outline, title: props.titles?.[i] ?? null }
  })
})

/** the viewport the root <svg> below covers: an exact 1:1 window over the
 * geometry's own extent (the shapes never exceed base+length / cross+size),
 * so nesting the renderer inside a chart's <svg> preserves every user-unit
 * coordinate — the root exists because Vue resolves the SVG namespace from
 * an <svg> ELEMENT (never per shape), keeping the renderer's output real SVG
 * in any mount context */
const viewport = computed(() => {
  const w = props.dir === 'v' ? props.cross + props.size : props.base + props.length
  const h = props.dir === 'v' ? props.base : props.cross + props.size
  const r2v = (v: number): number => Math.round(v * 100) / 100
  return { w: r2v(w), h: r2v(h), viewBox: `0 0 ${r2v(w)} ${r2v(h)}` }
})
</script>

<template>
  <svg
    :x="0"
    :y="0"
    :width="viewport.w"
    :height="viewport.h"
    :viewBox="viewport.viewBox"
    aria-hidden="true"
  >
    <rect
      v-for="s in shapes.filter((sh) => sh.rect)"
      :key="`r${s.key}`"
      class="bb-seg"
      :x="s.x"
      :y="s.y"
      :width="s.w"
      :height="s.h"
      :fill="s.color"
      :stroke="s.outline ? 'var(--seg-outline)' : undefined"
      :stroke-width="s.outline ? 2 : undefined"
      :data-size="s.size"
    ><title v-if="s.title">{{ s.title }}</title></rect>
    <path
      v-for="s in shapes.filter((sh) => !sh.rect)"
      :key="`p${s.key}`"
      class="bb-seg"
      :d="s.d"
      :fill="s.color"
      :stroke="s.outline ? 'var(--seg-outline)' : undefined"
      :stroke-width="s.outline ? 2 : undefined"
      :data-size="s.size"
    ><title v-if="s.title">{{ s.title }}</title></path>
  </svg>
</template>
