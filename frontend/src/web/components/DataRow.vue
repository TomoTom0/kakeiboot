<script setup lang="ts">
// TASK-167 D-1/D-2 (design: tmp/tasks/tm-167/design_row_hierarchy.md v2):
// the ONE shared list-row grammar — the main line (the data name 16px w600 +
// the amount w700 tabular right, the row's strongest figure) over a sub line
// (the derived representative items 0.8rem muted + the secondary figure +
// the label dots), with an optional bottom bar riding the caller's track.
// Every surface's rows (the receipt lists / ranked lists / search / the
// axis-detail static rows) render through this component; the per-surface
// .recent-row definitions are gone. The root carries the row's pressability
// (D-4): `to` renders a RouterLink, `onSelect` a button, neither a plain
// span — a non-pressable row never washes.
import { computed, useSlots } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { Label } from '@/shared/labels'
import AppIcon from './AppIcon.vue'
import LabelDots from '@/shared/components/LabelDots.vue'

const props = withDefaults(
  defineProps<{
    /** the row's destination: renders a RouterLink (null = not pressable) */
    to?: RouteLocationRaw | null
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
    to: undefined,
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
// label already carries the information) renders no sub line
const hasSub = computed(
  () =>
    !!props.subText ||
    !!props.subFigure ||
    (props.labels?.length ?? 0) > 0 ||
    !!slots.sub ||
    !!slots.figure ||
    !!slots['sub-end'],
)
</script>

<template>
  <component
    :is="to ? RouterLink : onSelect ? 'button' : 'span'"
    class="data-row"
    :class="{ 'is-link': !!to || !!onSelect }"
    v-bind="to ? { to } : onSelect ? { type: 'button', onClick: onSelect } : {}"
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
      <slot name="sub-end" />
      <span
        v-if="labels && labels.length"
        class="row-labels"
        data-test="row-labels"
      ><LabelDots
        :labels="labels"
        compact
      /></span>
      <slot name="figure">
        <span
          v-if="subFigure"
          class="row-fig"
        >{{ subFigure }}</span>
      </slot>
    </span>
    <slot name="bar" />
  </component>
</template>
