<script setup lang="ts">
import { ref } from 'vue'
import { usePeriodStore, type PeriodMode } from '../stores/period'
import AppIcon from './AppIcon.vue'

// Period selector shared by the dashboard-style screens: month / year with
// prev-next, or a custom date range (applied explicitly).
const period = usePeriodStore()
const MODES: { id: PeriodMode; label: string }[] = [
  { id: 'month', label: '月' },
  { id: 'year', label: '年' },
  { id: 'range', label: '期間' },
]
const from = ref(period.from)
const to = ref(period.to)

function apply(): void {
  if (!from.value || !to.value || from.value > to.value) return
  period.from = from.value
  period.to = to.value
}
</script>

<template>
  <div class="period-bar">
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
      >
        表示
      </button>
    </form>
  </div>
</template>
