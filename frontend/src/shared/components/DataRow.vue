<script setup lang="ts">
// TASK-167 D-1/D-2 (design: tmp/tasks/tm-167/design_row_hierarchy.md v2):
// the ONE shared list-row grammar — the main line (the data name 16px w600 +
// the amount w700 tabular right, the row's strongest figure) over a sub line
// (the derived representative items 0.8rem muted + the secondary figure +
// the label dots), with an optional bottom bar riding the caller's track.
// Every surface's rows (the receipt lists / ranked lists / search / the
// axis-detail static rows / the widget's lists, TASK-170) render through
// this component; the per-surface definitions are gone. The root carries
// the row's pressability (D-4): `onSelect` renders a button, neither a
// plain span — a non-pressable row never washes.
//
// TASK-170 W-1: the component itself is router-free. A surface needing
// links passes its own root component via `rootAs` (the web wrapper hands
// RouterLink, keeping the a.data-row.is-link DOM) with the root's own props
// in `rootProps`; a button root gets { type, onClick } composed internally.
import { computed, useSlots } from 'vue'
import type { Component } from 'vue'
import type { Label } from '@/shared/labels'
import AppIcon from './AppIcon.vue'
import LabelDots from '@/shared/components/LabelDots.vue'

const props = withDefaults(
  defineProps<{
    /** the root element override (the web wrapper passes RouterLink) */
    rootAs?: Component | null
    /** extra props bound onto the root (e.g. RouterLink's `to`) */
    rootProps?: Record<string, unknown> | null
    /** in-place action: renders a button */
    onSelect?: (() => void) | null
    /** the main line's data name (store name / axis label) */
    name?: string
    /** the name's tooltip (a long label keeps its full read) */
    nameTitle?: string
    /** the amount text; the #amount slot overrides it (TweenYen) */
    amount?: string
    /** the sub line's representative items text (品目A・品目B) */
    subText?: string | null
    /** the sub line's secondary figure (share % / date-time), right-aligned */
    subFigure?: string | null
    /** the receipt's labels — dots at the sub line's right end */
    labels?: Label[] | null
    /** the trailing chevron of the destination rows */
    chevron?: boolean
  }>(),
  {
    rootAs: undefined,
    rootProps: undefined,
    onSelect: undefined,
    name: undefined,
    nameTitle: undefined,
    amount: undefined,
    subText: null,
    subFigure: null,
    labels: null,
    chevron: false,
  },
)

const slots = useSlots()
// D-3: a row with no sub content at all (the client-built rest rows, whose
// label already carries the information) renders no sub line. TASK-170 W-1:
// the props decide first, so a slot-less call site (the widget's lists)
// works on props alone — and only the slots the caller actually passed
// count (a v-if-false slot does not exist, keeping the web behavior)
const hasSub = computed(
  () =>
    !!props.subText ||
    !!props.subFigure ||
    (props.labels?.length ?? 0) > 0 ||
    !!slots.sub ||
    !!slots.figure ||
    !!slots['sub-end'],
)

/** the root's bindings: the button composition (type + onClick) with the
 * caller's rootProps layered on top — both COMPOSE, never exclusive (W-1's
 * internal-composition contract: onSelect + rootProps together keep the
 * handler and the type) */
const rootBindings = computed<Record<string, unknown>>(() => ({
  ...(props.onSelect ? { type: 'button', onClick: props.onSelect } : {}),
  ...(props.rootProps ?? {}),
}))
</script>

<template>
  <component
    :is="rootAs ?? (onSelect ? 'button' : 'span')"
    class="data-row"
    :class="{ 'is-link': !!rootAs || !!onSelect }"
    v-bind="rootBindings"
  >
    <span class="row-main">
      <slot name="main">
        <span
          class="row-name truncate"
          :title="nameTitle ?? name"
        >{{ name }}</span>
      </slot>
      <slot name="amount">
        <span class="amount">{{ amount }}</span>
      </slot>
      <AppIcon
        v-if="chevron"
        class="ranked-chevron"
        name="chevron-right"
        :size="12"
      />
    </span>
    <span
      v-if="hasSub"
      class="row-sub"
    >
      <slot name="sub">
        <span
          v-if="subText"
          class="row-items truncate"
        >{{ subText }}</span>
      </slot>
      <slot name="figure">
        <span
          v-if="subFigure"
          class="row-fig"
        >{{ subFigure }}</span>
      </slot>
      <slot name="sub-end" />
      <span
        v-if="labels && labels.length"
        class="row-labels"
        data-test="row-labels"
      ><LabelDots
        :labels="labels"
        compact
      /></span>
    </span>
    <slot name="bar" />
  </component>
</template>
