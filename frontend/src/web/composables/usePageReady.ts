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
import { pendingRestore } from './navDirection'

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

function maybeRestore(): void {
  if (pendingRestore.value === null || !entered || !ready) return
  const top = pendingRestore.value
  pendingRestore.value = null
  clearGiveUp()
  window.scrollTo({ top })
}

// parking a position starts the give-up clock; clearing it stops the clock.
// A page that never becomes ready must not keep a stale restore armed.
watch(
  pendingRestore,
  (pos) => {
    clearGiveUp()
    if (pos !== null) giveUp = setTimeout(() => { pendingRestore.value = null }, 1500)
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
