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
import { useSessionStore } from '@/web/stores/session'
import { cleanup, ME, mockFetch, mountApp, settle } from './helpers'

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

  it('[covers:web-shell.page-transition] RouterView は page transition で包む（shell・public・branch 切替・設定tab の内側）', () => {
    const app = src('App.vue')
    // 3 = the shell RouterView, the public RouterView and the shell/public
    // branch swap itself (login -> home flips the v-if, which the inner
    // RouterView transitions never see)
    expect(app.match(/name="page"/g)).toHaveLength(3)
    expect(app.match(/mode="out-in"/g)).toHaveLength(3)
    // the branch swap is wrapped: the outermost Transition comes before the
    // v-if / v-else branch roots
    expect(app.indexOf('<Transition')).toBeLessThan(app.indexOf('v-if="showShell'))
    const settings = src('pages/SettingsPage.vue')
    expect(settings.match(/name="page"/g)).toHaveLength(1)
    expect(settings).toContain('mode="out-in"')
    // the swapped component carries the route key: a switch between two
    // routes that share a component still remounts under the transition
    expect(settings).toMatch(/<component\s+:is="Component"\s+:key=/)
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
    const statsCalls = () => fetches.calls.filter((c) => c.path.startsWith('/api/ledgers/1/stats'))
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
    expect(publicRoot.querySelector('[data-test="kpi"]')).toBe(null)
    expect(document.querySelector('.shell')).toBe(null)
    await leaveDone()
    expect(publicRoot.isConnected).toBe(false)
    expect(document.querySelector('.shell')).not.toBe(null)
    // home mounted exactly once — the leaving branch never fetched
    await settle()
    expect(statsCalls()).toHaveLength(1)
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
