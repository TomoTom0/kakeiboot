<script setup lang="ts">
import AppIcon from './AppIcon.vue'

// The condition chip row (TASK-74 §3-4 案A, absorbed into the one-line
// toolbar by TASK-75): one horizontal-scroll row of chips + remove events —
// the parent owns the state and answers remove(key) (the detail pages with a
// router.replace dropping the matching query key, the receipts list by
// clearing its filter). The chip of the page's own subject (removable: false)
// carries no x. Rendered inside BrowseToolbar's row; the interface is
// unchanged from the TASK-74 provisional placement.
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
