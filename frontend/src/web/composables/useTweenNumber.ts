// The amount tween (TASK-161 §2-2, design: tmp/tasks/tm-161/design_period_ui.md
// v2 — web-common.period-move-voice): a period move no longer remounts the
// pane, so a committed amount renders as the SAME element's value update —
// this composable eases the displayed number over ~300 rAF frames
// (tabular-nums keeps the digits column-steady, so the roll reads as a
// counter, never a layout shift). The APPEARANCE is the mount itself: every
// caller mounts behind a v-if on the committed data, so `ref(source())`
// lands the first value at once (a fresh pane never counts up from zero)
// and the pane's own appear fade carries the entry — the composable holds
// no appearance special case (review PR#4 #1: a firstChange exemption
// silenced the pane's FIRST PERIOD move instead, since the watch's first
// firing is that move, not a load appearance). Every change after mount
// tweens — the first one included, a collapse to (or a rise from) 0
// included, mid-tween interruptions re-target from the DISPLAYED value so a
// superseded amount can never come back. A change that bumps the pane's
// committed key is a content swap (that fade carries it) and lands at once;
// a reduced-motion preference settles everything instantly.
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import { prefersReducedMotion } from './reducedMotion'

/** `source` — a getter of the committed amount; the returned ref holds the
 *  displayed (possibly mid-tween) integer. The mount-time value (source()
 *  at setup) IS the appearance — instant, no tween. The tween cancels
 *  itself when the scope dies (an unmounted row never leaks a frame).
 *  `swapKey` — the pane's committed identity: a change that rides a key
 *  bump is a CONTENT swap (the pane's own fade carries it — the number
 *  lands at once); the tween serves the key-stable changes alone (an
 *  in-period value change — a period commit bumps the callers' keys
 *  like any other content change and lands at once). */
export function useTweenNumber(source: () => number, opts?: { duration?: number; swapKey?: () => string }): Ref<number> {
  const duration = opts?.duration ?? 300
  const shown = ref(source())
  let raf = 0
  watch(
    [source, opts?.swapKey ?? (() => '')],
    ([to], [from, prevKey]) => {
      // the previous tween's frames die FIRST on every path: an instant
      // landing that returned before the cancel left the old chain running,
      // resurrecting the superseded amount after the settle (review 高1)
      cancelAnimationFrame(raf)
      const paneSwap = opts?.swapKey !== undefined && opts.swapKey() !== prevKey
      if (!Number.isFinite(to) || !Number.isFinite(from) || to === from || paneSwap || prefersReducedMotion()) {
        shown.value = to
        return
      }
      // the clock reads performance.now() INSIDE the frame (the rAF callback's
      // timestamp rides a different clock in some environments — jsdom's is not
      // comparable with performance.now(), which once solved a negative
      // progress and wildly out-of-range mid values). The interpolation starts
      // at the DISPLAYED value — a mid-tween re-target continues from what is
      // on screen, never from a source the display already left behind
      const startShown = shown.value
      const start = performance.now()
      const step = (): void => {
        const p = Math.min(1, (performance.now() - start) / duration)
        const eased = 1 - Math.pow(1 - p, 3)
        shown.value = Math.round(startShown + (to - startShown) * eased)
        if (p < 1) raf = requestAnimationFrame(step)
      }
      raf = requestAnimationFrame(step)
    },
  )
  onScopeDispose(() => cancelAnimationFrame(raf))
  return shown
}
