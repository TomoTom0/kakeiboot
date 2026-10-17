<script setup lang="ts">
// Display-only labels (TASK-17, restyled in TASK-26), shared by the web
// screens and the widget. `compact` renders 8px color dots for tight rows
// (the spoken name as aria-label; a title attribute only when titled, so
// untitled labels show no text at all); the default renders the labels as
// LabelChip list (a colored name chip when titled, a bare color chip when
// not). Nothing is rendered for an empty label list.
import LabelChip from './LabelChip.vue'
import { labelAriaName, labelIndexOf, type LabelLike } from '../labels'

defineProps<{ labels: LabelLike[] | null | undefined; compact?: boolean }>()
</script>

<template>
  <span
    class="label-dots"
    :class="{ compact }"
  >
    <template v-if="compact">
      <span
        v-for="l in labels ?? []"
        :key="l.color"
        class="label-dot"
        :class="`label-${l.color}`"
        data-test="label-dot"
        role="img"
        :aria-label="labelAriaName(l, labelIndexOf(l.color))"
        :title="l.title || undefined"
      />
    </template>
    <template v-else>
      <LabelChip
        v-for="l in labels ?? []"
        :key="l.color"
        :label="l"
        :index="labelIndexOf(l.color)"
      />
    </template>
  </span>
</template>
