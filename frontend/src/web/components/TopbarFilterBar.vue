<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import LabelToggleGroup from './LabelToggleGroup.vue'
import PeriodPicker from './PeriodPicker.vue'
import PopoverPanel from './PopoverPanel.vue'
import { useLabelsStore } from '../stores/labels'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'
import { firstString } from '../composables/receiptContext'
import { formatLabelQuery, labelAriaList, type Label, type LabelColor } from '@/shared/labels'

// The topbar center filter bar (TASK-44 §11, stage 1a; TASK-41 stage 1b;
// two chips since TASK-101): the always-on period and search chips between
// the page title and the topbar actions, each opening a small PopoverPanel
// dialog. State stays where it was — the period store for both dimensions;
// the pages re-query through their watch(period.range) /
// watch(period.labelQuery). The search chip (filter-search) is also the
// label-filter entry: its dialog is two-tier — the one-line search form on
// top, the label toggle group + 解除 below (the old topbar label chip's
// contents, applied at once through period.setLabelColors like before) —
// and a selection surfaces on the chip itself as color dots, an accent
// border and the label section of the spoken name. On /search with a
// running q the chip carries the term (clamped); everywhere else it is the
// plain entry. No props: the bar reads the store / route directly.
const period = usePeriodStore()
const session = useSessionStore()
const labelsStore = useLabelsStore()
const route = useRoute()
const router = useRouter()
const periodOpen = ref(false)
const searchOpen = ref(false)
const draft = ref('')

// The bar outlives the page swap (it sits in the topbar), so a real
// navigation closes its dialogs — the same navKey rule as the account
// menu: the feed rewrites its URL while scrolling, which is not a
// navigation.
const navKey = computed(() => (route.name === 'receipt' ? 'receipt' : route.path))
watch(navKey, () => {
  periodOpen.value = false
  searchOpen.value = false
})

/** A custom range is an explicit narrowing; month/year are the defaults. */
const periodActive = computed(() => period.mode === 'range')
const periodAria = computed(() => `期間で絞り込み: ${period.label}`)

// The search term of the running /search (null everywhere else): part of
// the chip's spoken name and the clamped label.
const searchQ = computed(() =>
  route.name === 'search' ? (firstString(route.query.q)?.trim() || null) : null,
)
// The label definitions of the selected ledger (the spoken names of the
// selected colors; the same source the receipt picker reads).
const definitions = computed<Label[]>(() => labelsStore.definitions(session.selectedLedgerId ?? -1))
const selectedLabels = computed<Label[]>(() =>
  period.labelColors.map((c) => definitions.value.find((l) => l.color === c) ?? { color: c, title: null }),
)
// The chip's spoken name: the q section and the label section joined with
// "、" (labelAriaList: the title when set, otherwise ラベルN — never a color
// name). Either section stands alone when the other is empty.
const searchAria = computed(() => {
  const parts = [
    ...(searchQ.value ? [`検索: ${searchQ.value}`] : []),
    ...(period.labelColors.length > 0 ? [`ラベル: ${labelAriaList(selectedLabels.value)}`] : []),
  ]
  return parts.length > 0 ? parts.join('、') : '検索'
})

/** Toggle one color at once (dialog stays open; the pages re-query through
 * the same period store path the old topbar chip used). */
function toggleLabel(c: LabelColor): void {
  period.setLabelColors(
    period.labelColors.includes(c) ? period.labelColors.filter((x) => x !== c) : [...period.labelColors, c],
  )
}

function clearLabels(): void {
  period.setLabelColors([])
}

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
    <PopoverPanel
      v-model:open="searchOpen"
      variant="anchored"
      label="検索"
    >
      <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
        <button
          type="button"
          class="filter-chip-btn filter-chip-search"
          :class="{ active: period.labelColors.length > 0 }"
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
          <!-- the selected labels ride the chip as bare color dots (TASK-101);
               the spoken names live in the aria-label, never as visible text -->
          <span
            v-if="period.labelColors.length > 0"
            class="label-filter-dots"
            aria-hidden="true"
          >
            <span
              v-for="c in period.labelColors"
              :key="c"
              class="label-filter-dot"
              :class="`label-${c}`"
            />
          </span>
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
      <!-- the lower tier (TASK-101): the label toggles + 解除 below the
           search form, applied at once (the dialog stays open) -->
      <div class="search-dialog-labels">
        <LabelToggleGroup
          group-label="ラベルで絞り込み"
          :selected="period.labelColors"
          :definitions="definitions"
          test-key="label-filter"
          @toggle="toggleLabel"
        />
        <div class="label-filter-foot">
          <button
            type="button"
            class="label-clear-btn"
            :disabled="period.labelColors.length === 0"
            data-test="label-filter-clear"
            @click="clearLabels"
          >
            解除
          </button>
        </div>
      </div>
    </PopoverPanel>
  </div>
</template>
