<script setup lang="ts">
import { computed, useSlots } from 'vue'
import AppIcon from './AppIcon.vue'
import FilterChips, { type FilterChip } from './FilterChips.vue'

// The one-row in-page toolbar (TASK-75, tm-28 §6-3 as moved by §11-5): the
// 絞り込み button (the receipts list alone — every other screen handles its
// conditions through the carried context and the chips), the condition chips
// (FilterChips, interface unchanged) and the right-end "..." menu slot, all
// on a single row that never wraps. The chips area takes the rest of the
// width and scrolls horizontally; the period and label filters live in the
// topbar center bar (TASK-44 §11) and nothing else joins this row. Screens
// without chips (the category / store lists) render the "..."-only row
// (§6-5); a chip-less, menu-less toolbar (a bare store detail) renders
// nothing at all.
const props = defineProps<{
  /** the receipts list alone shows the 絞り込み button (§6-3) */
  filterButton?: boolean
  /** the button's open state (aria-expanded of the form that follows) */
  filtersOpen?: boolean
  /** the active conditions — the FilterChips interface */
  chips?: FilterChip[]
}>()
const emit = defineEmits<{ toggleFilters: []; remove: [key: string] }>()

const slots = useSlots()
const chipCount = computed(() => props.chips?.length ?? 0)
/** the row exists only when something sits on it */
const visible = computed(
  () => props.filterButton === true || chipCount.value > 0 || slots.menu !== undefined,
)
</script>

<template>
  <div
    v-if="visible"
    class="page-toolbar"
  >
    <button
      v-if="filterButton"
      type="button"
      class="btn btn-small toolbar-filter-btn"
      :aria-expanded="filtersOpen"
      data-test="filters-toggle"
      @click="emit('toggleFilters')"
    >
      <AppIcon
        name="search"
        :size="16"
      /><span class="toolbar-filter-word">絞り込み</span><span
        v-if="chipCount > 0"
        class="toolbar-filter-count"
      >{{ chipCount }}</span>
    </button>
    <FilterChips
      :chips="chips ?? []"
      @remove="(key) => emit('remove', key)"
    />
    <!-- the menu cell renders only when a slot came in (review L3): the chip
         rows without a "..." would otherwise carry an empty right-end div -->
    <div
      v-if="slots.menu !== undefined"
      class="page-toolbar-menu"
    >
      <slot name="menu" />
    </div>
  </div>
</template>
