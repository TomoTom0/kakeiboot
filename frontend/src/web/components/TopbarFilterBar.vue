<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import LabelFilter from './LabelFilter.vue'
import PeriodPicker from './PeriodPicker.vue'
import PopoverPanel from './PopoverPanel.vue'
import { usePeriodStore } from '../stores/period'
import { firstString } from '../composables/receiptContext'
import { formatLabelQuery } from '@/shared/labels'

// The topbar center filter bar (TASK-44 §11, stage 1a): the always-on
// period and label chips between the page title and the topbar actions,
// each opening a small PopoverPanel dialog. State stays where it was — the
// period store for both dimensions; the pages re-query through their
// watch(period.range) / watch(period.labelQuery). The search chip
// (filter-search, TASK-41 stage 1b) is the third entry: a 44px square icon
// that opens a one-line search form and runs into /search. On /search with
// a running q the chip carries the term (clamped); everywhere else it is
// the plain entry. No props: the bar reads the store / route directly.
const period = usePeriodStore()
const route = useRoute()
const router = useRouter()
const periodOpen = ref(false)
const labelsOpen = ref(false)
const searchOpen = ref(false)
const draft = ref('')

// The bar outlives the page swap (it sits in the topbar), so a real
// navigation closes its dialogs — the same navKey rule as the account
// menu: the feed rewrites its URL while scrolling, which is not a
// navigation.
const navKey = computed(() => (route.name === 'receipt' ? 'receipt' : route.path))
watch(navKey, () => {
  periodOpen.value = false
  labelsOpen.value = false
  searchOpen.value = false
})

/** A custom range is an explicit narrowing; month/year are the defaults. */
const periodActive = computed(() => period.mode === 'range')
const periodAria = computed(() => `期間で絞り込み: ${period.label}`)

// The search term of the running /search (null everywhere else): the chip's
// spoken name and the clamped label.
const searchQ = computed(() =>
  route.name === 'search' ? (firstString(route.query.q)?.trim() || null) : null,
)
const searchAria = computed(() => (searchQ.value ? `検索: ${searchQ.value}` : '検索'))

// The dialog's draft initializes once per open from the current q (on
// /search) or empty; closing drops whatever was typed.
watch(searchOpen, (open) => {
  if (open) draft.value = route.name === 'search' ? (firstString(route.query.q) ?? '') : ''
})

/** Submit (検索 / Enter): close and move to /search with the current term. */
function run(): void {
  const q = draft.value.trim()
  searchOpen.value = false
  if (route.name === 'search') {
    // refresh the page's results in place: replace keeps the history clean,
    // the period / labels / tab keys of the URL stand
    void router.replace({ query: { ...route.query, q: q || undefined } })
  } else {
    // from any other page: carry the current period and labels so the
    // "{period.label}のみ" scope chip can narrow at once (§11-3)
    void router.push({
      path: '/search',
      query: {
        ...(q ? { q } : {}),
        ...period.urlQuery,
        ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
      },
    })
  }
}
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
      <PeriodPicker />
    </PopoverPanel>
    <LabelFilter
      v-model:open="labelsOpen"
      size="topbar"
      :model-value="period.labelColors"
      @update:model-value="period.setLabelColors($event)"
    />
    <PopoverPanel
      v-model:open="searchOpen"
      variant="anchored"
      label="検索"
    >
      <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
        <button
          type="button"
          class="filter-chip-btn filter-chip-search"
          :aria-expanded="expanded"
          :aria-controls="controls"
          :aria-label="searchAria"
          data-test="filter-search"
        >
          <AppIcon
            name="search"
            :size="16"
          />
          <span
            v-if="searchQ"
            class="chip-label-q"
          >{{ searchQ }}</span>
        </button>
      </template>
      <form
        class="search-dialog"
        @submit.prevent="run"
      >
        <input
          v-model="draft"
          type="search"
          maxlength="200"
          data-autofocus
          aria-label="検索語"
          data-test="search-dialog-input"
        >
        <!-- submit only: the form's @submit.prevent handles both the button
             click and Enter once (a @click here would double-fire run in
             real browsers — REVIEW-3 指摘2) -->
        <button
          type="submit"
          class="btn btn-small"
          data-test="search-dialog-submit"
        >
          検索
        </button>
      </form>
    </PopoverPanel>
  </div>
</template>
