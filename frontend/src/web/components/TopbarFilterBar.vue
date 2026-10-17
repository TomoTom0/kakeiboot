<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import LabelFilter from './LabelFilter.vue'
import PeriodPicker from './PeriodPicker.vue'
import PopoverPanel from './PopoverPanel.vue'
import { usePeriodStore } from '../stores/period'

// The topbar center filter bar (TASK-44 §11, stage 1a): the always-on
// period and label chips between the page title and the topbar actions,
// each opening a small PopoverPanel dialog. State stays where it was — the
// period store for both dimensions; the pages re-query through their
// watch(period.range) / watch(period.labelQuery). The search chip
// (filter-search) joins in stage 1b together with /search (TASK-41) and
// must not exist yet. No props: the bar reads the store directly.
const period = usePeriodStore()
const route = useRoute()
const periodOpen = ref(false)
const labelsOpen = ref(false)

// The bar outlives the page swap (it sits in the topbar), so a real
// navigation closes its dialogs — the same navKey rule as the account
// menu: the feed rewrites its URL while scrolling, which is not a
// navigation.
const navKey = computed(() => (route.name === 'receipt' ? 'receipt' : route.path))
watch(navKey, () => {
  periodOpen.value = false
  labelsOpen.value = false
})

/** A custom range is an explicit narrowing; month/year are the defaults. */
const periodActive = computed(() => period.mode === 'range')
const periodAria = computed(() => `期間で絞り込み: ${period.label}`)
</script>

<template>
  <div class="topbar-filters">
    <PopoverPanel
      v-model:open="periodOpen"
      variant="sheet-narrow"
      label="期間で絞り込み"
    >
      <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
        <button
          type="button"
          class="filter-chip-btn filter-chip-period"
          :class="{ active: periodActive }"
          :aria-expanded="expanded"
          :aria-controls="controls"
          :aria-label="periodAria"
          data-test="filter-period"
        >
          <!-- both width labels ride the chip: a 900px media query shows one -->
          <span class="chip-label chip-label-short">{{ period.labelShort }}</span>
          <span class="chip-label chip-label-full">{{ period.label }}</span>
        </button>
      </template>
      <!-- Home reads a single calendar month only: its dialog keeps the 月
           tab (the page normalizes year/range back to month on entry) -->
      <PeriodPicker :month-only="route.name === 'home'" />
    </PopoverPanel>
    <LabelFilter
      v-model:open="labelsOpen"
      size="topbar"
      :model-value="period.labelColors"
      @update:model-value="period.setLabelColors($event)"
    />
  </div>
</template>
