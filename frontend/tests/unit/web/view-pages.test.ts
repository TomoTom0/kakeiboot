import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setDataApi, type DataApi, type StatsRow } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import RankedList from '@/web/components/RankedList.vue'
import { ME, cleanup, mockFetch, mountApp, patchTrackWidth, setMediaMatches, settle } from './helpers'

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

describe('CategoriesPage (list, TASK-89 redesign)', () => {
  it('[covers:web-layout.manage-link-in-menu] 期間ヘッダ+積み上げ推移+全量ランキング（残余は「ほか n件・計xx円」）・行押下で /axes/category/<top> へ・管理導線は三点メニュー内', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const { wrapper } = await mountApp('/categories?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, { axis: 'category', metric: 'amount', month: '2026-10', limit: 50 })
    // the period header with the whole-ledger totals
    expect(wrapper.find('[data-test="period-total"]').text()).toBe('948円')
    // the full ranking: 食費 550 / 日用品 398 (no folded row — only 2 real
    // categories this month), rows drill into the axis detail routes
    const rows = wrapper.findAll('[data-test="ranking"] .ranked-row')
    expect(rows[0]!.text()).toContain('食費')
    expect(rows[0]!.text()).toContain('550円')
    expect(new URL(rows[0]!.attributes('href')!, 'http://localhost').pathname).toBe('/axes/category/1')
    // the period context rides the link
    const url = new URL(rows[0]!.attributes('href')!, 'http://localhost')
    expect(url.searchParams.get('month')).toBe('2026-10')
    // the trend card: the stacked money view, no mode / metric chrome
    expect(wrapper.find('[data-test="trend-card"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="trend-card"] .bar-col.stacked').length).toBeGreaterThan(0)
    expect(wrapper.find('[data-test="trend-stacked"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="trend-metric-count"]').exists()).toBe(false)
    // the manage entries live behind the "..." menu only
    await expectManageLinkInMenu(wrapper, [
      { test: 'manage-link', label: 'カテゴリを管理', href: '/settings/categories?kind=item' },
      { test: 'add-top-link', label: '大分類を追加', href: '/settings/categories?kind=item&new=top' },
    ])
  })

  it('missing query は一覧の msg に出す（軸詳細の不在 id redirect の着地）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/categories?missing=999')
    expect(wrapper.find('[data-test="missing"]').text()).toContain('見つかりません')
  })

  it('truncated_rows>0 の残余行: 「ほか n件・計xx円」で金額セルは残余金額（件数を金額にしない・二重円なし）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const base = await api.getAnalysis(1, { axis: 'category', month: '2026-10' })
    // 2 real rows (食費 550・日用品 398) and 3 values beyond the cap; the
    // period total leaves 600 for the folded tail (REVIEW-13 M-1)
    vi.spyOn(api, 'getAnalysis').mockResolvedValue({
      ...base,
      totals: { ...base.totals, amount: 1548 },
      truncated_rows: 3,
    })
    const { wrapper } = await mountApp('/categories?month=2026-10')
    const rest = wrapper.find('[data-test="ranking"]').findAll('.ranked-row').at(-1)!
    expect(rest.find('.ranked-label').text()).toBe('ほか 3件・計600円')
    expect(rest.find('.amount').text()).toBe('600円')
    expect(rest.text()).not.toContain('円円')
    expect(rest.element.tagName).not.toBe('A')
  })

  // TASK-146 §3 #6 (web-common.content-swap): the content transition fires at
  // the load COMMIT — mid-refetch the old content stays dimmed with the swap
  // key unmoved. TASK-161 §2 (web-common.period-move-voice, 指摘3): a PERIOD
  // step never slides/remounts the pane anymore — the committedKey drops the
  // period range, so the commit renders in place (same pane node, no
  // slide-back classes). Written test-first.
  it('[covers:web-common.period-move-voice][covers:web-common.content-swap] 期間stepの内容遷移は pane を再mountしない（再取得中は旧内容の dim・確定時もslide classなし・同一DOM）', async () => {
    let gated = false
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const orig = api.getAnalysis.bind(api)
    vi.spyOn(api, 'getAnalysis').mockImplementation(async (...args: Parameters<typeof orig>) => {
      if (gated) await gate
      return orig(...args)
    })
    const { wrapper } = await mountApp('/categories', { attach: true, stubs: { transition: false } })
    const swapEl = () => wrapper.find('.view-stack .content-swap')
    expect(swapEl().exists()).toBe(true)
    // step back through the period dialog; the re-fetch is held at the gate
    gated = true
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('.view-stack').classes()).not.toContain('loading')
    const paneBefore = swapEl().element.firstElementChild
    release()
    await flushPromises()
    // the commit lands in place: no slide vocabulary, the SAME pane node
    // (the period change never bumps the committedKey)
    const kids = Array.from(swapEl().element.children)
    expect(
      kids.some((el) =>
        Array.from(el.classList).some((c) => c.includes('-enter-') || c.includes('-leave-')),
      ),
    ).toBe(false)
    expect(swapEl().element.firstElementChild).toBe(paneBefore)
    await settle()
    expect(wrapper.find('.period-label').text()).toBe('2026年9月')
  })
})

describe('StoresPage (list, TASK-89 redesign)', () => {
  it('[covers:web-layout.manage-link-in-menu] 店別の期間ヘッダ+推移+全量ランキング・店カテゴリのチップ行で絞り込み・行押下で /axes/store/<id> へ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const { wrapper } = await mountApp('/stores?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, { axis: 'store', metric: 'amount', month: '2026-10', limit: 50 })
    expect(wrapper.find('[data-test="period-total"]').text()).toBe('948円')
    const rows = wrapper.findAll('[data-test="ranking"] .ranked-row')
    expect(rows[0]!.text()).toContain('Aマート')
    expect(new URL(rows[0]!.attributes('href')!, 'http://localhost').pathname).toBe('/axes/store/1')
    // the store-category chip row narrows the ranking through the query
    const chips = wrapper.findAll('[data-test="store-category"]')
    expect(chips.map((c) => c.text())).toEqual(['スーパー', 'コンビニ', 'ドラッグストア'])
    await chips[0]!.trigger('click')
    await settle()
    expect(spy).toHaveBeenLastCalledWith(1, expect.objectContaining({ axis: 'store', store_category: 'スーパー' }))
    // Bコンビニ (not a スーパー) drops out of the ranking
    expect(wrapper.find('[data-test="row-Bコンビニ"]').exists()).toBe(false)
    await wrapper.findAll('[data-test="store-category"]')[0]!.trigger('click')
    await settle()
    expect(spy).toHaveBeenLastCalledWith(1, expect.objectContaining({ axis: 'store', limit: 50 }))
  })

  it('truncated_rows>0 の残余行: 金額セルは残余金額で「ほか n件・計xx円」（REVIEW-13 M-1）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const base = await api.getAnalysis(1, { axis: 'store', month: '2026-10' })
    // 3 real stores (Aマート 400・エーマート 398・Bコンビニ 150 = 948) and 2
    // values beyond the cap; the period total leaves 300 for the tail
    vi.spyOn(api, 'getAnalysis').mockResolvedValue({
      ...base,
      totals: { ...base.totals, amount: 1248 },
      truncated_rows: 2,
    })
    const { wrapper } = await mountApp('/stores?month=2026-10')
    const rest = wrapper.find('[data-test="ranking"]').findAll('.ranked-row').at(-1)!
    expect(rest.find('.ranked-label').text()).toBe('ほか 2件・計300円')
    expect(rest.find('.amount').text()).toBe('300円')
    expect(rest.text()).not.toContain('円円')
  })
})

describe('AxisDetailPage (TASK-89 §1-(5))', () => {
  it('[covers:web-axis.unified-skeleton][covers:web-browse.trend-month-window][covers:web-axis.page-back-removed] 大カテゴリ: 同一骨格（PageHead・期間ヘッダ・チップ・推移・交差ランキング・最近の明細）で sidebar のカテゴリ節が active・推移は6か月窓', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper } = await mountApp('/axes/category/1?month=2026-10')
    // the cross fetch (store axis, category narrowed) and the sub ranking
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'store', category: '食費' }))
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'category', category: '食費', limit: 50 }))
    // the trend rides the 6-month window in month mode
    expect(trendSpy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'category', granularity: 'month', from: '2026-05-01', to: '2026-10-31' }))
    // the skeleton parts all draw
    // TASK-164 §2-4/§2-6: the PageHead ‹ is gone (the topbar ‹ took the
    // axis back over — the heading row itself stays: kind label / name / total)
    expect(wrapper.find('.page-head [data-test="page-back"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="topbar-back"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="total"]').text()).toBe('550円')
    expect(wrapper.find('[data-test="axis-period"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="axis-period"]').find('[data-test="period-total"]').text()).toBe('550円')
    expect(wrapper.find('[data-test="trend-card"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="cross"]').text()).toContain('このカテゴリを買った店')
    expect(wrapper.find('[data-test="recent"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="own"]').text()).toContain('小カテゴリ別')
    // the sidebar's category entry stays active on the detail
    expect(wrapper.find('[data-test="nav-categories"]').classes()).toContain('active')
  })

  it('[covers:web-axis.category-hierarchy] 小カテゴリ行の押下で /axes/category/1/2 へ・小分類は品目一覧・未分類は carve-out（小ランキング・品目なし）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/axes/category/1?month=2026-10')
    // the sub rows drill into the pair route with the period context
    const sub = wrapper.find('[data-test="own"] [data-test="row-食費/食料品"]')
    expect(new URL(sub.attributes('href')!, 'http://localhost').pathname).toBe('/axes/category/1/2')
    await sub.trigger('click')
    await settle()
    // the sub page shows the item list instead of the sub ranking
    expect(wrapper.find('[data-test="own"]').text()).toContain('品目')
    expect(wrapper.find('[data-test="own"]').text()).toContain('牛乳')
    // a top-attached row (食費 itself) has no level below — non-link
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const again = await mountApp('/axes/category/1?month=2026-10')
    void again
    // the uncategorized carve-out: no sub ranking, no item list
    const unc = await mountApp('/axes/category/uncategorized?month=2026-10')
    expect(unc.wrapper.find('[data-test="own"]').exists()).toBe(false)
    expect(unc.wrapper.find('[data-test="total"]').exists()).toBe(true)
  })

  it('[covers:web-axis.unified-skeleton][covers:web-axis.page-back-removed] 店・品目・ラベル・支払の軸も同骨格（名前keyは解決処理なしで空データでも骨格描画・PageHead ‹ なし/topbar ‹ あり）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const store = await mountApp('/axes/store/1?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'category', store_id: 1 }))
    expect(store.wrapper.find('[data-test="cross"]').text()).toContain('この店で買ったカテゴリ')
    expect(store.wrapper.find('[data-test="nav-stores"]').classes()).toContain('active')
    expect(store.wrapper.find('.page-head [data-test="page-back"]').exists()).toBe(false)
    expect(store.wrapper.find('[data-test="topbar-back"]').exists()).toBe(true)
    // the name-keyed axes resolve nothing: an unknown item still draws
    const item = await mountApp('/axes/item/存在しない品目?month=2026-10')
    expect(item.wrapper.find('[data-test="trend-card"]').exists()).toBe(true)
    expect(item.wrapper.find('[data-test="cross"]').text()).toContain('この品目を買った店')
    expect(item.wrapper.find('.period-head').exists()).toBe(true)
    // a real item group narrows through item_query
    await mountApp('/axes/item/牛乳?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'store', item_query: '牛乳' }))
    // the label axis carries label_colors and a category cross
    const label = await mountApp('/axes/label/red?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'category', label_colors: ['red'] }))
    expect(label.wrapper.find('[data-test="cross"]').text()).toContain('このラベルのカテゴリ')
    // the payment axis narrows through payment_method
    await mountApp('/axes/payment/cash?month=2026-10')
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'store', payment_method: 'cash' }))
  })

    // [covers:web-axis.item-stats-section]
  it('品目軸は品目stats区画を持つ: summary（件数・金額・平均単価・min/max・最終購入・店数）+価格履歴+店別（REVIEW-13 M-4）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysisItem')
    const { wrapper } = await mountApp('/axes/item/牛乳?month=2026-10')
    // the stats fetch rides the subject name (item_query = 品名) + the period
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ item_query: '牛乳', month: '2026-10' }))
    const zone = wrapper.find('[data-test="item-stats"]')
    expect(zone.exists()).toBe(true)
    // October has the single 220 牛乳 purchase at Aマート
    const summary = zone.find('[data-test="item-summary"]').text()
    expect(summary).toContain('1件')
    expect(summary).toContain('220円')
    expect(summary).toContain('最終購入')
    expect(summary).toContain('10/10')
    expect(summary).toContain('1店')
    const prices = zone.findAll('[data-test="item-price-row"]')
    expect(prices).toHaveLength(1)
    expect(prices[0]!.text()).toContain('10/10')
    expect(prices[0]!.text()).toContain('Aマート')
    expect(prices[0]!.text()).toContain('220円')
    const stores = zone.findAll('[data-test="item-store-row"]')
    expect(stores).toHaveLength(1)
    expect(stores[0]!.text()).toContain('Aマート')
    expect(stores[0]!.text()).toContain('220円')
    // an unknown item keeps the zone with the empty text (no stats numbers)
    const empty = await mountApp('/axes/item/存在しない品目?month=2026-10')
    const emptyZone = empty.wrapper.find('[data-test="item-stats"]')
    expect(emptyZone.exists()).toBe(true)
    expect(emptyZone.text()).toContain('この期間の記録はありません。')
    expect(emptyZone.find('[data-test="item-summary"]').exists()).toBe(false)
  })

  // [covers:web-axis.item-param-raw]
  it('品目名に%を含むURLでもparamはそのまま品名になる（router decode済みの二重decode禁止・PR#1 P2）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysisItem')
    // the link builder encodes once and the router decodes once: a literal %
    // in the name must survive both (the old second decode threw URIError)
    const { wrapper } = await mountApp(`/axes/item/${encodeURIComponent('100%果汁')}?month=2026-10`)
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ item_query: '100%果汁' }))
    expect(wrapper.find('[data-test="page-chips"]').text()).toContain('品目: 100%果汁')
  })

  it('店軸は ?category= チップを出さない（extraFilters と同じく効いていない絞り込みは見せない・REVIEW-13 L-2）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/axes/store/1?month=2026-10&category=食費')
    expect(wrapper.find('[data-test="chip-category"]').exists()).toBe(false)
    // the subject chip stays
    expect(wrapper.find('[data-test="page-chips"]').text()).toContain('店: Aマート')
  })

  it('[covers:web-axis.unified-skeleton] 旧詳細URL（/categories/:top・/stores/:id・?category= 深link）は未対応 path として / へ redirect・不在 id は ?missing= 付きで一覧へ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const old1 = await mountApp('/categories/1')
    expect(old1.router.currentRoute.value.path).toBe('/')
    const old2 = await mountApp('/stores/1')
    expect(old2.router.currentRoute.value.path).toBe('/')
    // an unknown id replaces into the list with ?missing=
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const missing = await mountApp('/axes/category/999')
    expect(missing.router.currentRoute.value.path).toBe('/categories')
    expect(missing.router.currentRoute.value.query['missing']).toBe('999')
    expect(missing.wrapper.find('[data-test="missing"]').text()).toContain('見つかりません')
    const storeMissing = await mountApp('/axes/store/999')
    expect(storeMissing.router.currentRoute.value.path).toBe('/stores')
    expect(storeMissing.router.currentRoute.value.query['missing']).toBe('999')
  })

  it('[covers:web-browse.context-carry] 軸詳細の掛け合わせはチップで（category・store_id・store_category・labels）×は replace で外し下の階層へ引き継ぐ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const spy = vi.spyOn(api, 'getAnalysis')
    const { wrapper, router } = await mountApp('/axes/category/1?month=2026-10&store_id=1&labels=red')
    // the chips show the subject (no x) and the cross filters (x)
    expect(wrapper.find('[data-test="page-chips"]').text()).toContain('カテゴリ: 食費')
    expect(wrapper.find('[data-test="page-chips"]').text()).toContain('店: Aマート')
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ category: '食費', store_id: 1, label_colors: ['red'] }))
    // the cross fetch drops the store filter (it would collapse the rows)
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'store', category: '食費', limit: 20 }))
    // removing the store chip re-queries without store_id
    await wrapper.find('[data-test="chip-store"]').find('.chip-x').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['store_id']).toBeUndefined()
    expect(spy).toHaveBeenCalledWith(1, expect.objectContaining({ axis: 'store', category: '食費', limit: 20 }))
  })

  it('[covers:web-browse.context-carry] labels チップは title 定義を優先表示する（色keyの生表示はしない）', async () => {
    await api.updateLabelTitle(1, 'red', { title: '旅行' })
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/axes/category/1?month=2026-10&labels=red')
    expect(wrapper.find('[data-test="page-chips"]').text()).toContain('旅行')
    expect(wrapper.find('[data-test="page-chips"]').text()).not.toContain('red')
    expect(wrapper.find('[data-test="chip-x-label-red"]').exists()).toBe(true)
  })

  it('catalog 取得の失敗は msg-error に・ledger 切替は一覧へ replace（Feed と同じ方針）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'getCatalog').mockRejectedValue(new Error('fetch failed'))
    const failed = await mountApp('/axes/category/1')
    expect(failed.wrapper.find('[data-test="error"]').exists()).toBe(true)
    expect(failed.wrapper.find('[data-test="error"]').text()).toContain('エラー')
    cleanup() // restoreAllMocks inside puts getCatalog back
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // a ledger switch on a category detail goes back to the list, not under
    // the old heading (the Feed pattern)
    const switched = await mountApp('/axes/category/1')
    const { useSessionStore } = await import('@/web/stores/session')
    useSessionStore(switched.pinia).selectedLedgerId = 2
    await settle()
    expect(switched.router.currentRoute.value.path).toBe('/categories')
  })
})

describe('ReceiptsPage (dashboard)', () => {
  // TASK-105 (web-receipts.dashboard revised, design §4-4 / §5): the page is
  // zone化 — the daily / payments / receipts sections are .zone with visible
  // h2.zone-title headings（支払方法・レシート・日別の支出等の動的文言.
  // web-common.zone-headings-visible）, `.dash-grid` is replaced by
  // `.view-stack` + `.dash-cols`（左 col-main=daily・右 col-side=payments・
  // summary(kpi) とレシート一覧 zone は .dash-cols の外の全幅.
  // web-common.zone-layout）, and the payments rows carry the swatch + series
  // color（支払方法は名称 string の共通写像. web-common.series-color-assignment）.
  it('[covers:web-receipts.dashboard] 期間の合計・件数・平均・日別・支払方法と日付ごとの一覧、品名で絞り込み', async () => {
    // TASK-116 (design §3-2): the trend fetch lifts limit 1 -> 5 so the daily
    // bars can stack their series (the call count stays three)
    const trendSpy = vi.spyOn(api, 'getAnalysisTrend')
    const { wrapper, router } = await mountApp('/receipts')
    const summary = wrapper.find('[data-test="summary"]').text()
    expect(summary).toContain('948円')
    expect(summary).toContain('レシート 3件')
    expect(summary).toContain('1件あたり 316円')
    expect(wrapper.findAll('[data-test="daily"] .daily-col')).toHaveLength(31)
    expect(trendSpy).toHaveBeenCalledWith(1, expect.objectContaining({
      axis: 'category',
      granularity: 'day',
      limit: 5,
    }))
    expect(wrapper.find('[data-test="payments"]').text()).toContain('現金')
    expect(wrapper.find('[data-test="receipts"]').text()).toContain('10月10日（土）')
    // TASK-105: the three sections are zones with visible headings, riding
    // the two-column band — daily (chart, col-main) / payments (list,
    // col-side) — while the kpi summary and the receipts list stay full
    // width outside .dash-cols
    for (const t of ['daily', 'payments', 'receipts']) {
      const zone = wrapper.find(`[data-test="${t}"]`)
      expect(zone.classes(), t).toContain('zone')
      expect(zone.find('.zone-head h2.zone-title').exists(), t).toBe(true)
    }
    expect(wrapper.find('[data-test="daily"]').find('.zone-title').text()).toBe('日別の支出')
    expect(wrapper.find('[data-test="payments"]').find('.zone-title').text()).toBe('支払方法')
    expect(wrapper.find('[data-test="receipts"]').find('.zone-title').text()).toBe('レシート')
    expect(wrapper.find('[data-test="summary"]').classes()).not.toContain('zone')
    expect(wrapper.find('[data-test="daily"]').element.closest('.dash-cols')).not.toBeNull()
    expect(wrapper.find('[data-test="daily"]').element.closest('.col-main')).not.toBeNull()
    expect(wrapper.find('[data-test="payments"]').element.closest('.col-side')).not.toBeNull()
    expect(wrapper.find('[data-test="summary"]').element.closest('.dash-cols')).toBeNull()
    expect(wrapper.find('[data-test="receipts"]').element.closest('.dash-cols')).toBeNull()
    // the payment rows carry the series swatch (the method string's common
    // mapping — 現金=cash -> var(--series-4))
    const cashRow = wrapper.find('[data-test="payments"] [data-test="row-現金"]')
    expect(cashRow.find('.ranked-swatch').exists()).toBe(true)
    expect(cashRow.attributes('style')).toContain('--rank-color: var(--series-4)')
    // TASK-167 D-1: the receipt rows ride the shared two-line DataRow (the
    // per-surface receipt-row class) — no icon column
    const row = wrapper.find('[data-test="receipt-101"] a.data-row')
    expect(row.classes()).toContain('receipt-row')
    expect(row.find('.recent-icon').exists()).toBe(false)
    expect(row.find('.row-main').exists()).toBe(true)
    expect(row.find('[data-test="label-dot"]').exists()).toBe(true)
    // TASK-63/57: the day head carries the date, so the row's sub line
    // shows the time (mock 101 is 18:30)
    expect(row.find('.row-fig').text()).toBe('18:30')
    expect(row.text()).toContain('Aマート')
    expect(row.text()).toContain('400円')
    expect(row.find('.row-items').text()).toBe('牛乳・パン')
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

  it('[covers:web-receipts.kpi-parity][covers:web-receipts.group-time-column][covers:web-receipts.list-time-order] KPI は {label}（の支出なし・step pair付き）+1日あたり・同一日内は時刻降順で行は時刻列（searchItems も時刻順）', async () => {
    // 102 joins 101's day with an earlier time; 103 loses its time — the
    // same-day group orders by time desc (18:30 above 09:00, a time-less row
    // last) and the row column shows the time / '-'
    await api.updateReceipt(1, 102, { revision: 1, set: { purchased_on: '2026-10-10', purchased_time: '09:00' } })
    await api.updateReceipt(1, 103, { revision: 1, set: { purchased_time: null } })
    const { wrapper } = await mountApp('/receipts?month=2026-10')
    const kpi = wrapper.find('[data-test="summary"]')
    // TASK-57 A6: the same KPI vocabulary as the other dashboards.
    // TASK-161 §3/§4 (指摘5): the label is period.label alone (no「の支出」
    // suffix) with the step pair around it (web-common.period-step)
    expect(kpi.find('.label').text()).toBe('2026年10月')
    expect(kpi.find('[data-test="period-step-prev"]').exists()).toBe(true)
    expect(kpi.find('[data-test="period-step-next"]').exists()).toBe(true)
    const sub = kpi.find('.kpi-sub').text()
    expect(sub).toContain('レシート 3件')
    expect(sub).toContain('1日あたり 63円') // 948 / 15日（進行中は今日まで）
    expect(sub).toContain('1件あたり 316円')
    const groups = wrapper.findAll('.day-group')
    const day10 = groups.find((g) => g.text().includes('10月10日'))!
    const rows = day10.findAll('li')
    expect(rows.map((r) => r.find('.row-fig').text())).toEqual(['18:30', '09:00'])
    expect(rows[0]!.attributes('data-test')).toBe('receipt-101')
    const day5 = groups.find((g) => g.text().includes('10月5日'))!
    expect(day5.find('[data-test="receipt-103"] .row-fig').text()).toBe('-')
    // the mock's item-level list keeps the same key (date desc -> time desc)
    const items = await api.searchItems(1, { from: '2026-10-01', to: '2026-10-31' })
    const sameDay = items.items.filter((i) => i.purchased_on === '2026-10-10')
    expect([...new Set(sameDay.map((i) => i.receipt_id))]).toEqual([101, 102])
  })

  // TASK-105 (web-receipts.payment-filter revised, design §4-4): the
  // 「支払方法」zone's RankedList rows carry the swatch + `--rank-color` =
  // seriesColor（支払方法は名称 string の FNV-1a 共通写像・null 行
  // 〔その他/支払方法不明〕は var(--series-rest)・web-common.series-color-
  // assignment）。押下トグル・chevron なし等の既存期待は不変。
  it('[covers:web-receipts.payment-filter] 支払方法の絞り込み（ランキング行トグル・フォーム select・チップ・URL・一覧と集計の両方）', async () => {
    await api.updateReceipt(1, 102, { revision: 1, set: { payment_method: 'credit_card' } })
    const list = vi.spyOn(api, 'listReceipts')
    const stats = vi.spyOn(api, 'getAnalysis')
    const { wrapper, router } = await mountApp('/receipts')
    // TASK-65: the payment ranking rows are pressable (button, no chevron) and
    // filter in place; the unknown aggregate stays inert
    const cashRow = wrapper.find('[data-test="payments"] [data-test="row-現金"]')
    expect(cashRow.element.tagName).toBe('BUTTON')
    expect(cashRow.classes()).toContain('is-link')
    expect(cashRow.find('svg').exists()).toBe(false)
    // TASK-105: every payment row leads with the series swatch in the
    // method string's common mapping (現金=cash -> var(--series-4)) — a
    // null-key aggregate row, when present, paints the rest grey
    expect(cashRow.find('.ranked-swatch').exists()).toBe(true)
    expect(cashRow.attributes('style')).toContain('--rank-color: var(--series-4)')
    // TASK-129: the button rows (in-place filter branch) carry the same DOM
    // bar as the link rows — the shared component serves every row branch
    expect(cashRow.find('.ranked-bar-track .row-bar .row-seg').exists()).toBe(true)
    await cashRow.trigger('click')
    await settle()
    expect(router.currentRoute.value.query.payment_method).toBe('cash')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ payment_method: 'cash' }))
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ axis: 'payment_method', payment_method: 'cash' }))
    expect(wrapper.find('[data-test="summary"]').text()).toContain('550円') // 400 + 150（102は除外）
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="chip-payment"]').text()).toBe('支払: 現金')
    // pressing the same row again clears the filter (toggle)
    await wrapper.find('[data-test="payments"] [data-test="row-現金"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query.payment_method).toBeUndefined()
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(true)
    // the filter form's select applies too
    await wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await wrapper.find('[data-test="payment"]').setValue('credit_card')
    await wrapper.find('[data-test="filters"]').trigger('submit')
    await settle()
    expect(router.currentRoute.value.query.payment_method).toBe('credit_card')
    expect(wrapper.find('[data-test="receipt-101"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="receipt-102"]').exists()).toBe(true)
    await wrapper.find('[data-test="chip-x-payment"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="receipt-101"]').exists()).toBe(true)
    // a deep link filters the same way (CONTEXT_FIELDS round trip)
    cleanup()
    setDataApi(api)
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const direct = await mountApp('/receipts?payment_method=cash')
    expect(direct.wrapper.find('[data-test="receipt-102"]').exists()).toBe(false)
    expect(direct.wrapper.find('[data-test="chip-payment"]').text()).toBe('支払: 現金')
  })

  // TASK-105 (landed): the daily section's h2 is a visible h2.zone-title
  // inside .zone-head（文言・選択ロジックは不変 — the `h2` selector below
  // keeps working; the visible form's expectations live on
  // web-common.zone-headings-visible 側）。
  // TASK-105 (landed): the daily section's h2 is a visible h2.zone-title
  // inside .zone-head（文言・選択ロジックは不変 — the `h2` selector below
  // keeps working; the visible form's expectations live on
  // web-common.zone-headings-visible 側）。
  // TASK-116 (design §3-2): the bars stack their series — recorded buckets
  // carry .daily-seg children painted with the seriesColor tokens, zero
  // buckets keep the height-0% .daily-bar element with no segments.
  // TASK-123: the assembly is top-3 +「ほか」(web-common.stack-dimension-
  // rules — proven in trend-window.test.ts's 7-series fixture) and the
  // segment grammar gains the outline / corner / allocation rules; the mock
  // month holds at most two series per bucket so the counts below stay, and
  // the paint-level outline/radius checks live in styles.test.ts +
  // verify.spec.ts (jsdom cannot compute stylesheet rules).
  it('[covers:web-receipts.trend-card-granularity] 推移カードは期間の長さで日別・週別・月別（62日超でも消えない）・棒は系列の積み上げ', async () => {
    const title = (w: W) => w.find('[data-test="daily"] h2').text()
    const cols = (w: W) => w.findAll('[data-test="daily"] .daily-col')
    const bars = (w: W) => w.findAll('[data-test="daily"] .daily-bar')
    const axis = (w: W) => w.find('[data-test="daily"] .axis-ends').findAll('span').map((s) => s.text())
    // a month period keeps its daily bars (the browser-measured 31-column rule)
    const month = await mountApp('/receipts?month=2026-10')
    expect(title(month.wrapper)).toBe('日別の支出')
    expect(cols(month.wrapper)).toHaveLength(31)
    expect(axis(month.wrapper)).toEqual(['10月1日（木）', '10月31日（土）'])
    // every bucket keeps its .daily-bar element; the three recorded days
    // (10/5, 10/8, 10/10) alone carry segments
    expect(bars(month.wrapper)).toHaveLength(31)
    const segBars = bars(month.wrapper).filter((b) => b.findAll('.daily-seg').length > 0)
    expect(segBars).toHaveLength(3)
    const segStyle = (w: W, colTitle: string) =>
      w
        .findAll('[data-test="daily"] .daily-col')
        .find((c) => (c.attributes('title') ?? '').startsWith(colTitle))!
        .find('.daily-seg')
        .attributes('style') ?? ''
    // 10/5 (おにぎり 150円 食費) and 10/10 (牛乳+パン 400円 食費) paint the
    // 食費 token, 10/8 (洗剤 398円 日用品) the 日用品 token — the same
    // seriesColor tokens the ranking rows use
    expect(segStyle(month.wrapper, '10月5日')).toContain('var(--series-1)')
    expect(segStyle(month.wrapper, '10月8日')).toContain('var(--series-4)')
    expect(segStyle(month.wrapper, '10月10日')).toContain('var(--series-1)')
    // zero days keep the element at height 0% with no segments
    const zeroBar = month.wrapper
      .findAll('[data-test="daily"] .daily-col')
      .find((c) => (c.attributes('title') ?? '').startsWith('10月1日'))!
      .find('.daily-bar')
    expect(zeroBar.attributes('style')).toContain('height: 0%')
    expect(zeroBar.findAll('.daily-seg')).toHaveLength(0)
    cleanup()
    setDataApi(api)
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    // 76 days -> Monday-anchored weekly buckets (12), the ends are the bucket
    // starts; the card no longer disappears past 62 days
    const week = await mountApp('/receipts?from=2026-08-01&to=2026-10-15')
    expect(title(week.wrapper)).toBe('週別の支出')
    expect(cols(week.wrapper)).toHaveLength(12)
    expect(axis(week.wrapper)).toEqual(['7/27', '10/12'])
    const bar = cols(week.wrapper).at(10)
    expect(bar?.attributes('title')).toBe('10/5〜10/11 948円')
    // the same stacked structure at week granularity: the 10/5 week holds
    // both series (食費 550 + 日用品 398), every other bucket is bare
    expect(week.wrapper.findAll('[data-test="daily"] .daily-seg')).toHaveLength(2)
    const weekSegStyles = week.wrapper
      .findAll('[data-test="daily"] .daily-seg')
      .map((s) => s.attributes('style') ?? '')
    expect(weekSegStyles.some((s) => s.includes('var(--series-1)'))).toBe(true)
    expect(weekSegStyles.some((s) => s.includes('var(--series-4)'))).toBe(true)
    cleanup()
    setDataApi(api)
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    // 22 months -> monthly buckets with the year-boundary axis form
    const long = await mountApp('/receipts?from=2025-01-01&to=2026-10-15')
    expect(title(long.wrapper)).toBe('月別の支出')
    expect(cols(long.wrapper)).toHaveLength(22)
    expect(axis(long.wrapper)).toEqual(['2025年1月', '2026年10月'])
    // month granularity stacks the same way: only 2026-10 (948円) records
    expect(long.wrapper.findAll('[data-test="daily"] .daily-seg')).toHaveLength(2)
  })

  it('[covers:web-receipts.period-identity-in-url] フィルタ適用後も URL に month= が残り再読込で月モード・支払方法の空テキスト統一', async () => {
    const { wrapper, router } = await mountApp('/receipts?month=2026-09')
    expect(wrapper.find('[data-test="summary"] .label').text()).toBe('2026年9月')
    // TASK-57 A1: the same empty text as every stats card
    expect(wrapper.find('[data-test="payments"] .empty').text()).toBe('この期間の記録はありません。')
    await wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await wrapper.find('[data-test="item"]').setValue('牛乳')
    await wrapper.find('[data-test="filters"]').trigger('submit')
    await settle()
    // TASK-174 D2: filter patches keep the mode key and derive from/to
    // from the applied period. An ACK must not trigger a second stripping write.
    expect(router.currentRoute.value.query.month).toBe('2026-09')
    expect(router.currentRoute.value.query.from).toBe('2026-09-01')
    expect(router.currentRoute.value.query.to).toBe('2026-09-30')
    const savedUrl = router.currentRoute.value.fullPath
    cleanup()
    setDataApi(api)
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    // a fresh mount of that URL (the literal form of the asserted query)
    // restores the month mode
    const again = await mountApp(savedUrl)
    expect(again.wrapper.find('[data-test="summary"] .label').text()).toBe('2026年9月')
  })

  // TASK-105 (landed, web-shell.loading-skeleton revised, design §5-4):
  // ReceiptsPage — the last .dash-grid user — joins the others on
  // `.view-stack` + `.dash-cols` structure. A refetch never dims: the
  // committed content stays at full opacity until the commit (there is
  // no `.view-stack.loading` rule). The assertions here（初回 skeleton・
  // 完了後の実データ・aria）are unchanged by it.
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
    const storeDetail = await mountApp('/axes/store/1')
    expect(linkOf(storeDetail.wrapper.find('[data-test="recent-101"]').attributes('href'))).toEqual({
      path: '/receipts/101',
      query: { ...PERIOD, store_id: '1' },
    })
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const catDetail = await mountApp('/axes/category/1')
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
    // TASK-89: the KPI summary line left the store list; the ranked row's
    // label keeps the one-line ellipsis (min-width: 0 + .truncate)
    const css = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8')
    expect(css).toMatch(/\.ranked-label\s*\{[^}]*min-width: 0/)

    // trend card carries the hscroll
    expect(wrapper.find('[data-test="trend-card"] .hscroll [data-test="trend"]').exists()).toBe(true)

    // stage 5 final form: the detail page's heading carries the long name in
    // the ellipsizing .page-head-title (no title tooltip there — the CSS
    // keeps the row width intact with the total at the right end)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const detail = await mountApp('/axes/store/1')
    const title = detail.wrapper.find('.page-head-title')
    expect(title.text()).toBe(long)
    expect(title.attributes('title')).toBeUndefined()
    expect(detail.wrapper.find('.page-head-total').exists()).toBe(true)
    expect(css).toMatch(/\.page-head-title\s*\{[^}]*min-width: 0[^}]*overflow: hidden[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/)
  })
})

describe('Dashboard label filter (TASK-17/26/44, TASK-101)', () => {
  /** Open the search dialog (the label toggles live in its lower half, TASK-101). */
  async function openFilter(wrapper: W): Promise<void> {
    await wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
  }

  it('[covers:web-dashboard.label-filter] Home・Categories・Stores は period store に結合、ReceiptsPage は URL を補い書き戻す、Feed は URL のみ、ledger 切替で空', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router, pinia } = await mountApp('/')

    // Home: the dialog's label half binds to the period store's labelColors
    // and both analysis and the recent-receipts listReceipts carry the filter
    await openFilter(wrapper)
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'], limit: 50 }))
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
  // TASK-129: the component takes the screen-level `scale` prop (the bar
  // length is value/scale × track — no more list-local max).
  async function mountList(props: { rows: StatsRow[]; to?: (row: StatsRow) => { path: string } | null; scale: number }) {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/x/:id', name: 'x', component: { template: '<div />' } }],
    })
    await router.push('/')
    return mount(RankedList, { props, global: { plugins: [router] } })
  }

  // TASK-105 (web-layout.ranked-row-single-line revised, design §4-2): the
  // row grid gains the leading 12px swatch track — the cells become
  // .ranked-swatch -> .ranked-label -> .ranked-share -> .amount (-> chevron)
  // in both the a and span branches, the swatch renders on EVERY row（残余
  // 行・支払方法の非リンク行を含む）, and RankedList sets `--rank-color` =
  // seriesColor(row.keys[0] ?? null, axis)（optional axis prop・未指定なら
  // 共通写像）. The meter/diff absence and the shared a/span structure stay
  // as asserted.
  it('[covers:web-browse.ranked-row-link][covers:web-layout.ranked-row-single-line] to が非 null の行は RouterLink+行末 chevron・null と未渡しは span の非リンク行・行頭swatch全行・行は1行構成（label/share/amount の細胞を a/span で共有・meter・diff列無し）', async () => {
    const rows: StatsRow[] = [
      { keys: [11], labels: ['食費'], value: 550, share: 0.58 },
      { keys: [null], labels: ['その他'], value: 100, share: 0.1 },
    ]
    const to = (r: StatsRow) => (typeof r.keys[0] === 'number' ? { path: `/x/${r.keys[0]}` } : null)
    const w = await mountList({ rows, to, scale: 1000 })

    // a row whose `to` resolves: an anchor to the location with the trailing
    // chevron (aria-hidden svg)
    const link = w.find('[data-test="row-食費"]')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('href')).toBe('/x/11')
    expect(link.find('svg[aria-hidden="true"]').exists()).toBe(true)

    // TASK-105: the leading swatch paints the key's series color — key 11
    // -> ((11-1) mod 7)=slot 4; the row style carries the same --rank-color
    // the bottom bar reads
    expect(link.find('.ranked-swatch').exists()).toBe(true)
    expect(link.attributes('style')).toContain('--rank-color: var(--series-4)')

    // TASK-75 §6-4 single-line cells: label / share / amount — no meter
    // element, no dot column, no diff column
    expect(link.find('.ranked-label').text()).toBe('食費')
    expect(link.find('.ranked-label').attributes('title')).toBe('食費')
    expect(link.find('.ranked-share').text()).toBe('58%')
    expect(link.find('.amount').text()).toBe('550円')
    expect(link.find('.meter').exists()).toBe(false)

    // a row whose `to` returns null (その他 / 店不明): a plain span, no
    // chevron — but the very same cell structure (the share column stays)
    // and the very same leading swatch, in the null key's rest grey
    const other = w.find('[data-test="row-その他"]')
    expect(other.element.tagName).toBe('SPAN')
    expect(other.attributes('href')).toBeUndefined()
    expect(other.find('svg').exists()).toBe(false)
    expect(other.find('.ranked-swatch').exists()).toBe(true)
    expect(other.attributes('style')).toContain('--rank-color: var(--series-rest)')
    expect(other.find('.ranked-label').text()).toBe('その他')
    expect(other.find('.ranked-share').text()).toBe('10%')
    expect(other.find('.amount').text()).toBe('100円')
    expect(other.find('.meter').exists()).toBe(false)
    expect(other.find('.ranked-dot').exists()).toBe(false)
    expect(other.find('.ranked-diff').exists()).toBe(false)

    // no `to` prop at all (the payments breakdown): every row is a span
    const w2 = await mountList({ rows, scale: 1000 })
    expect(w2.find('[data-test="row-食費"]').element.tagName).toBe('SPAN')
    expect(w2.find('[data-test="row-食費"]').find('svg').exists()).toBe(false)

    // the selection-era markup is gone: no buttons, no pressed state
    for (const ww of [w, w2]) {
      expect(ww.find('.ranked-row[aria-pressed]').exists()).toBe(false)
      expect(ww.findAll('button').length).toBe(0)
    }
  })

  // TASK-129 (web-common.row-bar-component + web-common.bar-scale): the
  // row's proportional bar is a DOM bar through the shared component now —
  // one .row-seg in the row's series color inside the absolutely-positioned
  // track, its px width = value / scale × the measured track (the width
  // patch below pins every element to 300px, so 550/1000 → 165px), the 2px
  // bottom gradient and its --rank-fill variable are gone, and a zero-value
  // row draws no bar at all. Written test-first against the gradient rows.
  it('[covers:web-common.row-bar-component][covers:web-common.bar-scale] 行barは共通DOM bar（.row-bar+.row-seg・width=value/scale×track・--rank-fill廃止・ゼロ行はbarなし）', async () => {
    const restore = patchTrackWidth(300)
    try {
      const rows: StatsRow[] = [
        { keys: [11], labels: ['食費'], value: 550, share: 0.58 },
        { keys: [null], labels: ['その他'], value: 100 },
        { keys: [4], labels: ['ゼロ'], value: 0 },
      ]
      const w = await mountList({ rows, scale: 1000 })
      const track = (label: string) => w.find(`[data-test="row-${label}"] .ranked-bar-track`)
      // the link row: the absolute-positioned track carries the shared bar
      // with ONE segment in the row's seriesColor (key 11 → slot 4, the
      // same token the swatch reads), 550/1000 × 300 = 165px wide
      const foodSeg = track('食費').find('.row-bar .row-seg')
      expect(track('食費').exists()).toBe(true)
      expect(foodSeg.exists()).toBe(true)
      expect(foodSeg.attributes('style') ?? '').toContain('background-color: var(--series-4)')
      const widthOf = (s: ReturnType<W['find']>) =>
        Number.parseFloat(/width:\s*([\d.]+)px/.exec(s.attributes('style') ?? '')?.[1] ?? 'NaN')
      expect(widthOf(foodSeg)).toBeCloseTo(165, 1)
      // the null-key row: rest grey, its own value/scale width (100 → 30px)
      const restSeg = track('その他').find('.row-bar .row-seg')
      expect(restSeg.attributes('style') ?? '').toContain('background-color: var(--series-rest)')
      expect(widthOf(restSeg)).toBeCloseTo(30, 1)
      // one common scale: the length ratio equals the value ratio
      expect(widthOf(foodSeg) / widthOf(restSeg)).toBeCloseTo(550 / 100, 4)
      // a zero-value row draws no bar element at all
      expect(w.find('[data-test="row-ゼロ"] .row-bar').exists()).toBe(false)
      // the gradient era is gone: no --rank-fill anywhere, the bar is not a
      // background-image (the row style carries only --rank-color)
      for (const r of w.findAll('.ranked-row')) {
        expect(r.attributes('style') ?? '', 'no --rank-fill').not.toContain('--rank-fill')
        expect(r.attributes('style') ?? '', 'no inline background-image').not.toContain('background-image')
      }
    } finally {
      restore()
    }
  })

  // TASK-129 (web-common.bar-scale, the CategoriesPage wiring): the screen
  // scale comes from the aggregation of the screen's own bars (the ranking
  // rows' values here — 食費550・日用品398 → barScale(550)=1000), NOT the
  // list-local max=100% the gradient used to paint. Track pinned to 300px.
  it('[covers:web-common.bar-scale][covers:web-layout.ranked-row-single-line] /categories のランキング行barは画面単位scale（食費550/1000・日用品398/1000）で描かれる', async () => {
    const restore = patchTrackWidth(300)
    try {
      const { wrapper } = await mountApp('/categories?month=2026-10')
      const rows = wrapper.findAll('[data-test="ranking"] .ranked-row')
      expect(rows.length).toBeGreaterThanOrEqual(2)
      const widthOf = (i: number) =>
        Number.parseFloat(/width:\s*([\d.]+)px/.exec(rows[i]!.find('.row-seg').attributes('style') ?? '')?.[1] ?? 'NaN')
      // the mock month's ranking: 食費 550 (id 1) tops 日用品 398 (id 4);
      // screen scale = barScale(550) = 1000 → 550/1000×300 and 398/1000×300
      expect(rows[0]!.find('.ranked-label').text()).toBe('食費')
      expect(widthOf(0)).toBeCloseTo((550 / 1000) * 300, 1)
      expect(rows[1]!.find('.ranked-label').text()).toBe('日用品')
      expect(widthOf(1)).toBeCloseTo((398 / 1000) * 300, 1)
      // the lengths share one scale: value ratio = length ratio
      expect(widthOf(0) / widthOf(1)).toBeCloseTo(550 / 398, 4)
    } finally {
      restore()
    }
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


// TASK-167 A系: the ranked rows ride the same two-line grammar with the
// bottom bar kept (design v2 §2 D-1/D-2/D-3). Test-first: red until it lands.
describe('ranked rows two-line hierarchy (TASK-167)', () => {
  it('[covers:web-common.data-row-grammar][covers:web-common.row-top-items-display] ランキング行は2行構成（主行=軸label+金額・副行=代表品目+share）で下端barは維持', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/categories?month=2026-10')
    const rows = wrapper.findAll('.ranked-row')
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]!
    expect(row.classes()).toContain('data-row')
    expect(row.find('.row-main').exists()).toBe(true)
    expect(row.find('.row-main .amount').exists()).toBe(true)
    // the sub line carries the derived top items of that axis value and the
    // share as its secondary figure (牛乳 leads the mock's 食費 spending)
    const sub = row.find('.row-sub')
    expect(sub.exists()).toBe(true)
    expect(sub.text()).toContain('牛乳')
    expect(sub.text()).toMatch(/%/)
    // the bottom bar track (the TASK-129 grammar) survives the rework
    expect(row.find('.row-bar').exists()).toBe(true)
  })
})
