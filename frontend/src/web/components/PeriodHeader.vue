<script setup lang="ts">
import { formatYen } from '../composables/format'

// The period header (TASK-89 §1-(1), the compare side removed): the reading
// screens' headline — not a card, a whitespace + hairline compartment where
// typography leads. The period label rides above the total at
// 2.25rem/700/tabular-nums; the number itself is the whole statement.
defineProps<{
  /** the period label, e.g. "2026年10月の支出" */
  label: string
  total: number
}>()
</script>

<template>
  <header class="period-head">
    <div class="period-main">
      <p class="period-label muted small">
        {{ label }}
      </p>
      <strong
        class="period-total"
        data-test="period-total"
      >{{ formatYen(total) }}</strong>
    </div>
  </header>
</template>
