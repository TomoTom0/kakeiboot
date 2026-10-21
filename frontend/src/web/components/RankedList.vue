<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { StatsRow } from '../api/data'
import AppIcon from './AppIcon.vue'
import { formatYen } from '../composables/format'

// Ranked rows as one 44px line (TASK-75 §6-4): dot / label / share % / diff /
// amount / chevron on a single grid — the proportional bar rides the row's
// bottom edge as a 2px gradient instead of a standalone meter element. A row
// whose `to` returns a location renders as a RouterLink with the trailing
// chevron (TASK-74 §4-6); null / no `to` renders a plain non-link span — the
// aggregates without a destination of their own (その他 / 店不明) and the
// payment breakdown. Both branches share one row markup through
// `component :is` (the TASK-74 review L3 duplication fix), and every cell
// renders (empty when valueless) so the columns line up across rows.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    to?: (row: StatsRow) => RouteLocationRaw | null
    /** in-place row action for rows without a destination (no chevron) */
    select?: (row: StatsRow) => void
    colors?: boolean
  }>(),
  { to: undefined, select: undefined, colors: false },
)

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)']

const items = computed(() => {
  const max = Math.max(...props.rows.map((r) => r.value), 1)
  return props.rows.map((r, i) => ({
    label: r.labels[0] ?? '',
    value: r.value,
    share: r.share ?? null,
    diff: r.diff ?? null,
    fill: Math.max(Math.round((r.value / max) * 100), 1),
    color: props.colors ? (PALETTE[i] ?? 'var(--c-rest)') : 'var(--bb-accent)',
    to: props.to ? props.to(r) : null,
    onSelect: props.select ? () => props.select!(r) : null,
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
      <component
        :is="r.to ? RouterLink : r.onSelect ? 'button' : 'span'"
        class="ranked-row"
        :class="{ 'is-link': !!r.to || !!r.onSelect }"
        v-bind="r.to ? { to: r.to } : r.onSelect ? { type: 'button', onClick: r.onSelect } : {}"
        :data-test="`row-${r.label}`"
        :style="{ '--rank-fill': `${r.fill}%`, '--rank-color': r.color }"
      >
        <span
          class="ranked-dot"
          :style="colors ? { background: r.color } : {}"
        />
        <span
          class="ranked-label truncate"
          :title="r.label"
        >{{ r.label }}</span>
        <span class="ranked-share">{{ r.share !== null ? `${Math.round(r.share * 100)}%` : '' }}</span>
        <span
          class="ranked-diff"
          :class="r.diff && r.diff > 0 ? 'up' : r.diff && r.diff < 0 ? 'down' : ''"
        >{{ diffText(r.diff) }}</span>
        <span class="amount">{{ formatYen(r.value) }}</span>
        <AppIcon
          v-if="r.to"
          class="ranked-chevron"
          name="chevron-right"
          :size="12"
        />
      </component>
    </li>
  </ul>
</template>
