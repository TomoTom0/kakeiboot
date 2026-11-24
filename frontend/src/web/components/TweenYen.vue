<script setup lang="ts">
import { formatYen } from '../composables/format'
import { useTweenNumber } from '../composables/useTweenNumber'

// The amount cell (TASK-161 §2-2, web-common.period-move-voice): the .amount
// span the ranked / week rows render. In-period value changes tween over
// rAF (~300ms, tabular-nums); a period commit lands at once — the caller
// passes a swap key carrying the period epoch, and counting over from the
// previous period's amount would leave that period's number on screen.
// The first value lands instantly (a fresh pane never counts up from
// zero), and a reduced-motion preference settles at once.
const props = defineProps<{ value: number; swapKey?: string }>()
const shown = useTweenNumber(() => props.value, { swapKey: () => props.swapKey ?? '' })
</script>

<template>
  <span class="amount">{{ formatYen(shown) }}</span>
</template>
