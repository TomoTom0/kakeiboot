import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

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

describe('CategoriesPage (dashboard)', () => {
  it('[covers:web-categories.dashboard] 期間の合計・カテゴリ別・推移、選択で内訳とレシート、編集操作なし', async () => {
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/categories')
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_category', month: '2026-10' })
    expect(wrapper.find('[data-test="total"]').text()).toBe('948円')
    expect(wrapper.find('[data-test="row-食費"]').text()).toContain('550円')
    expect(wrapper.find('[data-test="trend-card"] [data-test="bar-2026-10"]').classes()).toContain('current')
    expectNoEditing(wrapper)
    expect(wrapper.find('[data-test="manage-link"]').attributes('href')).toBe('/settings/categories')

    await wrapper.find('[data-test="row-食費"]').trigger('click')
    await settle()
    const detail = wrapper.find('[data-test="detail"]')
    expect(detail.find('[data-test="sub-rows"]').text()).toContain('食料品')
    expect(detail.find('[data-test="sub-rows"]').text()).toContain('外食')
    expect(wrapper.find('[data-test="trend-card"] h2').text()).toBe('食費の推移')
    expect(stats).toHaveBeenCalledWith(1, { report: 'by_category', month: '2026-10', category: '食費' })
    const link = detail.find('[data-test="detail-receipts"]').attributes('href')!
    expect(decodeURIComponent(link)).toBe('/receipts?from=2026-10-01&to=2026-10-31&category=食費')

    // the previous month has no records (the period moves via the topbar's
    // period chip now; the page's own PeriodBar is gone, TASK-44 §11-5)
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="total"]').text()).toBe('0円')
    await router.push('/')
  })
})

describe('StoresPage (dashboard)', () => {
  it('[covers:web-stores.dashboard] 店別ランキング、選択で推移・買ったもの・レシート、編集操作なし', async () => {
    const { wrapper } = await mountApp('/stores')
    expect(wrapper.find('[data-test="row-Aマート"]').text()).toContain('400円')
    expectNoEditing(wrapper)
    expect(wrapper.find('[data-test="manage-link"]').attributes('href')).toBe('/settings/stores')
    await wrapper.find('[data-test="row-Aマート"]').trigger('click')
    await settle()
    const detail = wrapper.find('[data-test="detail"]')
    expect(detail.find('[data-test="store-categories"]').text()).toContain('食費')
    expect(detail.text()).toContain('スーパー')
    expect(wrapper.find('[data-test="trend-card"] h2').text()).toBe('Aマートの推移')
  })
})

describe('ReceiptsPage (dashboard)', () => {
  it('[covers:web-receipts.dashboard] 期間の合計・件数・平均・日別・支払方法と日付ごとの一覧、品名で絞り込み', async () => {
    const { wrapper, router } = await mountApp('/receipts')
    const summary = wrapper.find('[data-test="summary"]').text()
    expect(summary).toContain('948円')
    expect(summary).toContain('3 件')
    expect(summary).toContain('316円')
    expect(wrapper.findAll('[data-test="daily"] .daily-col')).toHaveLength(31)
    expect(wrapper.find('[data-test="payments"]').text()).toContain('現金')
    expect(wrapper.find('[data-test="receipts"]').text()).toContain('10月10日（土）')
    expectNoEditing(wrapper)

    await wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await wrapper.find('[data-test="item"]').setValue('牛乳')
    await wrapper.find('[data-test="filters"]').trigger('submit')
    await settle()
    expect(router.currentRoute.value.query.item).toBe('牛乳')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('1 件')
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(false)
    await wrapper.find('[data-test="clear-item"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(true)
  })

  it('[covers:web-receipts.dashboard-link-filters] 他画面からの期間・カテゴリ・店の条件を引き継ぐ', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/receipts?from=2026-10-01&to=2026-10-31&category=日用品')
    expect(list).toHaveBeenCalledWith(1, expect.objectContaining({ from: '2026-10-01', to: '2026-10-31', category: '日用品' }))
    expect(wrapper.find('[data-test="clear-category"]').exists()).toBe(true)
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
    // the main nav has no settings item: the title and the account menu show the section
    expect(stores.wrapper.find('.topbar-title').text()).toBe('設定')
    for (const link of stores.wrapper.findAll('[data-test="sidebar"] .side-link')) {
      expect(link.classes()).not.toContain('active')
    }
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
  it('[covers:web-receipts.recent-links-carry-context] ホーム・店・カテゴリの最近のレシートは期間と絞り込みを文脈に持つ', async () => {
    const PERIOD = { from: '2026-10-01', to: '2026-10-31' }
    const home = await mountApp('/')
    const h = linkOf(home.wrapper.find('[data-test="recent-101"]').attributes('href'))
    expect(h).toEqual({ path: '/receipts/101', query: PERIOD })
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stores = await mountApp('/stores')
    await stores.wrapper.find('[data-test="row-Aマート"]').trigger('click')
    await settle()
    const sLinks = stores.wrapper.findAll('[data-test="detail"] .recent-list a')
    expect(sLinks.length).toBeGreaterThan(0)
    for (const a of sLinks) {
      const l = linkOf(a.attributes('href'))
      expect(l.path).toMatch(/^\/receipts\/\d+$/)
      expect(l.query).toEqual({ ...PERIOD, store: 'Aマート' })
    }
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const cats = await mountApp('/categories')
    await cats.wrapper.find('[data-test="row-食費"]').trigger('click')
    await settle()
    const cLinks = cats.wrapper.findAll('[data-test="detail"] .recent-list a')
    expect(cLinks.length).toBeGreaterThan(0)
    for (const a of cLinks) {
      const l = linkOf(a.attributes('href'))
      expect(l.path).toMatch(/^\/receipts\/\d+$/)
      expect(l.query).toEqual({ ...PERIOD, category: '食費' })
    }
  })
})

describe('StoresPage long names (TASK-16)', () => {
  it('[covers:web-stores.long-name-no-overflow] 長い店名は省略・折返しクラスと title を持ち、推移は .hscroll 内', async () => {
    const long = 'あ'.repeat(100)
    await api.updateStore(1, 1, { name: long })
    const { wrapper } = await mountApp('/stores')
    const titled = (root: string) =>
      wrapper.findAll(`${root} [title]`).filter((e) => e.attributes('title') === long)
    // ranking row: an ellipsis / truncation class with the full name as title
    const rankName = titled('[data-test="ranking"]')
    expect(rankName.length).toBeGreaterThan(0)
    expect(rankName.some((e) => e.classes().some((c) => /ellipsis|truncate/.test(c)))).toBe(true)
    // kpi "最多": a line-clamp class with the full name as title
    const kpiName = titled('.kpi-sub')
    expect(kpiName.length).toBeGreaterThan(0)
    expect(kpiName.some((e) => e.classes().some((c) => /clamp/.test(c)))).toBe(true)

    await wrapper.find(`[data-test="row-${long}"]`).trigger('click')
    await settle()
    expect(wrapper.find('[data-test="trend-card"] .hscroll [data-test="trend"]').exists()).toBe(true)
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
