<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { AnalysisAxis, StatsRow } from '../api/data'
import AppIcon from './AppIcon.vue'
import { formatYen } from '../composables/format'
import { SERIES_REST, SERIES_SLOT_COUNT, seriesColor } from '../lib/seriesColor'

// Ranked rows as one 44px line (TASK-75 §6-4): swatch / label / share % /
// amount / chevron on a single grid — the proportional bar rides the row's
// bottom edge as a 2px inline bar instead of a standalone meter element.
// TASK-89: the donut is gone, so the per-row color dots and the `colors`
// palette prop are gone too — the inline bar is the single accent color and
// the composition ratio reads from the bar. TASK-105: the row color is back
// as the deterministic seriesColor of the row's key (`--rank-color` drives
// both the leading swatch and the bottom bar — the same color the trend
// segment paints), past the first SERIES_SLOT_COUNT rows the color drops to
// the rest grey (color belongs to the visible top set only). A row whose
// `to` returns a location renders as a RouterLink with the trailing chevron
// (TASK-74 §4-6); null / no `to` renders a plain non-link span — the
// aggregates without a destination of their own (ほか n件 rest rows / 店不明)
// and the payment breakdown. Both branches share one row markup through
// `component :is`, and every cell renders (empty when valueless) so the
// columns line up across rows.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    to?: (row: StatsRow) => RouteLocationRaw | null
    /** in-place row action for rows without a destination (no chevron) */
    select?: (row: StatsRow) => void
    /** the breakdown's axis — 'label' reads the managed label palette;
     *  unset (and every other axis) keeps the common mapping */
    axis?: AnalysisAxis
  }>(),
  { to: undefined, select: undefined, axis: undefined },
)

const items = computed(() => {
  const max = Math.max(...props.rows.map((r) => r.value), 1)
  return props.rows.map((r, i) => ({
    label: r.labels[0] ?? '',
    value: r.value,
    share: r.share ?? null,
    fill: Math.max(Math.round((r.value / max) * 100), 1),
    to: props.to ? props.to(r) : null,
    onSelect: props.select ? () => props.select!(r) : null,
    // null keys (未分類 / 店不明 / ほか) rest grey automatically; rows past the
    // palette size (a full ranking) rest grey too
    color: i < SERIES_SLOT_COUNT ? seriesColor(r.keys[0] ?? null, props.axis) : SERIES_REST,
  }))
})
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
        <span class="ranked-swatch" />
        <span
          class="ranked-label truncate"
          :title="r.label"
        >{{ r.label }}</span>
        <span class="ranked-share">{{ r.share !== null ? `${Math.round(r.share * 100)}%` : '' }}</span>
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
