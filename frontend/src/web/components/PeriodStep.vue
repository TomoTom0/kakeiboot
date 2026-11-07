<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { usePeriodStore } from '../stores/period'
import { prefersReducedMotion } from '../composables/reducedMotion'

// The in-page period step pair (TASK-161 §3, design: tmp/tasks/tm-161/
// design_period_ui.md v2 — web-common.period-step): ‹ › around the period
// label, calling period.step(±1). The store is read directly (the
// PeriodPicker way — no props to drift); the aria vocabulary derives from
// the mode (TASK-144). range hides the pair entirely (a range is a one-off
// narrowing — the PeriodPicker rule) while the slotted label stays. The
// chevron pair brackets the slot as the label's siblings, so the header's
// one-line layout ([‹] label [›] … total) composes here. TASK-161 §2-2: the
// slot carries the label's direction micro move (the wrapper below animates
// toward the travel direction on a range change — the direction derives
// from the move itself, straight off the store, never through the deleted
// periodMove machinery).
const period = usePeriodStore()

const STEP_WORDS: Record<'month' | 'week' | 'year', { prev: string; next: string }> = {
  month: { prev: '前の月', next: '次の月' },
  week: { prev: '前の週', next: '次の週' },
  year: { prev: '前の年', next: '次の年' },
}
const words = computed(() => {
  if (period.mode === 'week') return STEP_WORDS.week
  if (period.mode === 'year') return STEP_WORDS.year
  return STEP_WORDS.month
})
/** the pair renders only while the mode defines a step (range does not) */
const steppable = computed(() => period.mode !== 'range')

/** the label's micro move (§2-2): the latest range change's direction rides
 *  the wrapper for one 150ms pass. The baseline is captured at MOUNT (the
 *  very first move animates too — review 中5), every change strips the class
 *  first and re-applies it one frame later so a rapid same-direction press
 *  RESTARTS the animation instead of re-setting the same class (a no-op for
 *  CSS); a reduced preference keeps the label still */
const moveClass = ref('')
let clearTimer = 0
let moveGen = 0
watch(
  () => period.range[0],
  (from, prev) => {
    if (from === prev) return
    const gen = ++moveGen
    moveClass.value = ''
    window.clearTimeout(clearTimer)
    requestAnimationFrame(() => {
      if (gen !== moveGen || prefersReducedMotion()) return
      moveClass.value = from > prev ? 'label-move-next' : 'label-move-prev'
      clearTimer = window.setTimeout(() => {
        if (gen === moveGen) moveClass.value = ''
      }, 160)
    })
  },
  { flush: 'sync' },
)
</script>

<template>
  <span class="period-step">
    <button
      v-if="steppable"
      class="icon-btn"
      type="button"
      :aria-label="words.prev"
      :title="words.prev"
      data-test="period-step-prev"
      @click="period.step(-1)"
    >
      <AppIcon name="chevron-left" />
    </button>
    <span
      class="period-step-label"
      :class="moveClass"
    ><slot /></span>
    <button
      v-if="steppable"
      class="icon-btn"
      type="button"
      :aria-label="words.next"
      :title="words.next"
      data-test="period-step-next"
      :disabled="!period.canNext"
      @click="period.step(1)"
    >
      <AppIcon name="chevron-right" />
    </button>
  </span>
</template>
