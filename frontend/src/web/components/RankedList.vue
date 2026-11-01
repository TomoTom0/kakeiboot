<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { AnalysisAxis, StatsRow } from '../api/data'
import AppIcon from './AppIcon.vue'
import { formatYen } from '../composables/format'
// TASK-116: the mapping lives in shared/lib (web + widget, same palette)
import { SERIES_REST, SERIES_SLOT_COUNT, seriesColor } from '@/shared/lib/seriesColor'
import { allocateStack, type AllocatedSegment } from '@/shared/lib/stackedBars'

// Ranked rows as one 44px line (TASK-75 §6-4): swatch / label / share % /
// amount / chevron on a single grid. TASK-89: the donut is gone, so the
// per-row color dots and the `colors` palette prop are gone too. TASK-105:
// the row color is the deterministic seriesColor of the row's key
// (`--rank-color` drives the leading swatch — the same color the trend
// segment paints), past the first SERIES_SLOT_COUNT rows the color drops to
// the rest grey (color belongs to the visible top set only). A row whose
// `to` returns a location renders as a RouterLink with the trailing chevron
// (TASK-74 §4-6); null / no `to` renders a plain non-link span — the
// aggregates without a destination of their own (ほか n件 rest rows / 店不明)
// and the payment breakdown. Both branches share one row markup through
// `component :is`, and every cell renders (empty when valueless) so the
// columns line up across rows.
//
// TASK-129 (design §4-2/§4-3, web-common.row-bar-component): the row's
// proportional bar is the shared 6px DOM bar (.row-bar + .row-seg — the same
// component the week rows ride) inside an absolutely-positioned track
// spanning the row (padding included). The bar is the row's single-color
// segment at the SCREEN's absolute scale (value / scale × the measured track
// width — the old list-local max=100% gradient and its --rank-fill variable
// are gone), sized through the shared allocateStack (rule F drops the
// outline on a sub-3px bar), with no bar-specific title (the row label's
// title, the amount and the share % already carry the visible information).
// A zero-value row draws no bar element at all.
const props = withDefaults(
  defineProps<{
    rows: StatsRow[]
    /** the screen-level absolute scale (barScale of the screen's aggregated
     * bar outer amounts, TASK-129 web-common.bar-scale) — the bar length is
     * value / scale × track */
    scale: number
    to?: (row: StatsRow) => RouteLocationRaw | null
    /** in-place row action for rows without a destination (no chevron) */
    select?: (row: StatsRow) => void
    /** the breakdown's axis — 'label' reads the managed label palette;
     *  unset (and every other axis) keeps the common mapping */
    axis?: AnalysisAxis
  }>(),
  { to: undefined, select: undefined, axis: undefined },
)

// TASK-123 §4-5 rule E: the allocation works in px, so the track's real
// width feeds it (measured at mount / on resize; jsdom keeps 0 and the bar
// renders at size 0 with its color until then — the same pattern WeekRows
// uses)
const rowsEl = ref<HTMLElement | null>(null)
const trackW = ref(0)
let ro: ResizeObserver | null = null
function measure(): void {
  const track = rowsEl.value?.querySelector('.ranked-bar-track') ?? null
  trackW.value = track ? track.clientWidth : 0
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(measure)
  if (rowsEl.value) ro.observe(rowsEl.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

const items = computed(() =>
  props.rows.map((r, i) => {
    // null keys (未分類 / 店不明 / ほか) rest grey automatically; rows past the
    // palette size (a full ranking) rest grey too
    const color = i < SERIES_SLOT_COUNT ? seriesColor(r.keys[0] ?? null, props.axis) : SERIES_REST
    // the single-segment DOM bar at the screen's absolute scale; a
    // zero-value row keeps no bar element at all
    const width = (r.value / props.scale) * trackW.value
    const segs: AllocatedSegment[] =
      r.value > 0 ? allocateStack([{ label: r.labels[0] ?? '', value: r.value, color }], width) : []
    return {
      label: r.labels[0] ?? '',
      value: r.value,
      share: r.share ?? null,
      to: props.to ? props.to(r) : null,
      // the select branch keeps the null-key aggregate rows inert (TASK-65:
      // ほか / 支払方法不明 press to nothing — they render as plain spans)
      onSelect: props.select && (r.keys[0] ?? null) !== null ? () => props.select!(r) : null,
      color,
      bar: segs.length > 0 ? { width, segs } : null,
    }
  }),
)
</script>

<template>
  <ul
    ref="rowsEl"
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
        :style="{ '--rank-color': r.color }"
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
        <span class="ranked-bar-track">
          <span
            v-if="r.bar"
            class="row-bar"
            :style="{ width: `${r.bar.width}px` }"
          >
            <span
              v-for="(s, i) in r.bar.segs"
              :key="i"
              class="row-seg"
              :style="{ width: `${s.size}px`, background: s.color, border: s.outline ? undefined : 'none' }"
            />
          </span>
        </span>
      </component>
    </li>
  </ul>
</template>
