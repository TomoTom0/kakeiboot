<script setup lang="ts">
// Display-only label dots (TASK-17), shared by the web screens and the
// widget. Each dot carries the color name (and title) as aria-label / title
// (spec_mcp-tools.md 12: color name text + aria, no shape differences).
// `compact` renders dots only; the default adds the label text. Nothing is
// rendered for an empty label list.
import { labelText, type LabelLike } from '../labels'

defineProps<{ labels: LabelLike[] | null | undefined; compact?: boolean }>()
</script>

<template>
  <span
    class="label-dots"
    :class="{ compact }"
  >
    <span
      v-for="l in labels ?? []"
      :key="l.color"
      class="label-dot"
      :class="`label-${l.color}`"
      data-test="label-dot"
      role="img"
      :aria-label="labelText(l)"
      :title="labelText(l)"
    ><span
      v-if="!compact"
      class="label-dot-text"
    >{{ labelText(l) }}</span></span>
  </span>
</template>
