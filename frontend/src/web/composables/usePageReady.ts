// Page readiness for the shell's scroll restore (TASK-74 §4-3). A pop parks
// its saved scroll position (navDirection.pendingRestore) and the restore
// runs once BOTH gates open: the incoming page's transition enter settled
// (after-enter — immediate when the direction is none and the CSS machinery
// is off) and the page reported its data load done (markReady). A position
// that waits past 1.5s is given up on. App.vue provides markReady under
// PAGE_READY_KEY and resets both gates whenever the page key changes; pages
// take it through usePageReady() and call it when their load settles
// (success or failure, latest seq only).
import { inject, watch } from 'vue'
import { isCurrentRestore, pendingRestore } from './navDirection'

export interface PageReadyApi {
  markReady(): void
}

/** App.vue provides under this key: provide(PAGE_READY_KEY, { markReady }). */
export const PAGE_READY_KEY = 'page-ready'

let entered = false
let ready = false
let giveUp: ReturnType<typeof setTimeout> | null = null

function clearGiveUp(): void {
  if (giveUp !== null) {
    clearTimeout(giveUp)
    giveUp = null
  }
}

/** The landing attempt of a served restore, keyed by the reservation's
 *  generation: the incoming page's content swap (an out-in swap keyed by the
 *  load commit — e.g. an axis → cross axis move) can momentarily collapse
 *  the document, and a scrollTo landing in that gap clamps. Keep landing
 *  until the position sticks, the frames run out (a genuinely shorter page
 *  rests at its own max) or a newer navigation supersedes the attempt. */
let landingGen: number | null = null
let landingTries = 0

function land(top: number, gen: number): void {
  if (landingGen !== gen) return
  window.scrollTo({ top })
  if (Math.round(window.scrollY) === Math.round(top)) return
  if (landingTries >= 24) return
  landingTries += 1
  requestAnimationFrame(() => land(top, gen))
}

function maybeRestore(): void {
  const pending = pendingRestore.value
  if (pending === null || !entered || !ready) return
  pendingRestore.value = null
  clearGiveUp()
  // TASK-164 §2-2-2: a reservation superseded by a newer navigation (its
  // generation token no longer current) dies here unseen — no scroll —
  // instead of firing late through the gates
  if (isCurrentRestore(pending)) {
    landingGen = pending.gen
    landingTries = 0
    land(pending.top, pending.gen)
  }
}

// parking a position starts the give-up clock; clearing it stops the clock.
// A page that never becomes ready must not keep a stale restore armed.
// A reservation can also park with both gates ALREADY open (a non-remounting
// pop — the page stays mounted so no enter fires, and its params reload's
// markReady can beat vue-router's nextTick-deferred park): no gate event
// would ever come, so the park re-checks on the next task and serves if the
// gates stand open by then (REVIEW-12 #5's real-browser gap — the unit side
// drives the gates by hand and never hits the ordering).
watch(
  pendingRestore,
  (pos) => {
    clearGiveUp()
    // a new park (or a clear) supersedes any landing still in flight
    landingGen = pos === null ? null : pos.gen
    if (pos === null) return
    giveUp = setTimeout(() => { pendingRestore.value = null }, 1500)
    setTimeout(() => maybeRestore(), 0)
  },
  { flush: 'sync' },
)

/** The shell Transition's after-enter opens the first gate. */
export function notifyPageEntered(): void {
  entered = true
  maybeRestore()
}

/** App.vue closes both gates when the page key changes (a fresh page loads). */
export function resetPageReady(): void {
  entered = false
  ready = false
}

/** The data gate alone: a same-pageKey PATH change (an axis → its cross
 *  axis, the list → the feed) keeps the page mounted, so no enter fires and
 *  the enter gate stays as it was — only the incoming view's reload has to
 *  re-open this one before the parked restore serves. */
export function resetPageData(): void {
  ready = false
}

/** Pages call this when their load settles (success or failure). */
export function markReady(): void {
  ready = true
  maybeRestore()
}

/** The page-side injector for the shell-provided markReady. */
export function usePageReady(): PageReadyApi {
  const api = inject<PageReadyApi>(PAGE_READY_KEY)
  if (!api) throw new Error('usePageReady: the app shell did not provide page-ready')
  return api
}
