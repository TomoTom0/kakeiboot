import { onScopeDispose, watch } from 'vue'
import { useRouter, type LocationQueryRaw, type Router } from 'vue-router'
import { formatLabelQuery, parseLabelQuery, type LabelColor } from '@/shared/labels'
import { browsingNavigation, type WriteOwner } from './browsingNavigation'
import { firstString } from './receiptContext'
import { monthEnd, shiftDate } from './period'
import { usePeriodStore, type PeriodOperation } from '../stores/period'
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
    if (rollback) restore(committed)
    logical = { ...route.query }
    if (route.meta.browsingSync) {
      importing = true
      try {
        if (PERIOD_KEYS.some((key) => key in route.query)) period.fromQuery(route.query)
        if ('labels' in route.query) {
          const labels = parseLabelQuery(firstString(route.query.labels) ?? '')
          if (period.labelColors.join(',') !== labels.join(',')) period.setLabelColors(labels)
        }
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
