import { onScopeDispose, watch } from 'vue'
import { useRouter, type LocationQueryRaw, type Router } from 'vue-router'
import { formatLabelQuery, parseLabelQuery, type LabelColor } from '@/shared/labels'
import { browsingNavigation, type WriteOwner } from './browsingNavigation'
import { firstString } from './receiptContext'
import { monthEnd, shiftDate } from './period'
import { usePeriodStore, HOME_FRESH_WINDOW_MS, type PeriodOperation } from '../stores/period'
import { useSessionStore } from '../stores/session'

const PERIOD_KEYS = ['month', 'week', 'year', 'from', 'to']
export type BrowsingPatch = Record<string, string | undefined>
interface Snapshot {
  keys: Record<string, string>
  labels: LabelColor[]
}
interface Entry extends WriteOwner {
  kind: 'push' | 'replace'
  ownedPatch: BrowsingPatch
  deriveRange: boolean
  snapshot?: Snapshot
}
interface Coordinator {
  patch(patch: BrowsingPatch, deriveRange?: boolean): void
  logicalValue(key: string): string | undefined
  onBoundary(fn: () => void): () => void
}
const coordinators = new WeakMap<Router, Coordinator>()
/** Issue #9: routers whose session cold start has already been consumed.
 * The cold start is a property of the session (the router's lifetime),
 * not of one shell mount — a shell dispose/remount on the same router
 * (TASK-174 D3-2) must still import the late committed URL, so the flag
 * lives here, keyed by router, instead of in the composable's closure. */
const coldStartConsumed = new WeakSet<Router>()

function apply(query: LocationQueryRaw, patch: BrowsingPatch): LocationQueryRaw {
  const next = { ...query }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  return next
}
function equal(a: LocationQueryRaw, b: LocationQueryRaw): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]))
}
function derivedRange(query: LocationQueryRaw): BrowsingPatch {
  const month = firstString(query.month)
  const week = firstString(query.week)
  const year = firstString(query.year)
  if (month) return { from: `${month}-01`, to: monthEnd(month) }
  if (week) return { from: week, to: shiftDate(week, 6) }
  if (year) return { from: `${year}-01-01`, to: `${year}-12-31` }
  return { from: firstString(query.from) ?? undefined, to: firstString(query.to) ?? undefined }
}

/** Page writers submit only owned keys; undefined is an explicit deletion.
 * The logical query includes accepted, not yet committed FIFO elements. */
/** Issue #9: the period keys a query actually hands to period.fromQuery —
 * the same branch conditions as the store's import (an empty value, a
 * malformed month, a from without its to import NOTHING, so they must not
 * count as a keys-carrying entry either). Returns the one mode's keys
 * fromQuery would apply, or null when it would apply none. */
function importablePeriodKeys(query: LocationQueryRaw): Record<string, string> | null {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const month = s(query.month)
  const week = s(query.week)
  const year = s(query.year)
  if (month && /^\d{4}-\d{2}$/.test(month)) return { month }
  if (week && /^\d{4}-\d{2}-\d{2}$/.test(week) && !Number.isNaN(Date.parse(week))) return { week }
  if (year && /^\d{4}$/.test(year)) return { year }
  const from = s(query.from)
  const to = s(query.to)
  if (from && to) return { from, to }
  return null
}
function samePeriodKeys(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key])
}

export function useBrowsingQuery(): Coordinator {
  const router = useRouter()
  function coordinator(): Coordinator {
    const value = coordinators.get(router)
    if (!value) throw new Error('Mount the browsing URL coordinator in the shell first')
    return value
  }
  return {
    patch: (patch, deriveRange) => coordinator().patch(patch, deriveRange),
    logicalValue: (key) => coordinator().logicalValue(key),
    onBoundary(fn) {
      const off = coordinator().onBoundary(fn)
      onScopeDispose(off)
      return off
    },
  }
}

/** One synchronous operation subscription and one FIFO consumer per shell.
 * Route imports happen only after the adapter has classified completion. */
export function useBrowsingUrlSync(): void {
  const router = useRouter()
  const navigation = browsingNavigation(router)
  const period = usePeriodStore()
  const session = useSessionStore()
  const queue: Entry[] = []
  const boundaryListeners = new Set<() => void>()
  let generation = 0
  let alive = true
  let importing = false
  let draining = false
  let scheduled = false
  let completeBaseline = true
  let boundaryPending = navigation.pending
  let ledger = session.selectedLedgerId
  let ledgerBaseline: Snapshot | undefined
  let logical: LocationQueryRaw = { ...router.currentRoute.value.query }
  const snapshot = (): Snapshot => ({ keys: { ...period.urlQuery }, labels: [...period.labelColors] })
  let committed = snapshot()

  function context(): string {
    return JSON.stringify([router.currentRoute.value.path, firstString(logical.scope), ledger])
  }
  function periodPatch(value: Snapshot, scope = firstString(logical.scope)): BrowsingPatch {
    const patch: BrowsingPatch = {}
    for (const key of PERIOD_KEYS) patch[key] = undefined
    if (router.currentRoute.value.name !== 'search' || scope === 'period') Object.assign(patch, value.keys)
    patch.labels = value.labels.length ? formatLabelQuery(value.labels) : undefined
    return patch
  }
  function restore(value: Snapshot): void {
    importing = true
    try {
      period.fromQuery(value.keys)
      if (period.labelColors.join(',') !== value.labels.join(',')) period.setLabelColors(value.labels)
    } finally { importing = false }
  }
  function schedule(): void {
    if (scheduled || draining || !alive) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void drain()
    })
  }
  function enqueue(entry: Entry): void {
    let next = apply(logical, entry.ownedPatch)
    if (entry.deriveRange) next = apply(next, derivedRange(next))
    if (equal(next, logical)) return
    logical = next
    queue.push(entry)
    schedule()
  }
  function baseline(rollback: boolean, complete = true): void {
    if (!alive || navigation.pending) return
    const route = router.currentRoute.value
    // Issue #9: the freshness clock is read BEFORE this boundary's own
    // restore / import can count as fresh activity.
    const activityAtEntry = period.lastActivityAt
    if (rollback) restore(committed)
    logical = { ...route.query }
    if (route.meta.browsingSync) {
      // The session's first sync baseline is its cold start; consume it
      // here (not on a non-sync landing like /login) so the first BROWSING
      // screen decides the rule below.
      const coldStart = !coldStartConsumed.has(router)
      if (coldStart) coldStartConsumed.add(router)
      importing = true
      try {
        const importable = importablePeriodKeys(route.query)
        // Issue #9, cold start on home: a restored tab's ?month= is stale
        // state, not an instruction — the period keys are NOT imported
        // and home starts from the current month (the write-back below
        // replaces them with the store's keys). A period deep link is
        // aimed at its own screen (receipts / axes / …), which imports
        // as before. Labels are not period keys and still restore.
        const coldHome = coldStart && route.name === 'home'
        // Issue #9 (review follow-up): keys identical to the committed
        // snapshot are the sync's own write-back paint, not an explicit
        // instruction — every home history entry carries them, so a
        // browser/device BACK into home would otherwise always take the
        // import path and resurrect the stale period regardless of the
        // window. Painted keys go through the freshness rule below
        // instead; keys that DIFFER from committed (a deep link, a
        // stacked period entry) still import and restore.
        const painted = importable !== null && samePeriodKeys(importable, committed.keys)
        if (importable !== null && !coldHome && (route.name !== 'home' || !painted)) {
          period.fromQuery(route.query)
        }
        if ('labels' in route.query) {
          const labels = parseLabelQuery(firstString(route.query.labels) ?? '')
          if (period.labelColors.join(',') !== labels.join(',')) period.setLabelColors(labels)
        }
        // Issue #9, in-session home entry: beyond the fresh window the
        // standing period is stale — reset to the default (current
        // month). The entry counts as keys-less when it carries no
        // importable keys (none at all, an empty / malformed value, a
        // from without its to) or only the painted committed keys; an
        // entry carrying explicit keys imports instead (above) and the
        // explicit keys win over the reset. The reset rides the regular
        // write-back below (committed picks it up; a replace, never a
        // user entry), and notifying under `importing` keeps this
        // boundary from enqueueing a second write for it.
        if (!coldHome && route.name === 'home' && (importable === null || painted) &&
          Date.now() - activityAtEntry > HOME_FRESH_WINDOW_MS) {
          period.resetToDefault()
        }
      } finally { importing = false }
    }
    // Issue #9 (review follow-up): landing on the login screen ends the
    // session's period state — the standing period returns to the
    // default and the cold start re-arms, so an SPA logout → login round
    // trip (no reload) cannot carry the previous session's period into
    // the next session's first home entry. The reset runs under
    // `importing`, like the freshness reset above, so its notification
    // is not mistaken for a write (and cannot be rolled back by the
    // boundary's own restore). The period store is reached only from
    // this sync — no store-to-store reference, no import cycle.
    if (route.name === 'login') {
      coldStartConsumed.delete(router)
      importing = true
      try {
        period.resetToDefault()
      } finally { importing = false }
    }
    committed = snapshot()
    boundaryPending = false
    if (!complete || !route.meta.browsingSync || navigation.historyLocked.value) return
    enqueue({ operationId: 0, generation, context: context(), kind: 'replace',
      ownedPatch: periodPatch(committed), snapshot: committed, deriveRange: false })
  }
  function boundary(reason: string): void {
    // Reconcile stores after failure without recreating the rejected repair.
    // A subsequent explicit operation can still enqueue a fresh write.
    completeBaseline = !['failure', 'exception', 'write-failed', 'write-exception'].includes(reason)
    generation++
    queue.length = 0
    boundaryPending = true
    if (reason !== 'ledger') ledgerBaseline = undefined
    for (const listener of boundaryListeners) listener()
  }
  function settleBoundary(): void {
    if (!alive || navigation.pending) return
    if (ledgerBaseline) {
      const value = ledgerBaseline
      ledgerBaseline = undefined
      restore(value)
      committed = value
      logical = { ...router.currentRoute.value.query }
      boundaryPending = false
      if (!navigation.historyLocked.value && router.currentRoute.value.meta.browsingSync) {
        enqueue({ operationId: 0, generation, context: context(), kind: 'replace',
          ownedPatch: periodPatch(value), snapshot: value, deriveRange: false })
      }
    } else if (boundaryPending || navigation.classification(router.currentRoute.value) === 'boundary') {
      baseline(true, completeBaseline)
    }
  }
  async function drain(): Promise<void> {
    if (draining || !alive || navigation.pending || navigation.historyLocked.value || boundaryPending) return
    draining = true
    try {
      while (alive && queue.length && !boundaryPending && !navigation.historyLocked.value) {
        const entry = queue.shift()!
        if (entry.generation !== generation) continue
        const current = router.currentRoute.value
        let query = apply(current.query, entry.ownedPatch)
        if (entry.deriveRange) query = apply(query, derivedRange(query))
        if (entry.kind === 'replace' && equal(query, current.query)) continue
        const result = await navigation.write(entry.kind, { path: current.path, hash: current.hash, query }, entry)
        if (!alive) return
        if (entry.generation !== generation) break
        if (result.kind === 'owned-ack' || (result.kind === 'duplicate' && entry.kind === 'replace')) {
          if (entry.snapshot) committed = entry.snapshot
        } else {
          boundary('write-failed')
          settleBoundary()
          break
        }
      }
    } catch {
      // The adapter/router onError owns error reporting. Stop this generation;
      // a rejected chain must not poison later, independently accepted work.
      if (alive) {
        boundary('write-exception')
        settleBoundary()
      }
    } finally {
      draining = false
      if (alive && queue.length && !boundaryPending && !navigation.pending && !navigation.historyLocked.value) schedule()
    }
  }
  function checkLedger(): void {
    if (ledger === session.selectedLedgerId) return
    ledger = session.selectedLedgerId
    if (ledger === null) return
    const value = snapshot()
    navigation.invalidate('ledger')
    ledgerBaseline = value
    settleBoundary()
  }
  const offNavigation = navigation.subscribe({ boundary, settled: settleBoundary })
  const offOperations = period.subscribeOperations((operation: PeriodOperation) => {
    if (importing || !alive || operation.cause === 'import') return
    checkLedger()
    if (navigation.historyLocked.value || boundaryPending) {
      // While a ledger switch waits for its old in-flight settle, the saved
      // new-ledger baseline — not the pre-switch committed snapshot — is the
      // integration target (D3-2): the labels reset that announced the switch
      // is part of that baseline, and the settle restores it.
      if (!ledgerBaseline) restore(committed)
      return
    }
    if (!router.currentRoute.value.meta.browsingSync) {
      committed = snapshot()
      return
    }
    if (operation.cause === 'user' && router.currentRoute.value.name === 'search' && firstString(logical.scope) !== 'period') {
      committed = snapshot()
      return
    }
    const value: Snapshot = { keys: { ...operation.keys }, labels: [...operation.labels] }
    enqueue({ operationId: operation.operationId, generation, context: context(),
      kind: operation.cause === 'user' ? 'push' : 'replace',
      ownedPatch: periodPatch(value), snapshot: value, deriveRange: false })
  })
  const offLedger = watch(() => session.selectedLedgerId, checkLedger, { flush: 'sync' })
  const coordinator: Coordinator = {
    logicalValue: (key) => firstString(logical[key]) ?? undefined,
    onBoundary(fn) {
      boundaryListeners.add(fn)
      return () => { boundaryListeners.delete(fn) }
    },
    patch(patch, deriveRange = false) {
      if (!alive || navigation.historyLocked.value || boundaryPending || !router.currentRoute.value.meta.browsingSync) return
      const ownedPatch = { ...patch }
      if ('scope' in ownedPatch) Object.assign(ownedPatch, periodPatch(snapshot(), ownedPatch.scope ?? ''))
      enqueue({ operationId: 0, generation, context: context(), kind: 'replace', ownedPatch, deriveRange })
    },
  }
  coordinators.set(router, coordinator)
  baseline(false)
  onScopeDispose(() => {
    alive = false
    offOperations()
    offLedger()
    offNavigation()
    navigation.invalidate('dispose')
    queue.length = 0
    boundaryListeners.clear()
    if (coordinators.get(router) === coordinator) coordinators.delete(router)
  })
}
