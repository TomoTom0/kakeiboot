<script setup lang="ts">
import { computed } from 'vue'
import type { StatsRow } from '../api/data'
import { formatYen } from '../composables/format'

// Ranked rows with a bar, share and change vs. the compare period. Rows are
// selectable (emits the label) unless listed in `inert`.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    selected?: string | null
    compareLabel?: string
    inert?: string[]
    colors?: boolean
  }>(),
  { selected: null, compareLabel: '前月', inert: () => [], colors: false },
)
const emit = defineEmits<{ select: [label: string] }>()

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
      <button
        class="ranked-row"
        :class="{ clickable: !inert.includes(r.label), selected: selected === r.label }"
        :disabled="inert.includes(r.label)"
        :aria-pressed="selected === r.label"
        :data-test="`row-${r.label}`"
        @click="emit('select', r.label)"
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
      </button>
    </li>
  </ul>
</template>
