import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, fireMediaChange, mockFetch, mountApp, setMediaMatches, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

describe('HomePage (dashboard)', () => {
  it('[covers:web-home.dashboard-month-overview] 今月の支出・前月比・内訳・推移・店・最近のレシート', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getStats')
    const { wrapper } = await mountApp('/')
    expect(spy).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10' })
    expect(wrapper.find('[data-test="month"]').text()).toBe('2026年10月')
    expect(wrapper.find('[data-test="total"]').text()).toBe('948円')
    expect(wrapper.find('[data-test="receipt-count"]').text()).toContain('3 件')
    expect(wrapper.find('[data-test="diff"]').text()).toContain('+948円')
    // legend: top category first, same order as the ring
    const legend = wrapper.find('[data-test="categories"]').findAll('li')
    expect(legend[0]!.text()).toContain('食費')
    expect(legend[0]!.text()).toContain('550円')
    expect(legend[1]!.text()).toContain('日用品')
    expect(wrapper.findAll('[data-test="trend"] .bar-col')).toHaveLength(6)
    expect(wrapper.find('[data-test="trend"] .bar-col.current').text()).toContain('10月')
    expect(wrapper.find('[data-test="stores"]').text()).toContain('Aマート')
    // the link carries the period context (web-receipts.recent-links-carry-context)
    const recent = new URL(wrapper.find('[data-test="recent-101"]').attributes('href')!, 'http://localhost')
    expect(recent.pathname).toBe('/receipts/101')
  })

  it('[covers:web-home.dashboard-month-switch] 前月へ切替で空表示、未来の月へは進めない', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    expect(wrapper.find('[data-test="month-next"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="month-prev"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="month"]').text()).toBe('2026年9月')
    expect(wrapper.find('[data-test="total"]').text()).toBe('0円')
    expect(wrapper.find('[data-test="recent"]').text()).toContain('ChatGPT でレシートの写真を送ると')
    expect(wrapper.find('[data-test="month-next"]').attributes('disabled')).toBeUndefined()
  })

  it('[covers:web-shell.loading-skeleton] 初回 loading は dash-grid 同形の skeleton（aria-hidden + sr-only 文言）、再取得は既存 grid の dim', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const orig = api.getStats.bind(api)
    let release!: () => void
    let gate = new Promise<void>((r) => (release = r))
    vi.spyOn(api, 'getStats').mockImplementation(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    const { wrapper } = await mountApp('/')
    // first load: the dash-grid silhouette, decorative blocks aria-hidden,
    // the loading state itself stays readable (sr-only)
    const sk = wrapper.find('[data-test="loading"]')
    expect(sk.exists()).toBe(true)
    expect(sk.classes()).toContain('skeleton')
    expect(sk.attributes('aria-hidden')).toBe('true')
    expect(sk.find('.sr-only').text()).toBe('読み込んでいます...')
    expect(wrapper.find('[data-test="kpi"]').exists()).toBe(false)
    release()
    await settle()
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="total"]').text()).toBe('948円')

    // reload (month switch): the loaded grid stays and dims, no skeleton
    gate = new Promise((r) => (release = r))
    await wrapper.find('[data-test="month-prev"]').trigger('click')
    await settle()
    const grid = wrapper.find('.dash-grid')
    expect(grid.classes()).toContain('loading')
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
    release()
    await settle()
    expect(wrapper.find('.dash-grid').classes()).not.toContain('loading')
  })
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/** Items of the top-right account menu (open it first). */
function accountItems(w: W) {
  return w.findAll('[data-test="account-menu"] [role="menuitem"]')
}

function keydown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** jsdom exposes `inert` as a property or only as an attribute. */
const isInert = (el: Element | undefined) =>
  !!el && ((el as HTMLElement).inert === true || el.hasAttribute('inert'))

describe('App shell', () => {
  it('[covers:web-shell.navigation] 主ナビはデータ4節（sidebar に brand 見出しなし）、表題は SECTION_TITLES からアイコン併記、設定は右上メニューで示す', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    const side = wrapper.find('[data-test="sidebar"]')
    for (const n of ['home', 'receipts', 'categories', 'stores']) {
      expect(side.find(`[data-test="nav-${n}"] svg`).exists()).toBe(true)
    }
    expect(side.findAll('.side-link')).toHaveLength(4)
    // the sidebar is nav + user only: no brand heading (TASK-27)
    expect(side.find('.sidebar-head').exists()).toBe(false)
    expect(side.find('a.brand').exists()).toBe(false)
    expect(wrapper.find('[data-test="nav-settings"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="nav-apps"]').exists()).toBe(false)
    expect(side.find('[data-test="nav-home"]').classes()).toContain('active')
    const tabbar = wrapper.find('[data-test="tabbar"]')
    const tabs = tabbar.findAll('a')
    expect(tabs.map((t) => t.text())).toEqual(['ホーム', 'レシート', 'カテゴリ', '店'])
    for (const t of tabs) expect(t.find('svg').exists()).toBe(true)
    expect(tabbar.attributes('style')).toMatch(/--tab-count:\s*4/)
    // home: no page title in the top bar (neither text nor icon)
    const homeTitle = wrapper.find('.topbar-title')
    expect(homeTitle.exists() ? homeTitle.text() : '').toBe('')
    expect(wrapper.find('.topbar-title svg').exists()).toBe(false)

    await router.push('/settings')
    await settle()
    // the settings screen shows; the account number is nowhere in the web UI
    // (TASK-38 real-device follow-up removed the display itself)
    expect(wrapper.find('[data-test="settings-nav"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="account-number"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="kpi"]').exists()).toBe(false)
    expect(wrapper.find('.topbar-title').text()).toBe('設定')
    // the title carries the section icon (TASK-35), identified by its path d
    // like the menu-button glyph check above
    const settingsSvg = wrapper.find('.topbar-title svg')
    expect(settingsSvg.exists()).toBe(true)
    expect(settingsSvg.attributes('aria-hidden')).toBe('true')
    expect(settingsSvg.html()).toContain('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z') // the "settings" gear
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))
    expect(settingsItem?.attributes('aria-current')).toBe('page')
    // the receipt detail belongs to the receipts section
    await router.push('/receipts/101')
    await settle()
    expect(wrapper.find('[data-test="nav-receipts"]').classes()).toContain('active')
    expect(wrapper.find('.topbar-title').text()).toBe('レシート')
    const receiptsSvg = wrapper.find('.topbar-title svg')
    expect(receiptsSvg.exists()).toBe(true)
    expect(receiptsSvg.attributes('aria-hidden')).toBe('true')
    expect(receiptsSvg.html()).toContain('M5 3h14v18l-2.5-1.5') // the "receipt" glyph
  })

  it('[covers:web-shell.menus] 左上 menu ボタンで drawer を開閉（aria・アイコン・フォーカス・inert・scrim）、右上アカウントメニューからログアウト', async () => {
    const f = mockFetch({
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
      'POST /api/auth/logout': { status: 204 },
    })
    const { wrapper, router } = await mountApp('/receipts/101', { attach: true })
    const topbar = wrapper.find('header.topbar')
    const menuBtn = () => wrapper.find('[data-test="menu-button"]')
    expect(topbar.element.firstElementChild?.getAttribute('data-test')).toBe('menu-button')
    // closed: the button offers to open the drawer it controls
    expect(menuBtn().attributes('aria-controls')).toBe('app-sidebar')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを開く')
    expect(menuBtn().find('svg').html()).toContain('M4 6h16') // the "menu" glyph

    // open: the same button at the same spot becomes the close control
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('true')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを閉じる')
    expect(menuBtn().find('svg').html()).toContain('M6 6l12 12') // the "close" glyph
    // focus lands on the active section's link (receipts, not the first item)
    expect(document.activeElement).toBe(wrapper.find('[data-test="nav-receipts"]').element)
    // no separate close button; the content columns are inert, the topbar is not
    expect(wrapper.find('.drawer-close').exists()).toBe(false)
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(true)
    expect(isInert(topbar.element)).toBe(false)

    // Escape closes and returns the focus to the menu button
    keydown('Escape')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを開く')
    expect(document.activeElement).toBe(menuBtn().element)

    // a section without a nav entry (settings): the first link takes the focus
    await router.push('/settings')
    await settle()
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(document.activeElement).toBe(wrapper.find('[data-test="nav-home"]').element)
    // the scrim closes too (through closeDrawer, so the focus returns)
    await wrapper.find('.scrim').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(document.activeElement).toBe(menuBtn().element)

    // pressing the button while open closes it as well
    await menuBtn().trigger('click')
    await settle()
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(document.activeElement).toBe(menuBtn().element)

    // navigating to another route closes the drawer
    await menuBtn().trigger('click')
    await settle()
    await router.push('/stores')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('false')

    // ledger switching is the LedgerSwitcher, not a select
    expect(wrapper.find('[data-test="ledger-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(true)

    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
    const accountBtn = wrapper.find('[data-test="account-button"]')
    expect(accountBtn.attributes('aria-haspopup')).toBe('menu')
    await accountBtn.trigger('click')
    expect(wrapper.find('[data-test="account-menu"]').text()).not.toContain(ME.account_number)
    expect(wrapper.find('[data-test="account-menu"]').text()).toContain(ME.display_name)
    const labels = accountItems(wrapper).map((i) => i.text().trim())
    // TASK-37: 使い方 sits between the apps item and logout
    expect(labels).toHaveLength(4)
    expect(labels[0]).toContain('設定')
    expect(labels[1]).toContain('接続中のアプリ')
    expect(labels[2]).toContain('使い方')
    expect(labels[3]).toContain('ログアウト')
    await wrapper.find('[data-test="menu-logout"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/auth/logout')).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/login')
    // the shell is gone with the route swap (atomic logout, TASK-39)
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="login"]').exists()).toBe(true)
  })

  it('[covers:web-shell.nav-open-state-on-resize] 900px 以上へリサイズしてもナビは開いたまま（modal 効果の inert・drawer-lock は解ける）、desktop のボタンで同じ overlay を閉じ・開ける', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    await wrapper.find('[data-test="menu-button"]').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(true)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(true)
    // crossing into desktop (>= 900px) keeps the open state: the sidebar
    // stays open as the desktop overlay and only the mobile-only modal
    // effects (inert, drawer-lock, scrim) end — the open flag survives
    fireMediaChange('(min-width: 900px)', true)
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(true)
    expect(isInert(wrapper.find('.main-col').element)).toBe(false)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(false)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(false)
    // on desktop the same button slides the overlay closed and back (the
    // old grid-column fold / sidebar-collapsed class is gone)
    const btn = wrapper.find('[data-test="menu-button"]')
    expect(btn.attributes('aria-expanded')).toBe('true')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-label')).toBe('メニューを開く')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(btn.attributes('aria-label')).toBe('メニューを閉じる')
    // crossing back below 900px with the sidebar open restores the modal
    // effects — the state itself never reset
    fireMediaChange('(min-width: 900px)', false)
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(isInert(wrapper.find('.main-col').element)).toBe(true)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(true)
  })

  it('[covers:web-shell.sidebar-overlay] desktop は初期 open・非モーダル（scrim 担当なし・inert・drawer-lock なし・遷移と Escape では閉じない）', async () => {
    // mount inside the desktop viewport class: the shell starts open
    setMediaMatches('(min-width: 900px)', true)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    // the desktop overlay is not modal: main stays interactive
    expect(isInert(wrapper.find('.main-col').element)).toBe(false)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(false)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(false)
    // navigating from the sidebar leaves it open (it is persistent there)
    await wrapper.find('[data-test="nav-stores"]').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    // Escape (on the sidebar, where the handler lives) does not close it
    keydown('Escape', wrapper.find('[data-test="sidebar"]').element)
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    // the menu button is the one way to slide it closed and back
    const btn = wrapper.find('[data-test="menu-button"]')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(btn.attributes('aria-label')).toBe('メニューを開く')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(btn.attributes('aria-label')).toBe('メニューを閉じる')
  })

  it('[covers:web-shell.menus-stay-on-query-change] receipt ルート内の id 変化・query だけの変化ではメニューを閉じない', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/receipts/101')
    // account menu stays open across the feed's own URL updates
    await wrapper.find('[data-test="account-button"]').trigger('click')
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)
    await router.replace('/receipts/102?from=2026-10-01&to=2026-10-31')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(true)
    // the drawer too
    await wrapper.find('[data-test="menu-button"]').trigger('click')
    await router.replace('/receipts/103?from=2026-10-01&to=2026-10-31')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')

    // the ledger switcher stays open on a query-only change
    await router.push('/receipts')
    await settle()
    await wrapper.find('[data-test="ledger-switch"]').trigger('click')
    expect(wrapper.find('[data-test="ledger-menu"]').exists()).toBe(true)
    await router.replace({ path: '/receipts', query: { item: '牛乳' } })
    await settle()
    expect(wrapper.find('[data-test="ledger-menu"]').exists()).toBe(true)

    // another path closes everything
    await router.push('/stores')
    await settle()
    expect(wrapper.find('[data-test="ledger-menu"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')

    // a menu item click closes the menu explicitly
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))!
    await settingsItem.trigger('click')
    await settle()
    expect(wrapper.find('[data-test="account-menu"]').exists()).toBe(false)
  })

  it('[covers:web-shell.popover-menu] PopoverMenu: 矢印キー移動・Escape・外側クリックで閉じフォーカスはトリガへ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    // the top-right account menu is a PopoverMenu with four items (TASK-37
    // added 使い方)
    const trigger = () => wrapper.find('[data-test="account-button"]')
    ;(trigger().element as HTMLElement).focus()
    await trigger().trigger('click')
    await settle()
    const menu = wrapper.find('[role="menu"]')
    expect(menu.exists()).toBe(true)
    expect(trigger().attributes('aria-expanded')).toBe('true')
    const items = () => wrapper.findAll('[role="menu"] [role^="menuitem"]').map((i) => i.element)
    expect(items()).toHaveLength(4)
    keydown('ArrowDown')
    await settle()
    expect(document.activeElement).toBe(items()[0])
    keydown('ArrowDown')
    await settle()
    expect(document.activeElement).toBe(items()[1])
    keydown('ArrowUp')
    await settle()
    expect(document.activeElement).toBe(items()[0])
    keydown('Escape')
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger().element)
    expect(trigger().attributes('aria-expanded')).toBe('false')

    // outside click
    await trigger().trigger('click')
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    const outside = wrapper.find('.app-main').element
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger().element)
  })
})

describe('Brand logo (TASK-16 / TASK-27)', () => {
  it('[covers:web-shell.topbar-logo-responsive] topbar に full と compact を出し分けクラス付きで両方、sidebar にロゴ無し', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // both variants sit in the topbar behind their show/hide classes
    // (the 520px switch over these classes is checked in styles.test.ts)
    for (const { sel, word } of [
      { sel: '.topbar-logo-full', word: 'Kakei' },
      { sel: '.topbar-logo-compact', word: 'kb' },
    ] as const) {
      const logos = wrapper.findAll(`header.topbar ${sel}`)
      expect(logos, sel).toHaveLength(1)
      expect(logos[0]!.attributes('role')).toBe('img')
      expect(logos[0]!.attributes('aria-label')).toBe('kakeiboot')
      // the topbar full logo shortens its wordmark to "Kakei" (word prop);
      // the login-screen logo outside the header keeps the default "kakeiboot"
      expect(logos[0]!.find('.logo-word').text(), sel).toBe(word)
    }
    // the sidebar carries neither a brand link nor a logo
    expect(wrapper.find('[data-test="sidebar"] a.brand').exists()).toBe(false)
    expect(wrapper.find('[data-test="sidebar"] [aria-label="kakeiboot"]').exists()).toBe(false)
  })
})
