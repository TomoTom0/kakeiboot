<script setup lang="ts">
// The trend chart's window chrome (TASK-104): the prev/next chevron pair
// around TrendBars, in PeriodPicker's button vocabulary (.icon-btn +
// chevron + aria-label, resized to the 44px shared tap-target floor). A
// dedicated wrapper (the UI rule: one visual component per expression) —
// TrendBars stays a pure pass-through and never knows the window moves.
// TASK-115 (design: tmp/tasks/tm-115/design_trend-continuous-window.md
// §3-3): the Transition/:key out-in swap is gone — the window move keeps
// ONE graph on screen. The composable's slide state concatenates the old
// and new windows; this wrapper measures the committed track BEFORE the
// concatenated props land, pins the concatenated grid to the measured
// per-bar width (bars never shrink mid-slide), parks .bars/.axis-labels on
// the old window without a transition and then translates them as one
// viewport (the initial transform lands under .no-anim, the 220ms move
// under .is-sliding). The .bars row's transitionend reports the slide done
// (finish-slide; the page trims through the composable) with a 270ms
// watchdog backing the event, and the trim resets the transform and the
// pinned widths in one motionless step.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import TrendBars, { type StackedBar } from './TrendBars.vue'
import type { SlideState } from '../composables/trendWindow'
import type { TrendGranularity } from '../composables/trend'

// props: nav (month/year only — false hides the pair) / canPrev / canNext /
// windowKey (the v-if gate — null until the first response) / slide (the
// composable's concatenation, non-null while the viewport should move)
// plus TrendBars' pass-through (stacked / granularity / span / current —
// this `span` is the bars' own display range, not the composable's
// page-turn step)
const props = withDefaults(
  defineProps<{
    nav: boolean
    canPrev: boolean
    canNext: boolean
    /** the committed window's identity — null until the first response:
     *  the v-if gate (TASK-108 §1-4) */
    windowKey: string | null
    /** the slide state (TASK-115 §3-1) — non-null while the concatenated
     *  pair translates; null (or absent) trims instantly */
    slide?: SlideState | null
    stacked: StackedBar[]
    granularity?: TrendGranularity
    span?: [string, string] | null
    current?: string | null
  }>(),
  { slide: null, granularity: 'month', span: null, current: null },
)
const emit = defineEmits<{ prev: []; next: []; select: [key: string]; 'finish-slide': [] }>()

const root = ref<HTMLElement | null>(null)
/** true while the transform parks on its initial value or resets — the
 *  .no-anim class keeps those steps transitionless */
const noAnim = ref(false)

// TASK-158 (web-common.content-swap #14改訂): the windowKey-keyed chart fade
// is REMOVED. Its designed fire site — a windowKey change with no pane swap —
// does not exist in the real wiring: a window move rides the slide, a
// label/ledger switch keeps the key (the window is range-derived), the
// AxisDetail first commit lands before this component mounts (the pages'
// v-if on win.result), and every mode/range change bumps the pane's
// committedKey on all four screens — the pane's ContentSwap transition is
// the chart's single motion. The keyed remount instead faded visibly in
// BOTH race orders of a period step (this chart's windowKey commits
// independently of the page load: before the pane, or after it settled) —
// the reported 「グラフを移動すると色が消える」. A windowKey change now
// swaps the chart's content in place: TrendBars is never re-keyed (the
// slide's DOM reuse holds on every path), the v-if gate alone waits for the
// first window.
let watchdog = 0
let reported = false
let attached: HTMLElement | null = null
/** every slide start, trim and unmount bumps this (PR#2 review): each
 *  queued callback (the nextTick pin/park and the move's three rAF hops)
 *  captures the generation it was queued under and stops once it goes stale
 *  — an interrupted slide's queued frames must never paint their target
 *  transform onto the reset or replaced chart */
let generation = 0
/** the current pin's own measurements (PR#2 review): a re-press while a
 *  slide still runs replaces the slide before the trim's cleanup reaches
 *  the DOM, so the fresh measure would read the still-pinned 2-window grid
 *  and solve a double-width cell. While the pin is on the DOM the slide
 *  reuses the recorded cell instead; the trim drops it (the next slide
 *  re-measures, so a resize between slides re-pins at the true geometry) */
let pinned: { one: number; gap: number; wrapWidth: number } | null = null

const wrapEl = (): HTMLElement | null => root.value?.querySelector('.trend-wrap') ?? null
const barsEl = (): HTMLElement | null => root.value?.querySelector('.bars') ?? null
const axisEl = (): HTMLElement | null => root.value?.querySelector('.axis-labels') ?? null

/** the slide's report: idempotent (the transitionend and the watchdog can
 *  race) — the page trims through the composable's finishSlide */
function report(): void {
  if (reported) return
  reported = true
  clearWatchdog()
  emit('finish-slide')
}
function clearWatchdog(): void {
  if (watchdog !== 0) {
    clearTimeout(watchdog)
    watchdog = 0
  }
}

/** the .bars row is the transform's single source (design §3-3): only its
 *  transitionend (propertyName=transform) finishes the move — the
 *  .axis-labels row rides the same value and never reports */
function onEnd(e: TransitionEvent): void {
  if (e.propertyName !== 'transform') return
  if (!(e.target instanceof HTMLElement) || !e.target.classList.contains('bars')) return
  report()
}

function attach(): void {
  const bars = barsEl()
  if (bars === attached) return
  attached?.removeEventListener('transitionend', onEnd)
  attached = bars
  bars?.addEventListener('transitionend', onEnd)
}

/** the bars' gap in px (0.25rem everywhere — read from the DOM, 4 as the
 *  no-layout fallback) */
function gapPx(el: HTMLElement | null): number {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 4
  const v = Number.parseFloat(window.getComputedStyle(el).columnGap || window.getComputedStyle(el).gap)
  return Number.isFinite(v) ? v : 4
}

/** pin the concatenated track (design §3-3): the committed window's
 *  measured width fixes one track cell and the wrap's width, so the 2N-bar
 *  grid never re-solves its minmax tracks (bars do not shrink) and the
 *  2-window overflow stays clipped inside the wrap (no phantom scroll) */
function pinTrack(n: number, one: number, gap: number, wrapWidth: number): void {
  const cols = `repeat(${2 * n}, ${one}px)`
  const width = `${2 * n * one + (2 * n - 1) * gap}px`
  for (const el of [barsEl(), axisEl()]) {
    if (!el) continue
    el.style.gridTemplateColumns = cols
    el.style.width = width
  }
  // the wrap pin completes the .bars/.axis-labels pin above: the
  // stylesheet's .trend-wrap{width:fit-content} would ride the now 2N-wide
  // pinned .bars and stretch the wrap itself (.plot / gridline) to the
  // concatenated width — the measured one-window width keeps it put, with
  // .is-sliding{overflow:hidden} clipping the overflow
  const wrap = wrapEl()
  if (wrap && wrapWidth > 0) {
    wrap.style.width = `${wrapWidth}px`
    wrap.style.minWidth = `${wrapWidth}px`
  }
}

/** the concatenated array's index N (the boundary, either direction's
 *  right-window head) — the exact one-window travel in measured px */
function boundary(bars: HTMLElement, n: number): number {
  const bar = bars.children[n] as HTMLElement | undefined
  return bar ? bar.offsetLeft : 0
}

function setTransform(x: number): void {
  const t = `translateX(${x}px)`
  const bars = barsEl()
  const axis = axisEl()
  if (bars) bars.style.transform = t
  if (axis) axis.style.transform = t
}

// The slide lifecycle. The watch fires (flush 'pre') BEFORE the
// concatenated props reach the DOM: the committed window's track is still
// laid out there — measure it. After nextTick (the concatenation is on
// screen) pin the track, park the viewport on the old window (noAnim keeps
// the initial transform transitionless) and then move: two rAFs, so the
// .no-anim class is long off the DOM before the target transform lands
// under .is-sliding. The trim (slide=null) clears the transform and the
// pins in the same motionless step.
//
// PR#2 review hardening: (1) a re-press while a slide still runs replaces
// the slide in the same tick, so this watcher never sees the intermediate
// trim and the DOM still wears the previous pin — the recorded cell (not a
// fresh offsetWidth read, which would measure the pinned 2-window grid)
// keeps the re-slide at the committed geometry; (2) every queued callback
// re-checks the generation it was queued under, so a slide interrupted by a
// trim, a replacement or the unmount leaves no queued frame behind.
watch(
  () => props.slide,
  (slide) => {
    generation++
    const gen = generation
    clearWatchdog()
    noAnim.value = true
    if (!slide) {
      pinned = null
      void nextTick(() => {
        if (gen !== generation) return
        for (const el of [barsEl(), axisEl()]) {
          if (!el) continue
          el.style.transform = ''
          el.style.gridTemplateColumns = ''
          el.style.width = ''
        }
        const wrap = wrapEl()
        if (wrap) {
          wrap.style.width = ''
          wrap.style.minWidth = ''
        }
        requestAnimationFrame(() => {
          if (gen !== generation) return
          noAnim.value = false
        })
      })
      return
    }
    const n = Math.floor(slide.bars.length / 2)
    const barsNow = barsEl()
    // the previous pin still on the DOM (a same-tick replacement slid past
    // the trim's cleanup): reuse its recorded measurements
    const reuse = pinned !== null && barsNow !== null && barsNow.style.gridTemplateColumns !== '' ? pinned : null
    const gap = reuse?.gap ?? gapPx(barsNow)
    const wrapWidth = reuse?.wrapWidth ?? wrapEl()?.offsetWidth ?? 0
    const width = reuse === null ? (barsNow?.offsetWidth ?? 0) : 0
    // one track cell = (measured width - the N-1 gaps) / N; a non-positive
    // measurement (no layout in jsdom) keeps the minmax resolution
    const one = reuse?.one ?? (width > 0 && n > 0 ? (width - (n - 1) * gap) / n : 0)
    if (reuse === null && one > 0) pinned = { one, gap, wrapWidth }
    const dir = slide.dir
    void nextTick(() => {
      if (gen !== generation) return
      const bars = barsEl()
      if (!bars) return
      reported = false
      if (one > 0) pinTrack(n, one, gap, wrapWidth)
      const shift = boundary(bars, n)
      setTransform(dir === 'prev' ? -shift : 0)
      requestAnimationFrame(() => {
        if (gen !== generation) return
        requestAnimationFrame(() => {
          if (gen !== generation) return
          noAnim.value = false
          requestAnimationFrame(() => {
            if (gen !== generation) return
            setTransform(dir === 'prev' ? 0 : -shift)
            clearWatchdog()
            watchdog = window.setTimeout(report, 270)
          })
        })
      })
    })
  },
)

onMounted(attach)
// TrendBars appears once the first windowKey commits — bind the listener then
watch(
  () => props.windowKey,
  () => {
    void nextTick(attach)
  },
)
onBeforeUnmount(() => {
  // invalidates the slide's queued rAF hops along with the watchdog
  generation++
  attached?.removeEventListener('transitionend', onEnd)
  attached = null
  clearWatchdog()
})
</script>

<template>
  <div
    ref="root"
    class="trend-window"
  >
    <button
      v-if="nav"
      class="icon-btn trend-nav"
      type="button"
      aria-label="前の範囲"
      title="前の範囲"
      data-test="trend-prev"
      :disabled="!canPrev"
      @click="emit('prev')"
    >
      <AppIcon name="chevron-left" />
    </button>
    <TrendBars
      v-if="windowKey"
      :stacked="stacked"
      :granularity="granularity"
      :span="span"
      :current="current"
      :axis-windows="slide ? slide.axisWindows : null"
      :sliding="slide != null"
      :no-anim="noAnim"
      @select="emit('select', $event)"
    />
    <button
      v-if="nav"
      class="icon-btn trend-nav"
      type="button"
      aria-label="次の範囲"
      title="次の範囲"
      data-test="trend-next"
      :disabled="!canNext"
      @click="emit('next')"
    >
      <AppIcon name="chevron-right" />
    </button>
  </div>
</template>
