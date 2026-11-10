// Shared helpers for the web screen tests: a routed fetch stub and an app
// mount with memory history (no real browser navigation).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, type HistoryState, type Router, type RouterHistory } from 'vue-router'
import { vi } from 'vitest'
import App from '@/web/App.vue'
import type { Me } from '@/web/api/auth'
import { createAppRouter } from '@/web/router'
import { installHttpHooks } from '@/web/setup'

export interface Reply {
  status?: number
  body?: unknown
}
export type Handler = Reply | ((body: unknown, n: number) => Reply | Promise<Reply>)

export interface Call {
  method: string
  path: string
  body: unknown
}

export const ME: Me = {
  user_id: 1,
  account_number: 'BB-ABCD-EFGH',
  display_name: '太郎',
  default_ledger_id: 1,
  ledgers: [
    { id: 1, name: '家計', role: 'owner', color: 'teal' },
    { id: 2, name: '実家', role: 'editor', color: 'orange' },
  ],
  auth_at: 0,
}

/** Stub global fetch; handlers keyed by "METHOD /path". Arrays reply in order. */
export function mockFetch(handlers: Record<string, Handler | Handler[]>) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    const key = `${method} ${path}`
    const n = counts.get(key) ?? 0
    counts.set(key, n + 1)
    let h = handlers[key]
    if (Array.isArray(h)) h = h[Math.min(n, h.length - 1)]
    const r: Reply = h === undefined ? { status: 404, body: { error: 'not_found' } } : typeof h === 'function' ? await h(body, n) : h
    const status = r.status ?? 200
    if (status === 204) return new Response(null, { status })
    return new Response(JSON.stringify(r.body ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fn)
  return {
    fn,
    calls,
    to: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path),
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  }
}

const mounted: VueWrapper[] = []

export interface MountOptions {
  /** attach to document.body (needed for focus / document-level key events) */
  attach?: boolean
  /** pass through to mount() (e.g. { transition: false } for real Transitions) */
  stubs?: Record<string, boolean>
  /** an explicit RouterHistory instead of the default memory history — the
   * manual history of TASK-174's unit tests (pop notification control) goes
   * through here */
  history?: RouterHistory
}

export async function mountApp(
  path: string,
  options: MountOptions = {},
): Promise<{ wrapper: VueWrapper; router: Router; pinia: Pinia }> {
  installScrollMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(options.history ?? createMemoryHistory(), pinia)
  installHttpHooks(router, pinia)
  await router.push(path)
  await router.isReady()
  const attachTo = options.attach ? document.body.appendChild(document.createElement('div')) : undefined
  // TASK-146: the transition machinery is real by default (a stubbed
  // Transition wraps its child in a <transition-stub> element, which both
  // breaks the DOM structure the tests read and never applies the motion
  // classes the appear-fade / content-swap expectations observe); a test
  // can still opt out through its own stubs
  const wrapper = mount(App, {
    attachTo,
    global: {
      plugins: [pinia, router],
      stubs: { transition: false, 'transition-group': false, ...options.stubs },
    },
  })
  mounted.push(wrapper)
  await settle()
  return { wrapper, router, pinia }
}

export function cleanup(): void {
  while (mounted.length) mounted.pop()?.unmount()
  uninstallScrollMocks()
  delete (navigator as { clipboard?: unknown }).clipboard
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
}

// ---------------------------------------------------------------------------
// Track-width patch (TASK-129): the row bars measure their track at mount
// (clientWidth / getBoundingClientRect, the WeekRows pattern) — jsdom reports
// 0 for both. This pins EVERY element's width to `px` so the bar-length math
// (value / scale × track) becomes assertable in jsdom without pinning WHICH
// element the surface measures. Returns the restore fn. (clientWidth is an
// own property of Element.prototype in jsdom 30 — patch/restore BOTH accessors
// there; HTMLElement.prototype never owns it, so the old read left restore
// with undefined.)

/** narrows a property descriptor's value to the getBoundingClientRect shape
 * (a type guard instead of a cast — REVIEW-6 指摘2) */
function isRectFn(v: unknown): v is (this: Element) => DOMRect {
  return typeof v === 'function'
}

export function patchTrackWidth(px: number): () => void {
  const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')
  const origRect = rect?.value
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => px })
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element): DOMRect {
      if (!isRectFn(origRect)) throw new Error('getBoundingClientRect descriptor is not a function')
      const r = origRect.call(this)
      return { ...r, x: r.left, width: px, right: r.left + px }
    },
  })
  return () => {
    Object.defineProperty(Element.prototype, 'clientWidth', cw!)
    Object.defineProperty(Element.prototype, 'getBoundingClientRect', rect!)
  }
}

// ---------------------------------------------------------------------------
// Clipboard double (TASK-37): jsdom ships no navigator.clipboard. Installs a
// writeText spy that resolves — or rejects with `error` for the failure path
// — and returns it. cleanup() removes the property again.

export function stubClipboard(error?: Error): ReturnType<typeof vi.fn> {
  const writeText = error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  return writeText
}

// ---------------------------------------------------------------------------
// Scroll / visibility test doubles for the receipt feed (TASK-16): a manually
// fired IntersectionObserver, a recording Element.scrollIntoView, a
// window.scrollBy spy and a matchMedia stub (prefers-reduced-motion; queries
// default to matches=false and can be preset with setMediaMatches / flipped
// with fireMediaChange, whose 'change' listeners are recorded so tests can
// fire breakpoint crossings).

type ObserverCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

export class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  readonly targets = new Set<Element>()
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds: readonly number[] = [0]
  constructor(
    readonly callback: ObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.targets.add(el)
  }
  unobserve(el: Element): void {
    this.targets.delete(el)
  }
  disconnect(): void {
    this.targets.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

export interface ScrollMocks {
  /** every Element.scrollIntoView call: the element and its argument */
  intoView: { el: Element; arg: unknown }[]
  scrollBy: ReturnType<typeof vi.fn>
  /** every window.scrollTo call (the router scrollBehavior since TASK-74) */
  scrollTo: ReturnType<typeof vi.fn>
}

let scroll: ScrollMocks | null = null
let reducedMotion = false
// 'change' listeners registered on the matchMedia stub, keyed by query
// (e.g. the shell's '(min-width: 900px)' desktop watcher).
type MediaChangeListener = (event: { matches: boolean; media: string }) => void
const mediaChangeListeners = new Map<string, Set<MediaChangeListener>>()
// preset per-query results so a test can mount inside a viewport class
// (e.g. setMediaMatches('(min-width: 900px)', true) before mountApp for the
// desktop shell). fireMediaChange keeps this map in sync with fired events.
const mediaMatches = new Map<string, boolean>()
const originalScrollIntoView = Element.prototype.scrollIntoView

function installScrollMocks(): void {
  MockIntersectionObserver.instances = []
  reducedMotion = false
  mediaChangeListeners.clear()
  const s: ScrollMocks = { intoView: [], scrollBy: vi.fn(), scrollTo: vi.fn() }
  scroll = s
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  vi.stubGlobal('scrollBy', s.scrollBy)
  // the router scrollBehavior (TASK-74) scrolls on every navigation; jsdom's
  // own window.scrollTo only logs "Not implemented", so stub it as well
  vi.stubGlobal('scrollTo', s.scrollTo)
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: mediaMatches.has(media)
      ? mediaMatches.get(media)!
      : media.includes('prefers-reduced-motion') && media.includes('reduce')
        ? reducedMotion
        : false,
    media,
    onchange: null,
    addEventListener: (type: string, listener: unknown) => {
      if (type === 'change' && typeof listener === 'function') {
        let set = mediaChangeListeners.get(media)
        if (!set) mediaChangeListeners.set(media, (set = new Set()))
        set.add(listener as MediaChangeListener)
      }
    },
    removeEventListener: (type: string, listener: unknown) => {
      if (type === 'change') mediaChangeListeners.get(media)?.delete(listener as MediaChangeListener)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    s.intoView.push({ el: this, arg })
  }
}

function uninstallScrollMocks(): void {
  scroll = null
  MockIntersectionObserver.instances = []
  mediaChangeListeners.clear()
  mediaMatches.clear()
  Element.prototype.scrollIntoView = originalScrollIntoView
}

/** The scroll doubles of the current mountApp (throws before mounting). */
export function scrollMocks(): ScrollMocks {
  if (!scroll) throw new Error('mountApp first')
  return scroll
}

/** matchMedia('(prefers-reduced-motion: reduce)').matches from now on. */
export function setReducedMotion(value: boolean): void {
  reducedMotion = value
}

/** Preset matchMedia(`media`).matches from now on (e.g. desktop at mount). */
export function setMediaMatches(media: string, matches: boolean): void {
  mediaMatches.set(media, matches)
}

/** Fire the 'change' listeners of `media` (e.g. a breakpoint crossing). */
export function fireMediaChange(media: string, matches: boolean): void {
  mediaMatches.set(media, matches)
  for (const fn of mediaChangeListeners.get(media) ?? []) fn({ matches, media })
}

/**
 * Make `el` the only visible element: every observer watching `el` (or an
 * element inside / around it) gets an entry with isIntersecting=true for it
 * and isIntersecting=false for all its other targets.
 */
export function intersect(target: Element | { element: Element }): void {
  const el = 'element' in target ? target.element : target
  for (const o of [...MockIntersectionObserver.instances]) {
    const targets = [...o.targets]
    const hit = (t: Element) => t === el || el.contains(t) || t.contains(el)
    if (!targets.some(hit)) continue
    const entries = targets.map((t) => {
      const visible = hit(t)
      const rect = t.getBoundingClientRect()
      return {
        target: t,
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: 0,
      } as IntersectionObserverEntry
    })
    o.callback(entries, o as unknown as IntersectionObserver)
  }
}

export const ASSERTION = {
  id: 'cred',
  rawId: 'AQID',
  type: 'public-key',
  response: { authenticatorData: 'AA', clientDataJSON: 'AA', signature: 'AA', userHandle: null },
  extensions: {},
}

export const ATTESTATION = {
  id: 'cred',
  rawId: 'AQID',
  type: 'public-key',
  response: { attestationObject: 'AA', clientDataJSON: 'AA' },
  extensions: {},
}

export const RCR = { publicKey: { challenge: 'AQID', allowCredentials: [] } }
export const CCR = {
  publicKey: { challenge: 'AQID', user: { id: 'BAUG', name: 'n', displayName: 'd' }, excludeCredentials: [] },
}

// ---------------------------------------------------------------------------
// The manual history (TASK-174, design tmp/tasks/tm-174/design_url-history-
// entries.md v4 影響「テストと実装範囲」): a RouterHistory with the same shape
// as vue-router's memory history whose go() splits the POSITION move from the
// POP NOTIFICATION. The plain memory history notifies its listener
// synchronously inside go(), so a test cannot build the design's
// awaiting-pop window ("an issued back whose pop has not arrived yet") —
// holdPops() keeps go() moving the position (and recording the request) while
// the listener notification waits for releasePops(), which then delivers
// every withheld notification in order. go(delta, false) — the router's own
// restoration call after a rejected pop — moves the position without a
// notification by contract; the goCalls log keeps the two kinds apart for
// assertions.

/** One pop notification's listener payload (the manual history's record). */
export interface ManualPop {
  to: string
  from: string
  direction: 'back' | 'forward'
  delta: number
}

/**
 * A history listener — the exact NavigationCallback derived from
 * RouterHistory['listen']. vue-router 5 shapes the pop payload with string
 * enums (NavigationType / NavigationDirection) that it does not export, so a
 * hand-written literal { direction, delta, type: 'pop' } type would not be
 * assignable to the real NavigationInformation.
 */
type HistoryListener = Parameters<RouterHistory['listen']>[0]
/** The listener's pop payload (vue-router's NavigationInformation). */
type PopInformation = Parameters<HistoryListener>[2]

/**
 * The enum member values are not exported either, so borrow the genuine
 * payload from the library's own memory history: fire one pop for the
 * requested direction and keep what its listener received. Notifications
 * then only override the per-call delta on top of the captured payload.
 */
function genuinePopInformation(direction: ManualPop['direction']): PopInformation {
  const memory = createMemoryHistory()
  const fired: PopInformation[] = []
  const stop = memory.listen((_to, _from, info) => fired.push(info))
  memory.push('/pop-information')
  memory.push('/pop-information')
  memory.go(direction === 'back' ? -1 : 1)
  stop()
  const [info] = fired
  if (info === undefined) throw new Error(`createMemoryHistory fired no ${direction} pop to capture`)
  return info
}

/** the genuine { type: 'pop' } payload per direction (the delta is per notification) */
const POP_INFORMATION: Record<ManualPop['direction'], PopInformation> = {
  back: genuinePopInformation('back'),
  forward: genuinePopInformation('forward'),
}

export interface ManualHistory extends RouterHistory {
  /** every go() request so far: the delta and whether it asked for a notification */
  readonly goCalls: ReadonlyArray<{ delta: number; trigger: boolean }>
  /** Hold silent go(..., false) before it changes the physical position. */
  holdRestorations(): void
  /** Apply held silent moves without notifying RouterHistory listeners. */
  releaseRestorations(): void
  readonly pendingRestorations: number
  /** Inject a competing notification independently of the held request. */
  notifyPop(pop: ManualPop): void
  /** Move the position but withhold the pop notifications. */
  holdPops(): void
  /** deliver every withheld pop notification, in order */
  releasePops(): void
  /** the withheld notifications so far (assertions on the awaiting window) */
  readonly heldPops: ReadonlyArray<ManualPop>
}

export function createManualHistory(base = ''): ManualHistory {
  const listeners: HistoryListener[] = []
  let queue: Array<[string, HistoryState]> = [['', {}]]
  let position = 0
  let holding = false
  let holdingRestorations = false
  const restorations: number[] = []
  const held: ManualPop[] = []
  const goCalls: Array<{ delta: number; trigger: boolean }> = []

  function setLocation(to: string, state: HistoryState): void {
    position++
    if (position !== queue.length) queue = queue.slice(0, position)
    queue.push([to, state])
  }

  function deliver(pop: ManualPop): void {
    if (holding) {
      held.push(pop)
      return
    }
    const info = { ...POP_INFORMATION[pop.direction], delta: pop.delta }
    for (const cb of listeners) cb(pop.to, pop.from, info)
  }

  const history: ManualHistory = {
    base,
    createHref: (location: string): string => base + location,
    push: (to: string, state?: HistoryState): void => setLocation(to, state ?? {}),
    replace(to: string, state?: HistoryState): void {
      queue.splice(position--, 1)
      setLocation(to, state ?? {})
    },
    go(delta: number, trigger = true): void {
      const from = this.location
      const direction: 'back' | 'forward' = delta < 0 ? 'back' : 'forward'
      goCalls.push({ delta, trigger })
      if (!trigger && holdingRestorations) {
        restorations.push(delta)
        return
      }
      position = Math.max(0, Math.min(position + delta, queue.length - 1))
      if (trigger) deliver({ to: this.location, from, direction, delta })
    },
    listen(cb: HistoryListener): () => void {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i > -1) listeners.splice(i, 1)
      }
    },
    destroy(): void {
      listeners.length = 0
      queue = [['', {}]]
      position = 0
    },
    holdRestorations(): void { holdingRestorations = true },
    releaseRestorations(): void {
      holdingRestorations = false
      for (const delta of restorations.splice(0)) {
        position = Math.max(0, Math.min(position + delta, queue.length - 1))
      }
    },
    get pendingRestorations(): number { return restorations.length },
    notifyPop(pop: ManualPop): void {
      const info = { ...POP_INFORMATION[pop.direction], delta: pop.delta }
      for (const cb of listeners) cb(pop.to, pop.from, info)
    },
    holdPops(): void {
      holding = true
    },
    releasePops(): void {
      holding = false
      const pending = held.splice(0)
      for (const pop of pending) {
        const info = { ...POP_INFORMATION[pop.direction], delta: pop.delta }
        for (const cb of listeners) cb(pop.to, pop.from, info)
      }
    },
    get goCalls(): ReadonlyArray<{ delta: number; trigger: boolean }> {
      return [...goCalls]
    },
    get heldPops(): ReadonlyArray<ManualPop> {
      return [...held]
    },
    get location(): string {
      return queue[position]![0]
    },
    get state(): HistoryState {
      return queue[position]![1]
    },
  }
  return history
}
