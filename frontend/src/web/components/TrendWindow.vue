<script setup lang="ts">
// The trend chart's window chrome (TASK-104): the prev/next chevron pair
// around TrendBars, in PeriodPicker's button vocabulary (.icon-btn +
// chevron + aria-label, resized to the 44px shared tap-target floor). A
// dedicated wrapper (the UI rule: one visual component per expression) —
// TrendBars stays a pure pass-through and never knows the window moves.
import AppIcon from './AppIcon.vue'
import TrendBars, { type StackedBar } from './TrendBars.vue'
import type { TrendGranularity } from '../composables/trend'

// props: nav (month/year only — false hides the pair) / canPrev / canNext
// plus TrendBars' pass-through (stacked / granularity / span / current)
withDefaults(
  defineProps<{
    nav: boolean
    canPrev: boolean
    canNext: boolean
    stacked: StackedBar[]
    granularity?: TrendGranularity
    span?: [string, string] | null
    current?: string | null
  }>(),
  { granularity: 'month', span: null, current: null },
)
const emit = defineEmits<{ prev: []; next: []; select: [key: string] }>()
</script>

<template>
  <div class="trend-window">
    <button
      v-if="nav"
      class="icon-btn trend-nav"
      type="button"
      aria-label="前の範囲"
      title="前の範囲"
      data-test="trend-prev"
      :disabled="!canPrev"
      @click="emit('prev')"
    >
      <AppIcon name="chevron-left" />
    </button>
    <TrendBars
      :stacked="stacked"
      :granularity="granularity"
      :span="span"
      :current="current"
      @select="emit('select', $event)"
    />
    <button
      v-if="nav"
      class="icon-btn trend-nav"
      type="button"
      aria-label="次の範囲"
      title="次の範囲"
      data-test="trend-next"
      :disabled="!canNext"
      @click="emit('next')"
    >
      <AppIcon name="chevron-right" />
    </button>
  </div>
</template>
