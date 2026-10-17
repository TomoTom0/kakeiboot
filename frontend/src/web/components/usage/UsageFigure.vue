<script setup lang="ts">
import AppIcon from '../AppIcon.vue'

// Figure wrapper for the usage walkthrough (TASK-37): a screenshot with a
// caption when `src` is given (the Vite-imported asset URL), or a dashed
// placeholder carrying the swap-in note until the screenshot is captured.
const props = defineProps<{
  /** data-test of the figure element */
  id?: string
  caption: string
  /** Vite asset URL; omit for the placeholder (F2/F6 until captured) */
  src?: string
  alt?: string
  /** what the placeholder figure will show once captured */
  note?: string
}>()

const alt = props.alt ?? props.caption
</script>

<template>
  <figure
    class="usage-fig"
    :data-test="id"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt"
    >
    <div
      v-else
      class="usage-fig-ph"
    >
      <AppIcon
        name="image"
        :size="26"
      />
      <p class="small">
        {{ note }}
      </p>
    </div>
    <figcaption>{{ caption }}</figcaption>
  </figure>
</template>
