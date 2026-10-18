<script setup lang="ts">
import AppIcon from './AppIcon.vue'

// The condition chip row of the detail pages (TASK-74 §3-4 案A): one
// horizontal-scroll row right under the PageHead, chips + remove events —
// the parent owns the URL and answers remove(key) with a router.replace
// that drops the matching query key. The chip of the page's own subject
// (removable: false) carries no x. TASK-75 moves this row into the one-line
// toolbar without changing the interface.
export interface FilterChip {
  key: string
  label: string
  test?: string
  /** false for the page's own subject chip (no x — removing it is meaningless) */
  removable?: boolean
}

defineProps<{ chips: FilterChip[] }>()

const emit = defineEmits<{ remove: [key: string] }>()
</script>

<template>
  <div
    v-if="chips.length"
    class="page-chips"
    data-test="page-chips"
  >
    <span
      v-for="c in chips"
      :key="c.key"
      class="page-chip"
      :data-test="c.test ?? `chip-${c.key}`"
    >
      {{ c.label }}
      <button
        v-if="c.removable !== false"
        type="button"
        class="chip-x"
        :aria-label="`${c.label}を外す`"
        :data-test="`chip-x-${c.key}`"
        @click="emit('remove', c.key)"
      >
        <AppIcon
          name="close"
          :size="12"
        />
      </button>
    </span>
  </div>
</template>
