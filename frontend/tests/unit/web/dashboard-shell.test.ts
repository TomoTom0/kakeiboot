import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import PeriodHeader from '@/web/components/PeriodHeader.vue'
import RankedList from '@/web/components/RankedList.vue'
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

describe('HomePage (dashboard, TASK-89 redesign)', () => {
  it('[covers:web-home.period-header] 期間ヘッダ: 期間label+特大合計のみ（対比・diff・KPIカード形式なし）でanalysis は1fetch', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/')
    // the three loads: the category analysis (the period header total and
    // the breakdown), the stacked trend and the recent receipts
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(1, { axis: 'category', metric: 'amount', month: '2026-10', limit: 50 })
    expect(trendSpy).toHaveBeenCalledWith(1, {
      axis: 'category',
      metric: 'amount',
      granularity: 'month',
      from: '2026-05-01',
      to: '2026-10-31',
      limit: 5,
    })
    // the period header: the period label and the big total — no compare
    // selector, no diff values, no KPI card
    const head = wrapper.find('.period-head')
    expect(head.find('.period-label').text()).toBe('2026年10月の支出')
    expect(head.find('[data-test="period-total"]').text()).toBe('948円')
    expect(wrapper.find('[data-test="compare-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-test^="compare-diff-"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="kpi"]').exists()).toBe(false)
    expect(wrapper.find('.kpi-value').exists()).toBe(false)
  })

  it('[covers:web-home.zone-headings-sr-only] zone見出しはsr-only（視覚見出し語なし）・誘導はicon link（aria-label+chevron）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // the zone headings live in the DOM for the document outline / screen
    // readers but carry the sr-only class — the page shows no heading text
    const headings = wrapper.findAll('.zone h2.sr-only')
    expect(headings.map((h) => h.text())).toEqual(['支出の推移', '支出の内訳', '最近のレシート'])
    // the section links are icon-only (chevron), not word links
    const cat = wrapper.find('[data-test="breakdown-more"]')
    expect(cat.attributes('aria-label')).toBe('カテゴリ別に見る')
    expect(new URL(cat.attributes('href')!, 'http://localhost').pathname).toBe('/categories')
    const all = wrapper.find('[data-test="recent-more"]')
    expect(all.attributes('aria-label')).toBe('すべて見る')
    expect(new URL(all.attributes('href')!, 'http://localhost').pathname).toBe('/receipts')
    expect(wrapper.find('.zone h2:not(.sr-only)').exists()).toBe(false)
  })


  it('[covers:web-home.breakdown-rest-row] 内訳ランキング: 上位5行+「ほか n件・計xx円」の残余集計行（上位行と同じ形式・非リンク）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // seven top categories this month (five extra items on receipt 102)
    await api.updateReceipt(1, 102, {
      revision: 1,
      upsert_items: [
        { item_id: 1003, category: '日用品' },
        { name: 'シャンプー', amount: 300, category: '日用品' },
        { name: '電池', amount: 200, category: '交通費' },
        { name: '雑誌', amount: 350, category: '趣味' },
        { name: 'ティッシュ', amount: 150, category: null },
        { name: '歯ブラシ', amount: 120, category: null },
        { name: 'ガム', amount: 120, category: 'その他' },
      ],
    })
    const { wrapper } = await mountApp('/')
    const rows = wrapper.findAll('[data-test="breakdown"] .ranked-row')
    // six real categories (日用品698・食費550・趣味350・未分類270・交通費200・
    // その他120) fold into top-5 + the rest row (その他 120)
    expect(rows.length).toBe(6)
    const rest = rows.at(-1)!
    // REVIEW-13 M-1: the exact rest-row text — formatYen already appends 円
    // (the old label doubled it) and the amount cell holds the rest amount,
    // never the truncated row count
    expect(rest.find('.ranked-label').text()).toBe('ほか 1件・計120円')
    expect(rest.find('.amount').text()).toBe('120円')
    expect(rest.element.tagName).not.toBe('A')
    // the top rows keep their drill links into /axes/category/<id>
    expect(new URL(rows[0]!.attributes('href')!, 'http://localhost').pathname).toBe('/axes/category/4')
  })

  it('[covers:web-home.stacked-trend-fixed] 推移カード: 積み上げ金額の1形固定（mode/metric chromeなし・セグメントは金額表記）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const card = wrapper.find('[data-test="trend-card"]')
    // no mode / metric chrome anywhere in the card (TASK-95: the chart is
    // the only expression — total height = the period total, colors = the
    // composition, no word tabs)
    expect(card.find('[data-test="trend-stacked"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-total"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-metric-count"]').exists()).toBe(false)
    expect(card.find('[data-test="trend-metric-unit"]').exists()).toBe(false)
    // every column is the stacked money view: the current month holds both
    // series segments, each titled with the money format
    const col = card.find('[data-test="bar-2026-10"]')
    expect(col.classes()).toContain('stacked')
    const segs = col.findAll('.bar-seg')
    expect(segs.length).toBe(2)
    expect(segs.some((s) => (s.attributes('title') ?? '').endsWith('円'))).toBe(true)
    // the current bar's value label is the money total (compressed form)
    expect(col.find('.bar-val').exists()).toBe(true)
  })

  it('[covers:web-home.trend-day-bar-receipts] 日粒度の棒は button で押下可・押下でその日のレシート一覧（/receipts?from=d&to=d）へ・月棒は period 移動', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/')
    // month mode: 6 month bars, a press moves the shared period
    await wrapper.find('[data-test="bar-2026-05"]').trigger('click')
    await settle()
    const store = (await import('@/web/stores/period')).usePeriodStore()
    expect(store.month).toBe('2026-05')
    // week mode: 7 day bars as buttons; the 10-10 bar routes to that day
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const week = await mountApp('/?week=2026-10-05')
    const bar = week.wrapper.find('[data-test="bar-2026-10-10"]')
    expect(bar.element.tagName).toBe('BUTTON')
    expect(bar.classes()).toContain('bar-btn')
    await bar.trigger('click')
    await settle()
    expect(week.router.currentRoute.value.path).toBe('/receipts')
    expect(week.router.currentRoute.value.query).toMatchObject({ from: '2026-10-10', to: '2026-10-10' })
    void router
  })

  it('[covers:web-home.trend-granularity][covers:web-browse.trend-axis-minimal] 推移は期間の粒度に追従（月/年=月棒・range は 62/366 日閾値）・軸ラベルは両端のみ・値ラベルは current のみ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    // month mode: a 6-month window, no per-bar labels, axis ends only
    expect(wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(6)
    expect(wrapper.find('[data-test="bar-2026-10"]').classes()).toContain('current')
    expect(wrapper.find('[data-test="trend-card"] .bar-val').exists()).toBe(true)
    expect(wrapper.find('[data-test="trend-axis"]').findAll('span').map((s) => s.text())).toEqual(['5月', '10月'])
    // a 13-day range gives day bars (the analysis trend endpoint ships the
    // buckets; the span rules live in trendGranularity/spanGranularity)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const range = await mountApp('/?from=2026-10-03&to=2026-10-15')
    expect(range.wrapper.findAll('[data-test="trend-card"] .bar-col')).toHaveLength(13)
    expect(range.wrapper.find('[data-test="trend-axis"]').findAll('span').map((s) => s.text())).toEqual(['10/3', '10/15'])
  })

  it('[covers:web-shell.loading-skeleton] 初回 loading は view-stack 同形の skeleton（aria-hidden + sr-only 文言）、再取得は既存 stack の dim', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const resolvers: ((v: never) => void)[] = []
    vi.spyOn(api, 'getAnalysis').mockImplementation(
      () => new Promise((r) => resolvers.push(r)) as never,
    )
    const { wrapper } = await mountApp('/')
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="loading"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.find('[data-test="loading"] .sr-only').text()).toContain('読み込んでいます')
    for (const r of resolvers) r({} as never)
    await settle()
    // the settled load drops the skeleton (the empty object fails the
    // data check and renders nothing — the skeleton is gone either way)
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
  })

  it('[covers:web-dashboard.label-filter] topbar ラベルチップは Home の analysis 再取得へ label_colors で流れる', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const { wrapper } = await mountApp('/')
    expect(spy).not.toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    await wrapper.find('[data-test="filter-labels"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'], limit: 50 }))
  })
})

describe('PeriodHeader (component)', () => {
  it('期間labelと合計のみを描画する（diff・選択器の部位を持たない）', () => {
    const w = mount(PeriodHeader, {
      props: {
        label: '2026年10月の支出',
        total: 948,
      },
    })
    expect(w.find('.period-label').text()).toBe('2026年10月の支出')
    expect(w.find('[data-test="period-total"]').text()).toBe('948円')
    expect(w.find('[data-test^="compare-"]').exists()).toBe(false)
  })
})

describe('RankedList (component)', () => {
  it('残余行は to が null を返す行として span（非リンク）・上位行は RouterLink', () => {
    const w = mount(RankedList, {
      props: {
        rows: [
          { keys: [1], labels: ['食費'], value: 550, share: 0.58 },
          { keys: [null], labels: ['ほか 2件・計270円'], value: 270, share: undefined },
        ],
        to: (r) => (typeof r.keys[0] === 'number' ? { path: '/axes/category/1' } : null),
      },
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>', props: ['to'] },
        },
      },
    })
    expect(w.findAll('.ranked-row')[0]!.element.tagName).toBe('A')
    expect(w.findAll('.ranked-row')[1]!.element.tagName).toBe('SPAN')
  })
})

function accountItems(w: VueWrapper) {
  return w.findAll('[data-test="account-menu"] [role="menuitem"]')
}

function keydown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

/** jsdom exposes `inert` as a property or only as an attribute. */
const isInert = (el: Element | undefined) =>
  !!el && ((el as HTMLElement).inert === true || el.hasAttribute('inert'))

describe('App shell', () => {
  it('[covers:web-shell.navigation] 主ナビはデータ4節＋区切り付きで設定（sidebar に brand 見出しなし）、表題は SECTION_TITLES からアイコン併記', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    const side = wrapper.find('[data-test="sidebar"]')
    for (const n of ['home', 'receipts', 'categories', 'stores']) {
      expect(side.find(`[data-test="nav-${n}"] svg`).exists()).toBe(true)
    }
    // TASK-56: the sidebar's side-links are the four data sections plus the
    // settings entry of the separated second group
    expect(side.findAll('.side-link')).toHaveLength(5)
    // the sidebar is nav + user only: no brand heading (TASK-27)
    expect(side.find('.sidebar-head').exists()).toBe(false)
    expect(side.find('a.brand').exists()).toBe(false)
    expect(wrapper.find('[data-test="nav-apps"]').exists()).toBe(false)
    expect(side.find('[data-test="nav-home"]').classes()).toContain('active')
    // the tabbar keeps the four data sections only (TASK-56)
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

  it('[covers:web-shell.sidebar-settings-nav] sidebar 主 nav の下に区切り付きの設定 nav（tabbar とアカウントメニューは不変）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    const side = wrapper.find('[data-test="sidebar"]')
    // the settings link rides in a separated second group under the main nav
    const settingsLink = side.find('[data-test="nav-settings"]')
    expect(settingsLink.exists()).toBe(true)
    expect(settingsLink.attributes('href')).toBe('/settings')
    expect(settingsLink.classes()).toContain('side-link')
    expect(settingsLink.find('svg').exists()).toBe(true)
    expect(settingsLink.text()).toBe('設定')
    expect(side.find('.side-nav-secondary').exists()).toBe(true)
    // the settings link rides in the separated second group inside the same
    // nav (below the four data links), and home is not active while on /
    expect(side.find('.side-nav [data-test="nav-settings"]').exists()).toBe(true)
    expect(side.find('.side-nav > [data-test="nav-settings"]').exists()).toBe(false)
    expect(side.find('.side-nav-secondary [data-test="nav-settings"]').exists()).toBe(true)
    // on / the home entry is active and the settings entry is not
    expect(side.find('[data-test="nav-home"]').classes()).toContain('active')
    expect(settingsLink.classes()).not.toContain('active')

    // pressing it navigates to /settings and the entry turns active
    await settingsLink.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/settings/general')
    expect(wrapper.find('[data-test="nav-settings"]').classes()).toContain('active')
    // the manage screens inherit the settings section (TASK-74) — active too
    await router.push('/settings/labels')
    await settle()
    expect(wrapper.find('[data-test="nav-settings"]').classes()).toContain('active')

    // the tabbar keeps the four data tabs and the account menu keeps its
    // settings item (TASK-56: no removal, both entries live on)
    const tabbar = wrapper.find('[data-test="tabbar"]')
    expect(tabbar.findAll('a')).toHaveLength(4)
    expect(tabbar.attributes('style')).toMatch(/--tab-count:\s*4/)
    expect(tabbar.find('[data-test="nav-settings"]').exists()).toBe(false)
    await wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = accountItems(wrapper).find((i) => i.text().includes('設定'))
    expect(settingsItem?.attributes('aria-current')).toBe('page')
  })

  it('[covers:web-shell.section-from-meta] section・ledgerScoped は route.meta から（/search の表題・ledger スコープ・nav active・manage-* の settings 継承）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/search')
    // the /search title was empty since TASK-41: the section now comes from
    // route.meta and SECTION_TITLES carries search (TASK-74 §4-2)
    expect(wrapper.find('.topbar-title').text()).toBe('検索')
    expect(wrapper.find('.topbar-title svg').exists()).toBe(true)
    // search joins the ledger-scoped browsing routes: the switcher shows
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(true)
    expect(wrapper.find('header.topbar').classes()).toContain('ledger-scoped')
    // search is no nav section: none of the four tabs claims it
    for (const n of ['home', 'receipts', 'categories', 'stores']) {
      expect(wrapper.find(`[data-test="nav-${n}"]`).classes()).not.toContain('active')
    }
    // the browsing routes carry their section / depth / ledgerScoped meta
    // (TASK-74 §4-2 route table; the hierarchy routes landed in stage 5)
    const m = (p: string) => router.resolve(p).meta
    expect(m('/')).toMatchObject({ section: 'home', depth: 1, ledgerScoped: true })
    expect(m('/receipts')).toMatchObject({ section: 'receipts', depth: 1, ledgerScoped: true })
    expect(m('/receipts/101')).toMatchObject({ section: 'receipts', depth: 2, ledgerScoped: true })
    expect(m('/categories')).toMatchObject({ section: 'categories', depth: 1, ledgerScoped: true })
    expect(m('/axes/category/1')).toMatchObject({ section: 'categories', depth: 2, ledgerScoped: true })
    expect(m('/axes/category/1/2')).toMatchObject({ section: 'categories', depth: 3, ledgerScoped: true })
    expect(m('/axes/category/uncategorized')).toMatchObject({ section: 'categories', depth: 2, ledgerScoped: true })
    expect(m('/stores')).toMatchObject({ section: 'stores', depth: 1, ledgerScoped: true })
    expect(m('/axes/store/1')).toMatchObject({ section: 'stores', depth: 2, ledgerScoped: true })
    // the name-keyed axes light the home section (their lists do not exist)
    expect(m('/axes/item/牛乳')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/axes/label/red')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/axes/payment/cash')).toMatchObject({ section: 'home', depth: 2, ledgerScoped: true })
    expect(m('/search')).toMatchObject({ section: 'search', depth: 1, ledgerScoped: true })
    // manage-* inherits the settings section from the /settings parent record
    // but keeps the ledger scope; the plain settings tabs have no scope
    expect(m('/settings/categories')).toMatchObject({ section: 'settings', ledgerScoped: true })
    expect(m('/settings/general').section).toBe('settings')
    expect(m('/settings/general').ledgerScoped).toBeFalsy()
    expect(m('/apps').section).toBe('apps')
    expect(m('/usage/connect').section).toBe('usage')

    // the manage screen keeps the settings title with its switcher; usage is
    // not ledger scoped
    await router.push('/settings/categories')
    await settle()
    expect(wrapper.find('.topbar-title').text()).toBe('設定')
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(true)
    await router.push('/usage')
    await settle()
    expect(wrapper.find('.topbar-title').text()).toBe('使い方')
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(false)
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
    // (TASK-52: the glyph points where the panel goes — a left chevron, not
    // the close X that read as a second hamburger)
    await menuBtn().trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    expect(menuBtn().attributes('aria-expanded')).toBe('true')
    expect(menuBtn().attributes('aria-label')).toBe('メニューを閉じる')
    expect(menuBtn().find('svg').html()).toContain('M15 18l-6-6 6-6') // the "chevron-left" glyph
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

    // a section without a nav entry (usage): the first link takes the focus
    // (settings gained its own sidebar entry in TASK-56)
    await router.push('/usage')
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

  it('[covers:web-shell.nav-open-state-on-resize][covers:web-shell.sidebar-default-closed] 900px 以上へリサイズしてもナビは開いたまま（modal 効果の inert・drawer-lock は解ける）、desktop のボタンで同じ overlay を閉じ・開ける（初期は全幅で閉じている）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    // TASK-89: the drawer starts closed at every width (desktop default-open
    // is gone)
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    expect(wrapper.find('[data-test="menu-button"]').attributes('aria-expanded')).toBe('false')
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

  it('[covers:web-shell.sidebar-overlay][covers:web-shell.sidebar-default-closed] desktop の初期は closed・開ければ非モーダル（inert・drawer-lock なし）だが scrim 外タップ・Escape・遷移でも閉じる（TASK-89）', async () => {
    // mount inside the desktop viewport class: the shell starts closed
    setMediaMatches('(min-width: 900px)', true)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/', { attach: true })
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    const btn = wrapper.find('[data-test="menu-button"]')
    expect(btn.attributes('aria-expanded')).toBe('false')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    // the desktop overlay is not modal: main stays interactive
    expect(isInert(wrapper.find('.main-col').element)).toBe(false)
    expect(isInert(wrapper.find('[data-test="tabbar"]').element)).toBe(false)
    expect(document.documentElement.classList.contains('drawer-lock')).toBe(false)
    // TASK-89: the scrim shows at every width now — an outside tap closes
    // the desktop overlay too
    await wrapper.find('.scrim').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    // Escape closes it as well (the topbar carries the handler)
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).toContain('drawer-open')
    keydown('Escape', wrapper.find('[data-test="sidebar"]').element)
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
    // and a navigation from the sidebar closes it (no persistent overlay)
    await btn.trigger('click')
    await settle()
    await wrapper.find('[data-test="nav-stores"]').trigger('click')
    await settle()
    expect(wrapper.find('.shell').classes()).not.toContain('drawer-open')
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
