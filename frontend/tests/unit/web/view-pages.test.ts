import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setDataApi, type DataApi, type StatsQuery, type StatsRow } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import RankedList from '@/web/components/RankedList.vue'
import { ME, cleanup, mockFetch, mountApp, setMediaMatches, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
  mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/** No editing control is offered on a read-only screen. */
function expectNoEditing(w: W): void {
  for (const sel of ['rename', 'move', 'archive', 'edit', 'merge', 'delete', 'create-form', 'edit-form']) {
    expect(w.find(`[data-test="${sel}"]`).exists(), sel).toBe(false)
  }
  expect(w.find('.app-main').find('input:not([type="date"]), select, textarea').exists()).toBe(false)
}

/**
 * TASK-45 + TASK-40 rev2 + TASK-75: the manage link is not a standalone
 * toolbar link; it lives in the "..." page menu (PageMenu wrapping
 * PopoverMenu) next to a second create / classification entry. The trigger
 * sits at the right end of the one-row page toolbar (BrowseToolbar's menu
 * slot, TASK-75 §6-5) — not on a standalone .page-menu row of its own. In
 * the closed state no manage-link is in the DOM at all; the trigger opens
 * role=menu holding exactly the given menuitem links (checked for role /
 * label / href) and closes again on re-press.
 */
async function expectManageLinkInMenu(w: W, items: { test: string; label: string; href: string }[]): Promise<void> {
  expect(w.find('[data-test="manage-link"]').exists()).toBe(false)
  // the "..." lives inside the one-row toolbar's menu slot and no standalone
  // .page-menu row survives the merge
  const bar = w.find('.page-toolbar')
  expect(bar.exists()).toBe(true)
  const trigger = bar.find('.page-toolbar-menu [data-test="page-menu"]')
  expect(trigger.exists()).toBe(true)
  expect(w.find('.page-menu').exists()).toBe(false)
  expect(trigger.attributes('aria-haspopup')).toBe('menu')
  expect(trigger.attributes('aria-label')).toBe('その他の操作')
  expect(trigger.classes()).toContain('page-menu-trigger')
  await trigger.trigger('click')
  await settle()
  expect(trigger.attributes('aria-expanded')).toBe('true')
  const menu = w.find('[role="menu"]')
  expect(menu.findAll('[role="menuitem"]')).toHaveLength(items.length)
  for (const { test, label, href } of items) {
    const item = menu.find(`[data-test="${test}"]`)
    expect(item.exists(), test).toBe(true)
    expect(item.attributes('role')).toBe('menuitem')
    expect(item.text()).toBe(label)
    expect(item.attributes('href')).toBe(href)
  }
  await trigger.trigger('click')
  await settle()
  expect(w.find('[role="menu"]').exists()).toBe(false)
  expect(trigger.attributes('aria-expanded')).toBe('false')
}

describe('CategoriesPage (dashboard)', () => {
  it('[covers:web-categories.dashboard][covers:web-layout.manage-link-in-menu][covers:web-browse.trend-axis-minimal] 期間の合計・カテゴリ別・推移の一覧専用画面（行押下で /categories/:top へ）、編集操作なし、管理導線は三点メニュー内', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/categories')
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_category', month: '2026-10' })
    expect(wrapper.find('[data-test="total"]').text()).toBe('948円')
    expect(wrapper.find('[data-test="row-食費"]').text()).toContain('550円')
    expect(wrapper.find('[data-test="trend-card"] [data-test="bar-2026-10"]').classes()).toContain('current')
    // TASK-42: the 12-month window spans a year boundary, so the axis ends
    // carry the full "YYYY年M月" form
    expect(wrapper.find('[data-test="trend-card"] .bar-label').exists()).toBe(false)
    expect(wrapper.find('[data-test="trend-card"] [data-test="trend-axis"]').findAll('span').map((s) => s.text())).toEqual(['2025年11月', '2026年10月'])
    expectNoEditing(wrapper)
    await expectManageLinkInMenu(wrapper, [
      { test: 'manage-link', label: 'カテゴリを管理', href: '/settings/categories?kind=item' },
      { test: 'add-top-link', label: '大分類を追加', href: '/settings/categories?kind=item&new=top' },
    ])

    // TASK-74 stage 5 (final): the same-page selection section is gone and
    // the ranking rows drill into the category detail routes — keys[0] (the
    // top category id) builds /categories/<topId> with the period carried
    // over; the 未分類 row links to /categories/uncategorized and その他
    // stays a non-link span
    expect(wrapper.find('[data-test="detail"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="clear-selection"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('カテゴリを選ぶと')
    expect(wrapper.find('[data-test="trend-card"] h2').text()).toBe('支出の推移')
    const row = wrapper.find('[data-test="row-食費"]')
    expect(row.element.tagName).toBe('A')
    expect(linkOf(row.attributes('href'))).toEqual({ path: '/categories/1', query: { month: '2026-10' } })
    expect(row.find('svg').exists()).toBe(true)
    expect(linkOf(wrapper.find('[data-test="row-日用品"]').attributes('href'))).toEqual({ path: '/categories/4', query: { month: '2026-10' } })

    // the 未分類 aggregate row (keys[0]=null) links to the uncategorized
    // carve-out, not to a numeric id — the mutation needs a reload, so the
    // month takes a round trip through the topbar period chip (which also
    // re-checks the empty previous month along the way)
    await api.updateReceipt(1, 102, { revision: 1, upsert_items: [{ item_id: 1003, category: null }] })
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="total"]').text()).toBe('0円')
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    const unc = wrapper.find('[data-test="row-未分類"]')
    expect(unc.exists()).toBe(true)
    expect(linkOf(unc.attributes('href'))).toEqual({ path: '/categories/uncategorized', query: { month: '2026-10' } })
    await router.push('/')

    // a viewer gets the manage entries but not the create one (the manage
    // screen is viewable read-only; creation stays editor-only)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] } } })
    const viewer = await mountApp('/categories')
    const vTrigger = viewer.wrapper.find('[data-test="page-menu"]')
    await vTrigger.trigger('click')
    await settle()
    expect(viewer.wrapper.find('[role="menu"] [data-test="manage-link"]').exists()).toBe(true)
    expect(viewer.wrapper.find('[role="menu"] [data-test="add-top-link"]').exists()).toBe(false)
  })

  it('[covers:web-categories.dashboard] 旧 ?category= リンクは catalog で topId に解いて /categories/:top へ replace（未解決は一覧のまま）・missing query は一覧の msg に出す', async () => {
    // a bookmark-style deep link with the legacy query: the list resolves
    // the path through the catalog and replaces into the hierarchy route
    const deep = await mountApp('/categories?category=食費/食料品')
    expect(deep.router.currentRoute.value.path).toBe('/categories/1')
    expect(deep.router.currentRoute.value.query.category).toBeUndefined()
    // the uncategorized path lands on the carve-out route
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const unc = await mountApp('/categories?category=未分類')
    expect(unc.router.currentRoute.value.path).toBe('/categories/uncategorized')
    // an unresolvable path stays on the list (no broken redirect)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stuck = await mountApp('/categories?category=存在しない')
    expect(stuck.router.currentRoute.value.path).toBe('/categories')
    // the detail page's missing redirect shows the list's message
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const missing = await mountApp('/categories?missing=999')
    expect(missing.router.currentRoute.value.path).toBe('/categories')
    const msg = missing.wrapper.find('[data-test="missing"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('見つかりません')
  })
})

describe('StoresPage (dashboard)', () => {
  it('[covers:web-stores.dashboard][covers:web-layout.manage-link-in-menu] 店別ランキングと推移の一覧専用画面（行押下で /stores/:id へ）・店カテゴリのチップ行、編集操作なし、管理導線は三点メニュー内', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper } = await mountApp('/stores')
    expect(wrapper.find('[data-test="row-Aマート"]').text()).toContain('400円')
    expectNoEditing(wrapper)
    await expectManageLinkInMenu(wrapper, [
      { test: 'manage-link', label: '店を管理', href: '/settings/stores' },
      { test: 'manage-store-categories-link', label: '店カテゴリを管理', href: '/settings/categories?kind=store' },
    ])
    // TASK-74 stage 5 (final): the ranking rows drill into /stores/:id with
    // the period carried over (keys[0] = the store id)
    expect(wrapper.find('[data-test="detail"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('店を選ぶと')
    expect(wrapper.find('[data-test="trend-card"] h2').text()).toBe('支出の推移')
    const row = wrapper.find('[data-test="row-Aマート"]')
    expect(row.element.tagName).toBe('A')
    expect(linkOf(row.attributes('href'))).toEqual({ path: '/stores/1', query: { month: '2026-10' } })
    expect(row.find('svg').exists()).toBe(true)

    // the store-category chip row (D28 §4-2): single select over the
    // catalog's store categories; the choice rides the URL and reaches
    // getStats as the store_category filter
    const chips = wrapper.findAll('[data-test="store-categories"] [data-test="store-category"]')
    expect(chips.map((c) => c.text())).toEqual(['スーパー', 'コンビニ', 'ドラッグストア'])
    expect(chips[0]!.attributes('aria-pressed')).toBe('false')
    await chips[0]!.trigger('click')
    await settle()
    // the row link keeps the period (the store's own category is fixed on
    // the detail page, so store_category does not ride the link)
    expect(linkOf(wrapper.find('[data-test="row-Aマート"]').attributes('href'))).toEqual({ path: '/stores/1', query: { month: '2026-10' } })
    expect(wrapper.find('[data-test="row-Bコンビニ"]').exists()).toBe(false)
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ report: 'by_store', store_category: 'スーパー' }))
    expect(wrapper.find('[data-test="store-categories"] [data-test="store-category"]').attributes('aria-pressed')).toBe('true')
    // pressing the selected chip again clears the filter
    await wrapper.find('[data-test="store-categories"] [data-test="store-category"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="row-Bコンビニ"]').exists()).toBe(true)
    expect(stats).toHaveBeenLastCalledWith(1, expect.not.objectContaining({ store_category: 'スーパー' }))
  })

  it('[covers:web-stores.dashboard] 旧 ?store= リンクは listStores で id に解いて /stores/:id へ replace（未解決は一覧のまま）・missing query は一覧の msg に出す', async () => {
    const deep = await mountApp('/stores?store=Aマート')
    expect(deep.router.currentRoute.value.path).toBe('/stores/1')
    expect(deep.router.currentRoute.value.query.store).toBeUndefined()
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stuck = await mountApp('/stores?store=存在しない店')
    expect(stuck.router.currentRoute.value.path).toBe('/stores')
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const missing = await mountApp('/stores?missing=999')
    const msg = missing.wrapper.find('[data-test="missing"]')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('見つかりません')
  })
})

describe('ReceiptsPage (dashboard)', () => {
  it('[covers:web-receipts.dashboard] 期間の合計・件数・平均・日別・支払方法と日付ごとの一覧、品名で絞り込み', async () => {
    const { wrapper, router } = await mountApp('/receipts')
    const summary = wrapper.find('[data-test="summary"]').text()
    expect(summary).toContain('948円')
    expect(summary).toContain('レシート 3件')
    expect(summary).toContain('1件あたり 316円')
    expect(wrapper.findAll('[data-test="daily"] .daily-col')).toHaveLength(31)
    expect(wrapper.find('[data-test="payments"]').text()).toContain('現金')
    expect(wrapper.find('[data-test="receipts"]').text()).toContain('10月10日（土）')
    // TASK-75 §6-4: the receipt rows are one line (date / store / labels /
    // amount) — no icon column, no sub line
    const row = wrapper.find('[data-test="receipt-101"] a.recent-row')
    expect(row.find('.recent-icon').exists()).toBe(false)
    expect(row.find('.recent-main').exists()).toBe(false)
    expect(row.find('[data-test="label-dot"]').exists()).toBe(true)
    expect(row.text()).toContain('10/10')
    expect(row.text()).toContain('Aマート')
    expect(row.text()).toContain('400円')
    expect(row.text()).not.toContain('品目')
    expectNoEditing(wrapper)

    await wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await wrapper.find('[data-test="item"]').setValue('牛乳')
    await wrapper.find('[data-test="filters"]').trigger('submit')
    await settle()
    expect(router.currentRoute.value.query.item).toBe('牛乳')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('レシート 1件')
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(false)
    await wrapper.find('[data-test="chip-x-item"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(true)
  })

  it('[covers:web-receipts.dashboard-link-filters] 他画面からの期間・カテゴリ・店の条件を引き継ぐ', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/receipts?from=2026-10-01&to=2026-10-31&category=日用品')
    expect(list).toHaveBeenCalledWith(1, expect.objectContaining({ from: '2026-10-01', to: '2026-10-31', category: '日用品' }))
    expect(wrapper.find('[data-test="chip-x-category"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="receipt-101"]').exists()).toBe(false)
  })

  it('[covers:web-shell.loading-skeleton] レシート一覧も初回 loading は skeleton で統一', async () => {
    const orig = api.listReceipts.bind(api)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(api, 'listReceipts').mockImplementation(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    const { wrapper } = await mountApp('/receipts')
    const sk = wrapper.find('[data-test="loading"]')
    expect(sk.exists()).toBe(true)
    expect(sk.classes()).toContain('skeleton')
    expect(wrapper.find('[data-test="summary"]').exists()).toBe(false)
    release()
    await settle()
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="summary"]').text()).toContain('948円')
  })
})

describe('ReceiptDetail (view first)', () => {
  it('[covers:web-receipts.detail-view-first] Feed の各パネルは既定で閲覧のみ、修正は明示操作、削除は修正内の危険な操作', async () => {
    const { wrapper } = await mountApp('/receipts/101')
    const p = () => wrapper.find('[data-test="receipt-panel-101"]')
    expect(p().find('[data-test="total"]').text()).toBe('400円')
    expect(p().find('[data-test="edit-form"]').exists()).toBe(false)
    expect(p().find('[data-test="delete"]').exists()).toBe(false)
    expect(p().find('input, select, textarea').exists()).toBe(false)
    // no panel of the feed starts in the edit mode
    expect(wrapper.find('.app-main').find('[data-test="edit-form"]').exists()).toBe(false)
    await p().find('[data-test="edit"]').trigger('click')
    expect(p().find('[data-test="edit-form"]').exists()).toBe(true)
    expect(p().find('[data-test="danger-zone"]').attributes('open')).toBeUndefined()
    await p().find('[data-test="cancel-edit"]').trigger('click')
    expect(p().find('[data-test="edit-form"]').exists()).toBe(false)
  })
})

describe('SettingsPage data management', () => {
  it('[covers:web-settings.data-manage-links] カテゴリ・店・ラベルの編集は設定のデータtabから開き、設定節として示す', async () => {
    const { wrapper, router } = await mountApp('/settings')
    expect(router.currentRoute.value.path).toBe('/settings/general')
    await wrapper.find('[data-test="settings-tab-data"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/settings/data')
    for (const [key, href] of [
      ['settings-data-categories', '/settings/categories'],
      ['settings-data-stores', '/settings/stores'],
      ['settings-data-labels', '/settings/labels'],
    ] as const) {
      expect(wrapper.find(`[data-test="${key}"]`).attributes('href'), key).toBe(href)
    }
    // TASK-17: the label management joins the data-management links
    await wrapper.find('[data-test="settings-data-labels"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/settings/labels')
    // the manage panels carry no page-back breadcrumb (the tab strip is the way back)
    expect(wrapper.find('.page-back').exists()).toBe(false)
    // and the manage screen lights the data tab as its way back
    expect(wrapper.find('[data-test="settings-tab-data"]').attributes('aria-current')).toBe('page')
    await router.push('/settings/categories')
    await settle()
    expect(wrapper.find('.page-back').exists()).toBe(false)

    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stores = await mountApp('/settings/data')
    await stores.wrapper.find('[data-test="settings-data-stores"]').trigger('click')
    await settle()
    expect(stores.router.currentRoute.value.path).toBe('/settings/stores')
    expect(stores.wrapper.find('.page-back').exists()).toBe(false)
    // the main nav's data sections stay inactive on a manage screen; the
    // settings entry of the sidebar's second group is the active one
    // (TASK-56) and the title and the account menu show the section too
    expect(stores.wrapper.find('.topbar-title').text()).toBe('設定')
    for (const link of stores.wrapper.findAll('[data-test="sidebar"] .side-nav > .side-link')) {
      expect(link.classes()).not.toContain('active')
    }
    expect(stores.wrapper.find('[data-test="nav-settings"]').classes()).toContain('active')
    await stores.wrapper.find('[data-test="account-button"]').trigger('click')
    const settingsItem = stores.wrapper
      .findAll('[data-test="account-menu"] [role="menuitem"]')
      .find((i) => i.text().includes('設定'))
    expect(settingsItem?.attributes('aria-current')).toBe('page')
    expect(stores.wrapper.find('[data-test="merge"]').element.tagName).toBe('DETAILS')
    expect(stores.wrapper.find('[data-test="merge"]').attributes('open')).toBeUndefined()
  })
})

/** Query of a link as a plain object, with its path. */
function linkOf(href: string | undefined): { path: string; query: Record<string, string> } {
  const u = new URL(href ?? '', 'http://localhost')
  return { path: u.pathname, query: Object.fromEntries(u.searchParams) }
}

describe('Recent receipt links (TASK-16)', () => {
  it('[covers:web-receipts.recent-links-carry-context] ホームの最近のレシートは期間と絞り込みを文脈に持つ（店・カテゴリの一覧は選択セクションなし・詳細ページが最近のレシートを持つ）', async () => {
    const PERIOD = { from: '2026-10-01', to: '2026-10-31' }
    const home = await mountApp('/')
    const h = linkOf(home.wrapper.find('[data-test="recent-101"]').attributes('href'))
    expect(h).toEqual({ path: '/receipts/101', query: PERIOD })
    // TASK-74 final form: the store / category list pages stay list-only (no
    // selection section); the recent-receipt lists live on the detail pages,
    // carrying the page's own subject in the context
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stores = await mountApp('/stores')
    expect(stores.wrapper.find('[data-test="detail"]').exists()).toBe(false)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const cats = await mountApp('/categories')
    expect(cats.wrapper.find('[data-test="detail"]').exists()).toBe(false)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const storeDetail = await mountApp('/stores/1')
    expect(linkOf(storeDetail.wrapper.find('[data-test="recent-101"]').attributes('href'))).toEqual({
      path: '/receipts/101',
      query: { ...PERIOD, store_id: '1' },
    })
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const catDetail = await mountApp('/categories/1')
    expect(linkOf(catDetail.wrapper.find('[data-test="recent-101"]').attributes('href'))).toEqual({
      path: '/receipts/101',
      query: { ...PERIOD, category: '食費' },
    })
  })
})

describe('StoresPage long names (TASK-16)', () => {
  it('[covers:web-stores.long-name-no-overflow] 長い店名は省略・折返しクラスと title を持ち、推移は .hscroll 内・店詳細の見出しも ellipsis', async () => {
    const long = 'あ'.repeat(100)
    await api.updateStore(1, 1, { name: long })
    const { wrapper } = await mountApp('/stores')
    const titled = (root: string) =>
      wrapper.findAll(`${root} [title]`).filter((e) => e.attributes('title') === long)
    // ranking row: an ellipsis / truncation class with the full name as title
    const rankName = titled('[data-test="ranking"]')
    expect(rankName.length).toBeGreaterThan(0)
    expect(rankName.some((e) => e.classes().some((c) => /ellipsis|truncate/.test(c)))).toBe(true)
    // TASK-75 §6-4 + review L2: the KPI summary is one ellipsized line — the
    // 最多 store name rides it with the full name as its title (the only way
    // to read what the ellipsis cut; no clamp class)
    const css = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8')
    expect(css).toMatch(/\.kpi-sub\s*\{[^}]*white-space: nowrap[^}]*overflow: hidden[^}]*text-overflow: ellipsis/)
    expect(wrapper.find('.kpi-sub').classes().some((c) => /clamp/.test(c))).toBe(false)
    expect(titled('.kpi-sub').length).toBeGreaterThan(0)
    // TASK-74 stage 4: no same-page selection anymore — the list page's own
    // trend card carries the hscroll
    expect(wrapper.find('[data-test="trend-card"] .hscroll [data-test="trend"]').exists()).toBe(true)

    // stage 5 final form: the detail page's heading carries the long name in
    // the ellipsizing .page-head-title (no title tooltip there — the CSS
    // keeps the row width intact with the total at the right end)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const detail = await mountApp('/stores/1')
    const title = detail.wrapper.find('.page-head-title')
    expect(title.text()).toBe(long)
    expect(title.attributes('title')).toBeUndefined()
    expect(detail.wrapper.find('.page-head-total').exists()).toBe(true)
    expect(css).toMatch(/\.page-head-title\s*\{[^}]*min-width: 0[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/)
  })
})

describe('Dashboard label filter (TASK-17/26/44)', () => {
  /** Open the topbar label chip's dialog (the toggles live in it, TASK-44). */
  async function openFilter(wrapper: W): Promise<void> {
    await wrapper.find('[data-test="filter-labels"]').trigger('click')
    await settle()
  }

  it('[covers:web-dashboard.label-filter] Home・Categories・Stores は period store に結合、ReceiptsPage は URL を補い書き戻す、Feed は URL のみ、ledger 切替で空', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router, pinia } = await mountApp('/')

    // Home: the LabelFilter button binds to the period store's labelColors
    // and both getStats and the recent-receipts listReceipts carry the filter
    await openFilter(wrapper)
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    // the recent-receipts link carries the label filter in its context
    const href = wrapper.find('[data-test="recent-101"]').attributes('href')!
    expect(new URL(href, 'http://localhost').searchParams.get('labels')).toBe('red')

    // moving to /receipts with no query: the URL is filled from the store
    await router.push('/receipts')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBe('red')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))

    // changing (or clearing) the selection on ReceiptsPage writes back
    await openFilter(wrapper)
    await wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBe('red,blue')

    // the store value survives across the dashboard screens
    await router.push('/')
    await settle()
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    for (const path of ['/categories', '/stores']) {
      await router.push(path)
      await settle()
      expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    }

    // the feed reads only the URL, never the period store
    await router.push('/receipts/101')
    await settle()
    const feedQuery = list.mock.calls.at(-1)![1] as Record<string, unknown>
    expect(feedQuery['label_colors'] ?? []).toEqual([])
    await router.push('/receipts/101?labels=blue&from=2026-10-01&to=2026-10-31')
    await settle()
    expect(list).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ label_colors: ['blue'], from: '2026-10-01', to: '2026-10-31' }),
    )

    // switching the ledger resets the filter (fresh popover on Home)
    await router.push('/')
    await settle()
    const { useSessionStore } = await import('@/web/stores/session')
    useSessionStore(pinia).selectedLedgerId = 2
    await settle()
    expect(stats).toHaveBeenLastCalledWith(2, expect.objectContaining({ label_colors: [] }))
    await openFilter(wrapper)
    expect(wrapper.find('[data-test="label-filter-red"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-test="label-filter-blue"]').attributes('aria-pressed')).toBe('false')
  })
})

describe('RankedList row rendering (TASK-74 stage 4)', () => {
  // Component-level mount with a memory router: the list pages do not wire
  // `to` until stage 5, so the link branch needs a direct prop here.
  async function mountList(props: { rows: StatsRow[]; to?: (row: StatsRow) => { path: string } | null }) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/x/:id', name: 'x', component: { template: '<div />' } }],
    })
    await router.push('/')
    return mount(RankedList, { props, global: { plugins: [router] } })
  }

  it('[covers:web-browse.ranked-row-link][covers:web-layout.ranked-row-single-line] to が非 null の行は RouterLink+行末 chevron・null と未渡しは span の非リンク行・行は1行構成（dot/label/share/diff/amount の細胞を a/span で共有・meter 無し）', async () => {
    const rows: StatsRow[] = [
      { keys: [11], labels: ['食費'], value: 550, share: 0.58, diff: 120 },
      { keys: [null], labels: ['その他'], value: 100, share: 0.1 },
    ]
    const to = (r: StatsRow) => (typeof r.keys[0] === 'number' ? { path: `/x/${r.keys[0]}` } : null)
    const w = await mountList({ rows, to })

    // a row whose `to` resolves: an anchor to the location with the trailing
    // chevron (aria-hidden svg)
    const link = w.find('[data-test="row-食費"]')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('href')).toBe('/x/11')
    expect(link.find('svg[aria-hidden="true"]').exists()).toBe(true)

    // TASK-75 §6-4 single-line cells: dot / label / share / diff / amount —
    // no meter element, no compare-label prefix on the diff
    expect(link.find('.ranked-label').text()).toBe('食費')
    expect(link.find('.ranked-label').attributes('title')).toBe('食費')
    expect(link.find('.ranked-share').text()).toBe('58%')
    expect(link.find('.ranked-diff').classes()).toContain('up')
    expect(link.find('.ranked-diff').text()).toBe('+120円')
    expect(link.find('.amount').text()).toBe('550円')
    expect(link.find('.meter').exists()).toBe(false)

    // a row whose `to` returns null (その他 / 店不明): a plain span, no
    // chevron — but the very same cell structure (the share column stays,
    // the diff cell renders empty without a diff)
    const other = w.find('[data-test="row-その他"]')
    expect(other.element.tagName).toBe('SPAN')
    expect(other.attributes('href')).toBeUndefined()
    expect(other.find('svg').exists()).toBe(false)
    expect(other.find('.ranked-label').text()).toBe('その他')
    expect(other.find('.ranked-share').text()).toBe('10%')
    expect(other.find('.ranked-diff').text()).toBe('')
    expect(other.find('.amount').text()).toBe('100円')
    expect(other.find('.meter').exists()).toBe(false)
    expect(other.find('.ranked-dot').exists()).toBe(true)

    // no `to` prop at all (the payments breakdown): every row is a span
    const w2 = await mountList({ rows })
    expect(w2.find('[data-test="row-食費"]').element.tagName).toBe('SPAN')
    expect(w2.find('[data-test="row-食費"]').find('svg').exists()).toBe(false)

    // the selection-era markup is gone: no buttons, no pressed state
    for (const ww of [w, w2]) {
      expect(ww.find('.ranked-row[aria-pressed]').exists()).toBe(false)
      expect(ww.findAll('button').length).toBe(0)
    }
  })
})

describe('CategoryDetailPage (TASK-74 stage 5)', () => {
  it('[covers:web-categories.hierarchy-route] 大カテゴリ詳細: 見出し行‹・小カテゴリランキング行は /categories/:top/:sub へ・大直付け行は非リンク・推移・最近のレシート+すべて見る', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/categories/1')
    // the page queries with the resolved category path: the sub ranking,
    // the store cross-section, the trend, the KPI and the recent receipts
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_category', month: '2026-10', category: '食費' })
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_store', month: '2026-10', category: '食費' })
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_trend', from: '2025-11-01', to: '2026-10-31', category: '食費' })
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', category: '食費' })
    expect(list).toHaveBeenCalledWith(1, { from: '2026-10-01', to: '2026-10-31', category: '食費', limit: 5 })

    // the heading row: ‹ to the list, the kind, the name and the total
    const back = wrapper.find('[data-test="page-back"]')
    expect(back.attributes('aria-label')).toBe('カテゴリ一覧へ戻る')
    expect(wrapper.find('.page-head-kind').text()).toBe('カテゴリ')
    expect(wrapper.find('.page-head-title').text()).toBe('食費')
    expect(wrapper.find('.page-head-total').text()).toBe('550円')
    expect(wrapper.find('[data-test="total"]').text()).toBe('550円')

    // the sub ranking rows link one level down (keys[0] = the sub id)
    const sub = wrapper.find('[data-test="subs"] [data-test="row-食費/食料品"]')
    expect(linkOf(sub.attributes('href'))).toEqual({ path: '/categories/1/2', query: { month: '2026-10' } })
    expect(linkOf(wrapper.find('[data-test="subs"] [data-test="row-食費/外食"]').attributes('href'))).toEqual({ path: '/categories/1/3', query: { month: '2026-10' } })

    // recent receipts of the category + すべて見る into the receipts list
    expect(wrapper.find('[data-test="recent-101"]').exists()).toBe(true)
    expect(linkOf(wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', category: '食費' } })

    // the ‹ pushes the parent list route
    await back.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/categories')

    // an item attached to the top itself (品目が大直付け): the sub ranking
    // keeps the row but it cannot link below (it IS this page)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await api.updateReceipt(1, 101, { revision: 1, upsert_items: [{ item_id: 1001, category: '食費' }] })
    const direct = await mountApp('/categories/1')
    const row = direct.wrapper.find('[data-test="subs"] [data-test="row-食費"]')
    expect(row.exists()).toBe(true)
    expect(row.element.tagName).toBe('SPAN')
    expect(row.attributes('href')).toBeUndefined()
    expect(linkOf(direct.wrapper.find('[data-test="subs"] [data-test="row-食費/食料品"]').attributes('href'))).toEqual({ path: '/categories/1/2', query: { month: '2026-10' } })
  })

  it('[covers:web-categories.hierarchy-route] 小カテゴリ詳細: 見出し行に親の名前・品目セクション（searchItems 直近20件・Feed への文脈）・小ランキングなし', async () => {
    const items = vi.spyOn(api, 'searchItems')
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/categories/1/2')
    expect(items).toHaveBeenCalledWith(1, { category: '食費/食料品', from: '2026-10-01', to: '2026-10-31', limit: 20 })
    expect(stats).not.toHaveBeenCalledWith(1, expect.objectContaining({ report: 'by_category' }))
    expect(wrapper.find('[data-test="subs"]').exists()).toBe(false)
    // the heading shows the parent beside the kind and the ‹ goes to the top
    expect(wrapper.find('[data-test="page-back"]').attributes('aria-label')).toBe('食費へ戻る')
    expect(wrapper.find('.page-head-parent').text()).toBe('食費')
    expect(wrapper.find('.page-head-title').text()).toBe('食料品')
    // the item section: 2-line rows whose press leads to the feed with the
    // category context
    const rows = wrapper.findAll('[data-test="category-item"]')
    expect(rows).toHaveLength(2)
    const joined = rows.map((r) => r.text()).join()
    expect(joined).toContain('牛乳')
    expect(joined).toContain('パン')
    expect(linkOf(rows[0]!.attributes('href'))).toEqual({ path: '/receipts/101', query: { from: '2026-10-01', to: '2026-10-31', category: '食費/食料品' } })
    await wrapper.find('[data-test="page-back"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/categories/1')
  })

  it('[covers:web-categories.hierarchy-route] 未分類は category=未分類 で照会し小ランキング・品目セクションなし', async () => {
    await api.updateReceipt(1, 102, { revision: 1, upsert_items: [{ item_id: 1003, category: null }] })
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper } = await mountApp('/categories/uncategorized')
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', category: '未分類' })
    expect(stats).not.toHaveBeenCalledWith(1, expect.objectContaining({ report: 'by_category' }))
    expect(wrapper.find('[data-test="subs"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="items"]').exists()).toBe(false)
    expect(wrapper.find('.page-head-title').text()).toBe('未分類')
    expect(wrapper.find('[data-test="total"]').text()).toBe('398円')
    expect(linkOf(wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', category: '未分類' } })
  })

  it('[covers:web-categories.hierarchy-route] 小id を大として渡すと正しいパスへ replace・catalog に無い id は一覧へ missing 付きで replace', async () => {
    const swapped = await mountApp('/categories/2')
    expect(swapped.router.currentRoute.value.path).toBe('/categories/1/2')
    expect(swapped.wrapper.find('.page-head-title').text()).toBe('食料品')
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const missing = await mountApp('/categories/999')
    expect(missing.router.currentRoute.value.path).toBe('/categories')
    expect(missing.router.currentRoute.value.query.missing).toBe('999')
    expect(missing.wrapper.find('[data-test="missing"]').text()).toContain('見つかりません')
  })

  it('[covers:web-categories.hierarchy-route] catalog 取得の失敗は msg-error に出す（unhandled rejection・永久skeleton なし）', async () => {
    // the resolve awaits catalog.load(): a failed fetch must land in the
    // page's error message, visible over the skeleton branch (view stays
    // null), never as an unhandled rejection (review M2)
    vi.spyOn(api, 'getCatalog').mockRejectedValue(new Error('catalog down'))
    const failed = await mountApp('/categories/1')
    const msg = failed.wrapper.find('[data-test="error"]')
    expect(msg.exists()).toBe(true)
    expect(msg.classes()).toContain('msg-error')
    expect(msg.text()).toContain('エラーが発生しました')
  })

  it('[covers:web-categories.hierarchy-route] ledger 切替は別bookのcatalogを解決しに行かず /categories へ replace（Feed と同じ方針）', async () => {
    const { wrapper, router, pinia } = await mountApp('/categories/1')
    expect(wrapper.find('.page-head-title').text()).toBe('食費')
    const { useSessionStore } = await import('@/web/stores/session')
    useSessionStore(pinia).selectedLedgerId = 2
    await settle()
    expect(router.currentRoute.value.path).toBe('/categories')
  })
})

describe('Category cross-section (TASK-74 stage 5)', () => {
  it('[covers:web-categories.cross-store] 「このカテゴリを買った店」は category を引き継いで店詳細へ・その他行を除く上位5件・mock の store_id/store_category・数値 keys parity', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper } = await mountApp('/categories/1')
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_store', month: '2026-10', category: '食費' })
    // the rows cross into the store detail carrying this category
    const a = wrapper.find('[data-test="by-store"] [data-test="row-Aマート"]')
    expect(a.element.tagName).toBe('A')
    expect(linkOf(a.attributes('href'))).toEqual({ path: '/stores/1', query: { category: '食費', month: '2026-10' } })
    expect(linkOf(wrapper.find('[data-test="by-store"] [data-test="row-Bコンビニ"]').attributes('href'))).toEqual({ path: '/stores/3', query: { category: '食費', month: '2026-10' } })

    // the cap: a 7-row by_store response still renders at most 5 link rows
    // (the stub goes on after cleanup() — it restores mocks)
    const orig = api.getStats.bind(api)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'getStats').mockImplementation(async (l: number, q: StatsQuery) => {
      const res = await orig(l, q)
      if (q.report === 'by_store') {
        const extra = [11, 12, 13, 14, 15].map((i) => ({ keys: [i], labels: [`店${i}`], value: i, share: 0.01 }))
        res.sections[0]!.rows = [...res.sections[0]!.rows, ...extra]
      }
      return res
    })
    const capped = await mountApp('/categories/1')
    expect(capped.wrapper.findAll('[data-test="by-store"] .ranked-row')).toHaveLength(5)
    expect(capped.wrapper.find('[data-test="by-store"] [data-test="row-店5"]').exists()).toBe(false)

    // mock parity (backend ranked_section): numeric row keys, the exact
    // store_id match and the store_category path filter (orig — the stub
    // above still decorates api.getStats)
    const byStore = await orig(1, { report: 'by_store', month: '2026-10' })
    expect(byStore.sections[0]!.rows.map((r) => r.keys[0])).toEqual([1, 2, 3])
    const byCat = await orig(1, { report: 'by_category', month: '2026-10' })
    expect(byCat.sections[0]!.rows.map((r) => r.keys[0])).toEqual([1, 4])
    expect((await orig(1, { report: 'monthly_overview', month: '2026-10', store_id: 1 })).totals.value).toBe(400)
    expect((await orig(1, { report: 'monthly_overview', month: '2026-10', store_category: 'スーパー' })).totals.value).toBe(400)
    expect((await orig(1, { report: 'monthly_overview', month: '2026-10', store_id: 999 })).totals.value).toBe(0)
  })
})

describe('Detail context carry (TASK-74 stage 5)', () => {
  it('[covers:web-browse.context-carry] 掛け合わせ・labels はチップで × は replace で外す・下の階層とすべて見るへ引き継がれ store_category はすべて見るに乗らない', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/categories/1?store_id=3&month=2026-10')
    // the KPI carries the cross filter
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', category: '食費', store_id: 3 })
    // the chip row: the self category (no x) and the store name
    const chips = wrapper.find('[data-test="page-chips"]')
    expect(chips.text()).toContain('カテゴリ: 食費')
    expect(chips.text()).toContain('店: Bコンビニ')
    expect(wrapper.find('[data-test="chip-x-category"]').exists()).toBe(false)
    // the context rides the links down a level and into the receipts list
    // (the store filter narrows the sub ranking to Bコンビニ's 外食 row)
    expect(linkOf(wrapper.find('[data-test="subs"] [data-test="row-食費/外食"]').attributes('href'))).toEqual({ path: '/categories/1/3', query: { store_id: '3', month: '2026-10' } })
    expect(linkOf(wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', category: '食費', store_id: '3' } })
    // the store chip x: replace drops the key and the KPI widens (150 -> 550)
    expect(wrapper.find('[data-test="total"]').text()).toBe('150円')
    await wrapper.find('[data-test="chip-x-store"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query.store_id).toBeUndefined()
    expect(stats.mock.calls.at(-1)![1]!.store_id).toBeUndefined()
    expect(wrapper.find('[data-test="total"]').text()).toBe('550円')

    // a label chip x drops the labels key the same way
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const lb = await mountApp('/categories/1?labels=blue&month=2026-10')
    expect(lb.wrapper.find('[data-test="page-chips"]').text()).toContain('blue')
    await lb.wrapper.find('[data-test="chip-x-label-blue"]').trigger('click')
    await settle()
    expect(lb.router.currentRoute.value.query.labels).toBeUndefined()
    expect(lb.wrapper.find('[data-test="total"]').text()).toBe('550円')

    // the store_category 掛け合わせ: a chip, a filtered KPI, and never on
    // the すべて見る link
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const scStats = vi.spyOn(api, 'getStats')
    const sc = await mountApp('/categories/1?store_category=スーパー')
    expect(scStats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', category: '食費', store_category: 'スーパー' })
    expect(sc.wrapper.find('[data-test="page-chips"]').text()).toContain('店カテゴリ: スーパー')
    expect(linkOf(sc.wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', category: '食費' } })
    await sc.wrapper.find('[data-test="chip-x-store_category"]').trigger('click')
    await settle()
    expect(sc.router.currentRoute.value.query.store_category).toBeUndefined()
    expect(scStats.mock.calls.at(-1)![1]!.store_category).toBeUndefined()
  })
})

describe('StoreDetailPage (TASK-74 stage 5)', () => {
  it('[covers:web-stores.detail-route] 店詳細: KPI store_id 完全一致・「この店で買ったカテゴリ」のクロス集計（未分類行は uncategorized へ）・店情報は KPI 側・推移・最近のレシート+すべて見る', async () => {
    // an uncategorized item inside an Aマート receipt exercises the 未分類
    // cross row
    await api.updateReceipt(1, 101, { revision: 1, upsert_items: [{ item_id: 1001, category: null }] })
    const stats = vi.spyOn(api, 'getStats')
    const list = vi.spyOn(api, 'listReceipts')
    const storesSpy = vi.spyOn(api, 'listStores')
    const { wrapper, router } = await mountApp('/stores/1')
    expect(storesSpy).toHaveBeenCalledWith(1)
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', store_id: 1 })
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_category', month: '2026-10', store_id: 1 })
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ report: 'monthly_trend', store_id: 1 }))
    expect(list).toHaveBeenCalledWith(1, { from: '2026-10-01', to: '2026-10-31', store_id: 1, limit: 5 })

    // the heading row: ‹ to the list, the store name, its category as sub
    expect(wrapper.find('[data-test="page-back"]').attributes('aria-label')).toBe('店一覧へ戻る')
    expect(wrapper.find('.page-head-title').text()).toBe('Aマート')
    expect(wrapper.find('.page-head-sub').text()).toBe('スーパー')
    expect(wrapper.find('[data-test="total"]').text()).toBe('400円')
    // TASK-75 §6-4: the detail KPI is the one-line summary only (the total
    // lives in the heading row) — the store info folds into that line
    expect(wrapper.find('[data-test="kpi"] .kpi-value').exists()).toBe(false)
    const storeSub = wrapper.find('[data-test="kpi"] .kpi-sub').text()
    expect(storeSub).toContain('レシート ')
    expect(storeSub).toContain('累計件数')
    expect(storeSub).toContain('最終購入日')
    expect(wrapper.find('[data-test="kpi"]').text()).toContain('10/10')

    // the cross rows carry this store into the category detail; the 未分類
    // row takes the uncategorized carve-out
    expect(linkOf(wrapper.find('[data-test="by-category"] [data-test="row-食費"]').attributes('href'))).toEqual({ path: '/categories/1', query: { store_id: '1', month: '2026-10' } })
    expect(linkOf(wrapper.find('[data-test="by-category"] [data-test="row-未分類"]').attributes('href'))).toEqual({ path: '/categories/uncategorized', query: { store_id: '1', month: '2026-10' } })

    // recent receipts + すべて見る
    expect(wrapper.find('[data-test="recent-101"]').exists()).toBe(true)
    expect(linkOf(wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', store_id: '1' } })
    await wrapper.find('[data-test="page-back"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/stores')
  })

  it('[covers:web-stores.detail-route] catalog に無い store id は /stores?missing= へ replace・クロス集計は5行まで・category 掛け合わせはチップから外せる', async () => {
    const missing = await mountApp('/stores/999')
    expect(missing.router.currentRoute.value.path).toBe('/stores')
    expect(missing.router.currentRoute.value.query.missing).toBe('999')
    expect(missing.wrapper.find('[data-test="missing"]').text()).toContain('見つかりません')

    // the 5-row cap on the category cross-section (stub after cleanup())
    const orig = api.getStats.bind(api)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'getStats').mockImplementation(async (l: number, q: StatsQuery) => {
      const res = await orig(l, q)
      if (q.report === 'by_category') {
        const extra = [21, 22, 23, 24, 25].map((i) => ({ keys: [i], labels: [`Cat${i}`], value: i, share: 0.01 }))
        res.sections[0]!.rows = [...res.sections[0]!.rows, ...extra]
      }
      return res
    })
    const capped = await mountApp('/stores/1')
    expect(capped.wrapper.findAll('[data-test="by-category"] .ranked-row')).toHaveLength(5)

    // the category 掛け合わせ (from a category page's cross row): a chip
    // that removes through replace and re-queries
    cleanup()
    vi.restoreAllMocks()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stats = vi.spyOn(api, 'getStats')
    const withCat = await mountApp('/stores/1?category=食費/食料品&labels=red')
    expect(stats).toHaveBeenCalledWith(1, { report: 'monthly_overview', month: '2026-10', store_id: 1, category: '食費/食料品', label_colors: ['red'] })
    expect(withCat.wrapper.find('[data-test="page-chips"]').text()).toContain('カテゴリ: 食費/食料品')
    expect(linkOf(withCat.wrapper.find('[data-test="all-receipts"]').attributes('href'))).toEqual({ path: '/receipts', query: { month: '2026-10', store_id: '1', category: '食費/食料品', labels: 'red' } })
    await withCat.wrapper.find('[data-test="chip-x-category"]').trigger('click')
    await settle()
    expect(withCat.router.currentRoute.value.query.category).toBeUndefined()
    expect(stats.mock.calls.at(-1)![1]!.category).toBeUndefined()
  })

  it('[covers:web-stores.detail-route] listStores 取得失敗は msg-error に出す（unhandled rejection・永久skeleton なし）', async () => {
    // the resolve awaits listStores(): a failed fetch must land in the page's
    // error message, visible over the skeleton branch (store stays null),
    // never as an unhandled rejection (review M2)
    vi.spyOn(api, 'listStores').mockRejectedValue(new Error('stores down'))
    const failed = await mountApp('/stores/1')
    const msg = failed.wrapper.find('[data-test="error"]')
    expect(msg.exists()).toBe(true)
    expect(msg.classes()).toContain('msg-error')
    expect(msg.text()).toContain('エラーが発生しました')
  })

  it('[covers:web-stores.detail-route] ledger 切替は旧ledgerの店名・店カテゴリを残さず /stores へ replace（Feed と同じ方針）', async () => {
    // switching the book on the detail page must not keep showing the old
    // ledger's resolved store (its name / category may not exist there)
    const { wrapper, router, pinia } = await mountApp('/stores/1')
    expect(wrapper.find('.page-head-title').text()).toBe('Aマート')
    expect(wrapper.find('.page-head-sub').text()).toBe('スーパー')
    const { useSessionStore } = await import('@/web/stores/session')
    useSessionStore(pinia).selectedLedgerId = 2
    await settle()
    expect(router.currentRoute.value.path).toBe('/stores')
  })
})

describe('Detail page resilience (TASK-74 review)', () => {
  it('[covers:web-stores.dashboard] StoresPage の catalog 取得失敗は msg-error に出す（unhandled rejection なし・ランキングはそのまま）', async () => {
    // the store-category chip row needs the catalog; a failed fetch surfaces
    // through the page's error message while the ranking keeps working
    vi.spyOn(api, 'getCatalog').mockRejectedValue(new Error('catalog down'))
    const { wrapper } = await mountApp('/stores')
    const msg = wrapper.find('[data-test="error"]')
    expect(msg.exists()).toBe(true)
    expect(msg.classes()).toContain('msg-error')
    expect(wrapper.find('[data-test="row-Aマート"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="store-categories"]').exists()).toBe(false)
  })

  it('[covers:web-browse.context-carry] 詳細2ページの labels チップは title 定義を優先表示する（色keyの生表示はしない）', async () => {
    // a defined label title shows on the chip (the ReceiptsPage filter-chip
    // form); the removal key stays the color (review L4)
    await api.updateLabelTitle(1, 'blue', { title: '旅行' })
    const cat = await mountApp('/categories/1?labels=blue&month=2026-10')
    const catChips = cat.wrapper.find('[data-test="page-chips"]')
    expect(catChips.text()).toContain('旅行')
    expect(catChips.text()).not.toContain('blue')
    expect(cat.wrapper.find('[data-test="chip-x-label-blue"]').exists()).toBe(true)

    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const store = await mountApp('/stores/1?labels=blue&month=2026-10')
    const storeChips = store.wrapper.find('[data-test="page-chips"]')
    expect(storeChips.text()).toContain('旅行')
    expect(storeChips.text()).not.toContain('blue')
    expect(store.wrapper.find('[data-test="chip-x-label-blue"]').exists()).toBe(true)
  })
})

describe('ReceiptsPage 絞り込み popover (TASK-76 §6-3)', () => {
  it('[covers:web-receipts.filter-popover] フォームは本文のインライン折りたたみでなくツールバー絞り込みボタンの PopoverPanel（role=dialog）: 開いても本文を消費せず、適用で閉じ URL 同期、Escape・外側押下・480px 以下の scrim で閉じトリガへ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/receipts', { attach: true })
    const toggle = () => wrapper.find('[data-test="filters-toggle"]')
    // closed: neither the dialog nor the form is in the DOM — the old inline
    // fold used to put data-test=filters in the page body only while open,
    // and even then it consumed body lines; both are gone
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="filters"]').exists()).toBe(false)
    expect(toggle().attributes('aria-expanded')).toBe('false')
    expect(toggle().classes()).toContain('toolbar-filter-btn')

    // opening grows only the dialog: the form lives inside it, hosted on the
    // toolbar row's popover, so nothing is added below the toolbar
    await toggle().trigger('click')
    await settle()
    const dialog = wrapper.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(toggle().attributes('aria-expanded')).toBe('true')
    expect(toggle().attributes('aria-controls')).toBe(dialog.attributes('id'))
    expect(dialog.find('[data-test="filters"]').exists()).toBe(true)
    expect(dialog.find('[data-test="store"]').exists()).toBe(true)
    expect(dialog.find('[data-test="item"]').exists()).toBe(true)
    expect(dialog.find('[data-test="category"]').exists()).toBe(true)
    expect(dialog.find('[data-test="include-deleted"]').exists()).toBe(true)
    expect(wrapper.find('.page-toolbar [role="dialog"]').exists()).toBe(true)
    expect(wrapper.find('.view-page > [data-test="filters"]').exists()).toBe(false)

    // apply: the dialog closes and the same URL sync + re-query narrow the
    // list (the filter behavior itself is unchanged)
    await dialog.find('[data-test="item"]').setValue('牛乳')
    await dialog.find('[data-test="filters"]').trigger('submit')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(router.currentRoute.value.query.item).toBe('牛乳')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('レシート 1件')
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(false)

    // Escape closes and returns the focus to the trigger (usePopover)
    await toggle().trigger('click')
    await settle()
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(toggle().element)

    // a pointer press outside the popover closes it too
    await toggle().trigger('click')
    await settle()
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)

    // through 480px the sheet-narrow variant shows the scrim; its click
    // closes the dialog the same way
    cleanup()
    setMediaMatches('(max-width: 480px)', true)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const narrow = await mountApp('/receipts', { attach: true })
    await narrow.wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await settle()
    const scrim = narrow.wrapper.find('.popover-scrim')
    expect(scrim.exists()).toBe(true)
    await scrim.trigger('click')
    await settle()
    expect(narrow.wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(narrow.wrapper.find('.popover-scrim').exists()).toBe(false)
  })
})
