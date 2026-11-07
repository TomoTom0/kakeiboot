// Navigation direction for the shell page transition (TASK-74 §4-3).
// The direction is decided in router.afterEach by comparing
// window.history.state.position — the number vue-router keeps in the history
// state — with the previous value seen in this module. No catalog lookups and
// no history.listen: afterEach runs before the DOM patch of the same tick, so
// the Transition name is already the incoming navigation's when the pages
// swap (D28 review 指摘8).
import { ref, type Ref } from 'vue'
import type { NavigationFailure, RouteLocationNormalized, RouteLocationRaw, Router } from 'vue-router'
import { prefersReducedMotion } from './reducedMotion'

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

/** The up-navigation press (TASK-74 §3-2 案B for PageHead, shared by the
 * topbar ‹ since TASK-124 D3): a plain push to the parent route with the
 * one-shot back intent — not router.back(), so a direct link climbs too and
 * the slide always plays backwards though the history position moves
 * forward. The push is keys-less, so the shared period/labels ride along
 * through the URL sync's "keys-less entry keeps the store" rule. Returns
 * the push's own promise (resolved with a NavigationFailure when the
 * navigation was cancelled/redirected, per vue-router) so a caller that
 * keys a follow-up on the climb — the browsing fallback's boundary move —
 * can act on the actual landing, not on the first afterEach of anything. */
export function pushToParent(router: Router, to: RouteLocationRaw): Promise<NavigationFailure | void> {
  setNavIntent('back')
  return router.push(to)
}

/** A scroll restore parked by scrollBehavior until the incoming page is
 *  ready. The `gen` is the navigation-unit generation token (TASK-164
 *  §2-2-2): every scrollBehavior pass advances the counter, so a
 *  reservation left waiting by one navigation is invalidated by the next
 *  one (a period pop's same-path branch included) instead of firing late
 *  through the gates and breaking the scroll-keeping of the newer state. */
export interface PendingRestore {
  top: number
  gen: number
}

/** Scroll top parked by scrollBehavior until the incoming page is ready.
 *  Issued by scrollBehavior alone (never set from the pages). */
export const pendingRestore: Ref<PendingRestore | null> = ref(null)

let restoreGen = 0

/** Advance (and return) the reservation generation — scrollBehavior calls
 *  this at the head of every navigation. */
export function advanceRestoreGeneration(): number {
  restoreGen += 1
  return restoreGen
}

/** True when `pending` was issued by the CURRENT navigation. */
export function isCurrentRestore(pending: PendingRestore): boolean {
  return pending.gen === restoreGen
}

// --- the app-history boundary (TASK-164 §2-4) ----------------------------------
// The shell records window.history.state.position at its start: everything
// after it is the app's own history and a ‹ back may walk it; at (or below,
// or without) the boundary the ‹ falls back to a static parent instead — a
// reload or a direct link never digs into entries that predate the shell.
/** The history.state.position the shell started at (null when unreadable). */
export const boundaryPosition: Ref<number | null> = ref(null)

/** Record the shell-start boundary (App.vue's setup — the initial route is
 *  already resolved by then). */
export function recordHistoryBoundary(): void {
  boundaryPosition.value = historyPosition()
}

/** Move the boundary to the current position — the fallback climb's push
 *  uses this so a later ‹ never ping-pongs back into the climbed-from
 *  screen (§2-4 comparison (iii)). */
export function setHistoryBoundaryToCurrent(): void {
  boundaryPosition.value = historyPosition()
}

/** True when the app's own history has at least one entry behind the
 *  current position (a router.back stays inside the shell's session). A
 *  missing position reads as "no app history" — the fallback path. */
export function isWithinAppHistory(): boolean {
  const boundary = boundaryPosition.value
  if (boundary === null) return false
  const position = historyPosition()
  return position !== null && position > boundary
}

let lastPosition: number | null = null

function historyPosition(): number | null {
  const state = window.history.state as { position?: unknown } | null
  return typeof state?.position === 'number' ? state.position : null
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
