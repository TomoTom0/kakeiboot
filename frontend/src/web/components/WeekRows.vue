<script setup lang="ts">
import { computed } from 'vue'
import { formatYen } from '../composables/format'

// The Home month mode's week rows (TASK-103): each week of the selected
// month as one 44px full-width button — the clipped span label
// ("10/1〜10/4" at the month edges), the formatYen total and the
// RankedList-grammar inline ratio bar (a 2px bottom gradient, decorative —
// no standalone meter element). A press emits select(key) and the parent
// moves the shared period (period.setWeek — the same contract as a weekly
// trend bar). The `current` key (the week holding today) is highlighted.
export interface WeekRow {
  /** the week's Monday ("YYYY-MM-DD") */
  key: string
  /** the clipped span label, e.g. "10/5〜10/11" */
  label: string
  total: number
}
const props = withDefaults(
  defineProps<{ weeks: WeekRow[]; current?: string | null }>(),
  { current: null },
)
const emit = defineEmits<{ select: [key: string] }>()

const items = computed(() => {
  const max = Math.max(...props.weeks.map((w) => w.total), 1)
  return props.weeks.map((w) => ({ ...w, fill: Math.max(Math.round((w.total / max) * 100), 1) }))
})
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
        :style="{ '--rank-fill': `${w.fill}%` }"
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
