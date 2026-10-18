// Navigation direction for the shell page transition (TASK-74 §4-3).
// The direction is decided in router.afterEach by comparing
// window.history.state.position — the number vue-router keeps in the history
// state — with the previous value seen in this module. No catalog lookups and
// no history.listen: afterEach runs before the DOM patch of the same tick, so
// the Transition name is already the incoming navigation's when the pages
// swap (D28 review 指摘8).
import { ref, type Ref } from 'vue'
import type { NavigationFailure, RouteLocationNormalized } from 'vue-router'

export type NavDirection = 'forward' | 'back' | 'none'
export type NavKind = 'push' | 'pop' | 'replace'

/** Direction of the latest navigation; App.vue maps it to the transition name. */
export const direction: Ref<NavDirection> = ref('none')

/** Kind of the latest navigation from the same position comparison: 'push'
 * (position up), 'pop' (down) or 'replace' (unchanged); null before the
 * first observation or when the position is unreadable. The router's
 * scrollBehavior reads this on its next-tick pass — afterEach has already
 * run by then — so a replace (the feed's scrolling id rewrite, a chip ×, a
 * period change) never scrolls the viewport (D28 §4-3 rule 1). */
export const navKind: Ref<NavKind | null> = ref(null)

// One-shot intent (TASK-74 §3-2 案B): PageHead's ‹ sets 'back' right before
// its push — a push to the parent must slide back even though the history
// position moves forward. updateDirection consumes the flag on every path it
// can take; a flag left over by an aborted navigation is consumed by the next
// one (no state or URL effect beyond one slide direction).
let navIntent: 'back' | null = null

export function setNavIntent(intent: 'back' | null): void {
  navIntent = intent
}

/** Scroll top parked by scrollBehavior until the incoming page is ready. */
export const pendingRestore: Ref<number | null> = ref(null)

let lastPosition: number | null = null

function historyPosition(): number | null {
  const state = window.history.state as { position?: unknown } | null
  return typeof state?.position === 'number' ? state.position : null
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * The D28 §4-3 rules:
 * 1. a failed navigation, or an unchanged position (a replace — the feed's
 *    scrolling id rewrite, a chip ×, a period change) → none
 * 2. the position went down (browser back) → back
 * 3. the position went up (a push): the ‹ intent or a smaller to.depth →
 *    back / a larger to.depth → forward / same depth both 1 (tab switches) →
 *    none / same depth >= 2 (cross links between details) → forward
 * 4. an unchanged position with a different name (a replace to another route,
 *    e.g. the ledger switch feed → list) → none
 * Unset depths (settings / manage / public screens) match none of the depth
 * comparisons and stay direction-less; so does the first observation.
 */
export function updateDirection(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
  failure?: NavigationFailure | void,
): void {
  const position = historyPosition()
  const previous = lastPosition
  lastPosition = position
  const intent = navIntent
  navIntent = null
  navKind.value =
    previous === null || position === null
      ? null
      : position > previous
        ? 'push'
        : position < previous
          ? 'pop'
          : 'replace'
  let next: NavDirection = 'none'
  if (!failure && previous !== null && position !== null) {
    if (position < previous) {
      next = 'back'
    } else if (position > previous) {
      const toDepth = to.meta.depth
      const fromDepth = from.meta.depth
      const depthsKnown = typeof toDepth === 'number' && typeof fromDepth === 'number'
      if (intent === 'back') next = 'back'
      else if (depthsKnown && toDepth < fromDepth) next = 'back'
      else if (depthsKnown && toDepth > fromDepth) next = 'forward'
      else if (depthsKnown && toDepth >= 2) next = 'forward'
    }
    // position unchanged: a replace within the same route (rule 1) or across
    // routes (rule 4) — no direction either way
  }
  // reduced motion overwrites the direction entirely; the CSS side repeats
  // the same media query as a second guard
  direction.value = prefersReducedMotion() ? 'none' : next
}
