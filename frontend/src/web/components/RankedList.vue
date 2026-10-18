<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { StatsRow } from '../api/data'
import AppIcon from './AppIcon.vue'
import { formatYen } from '../composables/format'

// Ranked rows with a bar, share and change vs. the compare period. A row
// whose `to` returns a location renders as a RouterLink with a trailing
// chevron (TASK-74 §4-6); null / no `to` renders a plain non-link span —
// the aggregates without a destination of their own (その他 / 店不明) and
// the payment breakdown. The row keeps its 3-band structure (head / meter /
// sub); TASK-75 reworks the row layout on top of this DOM.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    compareLabel?: string
    to?: (row: StatsRow) => RouteLocationRaw | null
    colors?: boolean
  }>(),
  { compareLabel: '前月', to: undefined, colors: false },
)

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)']

const items = computed(() => {
  const max = Math.max(...props.rows.map((r) => r.value), 1)
  return props.rows.map((r, i) => ({
    label: r.labels[0] ?? '',
    value: r.value,
    share: r.share ?? null,
    diff: r.diff ?? null,
    width: Math.max(Math.round((r.value / max) * 100), 1),
    color: props.colors ? (PALETTE[i] ?? 'var(--c-rest)') : 'var(--bb-accent)',
    to: props.to ? props.to(r) : null,
  }))
})

function diffText(d: number | null): string {
  if (d === null || d === 0) return ''
  return `${d > 0 ? '+' : '−'}${formatYen(Math.abs(d))}`
}
</script>

<template>
  <ul
    class="ranked"
    data-test="rows"
  >
    <li
      v-for="r in items"
      :key="r.label"
    >
      <RouterLink
        v-if="r.to"
        class="ranked-row is-link"
        :to="r.to"
        :data-test="`row-${r.label}`"
      >
        <span class="ranked-head">
          <span
            class="ranked-label truncate"
            :title="r.label"
          >
            <span
              v-if="colors"
              class="dot"
              :style="{ background: r.color }"
            />{{ r.label }}</span>
          <span class="amount">{{ formatYen(r.value) }}</span>
        </span>
        <span class="meter"><span :style="{ width: `${r.width}%`, background: r.color }" /></span>
        <span class="ranked-sub muted small">
          <span v-if="r.share !== null">{{ Math.round(r.share * 100) }}%</span>
          <span
            v-if="diffText(r.diff)"
            :class="r.diff! > 0 ? 'up' : 'down'"
          >{{ compareLabel }}から {{ diffText(r.diff) }}</span>
        </span>
        <AppIcon
          class="ranked-chevron"
          name="chevron-right"
          :size="12"
        />
      </RouterLink>
      <span
        v-else
        class="ranked-row"
        :data-test="`row-${r.label}`"
      >
        <span class="ranked-head">
          <span
            class="ranked-label truncate"
            :title="r.label"
          >
            <span
              v-if="colors"
              class="dot"
              :style="{ background: r.color }"
            />{{ r.label }}</span>
          <span class="amount">{{ formatYen(r.value) }}</span>
        </span>
        <span class="meter"><span :style="{ width: `${r.width}%`, background: r.color }" /></span>
        <span class="ranked-sub muted small">
          <span v-if="r.share !== null">{{ Math.round(r.share * 100) }}%</span>
          <span
            v-if="diffText(r.diff)"
            :class="r.diff! > 0 ? 'up' : 'down'"
          >{{ compareLabel }}から {{ diffText(r.diff) }}</span>
        </span>
      </span>
    </li>
  </ul>
</template>
