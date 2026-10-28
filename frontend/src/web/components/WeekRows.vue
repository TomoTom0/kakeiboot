<script setup lang="ts">
import { computed } from 'vue'
import { formatYen } from '../composables/format'
import type { StackedSegment } from '@/shared/lib/stackedBars'

// The Home month mode's week rows (TASK-103): each week of the selected
// month as one 44px full-width button — the clipped span label
// ("10/1〜10/4" at the month edges), the formatYen total and the
// RankedList-grammar inline ratio bar (a 2px bottom gradient, decorative —
// no standalone meter element). A press emits select(key) and the parent
// moves the shared period (period.setWeek — the same contract as a weekly
// trend bar). The `current` key (the week holding today) is highlighted.
//
// TASK-116 (design §3-1): the inline bar carries the series breakdown — the
// parent passes each week's segments (shared stackedOf) and the fill splits
// into a multi-stop linear-gradient of the series colors, array order from
// the left (top-ranked first, the residual last) — the same first-series-
// at-the-base correspondence as the trend bar's column-reverse stack. A
// zero-total week draws no bar at all (no gradient — the meaningless 1%
// accent sliver is gone).
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
  defineProps<{ weeks: WeekRow[]; current?: string | null }>(),
  { current: null },
)
const emit = defineEmits<{ select: [key: string] }>()

interface WeekItem {
  key: string
  label: string
  total: number
  fill: number
  /** the multi-stop series gradient; null on a zero-total week (no bar) */
  gradient: string | null
}

const items = computed<WeekItem[]>(() => {
  const max = Math.max(...props.weeks.map((w) => w.total), 1)
  return props.weeks.map((w) => {
    // the 1% floor keeps a tiny positive week readable; a zero-total week
    // keeps fill 0 (the shared gradient paints nothing)
    const fill = w.total > 0 ? Math.max(Math.round((w.total / max) * 100), 1) : 0
    return { key: w.key, label: w.label, total: w.total, fill, gradient: gradientOf(w, fill) }
  })
})

/** The fill split into series-color stops (percent positions of the FULL row
 * width, never past 100): segment i covers [prev, cur] inside the fill, the
 * transparent tail closes it. Inline background-image overrides the shared
 * ranked-row gradient; background-size/position/origin keep the shared rule. */
function gradientOf(w: WeekRow, fill: number): string | null {
  if (w.total <= 0 || fill <= 0 || w.segments.length === 0) return null
  const stops: string[] = []
  let prev = 0
  for (const s of w.segments) {
    if (s.value <= 0 || w.total <= 0) continue
    // cumulative share of the fill, clamped so rounding never passes it
    const cur = Math.min(Math.round(prev + (s.value / w.total) * fill), fill)
    stops.push(`${s.color} ${prev}% ${cur}%`)
    prev = cur
  }
  if (stops.length === 0) return null
  stops.push(`transparent ${fill}% 100%`)
  return `linear-gradient(to right, ${stops.join(', ')})`
}
</script>

<template>
  <ul
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
        :style="{
          '--rank-fill': `${w.fill}%`,
          ...(w.gradient ? { 'background-image': w.gradient } : {}),
        }"
        @click="emit('select', w.key)"
      >
        <span class="week-label">{{ w.label }}</span>
        <span class="amount">{{ formatYen(w.total) }}</span>
        <!-- is-link は全行押下可能なため常に付与（RankedList button行と同文法。v3再レビュー2回目 M-1:
             §1-3 の is-link 共有 selector（hover/focus-visible/transition）と対になる -->
      </button>
    </li>
  </ul>
</template>
