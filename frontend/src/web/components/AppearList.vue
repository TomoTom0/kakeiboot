<script setup lang="ts">
// AppearList (TASK-146 review MED2): the ONE shared carrier of the bb-appear
// row grammar (web-common.appear-fade). Every list whose rows appear through
// the fade rides this component instead of its own TransitionGroup, so the
// pane coordination lives here once: a fresh list mount DURING a pane
// transition is the ContentSwap rebuild itself, and its rows must not run
// the appear fade on top of the pane's motion (単一演出原則) — the
// ContentSwapActive injection is already true by then (the swapKey watch is
// flush:'sync', settled before the rebuilt children render). Any fresh
// mount outside a pane transition (a "さらに表示" page opening a NEW day
// group) keeps the appear fade, and the appear gate never touches the
// appended rows: they enter through the same grammar as before. A list with
// no ContentSwap above it keeps the plain appear.
import { computed, inject, type Ref } from 'vue'
import { ContentSwapActive } from './ContentSwap.vue'

const paneActive = inject<Readonly<Ref<boolean>> | null>(ContentSwapActive, null)
const appear = computed(() => paneActive?.value !== true)

// instantLeave: for aggregate lists whose rows are replaced WHOLESALE by a
// period commit (week rows, ranked rows), the leaving rows go at once —
// a fade would hold the previous period's rows visibly inside the new
// period's list for the fade's duration. Row-level changes within one
// period (an appended page, an archived row) keep the fade.
const props = defineProps<{ instantLeave?: boolean }>()
</script>

<template>
  <TransitionGroup
    name="bb-appear"
    :appear="appear"
    :leave-active-class="props.instantLeave ? 'bb-appear-leave-instant' : undefined"
    tag="ul"
  >
    <slot />
  </TransitionGroup>
</template>
