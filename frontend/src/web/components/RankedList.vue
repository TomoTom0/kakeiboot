<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import type { AnalysisAxis, StatsRow } from '../api/data'
import AppearList from './AppearList.vue'
import DataRow from './DataRow.vue'
import RowBar from './RowBar.vue'
import TweenYen from './TweenYen.vue'
import { topItemsText } from '../composables/format'
// TASK-116: the mapping lives in shared/lib (web + widget, same palette)
import { SERIES_REST, SERIES_SLOT_COUNT, seriesColor } from '@/shared/lib/seriesColor'
import { allocateStack, type AllocatedSegment } from '@/shared/lib/stackedBars'

// TASK-167 D-1/D-2/D-3: the ranked rows ride the ONE shared two-line row
// grammar (DataRow: .data-row > .row-main + .row-sub). The main line keeps
// the leading 12px series swatch (TASK-105) and the axis label; the sub line
// carries the axis value's derived representative items (top_items, amount
// desc k=2) with the share % as the secondary figure — the client-built rest
// rows carry no top items and render no sub line at all. The TASK-129
// proportional bar stays the shared DOM bar (.row-bar + .row-seg) inside the
// absolutely-positioned track spanning the row; the old five-column
// one-line grid is gone.
//
// TASK-162 §1-11: the absolute-tick overlay is GONE from the ranked list
// (the Home breakdown became the ONE bar — BreakdownBar owns the graduation
// now). The % share sub figure rides each row's own share field (PR#4
// review 5: the `share: false` prop path was dead — no call site passed it,
// so the prop and its no-share class are gone).
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
    /** the value epoch (the pane's committed key + the period store's
     * committedEpoch): a change landing with a new epoch is a period
     * commit — the amounts land at once instead of counting over */
    swapKey?: string
  }>(),
  { to: undefined, select: undefined, axis: undefined, swapKey: undefined },
)

// TASK-123 §4-5 rule E: the allocation works in px, so the track's real
// width feeds it (measured at mount / on resize; jsdom keeps 0 and the bar
// renders at size 0 with its color until then — the same pattern WeekRows
// uses). The ref rides the AppearList carrier (TASK-161 §2-2: the rows
// enter/leave/move through the shared bb-appear grammar), so the root ul is
// the instance's $el
const rowsEl = ref<ComponentPublicInstance | null>(null)
const trackW = ref(0)
let ro: ResizeObserver | null = null
function measure(): void {
  const root = rowsEl.value?.$el
  const track = root instanceof HTMLElement ? (root.querySelector('.ranked-bar-track') ?? null) : null
  trackW.value = track ? track.clientWidth : 0
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(measure)
  const root = rowsEl.value?.$el
  if (root instanceof HTMLElement) ro.observe(root)
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
      // TASK-167 D-3: the derived representative items of the axis value
      // (empty on the client-built rest rows)
      top: topItemsText(r.top_items),
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
  <AppearList
    ref="rowsEl"
    class="ranked"
    data-test="rows"
    instant-leave
  >
    <li
      v-for="r in items"
      :key="r.label"
    >
      <DataRow
        class="ranked-row"
        :class="{ 'is-link': !!r.to || !!r.onSelect }"
        :to="r.to"
        :on-select="r.onSelect"
        :data-test="`row-${r.label}`"
        :style="{ '--rank-color': r.color }"
        :chevron="!!r.to"
      >
        <template #main>
          <span class="ranked-swatch" />
          <span
            class="ranked-label truncate"
            :title="r.label"
          >{{ r.label }}</span>
        </template>
        <template #amount>
          <TweenYen :value="r.value" :swap-key="props.swapKey" />
        </template>
        <template
          v-if="r.top"
          #sub
        >
          <span class="row-items truncate">{{ r.top }}</span>
        </template>
        <template
          v-if="r.share !== null"
          #figure
        >
          <span class="ranked-share">{{ `${Math.round(r.share * 100)}%` }}</span>
        </template>
        <template
          v-if="r.bar"
          #bar
        >
          <span class="ranked-bar-track">
            <RowBar
              :width="r.bar.width"
              :segs="r.bar.segs"
            />
          </span>
        </template>
      </DataRow>
    </li>
  </AppearList>
</template>
