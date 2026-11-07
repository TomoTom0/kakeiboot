<script setup lang="ts">
import { computed } from 'vue'
import { estimateTextWidth, truncateLabelWidth } from '@/shared/format'
import { seriesInk } from '@/shared/lib/seriesColor'
import type { AllocatedSegment } from '@/shared/lib/stackedBars'

// The ONE horizontal row bar (TASK-161 §7, design: tmp/tasks/tm-161/
// design_period_ui.md v2 — web-common.row-bar-component / row-bar-thickness):
// the DOM twin of the ranked rows' and the week rows' bars, previously
// duplicated markup in RankedList.vue and WeekRows.vue. It receives the
// allocateStack result and draws it alone — "the sole owner of the
// horizontal bar's DOM". The CSS grammar (thickness via --row-bar-h, the
// data-end cap, the width transition) lives in styles.css.
//
// TASK-161 §6-1 (web-home.week-row-in-bar-label): `inBarLabels` paints each
// segment's series name INSIDE the bar whenever the drawn px fit the
// estimated text (the monospace char-count × em conversion) plus the 4px
// end paddings — the full name first, then the width-budget truncation
// (… tail), nothing when even that cannot fit. Unmeasured environments
// (jsdom: size 0) keep the colour-only fallback. The ink comes from the
// fixed token contrast table (seriesInk); the hover title keeps the FULL
// information either way.
//
// TASK-162 §1-9/§1-10 (reviews 4/9 — BreakdownBar rides this component):
// `segSelect` turns every non-rest segment into a BUTTON (the rest flag is
// the residual's identity — it never presses; WeekRows passes no segSelect,
// so no button nests inside its row button). The button's padding grows the
// tap band to 24px over the 16px visual (background-clip: content-box keeps
// the painted band the bar's own). The v-for key is the SERIES key now
// ('rest' for the residual) — a series add/remove/reorder moves as a keyed
// node and the width transition carries it; segments enter/leave through a
// 150ms fade and a label-text change crossfades (bb-appear's grammar).
const props = withDefaults(
  defineProps<{
    /** the bar's drawn width in px (0 until the track measures) */
    width: number
    /** the allocator's output — sizes are px, outline off = fill only */
    segs: AllocatedSegment[]
    /** the per-segment hover title「名称 金額（n%）」; omit for untitled bars */
    segTitle?: (s: AllocatedSegment) => string
    /** paint the in-bar series-name labels where they fit (§6-1) */
    inBarLabels?: boolean
    /** the segment press (§1-9): provided = the non-rest segments become
     *  buttons calling this (the caller owns the routing) */
    segSelect?: (s: AllocatedSegment) => void
    /** the shared data-test hook every segment carries when set (§1-9's
     *  press hook — the segments share one id, the tests read the set) */
    segTest?: string
  }>(),
  { segTitle: undefined, inBarLabels: false, segSelect: undefined, segTest: undefined },
)

/** the in-bar label's font metrics (TASK-162 §3-1: 11px/600/0.02em inside the
 *  16px --row-bar-h bar — the --bar-label-* tokens' JS twin; the estimate
 *  errs wide so a marginal label hides rather than overflows) */
const LABEL_FONT = 11
const LABEL_PAD = 8

interface SegView {
  seg: AllocatedSegment
  /** the fitted (possibly truncated) label; null when it cannot fit */
  label: string | null
  ink: string
  /** the segment renders as a pressable button (§1-9: segSelect + non-rest) */
  pressable: boolean
  /** the keyed v-for's key (§1-10: the series key, 'rest' for the residual) */
  key: string
}

const views = computed<SegView[]>(() =>
  props.segs.map((seg) => {
    let label: string | null = null
    if (props.inBarLabels) {
      const avail = seg.size - LABEL_PAD
      if (avail > 0) {
        // the FULL name first — a single-code-point name (a 1-char category)
        // fits widths the truncation minimum (1 char + the … tail) never
        // could, and hiding it there was review 低9
        const est = estimateTextWidth(seg.label, LABEL_FONT)
        if (est <= avail) label = seg.label
        else {
          const fitted = truncateLabelWidth(seg.label, avail, LABEL_FONT)
          if (estimateTextWidth(fitted, LABEL_FONT) <= avail) label = fitted
        }
      }
    }
    return {
      seg,
      label,
      ink: label === null ? '' : seriesInk(seg.color),
      pressable: props.segSelect !== undefined && seg.rest !== true,
      key: seg.rest === true ? 'rest' : String(seg.key ?? 'null'),
    }
  }),
)

function onSelect(v: SegView): void {
  if (props.segSelect && v.pressable) props.segSelect(v.seg)
}
</script>

<template>
  <span
    class="row-bar"
    :style="{ width: `${width}px` }"
  >
    <TransitionGroup name="row-seg">
      <component
        :is="v.pressable ? 'button' : 'span'"
        v-for="v in views"
        :key="v.key"
        :class="['row-seg', { 'is-btn': v.pressable }]"
        :type="v.pressable ? 'button' : undefined"
        :style="{
          width: `${v.seg.size}px`,
          // backgroundColor, NOT the background shorthand: the shorthand
          // resets background-clip to border-box and would repaint the
          // button's full 24px box — the longhand keeps the stylesheet's
          // content-box clip (the painted band stays the 16px bar)
          backgroundColor: v.seg.color,
          border: v.seg.outline ? undefined : 'none',
          ...(v.label !== null ? { color: v.ink } : {}),
        }"
        :title="segTitle ? segTitle(v.seg) : undefined"
        :data-test="segTest ?? undefined"
        :aria-label="v.pressable && segTitle ? segTitle(v.seg) : undefined"
        @click="v.pressable && onSelect(v)"
      ><Transition
        name="row-seg-label"
        mode="out-in"
      ><span
        v-if="v.label !== null"
        :key="v.label"
        class="row-seg-label"
      >{{ v.label }}</span></Transition></component>
    </TransitionGroup>
  </span>
</template>
