<script setup lang="ts">
import { computed } from 'vue'
import { formatSignedYen, formatYen } from '@/shared/format'

const props = withDefaults(defineProps<{ value: number | null | undefined; signed?: boolean }>(), { signed: false })
const text = computed(() => (props.signed ? formatSignedYen(props.value) : formatYen(props.value)))
const negative = computed(() => typeof props.value === 'number' && props.value < 0)
</script>

<template>
  <span
    class="bb-money"
    :class="{ 'bb-money--neg': negative }"
  >{{ text }}</span>
</template>

<style scoped>
.bb-money {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.bb-money--neg {
  color: var(--bb-danger);
}
</style>
