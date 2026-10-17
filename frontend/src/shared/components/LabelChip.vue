<script setup lang="ts">
import { computed } from 'vue'
import { labelAriaName, type LabelLike } from '../labels'

// One label's visual (TASK-26 1-2 V3), shared by the web screens and the
// widget. A titled label is a colored name chip (soft background of the
// label color, the color as the border, a dark foreground); an untitled
// label is a bare color chip with no text at all. The spoken name
// (labelAriaName) rides as aria-label; the title attribute carries the full
// name only when one is set (hover truncation relief). `selected` adds a
// 2px ring plus a check (before the name when titled, centered and white
// when bare). Sizes: md = 24px (default), sm = 20px (dense rows).
const props = withDefaults(
  defineProps<{ label: LabelLike; index: number; size?: 'sm' | 'md'; selected?: boolean }>(),
  { size: 'md', selected: false },
)

const ariaName = computed(() => labelAriaName(props.label, props.index))
</script>

<template>
  <span
    class="label-chip"
    :class="[`label-${label.color}`, size, { titled: Boolean(label.title), selected }]"
    data-test="label-chip"
    role="img"
    :aria-label="ariaName"
    :title="label.title || undefined"
  >
    <svg
      v-if="selected"
      class="label-check"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    ><path d="M20 6 9 17l-5-5" /></svg>
    <span
      v-if="label.title"
      class="label-chip-name"
    >{{ label.title }}</span>
  </span>
</template>
