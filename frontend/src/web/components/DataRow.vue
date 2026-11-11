<script setup lang="ts">
// TASK-170 W-1: the row grammar's structure lives in
// shared/components/DataRow.vue (router-free); this thin wrapper is the
// web's root resolution alone — a `to` renders the RouterLink
// (a.data-row.is-link, the same DOM as before), everything else passes
// through untouched: the props, the attrs and ONLY the slots the caller
// actually passed (none are fabricated here, so the shared hasSub slot
// detection keeps its behavior — a v-if-false slot does not exist).
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { Label } from '@/shared/labels'
import SharedDataRow from '@/shared/components/DataRow.vue'

defineOptions({ inheritAttrs: false })

withDefaults(
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
</script>

<template>
  <SharedDataRow
    :root-as="to ? RouterLink : undefined"
    :root-props="to ? { to } : undefined"
    :on-select="onSelect"
    :name="name"
    :name-title="nameTitle"
    :amount="amount"
    :sub-text="subText"
    :sub-figure="subFigure"
    :labels="labels"
    :chevron="chevron"
    v-bind="$attrs"
  >
    <template
      v-for="(_, slotName) in $slots"
      :key="slotName"
      #[slotName]="slotProps"
    >
      <slot
        :name="slotName"
        v-bind="slotProps ?? {}"
      />
    </template>
  </SharedDataRow>
</template>
