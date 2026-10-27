<script setup lang="ts">
import { ref } from 'vue'
import { usePeriodStore, type PeriodMode } from '../stores/period'
import AppIcon from './AppIcon.vue'

// The period dialog's content (TASK-44 §11-3/11-6): the former in-page
// PeriodBar's pieces — the week / month / year / Custom tabs, the prev-next
// step and the explicit "表示" range form — carried by the topbar period
// chip's PopoverPanel. Tab switches and steps apply at once (the dialog
// stays open; pages re-query through their existing watch(period.range)); a
// typed range only commits on the 表示 button. TASK-90/91 (real-device):
// the tabs run in natural ascending order 週｜月｜年 and the free-form
// fourth tab says Custom.
const period = usePeriodStore()
const MODES: { id: PeriodMode; label: string }[] = [
  { id: 'week', label: '週' },
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
  { id: 'range', label: 'Custom' },
]
const from = ref(period.from)
const to = ref(period.to)

function apply(): void {
  if (!from.value || !to.value || from.value > to.value) return
  period.from = from.value
  period.to = to.value
}
// The button rides both paths: its own click (jsdom never synthesizes the
// form submission from a button click) and the form's submit event (the
// Enter key in a date input). The double run in a real browser is
// idempotent — the second apply writes the same strings.

</script>

<template>
  <div class="period-picker">
    <div
      class="tabs"
      role="tablist"
      aria-label="期間の単位"
    >
      <button
        v-for="m in MODES"
        :key="m.id"
        class="tab"
        :class="{ active: period.mode === m.id }"
        role="tab"
        :aria-selected="period.mode === m.id"
        :data-test="`mode-${m.id}`"
        @click="period.mode = m.id"
      >
        {{ m.label }}
      </button>
    </div>
    <div
      v-if="period.mode !== 'range'"
      class="period-step"
    >
      <button
        class="icon-btn"
        aria-label="前へ"
        data-test="period-prev"
        @click="period.step(-1)"
      >
        <AppIcon name="chevron-left" />
      </button>
      <strong data-test="period">{{ period.label }}</strong>
      <button
        class="icon-btn"
        aria-label="次へ"
        data-test="period-next"
        :disabled="!period.canNext"
        @click="period.step(1)"
      >
        <AppIcon name="chevron-right" />
      </button>
    </div>
    <form
      v-else
      class="period-range"
      @submit.prevent="apply"
    >
      <input
        v-model="from"
        type="date"
        aria-label="開始日"
        data-test="range-from"
      >
      <span class="muted">〜</span>
      <input
        v-model="to"
        type="date"
        aria-label="終了日"
        data-test="range-to"
      >
      <button
        class="btn btn-small"
        type="submit"
        data-test="range-apply"
        @click="apply"
      >
        表示
      </button>
    </form>
  </div>
</template>
