<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatYen } from '../composables/format'
import { allocateStack, type AllocatedSegment, type StackedSegment } from '@/shared/lib/stackedBars'

// The Home month mode's week rows (TASK-103): each week of the selected
// month as one 44px full-width button — the clipped span label
// ("10/1〜10/4" at the month edges) and the formatYen total over the row's
// inline stacked bar. A press emits select(key) and the parent moves the
// shared period (period.setWeek — the same contract as a weekly trend bar).
// The `current` key (the week holding today) is highlighted.
//
// TASK-116 (design §3-1): the inline bar carries the series breakdown — the
// parent passes each week's segments (shared stackedOf: top-3 + the residual
// 「ほか」), array order from the left (top-ranked first, the residual last),
// the same first-series-at-the-base correspondence as the trend bar's
// column-reverse stack. A zero-total week draws no bar at all.
//
// TASK-123 (design §4-7): the bar is a DOM element structure now — the old
// multi-stop linear-gradient string is gone (a gradient cannot carry the
// per-segment title, the 1px outline, the allocation rules or the corner
// cap). The row left the shared .ranked-row bottom-gradient grammar: the bar
// is a 6px flex row of segments whose px widths come from the shared
// allocateStack (§4-5 horizontal variant: the full fill length splits by
// value ratio, the outline consumes inside, minimum 3px, 5%/size folds,
// sub-3px fill-only) and the data end (right) alone rounds.
//
// TASK-129 (design §4-2, web-common.row-bar-component + web-common.bar-scale):
// the bar element is the SAME shared DOM bar component as the ranked rows'
// (.row-bar + .row-seg — the week-scoped .week-bar/.week-seg classes are
// gone), and the bar's full length rides the screen's absolute scale
// (week total / scale × track) instead of the old week/max-week fill — so
// even the max week no longer pegs the full track, and the same amount
// paints the same length as the ranked rows over the same track width.
export interface WeekRow {
  /** the week's Monday ("YYYY-MM-DD") */
  key: string
  /** the clipped span label, e.g. "10/5〜10/11" */
  label: string
  total: number
  /** the week's stacked segments (TASK-116); empty on a zero-total week */
  segments: StackedSegment[]
}
const props = withDefaults(
  defineProps<{ weeks: WeekRow[]; current?: string | null; scale: number }>(),
  { current: null },
)
const emit = defineEmits<{ select: [key: string] }>()

interface WeekBarView {
  /** the bar's drawn width — the week total over the screen scale (px) */
  width: number
  segs: AllocatedSegment[]
  /** the allocated values' sum (the hover titles' share base) */
  segTotal: number
}

interface WeekItem {
  key: string
  label: string
  total: number
  /** the DOM stacked bar; null on a zero-total week (no bar element) */
  bar: WeekBarView | null
}

// TASK-123 §4-5 rule E: the allocation works in px, so the track's real
// width feeds it (measured at mount / on resize; jsdom keeps 0 and the
// segments render at size 0 with their titles and colors until then)
const rowsEl = ref<HTMLElement | null>(null)
const trackW = ref(0)
let ro: ResizeObserver | null = null
function measure(): void {
  const track = rowsEl.value?.querySelector('.week-bar-track') ?? null
  trackW.value = track ? track.clientWidth : 0
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(measure)
  if (rowsEl.value) ro.observe(rowsEl.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

const items = computed<WeekItem[]>(() =>
  props.weeks.map((w) => {
    // TASK-129: the bar's full length is the week total over the SCREEN's
    // absolute scale (never the list-local max-week peg); a zero-total week
    // keeps no bar element at all
    const width = (w.total / props.scale) * trackW.value
    const segs = w.total > 0 ? allocateStack(w.segments, width) : []
    return {
      key: w.key,
      label: w.label,
      total: w.total,
      bar:
        segs.length > 0
          ? { width, segs, segTotal: segs.reduce((a, s) => a + s.value, 0) }
          : null,
    }
  }),
)

/** the segment hover title「名称 金額（構成比%）」— the same form the trend
 * and daily segments carry, over the allocated composition */
function segTitle(s: AllocatedSegment, segTotal: number): string {
  const pct = segTotal > 0 ? Math.round((s.value / segTotal) * 100) : 0
  return `${s.label} ${formatYen(s.value)}（${pct}%）`
}
</script>

<template>
  <ul
    ref="rowsEl"
    class="week-rows"
    data-test="rows"
  >
    <li
      v-for="w in items"
      :key="w.key"
    >
      <button
        type="button"
        class="week-row"
        :class="{ current: w.key === current, 'is-link': true }"
        :data-test="`row-${w.key}`"
        @click="emit('select', w.key)"
      >
        <span class="week-label">{{ w.label }}</span>
        <span class="amount">{{ formatYen(w.total) }}</span>
        <span class="week-bar-track">
          <span
            v-if="w.bar"
            class="row-bar"
            :style="{ width: `${w.bar.width}px` }"
          >
            <span
              v-for="(s, i) in w.bar.segs"
              :key="i"
              class="row-seg"
              :style="{ width: `${s.size}px`, background: s.color, border: s.outline ? undefined : 'none' }"
              :title="segTitle(s, w.bar.segTotal)"
            />
          </span>
        </span>
        <!-- is-link は全行押下可能なため常に付与（RankedList button行と同文法。v3再レビュー2回目 M-1:
             §1-3 の is-link 共有 selector（hover/focus-visible/transition）と対になる -->
      </button>
    </li>
  </ul>
</template>
