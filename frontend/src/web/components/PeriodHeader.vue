<script setup lang="ts">
import { formatYen } from '../composables/format'
import { useTweenNumber } from '../composables/useTweenNumber'
import PeriodStep from './PeriodStep.vue'

// The period header (TASK-89 §1-(1), the compare side removed): the reading
// screens' headline — not a card, a whitespace + hairline compartment where
// typography leads. TASK-161 §3/§4 (design: tmp/tasks/tm-161/design_period_ui.md
// v2) reworks it into the one-line layout
//
//   [‹] 2026年10月 [›]                ¥123,456
//
// — the label is period.label ALONE (the「の支出」suffix is gone from every
// caller, 指摘5), bracketed by the PeriodStep pair (指摘4), with the period
// total at the far right (2.25rem/700/tabular-nums unchanged — the number is
// the statement, no「総額」caption). The two-stage gap lives in styles.css
// (button↔label 0.25rem, label組↔total space-between with a 1.5rem floor,
// flex-wrap on the narrow bands). The label's direction micro move rides the
// PeriodStep slot; the total tweens on a period change (§2-2).
const props = defineProps<{
  /** the period label, e.g. "2026年10月" (period.label — no suffix) */
  label: string
  total: number
  /** the pane's committed identity (TASK-161 §2-2): a total change that
   *  rides a key bump is a content swap — the number lands at once and the
   *  pane's fade is the motion; the tween serves the period moves alone */
  swapKey?: string
}>()
const totalView = useTweenNumber(() => props.total, { swapKey: () => props.swapKey ?? '' })
</script>

<template>
  <header class="period-head">
    <PeriodStep>
      <span class="period-label muted small">{{ label }}</span>
    </PeriodStep>
    <strong
      class="period-total"
      data-test="period-total"
    >{{ formatYen(totalView) }}</strong>
  </header>
</template>
