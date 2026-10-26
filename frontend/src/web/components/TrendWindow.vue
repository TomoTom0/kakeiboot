<script setup lang="ts">
// The trend chart's window chrome (TASK-104): the prev/next chevron pair
// around TrendBars, in PeriodPicker's button vocabulary (.icon-btn +
// chevron + aria-label, resized to the 44px shared tap-target floor). A
// dedicated wrapper (the UI rule: one visual component per expression) —
// TrendBars stays a pure pass-through and never knows the window moves.
// TASK-108: the swap of the committed window slides — windowKey gates the
// bars' v-if (null until the first response) and keys the out-in transition;
// transitionName ('' / trend-slide-back|forward) is computed in the
// composable from the direction record + the first-paint guard.
import AppIcon from './AppIcon.vue'
import TrendBars, { type StackedBar } from './TrendBars.vue'
import type { TrendGranularity } from '../composables/trend'

// props: nav (month/year only — false hides the pair) / canPrev / canNext /
// windowKey + transitionName (the TASK-108 slide pair) plus TrendBars'
// pass-through (stacked / granularity / span / current — this `span` is the
// bars' own display range, not the composable's page-turn step)
withDefaults(
  defineProps<{
    nav: boolean
    canPrev: boolean
    canNext: boolean
    /** the committed window's identity — null until the first response:
     *  the v-if gate and the transition key (TASK-108 §1-4) */
    windowKey: string | null
    /** the transition name ('' = instant paint / trend-slide-back|forward) —
     *  the composable computes it from direction + slideReady (§1-4) */
    transitionName: string
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
    <Transition
      :name="transitionName"
      mode="out-in"
    >
      <TrendBars
        v-if="windowKey"
        :key="windowKey"
        :stacked="stacked"
        :granularity="granularity"
        :span="span"
        :current="current"
        @select="emit('select', $event)"
      />
    </Transition>
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
