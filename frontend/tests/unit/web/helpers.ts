// Shared helpers for the web screen tests: a routed fetch stub and an app
// mount with memory history (no real browser navigation).
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createMemoryHistory, type Router } from 'vue-router'
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
}

export async function mountApp(
  path: string,
  options: MountOptions = {},
): Promise<{ wrapper: VueWrapper; router: Router; pinia: Pinia }> {
  installScrollMocks()
  const pinia = createPinia()
  setActivePinia(pinia)
  const router = createAppRouter(createMemoryHistory(), pinia)
  installHttpHooks(router, pinia)
  await router.push(path)
  await router.isReady()
  const attachTo = options.attach ? document.body.appendChild(document.createElement('div')) : undefined
  const wrapper = mount(App, { attachTo, global: { plugins: [pinia, router], stubs: options.stubs } })
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
  const s: ScrollMocks = { intoView: [], scrollBy: vi.fn() }
  scroll = s
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  vi.stubGlobal('scrollBy', s.scrollBy)
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
