// Checks of the atomic-transition implementation (TASK-39): the
// mount / navigation / session ordering and the RouterView transition wiring
// are entry-point and template concerns that the jsdom mounts in the other
// test files do not exercise, so they are asserted on the source text (the
// same approach as vite-proxy.test.ts). The settings tab swap is verified
// behaviorally below: jsdom resolves no stylesheet, so the transition is
// made observable through an inline transition-duration on the leaving panel.
// Vitest runs with the frontend dir as cwd.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMemoryHistory, type NavigationFailure, type RouteLocationNormalized, type Router } from 'vue-router'
import { createPinia } from 'pinia'
import { direction, navKind, pendingRestore, setNavIntent, updateDirection } from '@/web/composables/navDirection'
import { markReady, notifyPageEntered, resetPageReady } from '@/web/composables/usePageReady'
import { createAppRouter } from '@/web/router'
import { useSessionStore } from '@/web/stores/session'
import { cleanup, ME, mockFetch, mountApp, scrollMocks, setReducedMotion, settle } from './helpers'

/** router.resolve() answers the RESOLVED variant whose name is nullable;
 * scrollBehavior expects the normalized shape (a non-null name among the
 * differences). Narrow the name with a guard — no `as` cast. */
function normalizedRoute(router: Router, path: string): RouteLocationNormalized {
  const r = router.resolve(path)
  if (r.name === null) throw new Error(`normalizedRoute: no route matches ${path}`)
  return { ...r, name: r.name }
}

/** Drive the app router's scrollBehavior the way a pop does: memory history
 * never delivers a savedPosition, so a pop's park is exercised by calling the
 * router's own scrollBehavior with a fabricated one (the TASK-74 recipe;
 * TASK-164 §2-2-2 keeps scrollBehavior the only issuer of reservations). */
async function popSaved(router: Router, toPath: string, fromPath: string, top: number): Promise<unknown> {
  const sb = router.options.scrollBehavior
  if (!sb) throw new Error('the app router has no scrollBehavior')
  return sb(normalizedRoute(router, toPath), normalizedRoute(router, fromPath), { left: 0, top })
}

const src = (...p: string[]) => readFileSync(resolve(process.cwd(), 'src/web', ...p), 'utf8')

/** Source text without comments: ordering is asserted on code, not prose. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('atomic transitions (TASK-39)', () => {
  it('[covers:web-shell.atomic-mount] mount は router.isReady() 待ち、login/register は me 確定後に遷移、logout/401 は遷移確定後に clear', () => {
    // the app mounts only after the initial navigation (guard included)
    const main = src('main.ts')
    expect(main.indexOf('router.isReady()')).toBeGreaterThan(-1)
    expect(main.indexOf('router.isReady()')).toBeLessThan(main.indexOf(".mount('#app')"))

    // login settles the session before navigating home; the single clear()
    // left is the consent branch (public screen, no shell)
    const login = src('pages/LoginPage.vue')
    expect(login).toContain('await session.loadMe()')
    expect(login.match(/session\.clear\(\)/g)).toHaveLength(1)
    expect(login.indexOf('await session.loadMe()')).toBeLessThan(login.indexOf("router.replace('/')"))

    // registration does the same (and has no clear left at all)
    const register = src('pages/RegisterPage.vue')
    expect(register).toContain('await session.loadMe()')
    expect(register).not.toContain('session.clear()')
    expect(register.indexOf('await session.loadMe()')).toBeLessThan(register.indexOf("router.replace('/')"))

    // logout and the 401 hook confirm the navigation first, then clear the
    // session — the shell swap and the page swap land in one frame. The
    // 401 hook's public-route branch (already on /login) clears directly.
    const app = code(src('App.vue'))
    expect(app.indexOf("router.replace('/login')")).toBeGreaterThan(-1)
    expect(app.indexOf("router.replace('/login')")).toBeLessThan(app.indexOf('session.clear()'))
    const setup = code(src('setup.ts'))
    expect(setup).toContain("replace({ path: '/login' })")
    // the clear runs in the replace chain's finally — after the navigation
    expect(setup).toContain('.finally(() => session.clear())')
  })

  it('[covers:web-shell.sync-route-imports] route は全て同期 import でテスト側の preloadPages も無い', () => {
    expect(src('router.ts')).not.toMatch(/\(\)\s*=>\s*import\(/)
    const helpers = readFileSync(resolve(process.cwd(), 'tests/unit/web/helpers.ts'), 'utf8')
    expect(helpers).not.toContain('preloadPages')
  })

  it('[covers:web-shell.page-transition] RouterView の遷移: shell 側は方向ベース（slide/none）・外側分岐と public 側は page fade・設定tab は内側 fade（TASK-74 改訂）', () => {
    const app = src('App.vue')
    // 2 = the shell/public branch swap (login -> home flips the v-if, which
    // the inner RouterView transitions never see) and the public RouterView;
    // the shell RouterView is direction-based since TASK-74
    expect(app.match(/name="page"/g)).toHaveLength(2)
    expect(app.match(/mode="out-in"/g)).toHaveLength(2)
    // the branch swap is wrapped: the outermost Transition comes before the
    // v-if / v-else branch roots
    expect(app.indexOf('<Transition')).toBeLessThan(app.indexOf('v-if="showShell'))
    // the shell RouterView: the slide name follows the navigation direction
    // and a 'none' direction keeps the CSS machinery off entirely (no mode:
    // both pages move at once), keyed by the first path segment.
    // TASK-146 §3 #2: transitionName looks at navKind TOO — a direction-less
    // PUSH (same-depth tabs, depth-less routes) fades instead of skipping,
    // only a replace stays classless
    expect(app).toContain(':name="transitionName"')
    expect(app).toContain(":css=\"transitionName !== ''\"")
    expect(app).toMatch(/<component\s+:is="Component"\s+:key="pageKey"/)
    expect(app).toContain('@after-enter')
    const nameCalc = app.slice(app.indexOf('transitionName'), app.indexOf('pageKey'))
    expect(nameCalc).toContain('navKind')
    const settings = src('pages/SettingsPage.vue')
    expect(settings.match(/name="page"/g)).toHaveLength(1)
    expect(settings).toContain('mode="out-in"')
    // the swapped component carries the route key: a switch between two
    // routes that share a component still remounts under the transition
    expect(settings).toMatch(/<component\s+:is="Component"\s+:key=/)
  })

  it('[covers:web-shell.page-transition] slide 系 CSS: app-main の context・forward/back の対称スライド・reduced-motion 二重化', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8')
    // the slide stage: .app-main gains the positioning context the parked
    // leaving page needs (absolute + translateX without a horizontal overflow)
    expect(css).toMatch(/\.app-main\s*\{[^}]*position: relative/)
    expect(css).toMatch(/\.app-main\s*\{[^}]*overflow-x: clip/)
    // forward: in from the right, out to the left; back is the mirror
    expect(css).toMatch(/\.slide-forward-enter-from\s*\{[^}]*transform: translateX\(100%\)/)
    expect(css).toMatch(/\.slide-forward-leave-to\s*\{[^}]*transform: translateX\(-30%\)[^}]*opacity: 0/)
    expect(css).toMatch(/\.slide-back-enter-from\s*\{[^}]*transform: translateX\(-100%\)/)
    expect(css).toMatch(/\.slide-back-leave-to\s*\{[^}]*transform: translateX\(30%\)[^}]*opacity: 0/)
    // no mode: both pages move at once, the leaving one parked absolute
    expect(css).toMatch(
      /\.slide-forward-enter-active,\s*\.slide-forward-leave-active,\s*\.slide-back-enter-active,\s*\.slide-back-leave-active\s*\{[^}]*transition: transform 220ms cubic-bezier\(\.2, ?\.7, ?\.2, ?1\), opacity 220ms/,
    )
    expect(css).toMatch(/\.slide-forward-leave-active,\s*\.slide-back-leave-active\s*\{[^}]*position: absolute[^}]*width: 100%/)
    // reduced-motion doubles the JS-side 'none' override in CSS
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.slide-forward-enter-active[^{]*\{[^}]*transition: none/)
    expect(reduced).toMatch(/\.slide-forward-enter-from[^{]*\{[^}]*transform: none/)
  })
})

// ---------------------------------------------------------------------------
// Settings tab swap (real-device fix on top of TASK-39): the inner RouterView
// panels must animate. A panel with several root nodes is a fragment and
// <Transition> cannot animate it (Vue skips the classes with a dev warning),
// which is what the real-device review saw on the settings tabs.

describe('settings tab transition', () => {
  afterEach(cleanup)

  function mountSettings(path: string) {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    // attached: the leave-phase asserts read document (isConnected) directly;
    // transition stubs off: @vue/test-utils replaces <Transition> with a
    // non-functional stub unless stubs.transition is disabled explicitly
    return mountApp(path, { attach: true, stubs: { transition: false } })
  }

  /** jsdom ships no stylesheet: a real duration keeps the leave observable. */
  const slowLeave = (el: Element) => {
    ;(el as HTMLElement).style.transitionDuration = '0.05s'
    ;(el as HTMLElement).style.transitionProperty = 'opacity'
  }

  /** Leave the leave time to finish (rAF + the whenTransitionEnds timeout). */
  const leaveDone = () => settle().then(() => new Promise((r) => setTimeout(r, 100)))

  it('[covers:web-shell.page-transition] 設定tab（内側 RouterView）の切替も out-in で panel が入れ替わる（全tabが単一root）', async () => {
    const warns: string[] = []
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.map(String).join(' ')))
    const { router } = await mountSettings('/settings/general')
    // TASK-74: the shell RouterView's key is the first path segment, so every
    // settings tab (and the manage screens) shares the key 'settings' — the
    // SettingsPage shell never remounts and its inner fade stays the only
    // motion. The tab strip node must survive every switch below.
    const navStrip = document.querySelector('[data-test="settings-nav"]')
    expect(navStrip).not.toBe(null)

    // general -> auth: the leaving general panel carries the page-leave
    // classes and, with mode="out-in", the auth panel mounts only after the
    // leave ends (the old root is gone by then)
    const generalRoot = document.querySelector('.settings-layout > section.card')!
    slowLeave(generalRoot)
    await router.push('/settings/auth')
    await flushPromises()
    expect(generalRoot.classList.contains('page-leave-active')).toBe(true)
    expect(generalRoot.classList.contains('page-leave-from')).toBe(true)
    expect(document.querySelector('[data-test="passkeys-panel"]')).toBe(null) // out-in: still waiting
    await leaveDone()
    expect(generalRoot.isConnected).toBe(false)
    expect(document.querySelector('[data-test="passkeys-panel"]')).not.toBe(null)

    // auth -> general: the auth side must animate too — its panels live under
    // ONE root. A multi-root panel is a fragment and <Transition> skips it
    // (this is what the real-device review saw: no animation on tab swaps)
    const authRoot = document.querySelector('.settings-layout > .settings-panel')
    expect(authRoot).not.toBe(null)
    slowLeave(authRoot!)
    await router.push('/settings/general')
    await flushPromises()
    expect(authRoot!.classList.contains('page-leave-active')).toBe(true)
    expect(document.querySelector('[data-test="display-name"]')).toBe(null) // out-in: still waiting
    await leaveDone()
    expect(authRoot!.isConnected).toBe(false)
    expect(document.querySelector('[data-test="display-name"]')).not.toBe(null)

    // every tab (and the manage screens under the data tab) renders exactly
    // one root: a fragment child makes <Transition> skip the animation with
    // the "renders non-element root node" warning
    for (const path of ['/settings/general', '/settings/auth', '/settings/data', '/settings/others', '/settings/categories', '/settings/labels']) {
      await router.push(path)
      await settle()
    }
    expect(warns.filter((w) => w.includes('cannot be animated'))).toEqual([])
    // the shell never remounted across those switches: same DOM node
    expect(document.querySelector('[data-test="settings-nav"]')).toBe(navStrip)
  })
})

// ---------------------------------------------------------------------------
// Branch swap (TASK-39 real-device follow-up): login -> home flips the
// showShell v-if, a swap the inner RouterView transitions never see — the
// whole branch (login screen / shell) must fade through the same page
// transition. Verified behaviorally in both directions; the 401 path runs the
// same replace -> clear sequence as logout (web-shell.atomic-mount).

describe('branch transition (login/logout shell swap)', () => {
  afterEach(cleanup)

  /** jsdom ships no stylesheet: a real duration keeps the leave observable. */
  const slowLeave = (el: Element) => {
    ;(el as HTMLElement).style.transitionDuration = '0.05s'
    ;(el as HTMLElement).style.transitionProperty = 'opacity'
  }

  /** Leave the leave time to finish (rAF + the whenTransitionEnds timeout). */
  const leaveDone = () => settle().then(() => new Promise((r) => setTimeout(r, 100)))

  it('[covers:web-shell.page-transition] login→home は public branch の fade-out → shell の fade-in（out-in・旧branch はlogin画面のまま）', async () => {
    // no session: /login renders the public branch (no /me round trip). The
    // home endpoints stay unmocked (404): the call log still records them,
    // which is what the exactly-once check below reads
    const fetches = mockFetch({})
    const statsCalls = () => fetches.calls.filter((c) => c.path.startsWith('/api/ledgers/1/analysis'))
    const { router, pinia } = await mountApp('/login', { attach: true, stubs: { transition: false } })
    const publicRoot = document.querySelector('main.public')!
    expect(publicRoot).not.toBe(null)
    slowLeave(publicRoot)

    // login completion order (TASK-39 A-2): me first, then the navigation
    useSessionStore(pinia).setMe(ME)
    await router.push('/')
    await flushPromises()
    // mid-leave: the public root carries the page-leave classes and out-in
    // holds the shell back; the leaving branch still shows the login screen
    // (not the incoming home page)
    expect(publicRoot.classList.contains('page-leave-active')).toBe(true)
    expect(publicRoot.classList.contains('page-leave-from')).toBe(true)
    expect(publicRoot.querySelector('[data-test="login"]')).not.toBe(null)
    expect(publicRoot.querySelector('[data-test="period-total"]')).toBe(null)
    expect(document.querySelector('.shell')).toBe(null)
    await leaveDone()
    expect(publicRoot.isConnected).toBe(false)
    expect(document.querySelector('.shell')).not.toBe(null)
    // home mounted exactly once — the leaving branch never fetched. One
    // Home load issues three analysis-path calls: the category breakdown
    // and the month-window trend since TASK-93, plus TASK-103's week fetch
    // (getAnalysisTrend granularity:week limit:5 since TASK-116), so
    // exactly-once = 3
    await settle()
    expect(statsCalls()).toHaveLength(3)
  })

  it('[covers:web-shell.page-transition] logout（replace→clear）は shell の fade-out → login の fade-in', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { router, pinia } = await mountApp('/', { attach: true, stubs: { transition: false } })
    const shellRoot = document.querySelector('.shell')!
    expect(shellRoot).not.toBe(null)
    slowLeave(shellRoot)

    // the App.vue logout sequence: confirm the navigation first, clear after
    await router.replace('/login')
    useSessionStore(pinia).clear()
    await flushPromises()
    expect(shellRoot.classList.contains('page-leave-active')).toBe(true)
    expect(shellRoot.classList.contains('page-leave-from')).toBe(true)
    expect(document.querySelector('main.public')).toBe(null) // out-in: still waiting
    await leaveDone()
    expect(shellRoot.isConnected).toBe(false)
    expect(document.querySelector('main.public')).not.toBe(null)
    expect(document.querySelector('[data-test="login"]')).not.toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Navigation direction (TASK-74 §4-3): the direction is decided in
// router.afterEach by comparing window.history.state.position with the
// previous value. The memory history of the test mounts never writes
// window.history, so the tests set the position directly before each
// navigation — exactly the value updateDirection reads.

describe('navDirection rules (TASK-74)', () => {
  const at = (position: number) => window.history.replaceState({ position }, '')

  const nav = (
    to: { name?: string; depth?: number },
    from: { name?: string; depth?: number },
    failure?: unknown,
  ) =>
    updateDirection(
      { name: to.name, meta: { depth: to.depth } } as unknown as RouteLocationNormalized,
      { name: from.name, meta: { depth: from.depth } } as unknown as RouteLocationNormalized,
      failure as NavigationFailure | undefined,
    )

  afterEach(() => {
    setNavIntent(null)
    window.history.replaceState(null, '')
    cleanup()
  })

  it('[covers:web-browse.transition-direction] 規則1〜4: position 比較と depth・一次性 navIntent で方向が決まる（failure・replace・未設定 depth・初回は none）', () => {
    // the first observation has no previous position to compare: none
    at(5)
    nav({ name: 'receipts', depth: 1 }, { name: 'home', depth: 1 })
    expect(direction.value).toBe('none')
    // rule 2 — the position went down (popstate / the browser back): back
    at(4)
    nav({ name: 'receipts', depth: 1 }, { name: 'receipt', depth: 2 })
    expect(direction.value).toBe('back')
    // rule 3 push — a deeper route slides forward
    at(5)
    nav({ name: 'receipt', depth: 2 }, { name: 'receipts', depth: 1 })
    expect(direction.value).toBe('forward')
    // rule 3 push — a shallower target is back (cross links down the tree)
    at(6)
    nav({ name: 'categories', depth: 1 }, { name: 'subcategory', depth: 3 })
    expect(direction.value).toBe('back')
    // rule 3 push — same depth 1 (tab / sidebar switches): none
    at(7)
    nav({ name: 'stores', depth: 1 }, { name: 'receipts', depth: 1 })
    expect(direction.value).toBe('none')
    // rule 3 push — same depth >= 2 (detail -> detail cross): forward
    at(8)
    nav({ name: 'store', depth: 2 }, { name: 'category', depth: 2 })
    expect(direction.value).toBe('forward')
    // rule 3 push with the one-shot ‹ intent: back even against the depth
    setNavIntent('back')
    at(9)
    nav({ name: 'categories', depth: 1 }, { name: 'store', depth: 2 })
    expect(direction.value).toBe('back')
    // the intent is one-shot: consumed above, the next depth-1 switch is none
    at(10)
    nav({ name: 'home', depth: 1 }, { name: 'categories', depth: 1 })
    expect(direction.value).toBe('none')
    // rule 1 — an unchanged position (replace within the same route: the
    // feed's scrolling id rewrite, a chip ×, a period change): none
    at(10)
    nav({ name: 'receipt', depth: 2 }, { name: 'receipt', depth: 2 })
    expect(direction.value).toBe('none')
    // rule 4 — an unchanged position with a different name (a replace to
    // another route, e.g. the ledger switch feed -> list): none
    at(10)
    nav({ name: 'receipts', depth: 1 }, { name: 'receipt', depth: 2 })
    expect(direction.value).toBe('none')
    // rule 1 — a failed navigation is none
    at(11)
    nav({ name: 'receipt', depth: 2 }, { name: 'receipts', depth: 1 }, {})
    expect(direction.value).toBe('none')
    // unset depths (settings / manage / public) never take a direction
    at(12)
    nav({ name: 'receipts', depth: 1 }, { name: 'settings-general' })
    expect(direction.value).toBe('none')
    at(13)
    nav({ name: 'manage-categories' }, { name: 'settings-general' })
    expect(direction.value).toBe('none')
    // TASK-146 §3 #2: 'none' no longer means "no motion" — a direction-less
    // navigation still records its KIND, and App.vue maps a none + push/pop
    // to the page fade (only a replace stays classless). The kind is the
    // source the fade mapping reads.
    at(14)
    nav({ name: 'stores', depth: 1 }, { name: 'receipts', depth: 1 })
    expect(direction.value).toBe('none')
    expect(navKind.value).toBe('push')
    at(15)
    nav({ name: 'receipts', depth: 1 }, { name: 'settings-general' })
    expect(direction.value).toBe('none')
    expect(navKind.value).toBe('push')
    at(16)
    nav({ name: 'manage-categories' }, { name: 'receipts', depth: 1 })
    expect(direction.value).toBe('none')
    expect(navKind.value).toBe('push')
    // a replace keeps neither direction nor kind-based motion
    at(16)
    nav({ name: 'receipts', depth: 1 }, { name: 'receipt', depth: 2 })
    expect(direction.value).toBe('none')
    expect(navKind.value).toBe('replace')
  })
})

// ---------------------------------------------------------------------------
// The shell slide transition itself (TASK-74 §4-3): afterEach decides the
// direction before the DOM patch, so the transition classes of the swap are
// already the new navigation's. Verified with real transitions (jsdom ships
// no stylesheet: the classes land in the patch and clear on the next frame).

describe('shell slide transition (TASK-74)', () => {
  afterEach(() => {
    window.history.replaceState(null, '')
    cleanup()
  })

  it('[covers:web-browse.transition-direction] afterEach で決まった方向が新コンポーネントの描画に反映（push は右から前へ・戻りは左から後ろへ）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    // a push down the hierarchy (the list -> the feed): the incoming page
    // enters from the right while the leaving one drifts left
    window.history.replaceState({ position: 1 }, '')
    await router.push('/receipts/101')
    await flushPromises()
    const entering = document.querySelector('main.app-main .receipt-feed')
    expect(entering?.classList.contains('slide-forward-enter-active')).toBe(true)
    expect(entering?.classList.contains('slide-forward-enter-from')).toBe(true)
    const leaving = document.querySelector('main.app-main .view-page:not(.receipt-feed)')
    expect(leaving?.classList.contains('slide-forward-leave-active')).toBe(true)
    await settle()
    expect(document.querySelector('main.app-main .view-page:not(.receipt-feed)')).toBe(null)

    // a history pop reverses the slide: the incoming list enters from the
    // left (same page key, different component — the swap still animates)
    window.history.replaceState({ position: 0 }, '')
    await router.back()
    await flushPromises()
    const back = document.querySelector('main.app-main .view-page:not(.receipt-feed)')
    expect(back?.classList.contains('slide-back-enter-active')).toBe(true)
    expect(back?.classList.contains('slide-back-enter-from')).toBe(true)
    await settle()
  })

  it('[covers:web-browse.feed-no-remount] Feed のスクロール replace（id の書き換え）では再マウントも演出も無し', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts/101', { attach: true, stubs: { transition: false } })
    const feed = document.querySelector('main.app-main .receipt-feed')
    expect(feed).not.toBe(null)
    // the replace keeps the position (and the route name + page key): the
    // very same DOM node stays mounted and no slide class ever lands on it
    await router.replace('/receipts/102')
    await settle()
    expect(document.querySelector('main.app-main .receipt-feed')).toBe(feed)
    expect(direction.value).toBe('none')
    expect(
      Array.from(feed!.classList).filter((c) => c.includes('slide-') || c.includes('-enter-') || c.includes('-leave-')),
    ).toEqual([])
  })

  it('[covers:web-browse.reduced-motion] prefers-reduced-motion では方向を none へ上書きし演出なし（新ページが即表示）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    // installScrollMocks resets the flag at mount: flip it after mounting
    setReducedMotion(true)
    window.history.replaceState({ position: 1 }, '')
    await router.push('/receipts/101')
    await settle()
    expect(direction.value).toBe('none')
    const pages = document.querySelectorAll('main.app-main .view-page')
    expect(pages).toHaveLength(1)
    expect(pages[0]?.classList.contains('receipt-feed')).toBe(true)
    expect(Array.from(pages[0]!.classList).some((c) => c.startsWith('slide-'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Direction-less push fade (TASK-146 §3 遷移全数表 #2): a push whose direction
// cannot settle — same-depth tab switches and depth-less routes (the settings
// tree, apps, usage, manage-*) — used to render with NO motion (:css=false).
// transitionName now reads navKind as well: a none + push/pop navigation
// fades through the page vocabulary, and only a replace stays classless.

describe('direction-less push fade (TASK-146)', () => {
  afterEach(() => {
    window.history.replaceState(null, '')
    cleanup()
  })

  /** the app-main children of the current swap, keyed by their motion class */
  const pages = (): Element[] => Array.from(document.querySelectorAll('main.app-main > *'))

  it('[covers:web-shell.page-transition][covers:web-browse.transition-direction] 同depth(1)同士のpush（/receipts→/categories）は fade（page-enter-active/page-leave-active）で遷移', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    window.history.replaceState({ position: 1 }, '')
    await router.push('/categories')
    await flushPromises()
    // direction-less but a push: the fade vocabulary carries the swap. (The
    // navKind source itself is pinned by the rules test above — the browsing
    // screens' URL-sync writeBack issues a replace right behind every push,
    // so reading the ref here would observe that follow-up instead.)
    expect(direction.value).toBe('none')
    const entering = pages().find((el) => el.classList.contains('page-enter-active'))
    expect(entering).toBeDefined()
    expect(entering?.classList.contains('page-enter-from')).toBe(true)
    const leaving = pages().find((el) => el.classList.contains('page-leave-active'))
    expect(leaving).toBeDefined()
    expect(entering?.classList.contains('view-page')).toBe(true)
    await settle()
    expect(pages().filter((el) => el.classList.contains('view-page'))).toHaveLength(1)
  })

  it('[covers:web-shell.page-transition] depth未設定route（/settings/general）へのpushも fade で遷移する（none+push は無演出でない）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    window.history.replaceState({ position: 1 }, '')
    await router.push('/settings/general')
    await flushPromises()
    expect(direction.value).toBe('none')
    const entering = pages().find((el) => el.classList.contains('page-enter-active'))
    expect(entering).toBeDefined()
    expect(entering?.classList.contains('settings-layout')).toBe(true)
    await settle()
    // and back out to a depth route slides as usual (pop -> back)
    window.history.replaceState({ position: 0 }, '')
    await router.back()
    await flushPromises()
    const back = pages().find((el) => el.classList.contains('slide-back-enter-active'))
    expect(back).toBeDefined()
  })

  it('[covers:web-browse.reduced-motion] reduced-motion では方向なしpushのfadeも無効（classなし・即時入れ替え）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    setReducedMotion(true)
    window.history.replaceState({ position: 1 }, '')
    await router.push('/categories')
    await settle()
    expect(direction.value).toBe('none')
    const current = pages()
    expect(current).toHaveLength(1)
    expect(current[0]?.classList.contains('view-page')).toBe(true)
    expect(
      Array.from(current[0]!.classList).some((c) => c.startsWith('page-') || c.startsWith('slide-')),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scroll restore (TASK-74 §4-3): a push to another page goes to the top
// through the router's scrollBehavior; a replace and a same-pageKey
// navigation must not touch the scroll at all (review H1 — vue-router calls
// scrollBehavior on replace too, and {top:0} there yanked the continuous feed
// back to its start on every scrolling id rewrite); a pop parks its saved
// position and the restore waits for BOTH the finished enter and the incoming
// page's markReady (memory history cannot deliver a savedPosition, so the
// park is driven the way scrollBehavior does it — setting pendingRestore
// directly).

describe('scroll restore (TASK-74 §4-3)', () => {
  /** scrollTo args to the effective top ({top} object or positional x, y). */
  const callTop = (call: unknown[]): number | undefined => {
    const [a, b] = call as [{ top?: number }?, number?]
    return typeof a === 'number' ? b : a?.top
  }

  afterEach(() => {
    window.history.replaceState(null, '')
    cleanup()
  })

  it('[covers:web-browse.scroll-restore] pageKey の異なる push は先頭へ・replace と同一 pageKey 内 push はスクロールさせない・保存位置は after-enter と markReady の両方が済んだ後に復元', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    window.history.replaceState({ position: 0 }, '')
    const { router } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    const scrollTo = scrollMocks().scrollTo

    // a replace within the same route (the feed's scrolling id rewrite, the
    // /search debounce): the history position is unchanged and the scroll
    // must stay exactly where it is
    scrollTo.mockClear()
    await router.replace('/receipts?from=2026-10-01&to=2026-10-31')
    await settle()
    expect(scrollTo).not.toHaveBeenCalled()

    // a push within the same page key keeps the position too: the page does
    // not remount (the list -> the feed — the feed entry self-positions at
    // its anchor panel; the ‹ parent climb is the same shape)
    scrollTo.mockClear()
    window.history.replaceState({ position: 1 }, '')
    await router.push('/receipts/101')
    await settle()
    expect(scrollTo).not.toHaveBeenCalled()

    // a replace across page keys (the ledger switch shape) must not scroll
    // either — the replace rule stands on its own, not just on the page key
    scrollTo.mockClear()
    await router.replace('/stores')
    await settle()
    expect(scrollTo).not.toHaveBeenCalled()

    // a push to another page key goes to the top through scrollBehavior
    scrollTo.mockClear()
    window.history.replaceState({ position: 2 }, '')
    await router.push('/receipts/101')
    await settle()
    expect(callTop(scrollTo.mock.calls.at(-1)!)).toBe(0)

    // a pop parks the saved position; the restore waits for the page's
    // readiness on top of the finished enter (stage 5: the pages call
    // markReady themselves, so re-arm both gates for the incoming page —
    // the parked position predates its load in the real flow). The park is
    // driven the way scrollBehavior does it (memory history never delivers
    // a savedPosition)
    window.history.replaceState({ position: 2 }, '')
    await router.back()
    await settle()
    await popSaved(router, '/receipts', '/receipts/101', 640)
    scrollTo.mockClear()
    resetPageReady()
    notifyPageEntered()
    expect(scrollTo).not.toHaveBeenCalled()
    markReady()
    expect(scrollTo).toHaveBeenCalledWith({ top: 640 })
    expect(pendingRestore.value).toBe(null)
  })

  it('[covers:web-browse.scroll-restore] markReady が1.5秒来なければ保存位置を諦める（復元しない）', async () => {
    vi.useFakeTimers()
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      resetPageReady()
      // a bare app router is enough to issue the park (no mount needed)
      const bare = createAppRouter(createMemoryHistory(), createPinia())
      await popSaved(bare, '/stores', '/receipts', 800)
      notifyPageEntered() // the enter side is done; readiness never comes
      vi.advanceTimersByTime(1500)
      expect(pendingRestore.value).toBe(null)
      markReady() // too late: nothing is parked anymore
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// TASK-164 §2-2-2 (design: tmp/tasks/tm-164/design_back_home.md v4): the
// period pop's scroll and the reservation token. A period-change pop rides a
// query-only URL change — the PATH never moves — so scrollBehavior's
// same-path branch (placed BEFORE the savedPosition branch) returns false
// without parking a reservation: the viewport keeps its place both ways of
// the round trip. A pop whose path differs (a screen change — even between
// screens sharing the first path segment, /receipts ↔ /receipts/101 or two
// axes, whose pageKey collides) parks the saved position as before. The
// reservations carry a navigation-unit generation token: every scrollBehavior
// pass advances it and the page-ready gate releases only a reservation whose
// token is still current — a stale one (a cross-screen pop's restore still
// waiting when a period pop comes in) dies unseen. Test-first: red until it
// lands.

describe('period pop scroll + reservation tokens (TASK-164 §2-2-2)', () => {
  afterEach(() => {
    window.history.replaceState(null, '')
    cleanup()
  })

  it('[covers:web-browse.period-pop-scroll] 同一pathの期間popはsavedPositionを復元しない（scroll維持・予約なし）・pathが異なるpop（pageKey同値の画面間を含む）はsavedPositionを予約する', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { router } = await mountApp('/categories?month=2026-10')
    const scrollTo = scrollMocks().scrollTo

    // the period pop: the same path, a query-only change — even WITH a
    // saved position the same-path branch (now ahead of the savedPosition
    // branch) returns false and parks nothing
    scrollTo.mockClear()
    const verdict = await popSaved(router, '/categories?month=2026-09', '/categories', 640)
    expect(verdict).toBe(false)
    expect(pendingRestore.value).toBe(null)
    expect(scrollTo).not.toHaveBeenCalled()

    // a pop whose path differs parks the saved position — and the parked
    // reservation REALLY restores through both page-ready gates, not just
    // that a reservation exists (REVIEW-12 #5): the enter gate alone does
    // not scroll, the readiness gate releases the exact parked top
    await popSaved(router, '/stores', '/categories', 320)
    expect(pendingRestore.value?.top).toBe(320)
    scrollTo.mockClear()
    resetPageReady()
    notifyPageEntered()
    expect(scrollTo).not.toHaveBeenCalled()
    markReady()
    expect(scrollTo).toHaveBeenCalledWith({ top: 320 })
    expect(pendingRestore.value).toBe(null)

    // ... including screens that SHARE the first path segment — the pageKey
    // collides (/receipts ↔ /receipts/101, two axes); the PATH decides — and
    // each parks its own top through the same gate flow
    await popSaved(router, '/receipts/101', '/receipts', 500)
    expect(pendingRestore.value?.top).toBe(500)
    scrollTo.mockClear()
    resetPageReady()
    notifyPageEntered()
    markReady()
    expect(scrollTo).toHaveBeenCalledWith({ top: 500 })
    await popSaved(router, '/axes/store/2', '/axes/category/1', 400)
    expect(pendingRestore.value?.top).toBe(400)
  })

  it('[covers:web-browse.restore-generation-token] 予約はnavigation単位token: 後続navigation（期間popのreturn false含む）で無効化された旧予約は gate 解放でも実行されず破棄される', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { router } = await mountApp('/categories?month=2026-10')
    const scrollTo = scrollMocks().scrollTo

    // a cross-screen pop parks its restore and waits for the page gates ...
    await popSaved(router, '/stores', '/categories', 640)
    expect(pendingRestore.value).not.toBe(null)
    // ... but a further navigation — here the period pop's same-path return
    // false — advances the generation: the parked reservation went stale
    await popSaved(router, '/categories?month=2026-09', '/categories', 640)
    scrollTo.mockClear()
    resetPageReady()
    notifyPageEntered()
    markReady()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(pendingRestore.value).toBe(null)

    // a CURRENT reservation still releases through both gates
    await popSaved(router, '/stores', '/categories', 240)
    scrollTo.mockClear()
    resetPageReady()
    notifyPageEntered()
    expect(scrollTo).not.toHaveBeenCalled()
    markReady()
    expect(scrollTo).toHaveBeenCalledWith({ top: 240 })
    expect(pendingRestore.value).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// TASK-171 (PR#4 review): the page fade vocabulary's in-flow contract. The
// vocabulary's own CSS comment is "out-in so the old page leaves first and
// the layout never shows both stacked" — every IN-FLOW caller (not only the
// RouterView pair and the settings tabs) must set mode="out-in": the default
// simultaneous mode stacks the leaving and entering element in flow for the
// fade's duration, and a keyed line inside a card stretches its container
// (the receipts KPI jumped two lines tall on every period step, pushing the
// content below).

describe('page vocabulary in-flow callers (TASK-171)', () => {
  it('[covers:web-shell.page-vocab-inflow-out-in] page fade語彙を in-flow の keyed 入れ替えに使うcaller（Receipts の .kpi-sub）は mode=out-in（旧・新がin-flowに並ばない）', () => {
    const receipts = src('pages/ReceiptsPage.vue')
    const sub = receipts.indexOf('class="kpi-sub"')
    expect(sub, 'the .kpi-sub summary line').toBeGreaterThan(-1)
    // the Transition opening tag wrapping the keyed summary line
    const open = receipts.lastIndexOf('<Transition', sub)
    expect(open, 'the Transition wrapping .kpi-sub').toBeGreaterThan(-1)
    const attrs = receipts.slice(open, receipts.indexOf('>', open))
    expect(attrs).toContain('name="page"')
    expect(attrs, 'the in-flow swap never stacks the old and new line').toContain('mode="out-in"')
  })
})
