<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import type { StatsRow } from '../api/data'
import RowBar from './RowBar.vue'
import { axisTicksOf, type AxisTick } from '@/shared/lib/axisTicks'
import { allocateStack, stackedOfRows, type AllocatedSegment } from '@/shared/lib/stackedBars'
import { SERIES_REST } from '@/shared/lib/seriesColor'
import { formatYen } from '../composables/format'

// The Home breakdown's ONE stacked bar (TASK-162 §1, design: tmp/tasks/
// tm-162/design_breakdown_stack.md v2 — web-home.breakdown-absolute-ticks):
// the full-width track + ONE right-growing stacked bar whose segments ARE the
// pressable category links (RowBar under segSelect — §1-9), the series name
// painted inside each segment (§1-4, RowBar's inBarLabels), and the absolute
// graduation overlaid on the track (axisTicksOf's 5 steps — the CUMULATIVE
// amount axis: each segment's right end reads the amount up to that category,
// §1-5). The assembly is the pure stackedOfRows (top-5 + the「ほか」residual
// closing against the TOTAL, §1-2/§1-6); the bar's own length is
// total / screenScale × the measured track (§1-3).
const props = withDefaults(
  defineProps<{
    /** the analysis rows, amount-desc (the caller sorts) */
    rows: StatsRow[]
    /** the period total (totals.amount) — the residual closes against it */
    total: number
    /** the screen's ONE absolute scale (barScale aggregate, §1-3) */
    scale: number
    /** the count of rows the limit-50 fetch truncated (analysis.truncated_
     *  rows — §1-6: the rest count merges them too) */
    truncated?: number
    /** a segment's destination: /axes/category/<key> with the period context */
    to: (key: string | number | null, label: string) => RouteLocationRaw | null
  }>(),
  { truncated: 0 },
)

const router = useRouter()

// the track's measured width feeds the allocation (mount / resize; jsdom
// keeps 0 — the segments render at size 0 with their titles and colors until
// then, the RowBar/RankedList measuring pattern)
const trackEl = ref<HTMLElement | null>(null)
const trackW = ref(0)
let ro: ResizeObserver | null = null
function measure(): void {
  trackW.value = trackEl.value ? trackEl.value.clientWidth : 0
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(measure)
  if (trackEl.value) ro.observe(trackEl.value)
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

/** the top-5 +「ほか」assembly (§1-6): the residual's value closes against
 *  the TOTAL and its count is the number of merged categories (tail + the
 *  5% folds + the truncated rows the fetch never returned) */
const assembly = computed(() => stackedOfRows(props.rows, props.total, props.truncated))

/** the bar's own px length: the total over the screen's scale (§1-3) */
const barW = computed(() => (props.scale > 0 ? (props.total / props.scale) * trackW.value : 0))

/** the allocated composition: the kept series + the residual as the closing
 *  rest segment (the default rules — the horizontal bar's minimums; the
 *  dimension folds merge into the rest segment's value) */
const allocated = computed<AllocatedSegment[]>(() => {
  const segs = [...assembly.value.segments]
  if (assembly.value.rest.value > 0) {
    segs.push({ label: 'ほか', value: assembly.value.rest.value, color: SERIES_REST, key: null, rest: true })
  }
  return allocateStack(segs, barW.value)
})

/** the rest title's merged-category count (§1-6): the assembly's own count
 *  PLUS every series the dimension allocation folded into the rest (the
 *  folds the pure helper cannot see — allocateStack merges the values into
 *  the rest segment; this adds their categories to the count) */
const restCount = computed(() => {
  const folded = assembly.value.segments.length - allocated.value.filter((s) => s.rest !== true).length
  return assembly.value.rest.count + Math.max(folded, 0)
})

/** the hover/aria title「名称 金額（n%）」— the residual's adds the merged
 *  category count (§1-6: 「ほか n件・計xx円（p%）」) */
function segTitle(s: AllocatedSegment): string {
  const sum = allocated.value.reduce((a, x) => a + x.value, 0)
  const pct = sum > 0 ? Math.round((s.value / sum) * 100) : 0
  const count = s.rest === true ? ` ${restCount.value}件・計` : ' '
  return `${s.label}${count}${formatYen(s.value)}（${pct}%）`
}

/** the segment press (§1-7): the series key routes to the AxisDetail with
 *  the period context; the residual never presses (RowBar keeps it a span) */
function segSelect(s: AllocatedSegment): void {
  const loc = props.to(s.key ?? null, s.label)
  if (loc) void router.push(loc)
}

/** the cumulative-amount graduation (§1-5): axisTicksOf's ladder over the
 *  screen scale — the ratio-0 baseline keeps its line alone */
const ticks = computed<AxisTick[]>(() => axisTicksOf(props.scale))
</script>

<template>
  <div
    ref="trackEl"
    class="breakdown-track"
    data-test="breakdown-track"
  >
    <div
      class="breakdown-ticks"
      aria-hidden="true"
    >
      <span
        v-for="(t, i) in ticks"
        :key="t.ratio"
        class="breakdown-tick"
        :data-test="`breakdown-tick-${i}`"
        :style="{ left: `${t.ratio * 100}%` }"
      ><span
        v-if="t.ratio > 0"
        class="breakdown-tick-val"
      >{{ t.label }}</span></span>
    </div>
    <RowBar
      data-test="breakdown-bar"
      :width="barW"
      :segs="allocated"
      :seg-title="segTitle"
      in-bar-labels
      :seg-select="segSelect"
      seg-test="breakdown-seg"
    />
  </div>
</template>
