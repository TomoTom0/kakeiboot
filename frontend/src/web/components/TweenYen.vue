<script setup lang="ts">
import { formatYen } from '../composables/format'
import { useTweenNumber } from '../composables/useTweenNumber'

// The amount cell (TASK-161 §2-2, web-common.period-move-voice): the .amount
// span the ranked / week rows render, with the value tweened over rAF
// (~300ms, tabular-nums) — a period move updates the SAME element's number
// instead of remounting the pane. The first value lands instantly (a fresh
// pane never counts up from zero), and a reduced-motion preference settles
// at once.
const props = defineProps<{ value: number }>()
const shown = useTweenNumber(() => props.value)
</script>

<template>
  <span class="amount">{{ formatYen(shown) }}</span>
</template>
