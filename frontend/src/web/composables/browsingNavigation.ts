import { ref, watch } from 'vue'
import {
  isNavigationFailure, NavigationFailureType,
  type RouteLocationNormalized, type RouteLocationRaw, type Router, type RouterHistory,
} from 'vue-router'

export interface WriteOwner {
  operationId: number
  generation: number
  context: string
}
type Classification = 'pending' | 'owned-ack' | 'stale-owned' | 'boundary'
interface Observation {
  kind: Classification
  requestId: number
  revision: number
}
interface Request {
  requestId: number
  attemptId: number
  origin: 'FIFO' | 'external'
  owner?: WriteOwner
  target: string
  revision: number
  unique: boolean
  observed?: RouteLocationNormalized
}
interface HistoryRequest {
  requestId: number
  revision: number
  origin: 'topbar-back' | 'external-history' | 'pop'
  navigation: 'unobserved' | 'active' | 'success' | 'failure'
  history: 'awaiting-pop' | 'pop-active' | 'restoration-pending' | 'settled'
  ambiguous: boolean
  target?: string
  from?: string
  delta?: number
  destination?: string
  position?: number
}
export interface WriteResult {
  kind: 'owned-ack' | 'stale-owned' | 'boundary' | 'duplicate'
  route: RouteLocationNormalized
}
interface Subscriber {
  boundary(reason: string): void
  settled(): void
}

/** Router lifetime adapter. Only public entrances, promises and hooks identify
 * requests. A hook's URL alone is never evidence of ownership. */
export function createBrowsingNavigation(history: RouterHistory) {
  let router: Router
  let serial = 0
  let revision = 0
  let fifoOwner: WriteOwner | undefined
  let topbar = false
  const requests = new Set<Request>()
  const subscribers = new Set<Subscriber>()
  const observations = new WeakMap<RouteLocationNormalized, Observation>()
  const historyLocked = ref(false)
  const boundaryReason = ref('initial')
  let waiting: HistoryRequest | undefined
  let pop: HistoryRequest | undefined
  let lastResult: Promise<WriteResult> | undefined

  function boundary(reason: string): void {
    revision++
    boundaryReason.value = reason
    for (const request of requests) request.unique = false
    for (const listener of subscribers) listener.boundary(reason)
  }
  function settled(): void {
    if (requests.size > 0) return
    if (pop?.navigation === 'success' && !pop.ambiguous && waiting === pop) {
      pop.history = 'settled'
      waiting = undefined
      historyLocked.value = false
    }
    if (pop?.navigation === 'success' || pop?.navigation === 'failure') pop = undefined
    for (const listener of subscribers) listener.settled()
  }
  // Installed before createRouter: even browser pops cross the boundary
  // before the router starts its guards. Silent restoration has no callback.
  const listen = history.listen.bind(history)
  history.listen = (callback) => listen((to, from, info) => {
    const previous = waiting
    // Match the departure and displacement, plus destination/entry position
    // when the history exposes them. A competing notification permanently
    // invalidates this wait; a later matching pop cannot repair causality.
    const unique = previous?.history === 'awaiting-pop' && !previous.ambiguous && !pop &&
      previous.from === from && previous.delta === info.delta &&
      info.direction === (previous.delta < 0 ? 'back' : 'forward') &&
      (previous.destination === undefined || previous.destination === to) &&
      (previous.position === undefined || history.state.position === previous.position + previous.delta)
    boundary('pop')
    const record: HistoryRequest = unique ? previous : {
      requestId: ++serial, revision, origin: 'pop', navigation: 'unobserved',
      history: 'pop-active', ambiguous: !!previous || !!pop,
    }
    record.from = from
    record.delta = info.delta
    record.target = to
    record.navigation = 'active'
    record.history = 'pop-active'
    pop = record
    if (!previous) waiting = record
    else if (!unique) previous.ambiguous = true
    historyLocked.value = true
    callback(to, from, info)
  })

  function install(value: Router): void {
    router = value
    const push = router.push.bind(router)
    const replace = router.replace.bind(router)
    const go = router.go.bind(router)
    function navigate(kind: 'push' | 'replace', target: RouteLocationRaw) {
      const owner = fifoOwner
      fifoOwner = undefined
      if (!owner) {
        if (waiting) waiting.ambiguous = true
        boundary('external')
      }
      const request: Request = {
        requestId: ++serial, attemptId: serial,
        origin: owner ? 'FIFO' : 'external', owner,
        target: router.resolve(target).fullPath, revision,
        unique: requests.size === 0 && !historyLocked.value,
      }
      if (requests.size) for (const pending of requests) pending.unique = false
      requests.add(request)
      // Register before invoking the original entrance (including sync errors).
      let result: ReturnType<Router['push']>
      try { result = kind === 'push' ? push(target) : replace(target) }
      catch (error) {
        requests.delete(request)
        boundary('exception')
        settled()
        throw error
      }
      const classification = result.then((failure): WriteResult => {
        const route = router.currentRoute.value
        const unique = request.unique && request.observed === route &&
          route.fullPath === request.target && !route.redirectedFrom
        let kind: WriteResult['kind'] = 'boundary'
        if (!failure && unique && request.origin === 'FIFO') {
          kind = request.revision === revision ? 'owned-ack' : 'stale-owned'
        } else if (isNavigationFailure(failure, NavigationFailureType.duplicated) &&
          request.unique && request.revision === revision && route.fullPath === request.target) {
          kind = 'duplicate'
        }
        if (kind === 'boundary' && request.revision === revision && request.origin === 'FIFO') {
          boundary(failure ? 'failure' : 'redirect-or-ambiguous')
        }
        observations.set(route, { kind: kind === 'duplicate' ? 'boundary' : kind, requestId: request.requestId, revision })
        requests.delete(request)
        settled()
        return { kind, route }
      }, (error: unknown) => {
        requests.delete(request)
        boundary('exception')
        settled()
        throw error
      })
      // Observe even when the external caller does not await. Router onError
      // remains the application's error surface; do not create an unhandled chain.
      void classification.catch(() => {})
      if (owner) lastResult = classification
      return result
    }
    router.push = (target) => navigate('push', target)
    router.replace = (target) => navigate('replace', target)
    function travel(delta: number): void {
      if (historyLocked.value) return
      boundary('history-request')
      const destination = delta === -1 ? history.state.back : delta === 1 ? history.state.forward : undefined
      waiting = {
        requestId: ++serial, revision, origin: topbar ? 'topbar-back' : 'external-history', navigation: 'unobserved',
        history: 'awaiting-pop', ambiguous: false, from: history.location, delta,
        destination: typeof destination === 'string' ? destination : undefined,
        position: typeof history.state.position === 'number' ? history.state.position : undefined,
      }
      historyLocked.value = true
      go(delta)
    }
    router.go = travel
    router.back = () => travel(-1)
    router.forward = () => travel(1)

    watch(router.currentRoute, (route) => {
      if (!requests.size && !pop) {
        boundary('unknown-route')
        observations.set(route, { kind: 'boundary', requestId: 0, revision })
        settled()
      }
    }, { flush: 'sync' })

    router.beforeEach((to) => {
      if (!requests.size && !pop) boundary('unknown-hook')
      if (to.redirectedFrom) boundary('redirect')
    })
    router.afterEach((to, _from, failure) => {
      if (requests.size === 1 && !pop) {
        for (const request of requests) {
          request.observed = to
          observations.set(to, { kind: 'pending', requestId: request.requestId, revision })
        }
      } else if (!requests.size && pop && pop.target === to.fullPath) {
        pop.navigation = failure || to.redirectedFrom ? 'failure' : 'success'
        if (pop.navigation === 'failure') pop.history = 'restoration-pending'
        observations.set(to, { kind: 'boundary', requestId: pop.requestId, revision })
        settled()
      } else if (!requests.size) {
        boundary('unknown-completion')
        settled()
      }
    })
    // Retain the router's default error-reporting surface alongside observation.
    router.onError((error) => {
      console.error(error)
      if (waiting) {
        waiting.navigation = 'failure'
        waiting.history = 'restoration-pending'
      }
      boundary('exception')
      settled()
    })
  }

  return {
    install, historyLocked, boundaryReason,
    topbarBack(): void {
      topbar = true
      try { router.back() } finally { topbar = false }
    },
    get revision() { return revision },
    get pending() { return requests.size > 0 },
    classification(route: RouteLocationNormalized): Classification | undefined {
      const observation = observations.get(route)
      return observation?.revision === revision ? observation.kind : undefined
    },
    subscribe(listener: Subscriber): () => void {
      subscribers.add(listener)
      return () => { subscribers.delete(listener) }
    },
    invalidate(reason: 'ledger' | 'dispose'): void {
      // Logical boundaries do not cancel an already captured request. Its
      // identifiable late success may be classified stale-owned, never ACKed.
      revision++
      boundaryReason.value = reason
      for (const listener of subscribers) listener.boundary(reason)
    },
    async write(kind: 'push' | 'replace', target: RouteLocationRaw, owner: WriteOwner): Promise<WriteResult> {
      fifoOwner = owner
      lastResult = undefined
      try {
        const promise = router[kind](target)
        const result = lastResult
        if (!result) {
          boundary('unobserved-entrance')
          await promise
          return { kind: 'boundary', route: router.currentRoute.value }
        }
        return await result
      } finally { fifoOwner = undefined }
    },
  }
}
export type BrowsingNavigation = ReturnType<typeof createBrowsingNavigation>
const adapters = new WeakMap<Router, BrowsingNavigation>()
export function installBrowsingNavigation(router: Router, adapter: BrowsingNavigation): void {
  adapters.set(router, adapter)
  adapter.install(router)
}
export function browsingNavigation(router: Router): BrowsingNavigation {
  const adapter = adapters.get(router)
  if (!adapter) throw new Error('Browsing navigation adapter must be installed before publishing the router')
  return adapter
}
