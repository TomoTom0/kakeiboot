// /search (TASK-41 stage 1b, design: tmp/tasks/tm-41/design_search-tab.md
// §2-2 / §3): the URL is the single source of truth — the commit rules of
// the search input (Enter at once + a 300ms debounce, IME-safe), the two
// tabs (receipts / items), the period scope chip, and the URL restore of a
// direct link. The match semantics of q live in the backend
// (backend/tests/web_data_api.rs, web-data-api.receipt-list-text-query /
// items-search); here the page contract is pinned against the mock api —
// red-first: /search does not exist yet, so every mount lands on the
// catch-all redirect until the router gains the route. Conditions:
// web-search.receipts / items / url-restore / input-commit in
// tests/design/conditions.toml.
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setDataApi,
  type DataApi,
  type ReceiptListQuery,
  type ReceiptListResult,
  type ReceiptSummary,
} from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import ContentSwap from '@/web/components/ContentSwap.vue'
import { usePeriodStore } from '@/web/stores/period'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are 101 (10-10, 牛乳/パン, label red),
  // 102 (10-08, 洗剤, エーマート), 103 (10-05, おにぎり); "today" is 2026-10-15 JST
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

function summary(id: number): ReceiptSummary {
  return {
    receipt_id: id,
    purchased_on: '2026-10-01',
    purchased_time: '18:30',
    store_name: `店${id}`,
    amount: 100,
    item_count: 1,
    has_image: false,
    deleted_at: null,
  }
}

/** The item-tab row DTO (GET /items) the stub below serves. */
interface ItemRow {
  item_id: number
  receipt_id: number
  purchased_on: string
  store_id: number | null
  store_name: string | null
  name: string
  quantity: number | null
  unit: string | null
  unit_price: number | null
  amount_incl: number
  category: string | null
}

const MILK: ItemRow = {
  item_id: 1001,
  receipt_id: 101,
  purchased_on: '2026-10-10',
  store_id: 1,
  store_name: 'Aマート',
  name: '牛乳',
  quantity: 1,
  unit: null,
  unit_price: null,
  amount_incl: 220,
  category: '食費/食料品',
}

/**
 * Serve the item tab from a recording stub instead of the mock: the mock's
 * own searchItems arrives with the implementation, and the matching
 * semantics are the backend's contract. What these tests pin is the page's
 * calling contract (ledger id + query args) and the rendered rows.
 */
function stubSearchItems(api: DataApi, rows: ItemRow[] = [MILK], nextCursor: string | null = null) {
  const calls: Array<[number, Record<string, unknown>]> = []
  ;(
    api as unknown as { searchItems: (l: number, q: Record<string, unknown>) => Promise<unknown> }
  ).searchItems = async (l, q) => {
    calls.push([l, q])
    return {
      total_count: rows.length,
      sum_amount: rows.reduce((a, r) => a + r.amount_incl, 0),
      items: rows,
      next_cursor: nextCursor,
    }
  }
  return calls
}

/** Enable the debounce timer fakes mid-test (mountApp's settle needs real ones). */
function fakeTimersWithDebounce(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
}

describe('search page: receipts tab', () => {
  it('[covers:web-search.receipts] q は品目名 OR 店名で listReceipts を呼ぶ（既定は全期間）・件数合計行・行は q つき文脈の Feed リンク', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/search?q=牛乳')

    // item-name hit (receipt 101 holds 牛乳): the cross-field q rides the query
    expect(list).toHaveBeenCalledWith(1, expect.objectContaining({ q: '牛乳' }))
    expect(list.mock.calls.at(-1)![1]!.from).toBeUndefined()
    expect(list.mock.calls.at(-1)![1]!.to).toBeUndefined()
    expect(wrapper.find('[data-test="search-row"]').exists()).toBe(true)
    const meta = wrapper.find('[data-test="search-meta"]')
    expect(meta.exists()).toBe(true)
    expect(meta.text()).toMatch(/1件/)
    expect(meta.text()).toMatch(/400/)
    // the row leads to the feed carrying the search term (scope=all: no from/to)
    const href = wrapper.find('[data-test="search-row"]').attributes('href')
    const u = new URL(href!, 'http://localhost')
    expect(u.pathname).toBe('/receipts/101')
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: '牛乳' })
    cleanup()

    // store-name hit (エーマート is the store of 102; its item is 洗剤) — the OR half
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const storeList = vi.spyOn(api, 'listReceipts')
    const store = await mountApp('/search?q=エーマート')
    expect(storeList).toHaveBeenCalledWith(1, expect.objectContaining({ q: 'エーマート' }))
    expect(storeList.mock.calls.at(-1)![1]!.from).toBeUndefined()
    expect(store.wrapper.find('[data-test="search-row"]').exists()).toBe(true)
    expect(store.wrapper.find('[data-test="search-meta"]').text()).toMatch(/1件/)
  })

  it('[covers:web-search.receipts] 空状態: q 無しは API を呼ばず「検索語を入力してください」・q あり 0 件は「見つかりませんでした」', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts')
    const none = await mountApp('/search')
    expect(list).not.toHaveBeenCalled()
    expect(none.wrapper.find('[data-test="search-empty"]').text()).toBe('検索語を入力してください')
    expect(none.wrapper.find('[data-test="search-meta"]').exists()).toBe(false)
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const zero = await mountApp('/search?q=存在しない語')
    expect(zero.wrapper.find('[data-test="search-empty"]').text()).toBe('見つかりませんでした')
    expect(zero.wrapper.find('[data-test="search-row"]').exists()).toBe(false)
  })

  it('[covers:web-search.receipts] 期間スコープチップで {period.label}のみ へ切替（時期チップ・ラベルの変更に追従して再取得）し行リンクに from/to・labels も乗る', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/search?q=牛乳')
    const scope = () => wrapper.find('[data-test="search-scope"]')

    // the chip starts as the all-period toggle
    expect(scope().attributes('aria-pressed')).toBe('false')
    expect(scope().text()).toContain('全期間')
    await scope().trigger('click')
    await settle()
    expect(scope().attributes('aria-pressed')).toBe('true')
    expect(scope().text()).toContain('2026年10月のみ')
    // the URL gains scope=period plus the store's current period keys
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳', scope: 'period', month: '2026-10' })
    expect(list).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ q: '牛乳', from: '2026-10-01', to: '2026-10-31' }),
    )

    // while scoped, the topbar period chip re-queries and rewrites the period keys
    await wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="mode-year"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳', scope: 'period', year: '2026' })
    expect(list).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ q: '牛乳', from: '2026-01-01', to: '2026-12-31' }),
    )

    // the label filter applies to the search results too (and rides the URL)
    // — the toggles live in the search dialog's lower half (TASK-101)
    await wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({
      q: '牛乳',
      scope: 'period',
      year: '2026',
      
      labels: 'red',
    })
    expect(list).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ q: '牛乳', from: '2026-01-01', to: '2026-12-31', label_colors: ['red'] }),
    )

    // the row link carries the full context: q + the scoped period + labels
    const href = wrapper.find('[data-test="search-row"]').attributes('href')
    const u = new URL(href!, 'http://localhost')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
      labels: 'red',
      q: '牛乳',
    })
  })

  it('[covers:web-search.receipts][covers:web-common.appear-fade] さらに表示: next_cursor があれば続きを page へ append（cursor pagination）・追加行のみ出現fade', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts').mockImplementation(
      async (_l: number, q: ReceiptListQuery): Promise<ReceiptListResult> => ({
        total_count: 2,
        sum_amount: 300,
        receipts: q.cursor ? [summary(102)] : [summary(101)],
        next_cursor: q.cursor ? null : 'c1',
      }),
    )
    const { wrapper } = await mountApp('/search?q=牛乳')
    expect(wrapper.findAll('[data-test="search-row"]')).toHaveLength(1)

    await wrapper.find('[data-test="search-more"]').trigger('click')
    await flushPromises()
    await nextTick()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ q: '牛乳', cursor: 'c1' }))
    const rows = wrapper.findAll('[data-test="search-row"]')
    expect(rows).toHaveLength(2)
    // TASK-146 §3 #18 (web-common.appear-fade): only the APPENDED row earns
    // the shared appear-fade grammar; the existing row stays put. The row's
    // grammar class rides the <li> the TransitionGroup keys — the
    // [data-test="search-row"] link sits inside it, so the row element is
    // reached through closest (the link's own class or a descendant stays
    // the other accepted carriers)
    const hasAppear = (el: Element): boolean =>
      el.className.includes('bb-appear') ||
      el.querySelector('[class*="bb-appear"]') !== null ||
      el.closest('li[class*="bb-appear"]') !== null
    expect(hasAppear(rows[0]!.element), 'the existing row never moves').toBe(false)
    expect(hasAppear(rows[1]!.element), 'the appended row appears through the fade').toBe(true)
    await settle()
    expect(wrapper.find('[data-test="search-more"]').exists()).toBe(false)
  })

  it('[covers:web-search.receipts] API 例外（400 を含む）は meta 行の代わりにエラーメッセージ（再試行ボタンなし）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'listReceipts').mockRejectedValue({ status: 400, code: 'invalid_request' })
    const { wrapper } = await mountApp('/search?q=!!')
    await settle()
    expect(wrapper.find('[data-test="search-meta"]').exists()).toBe(false)
    const error = wrapper.find('[data-test="error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).not.toBe('')
  })
})

describe('search page: items tab', () => {
  it('[covers:web-search.items] q は品目名のみで searchItems を呼ぶ・行は共通2行文法（.data-row）・カテゴリは副行の非押下text', async () => {
    const itemCalls = stubSearchItems(api)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳&tab=items')

    expect(itemCalls.at(-1)).toEqual([1, expect.objectContaining({ q: '牛乳' })])
    expect(itemCalls.at(-1)![1]!['from']).toBeUndefined()
    expect(wrapper.find('[data-test="search-item-row"]').exists()).toBe(true)
    const row = wrapper.find('[data-test="search-item-row"]')
    expect(row.text()).toContain('牛乳')
    expect(row.text()).toContain('220')
    expect(row.text()).toContain('Aマート')
    // the meta line is the same shape as the receipts tab
    const meta = wrapper.find('[data-test="search-meta"]')
    expect(meta.text()).toMatch(/1件/)
    expect(meta.text()).toMatch(/220/)

    // the row itself (the shared .data-row root — REVIEW-15 中1 moved the
    // item tab onto DataRow, so the whole row is the one press to the feed)
    // carries the q context on its own href
    expect(row.element?.tagName).toBe('A')
    const fu = new URL(row.attributes('href')!, 'http://localhost')
    expect(fu.pathname).toBe('/receipts/101')
    expect(Object.fromEntries(fu.searchParams)).toEqual({ q: '牛乳' })

    // the category rides the SUB line as plain muted text (REVIEW-15 裁断
    // 2026-11-07: the row keeps its single action, D-4 — no in-row link; the
    // category route rides the feed's own cat-link)
    const cat = wrapper.find('[data-test="search-item-category"]')
    expect(cat.exists()).toBe(true)
    expect(cat.element?.tagName).toBe('SPAN')
    expect(cat.attributes('href')).toBeUndefined()
    expect(cat.classes()).not.toContain('hover-ink')
    expect(cat.text()).toBe('食費/食料品')

    // the scope chip narrows the item query the same way
    await wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({
      q: '牛乳',
      tab: 'items',
      scope: 'period',
      month: '2026-10',

    })
    expect(itemCalls.at(-1)).toEqual([
      1,
      expect.objectContaining({ q: '牛乳', from: '2026-10-01', to: '2026-10-31' }),
    ])
  })

  it('[covers:web-search.items] 副行のカテゴリは非押下のmuted text（catalog に解けない path も同一の表示・linkでない）', async () => {
    stubSearchItems(api)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&tab=items&scope=period&month=2026-10')
    // REVIEW-15 裁断 2026-11-07: the category never renders as a link — the
    // row keeps its single action (D-4) and the category route rides the
    // feed's own cat-link, so neither labels nor period ride an in-row href
    const cat = wrapper.find('[data-test="search-item-category"]')
    expect(cat.element?.tagName).toBe('SPAN')
    expect(cat.attributes('href')).toBeUndefined()
    expect(cat.classes()).not.toContain('hover-ink')
    expect(cat.text()).toBe('食費/食料品')

    // a category path the catalog cannot resolve (a deleted / foreign tree)
    // renders the same plain text — no /categories fallback destination
    stubSearchItems(api, [{ ...MILK, category: '存在しない分類' }])
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const unresolved = await mountApp('/search?q=牛乳&tab=items&scope=period&month=2026-10')
    await settle()
    const cu = unresolved.wrapper.find('[data-test="search-item-category"]')
    expect(cu.element?.tagName).toBe('SPAN')
    expect(cu.attributes('href')).toBeUndefined()
    expect(cu.text()).toBe('存在しない分類')
  })

  it('[covers:web-search.items] catalog 取得失敗は msg-error に出す（unhandled rejection なし・結果行はそのまま）', async () => {
    // the category links need the catalog; a failed fetch surfaces through
    // the page's error message while the rows themselves keep working (the
    // category links just fall back to the /categories list destination)
    stubSearchItems(api)
    vi.spyOn(api, 'getCatalog').mockRejectedValue(new Error('catalog down'))
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&tab=items')
    const msg = wrapper.find('[data-test="error"]')
    expect(msg.exists()).toBe(true)
    expect(msg.classes()).toContain('msg-error')
    expect(wrapper.findAll('[data-test="search-item-row"]')).toHaveLength(1)
  })

  it('[covers:web-search.items] さらに表示はレシートtab と同型（cursor 付き再取得・append）', async () => {
    // page 1: the milk row + a cursor; page 2: one more row without a cursor
    const page2: ItemRow = { ...MILK, item_id: 1003, receipt_id: 103, name: '牛乳 1L', amount_incl: 250 }
    let served = false
    ;(
      api as unknown as { searchItems: (l: number, q: Record<string, unknown>) => Promise<unknown> }
    ).searchItems = async (_l, q) => {
      const cursor = q['cursor']
      const rows = cursor ? [page2] : [MILK]
      served = true
      return {
        total_count: 2,
        sum_amount: 470,
        items: rows,
        next_cursor: cursor ? null : 'c1',
      }
    }
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&tab=items')
    expect(served).toBe(true)
    expect(wrapper.findAll('[data-test="search-item-row"]')).toHaveLength(1)
    await wrapper.find('[data-test="search-more"]').trigger('click')
    await settle()
    expect(wrapper.findAll('[data-test="search-item-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="search-more"]').exists()).toBe(false)
  })
})

describe('search page: URL restore', () => {
  it('[covers:web-search.url-restore] 直リンクの q・tab・scope・期間3形・labels だけで結果が復元される', async () => {
    const itemCalls = stubSearchItems(api)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&tab=items&scope=period&month=2026-10&labels=red')

    // the draft, the tab and both shared filters all come from the URL
    expect((wrapper.find('[data-test="search-input"]').element as HTMLInputElement).value).toBe('牛乳')
    expect(wrapper.find('[data-test="search-tab-items"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-test="search-tab-receipts"]').attributes('aria-selected')).toBe('false')
    expect(wrapper.find('[data-test="filter-period"]').attributes('aria-label')).toBe('期間で絞り込み: 2026年10月')
    // the search chip carries the q and the restored label together (TASK-101)
    const searchChip = wrapper.find('[data-test="filter-search"]')
    expect(searchChip.classes()).toContain('active')
    expect(searchChip.findAll('.label-filter-dot')).toHaveLength(1)
    expect(searchChip.findAll('.label-filter-dot')[0]!.classes()).toContain('label-red')
    expect(searchChip.attributes('aria-label')).toBe('検索: 牛乳、ラベル: ラベル1')
    // the item query carries the scoped period and the label filter
    expect(itemCalls.at(-1)).toEqual([
      1,
      expect.objectContaining({ q: '牛乳', from: '2026-10-01', to: '2026-10-31', label_colors: ['red'] }),
    ])
  })

  it('[covers:web-search.url-restore] タブとスコープの操作は URL 出し分け（receipts/all は key 省略）・空欄確定は q のみ除去', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳')

    expect(wrapper.find('[data-test="search-tab-receipts"]').attributes('aria-selected')).toBe('true')
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳' })
    await wrapper.find('[data-test="search-tab-items"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳', tab: 'items' })
    expect(wrapper.find('[data-test="search-tab-items"]').attributes('aria-selected')).toBe('true')
    await wrapper.find('[data-test="search-tab-receipts"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳' })

    // scope=period fills in the store's current period keys (the ONLY
    // direction that seats them — TASK-145 D1-3); back to all drops the
    // period keys too (next=all keeps dropPeriodQuery's result: no
    // seat-then-strip round trip on our own transition)
    await wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳', scope: 'period', month: '2026-10' })
    await wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳' })

    // an empty commit clears q and keeps the rest
    await wrapper.find('[data-test="search-input"]').setValue('')
    await wrapper.find('[data-test="search-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(router.currentRoute.value.query).toEqual({})
  })

  // PR#4 #5: the scope toggle's ONLY query change is from/to — exactly the
  // keys committedKey drops — so the scope rides the key explicitly and a
  // period⇄all toggle lands as a content swap (the pane's fade), matching
  // the template comment "a term / tab / scope / label change is a swap".
  it('[covers:web-common.content-swap] scope切替（period⇄all）はcommittedKeyがbumpしpaneの内容swapになる（期間成分の除外だけで成立しない）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&scope=period&month=2026-10')
    await settle()
    /** the committed key's scope field (l | tab | SCOPE | queryJSON) */
    const scopePart = () => String(wrapper.findComponent(ContentSwap).props('swapKey')).split('|')[2]
    expect(scopePart()).toBe('period')
    // period → all: the key bumps even though from/to alone changed
    await wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(scopePart()).toBe('all')
    // all → period bumps the key back the same way
    await wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(scopePart()).toBe('period')
  })
})

describe('search page: input commit', () => {
  it('[covers:web-search.input-commit] Enter 即時＋入力停止 300ms の debounce・IME composition 中は不発・空欄確定でクリア', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳')
    fakeTimersWithDebounce()
    const input = wrapper.find('[data-test="search-input"]')
    const q = () => router.currentRoute.value.query['q']

    // the debounce fires only after 300ms of silence
    await input.setValue('牛乳1L')
    await vi.advanceTimersByTimeAsync(299)
    expect(q()).toBe('牛乳')
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(q()).toBe('牛乳1L')

    // Enter commits at once and cancels the pending timer
    await input.setValue('パン')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(q()).toBe('パン')
    await vi.advanceTimersByTimeAsync(500)
    expect(q()).toBe('パン')

    // composition: no timer while composing, the committing Enter is a no-op,
    // and compositionend restarts the debounce
    await input.trigger('compositionstart')
    await input.setValue('ぎゅう')
    await vi.advanceTimersByTimeAsync(400)
    expect(q()).toBe('パン')
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    await flushPromises()
    expect(q()).toBe('パン')
    await input.trigger('compositionend')
    await vi.advanceTimersByTimeAsync(299)
    expect(q()).toBe('パン')
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(q()).toBe('ぎゅう')

    // an empty commit removes q (no minimum length gate)
    await input.setValue('')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(q()).toBeUndefined()
  })

  it('[covers:web-search.input-commit] 逐次入力の race は seq guard で最後のみ採用（遅い旧応答は破棄）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    let releaseFirst!: (v: ReceiptListResult) => void
    const first = new Promise<ReceiptListResult>((res) => {
      releaseFirst = res
    })
    let n = 0
    vi.spyOn(api, 'listReceipts').mockImplementation(async (): Promise<ReceiptListResult> => {
      n += 1
      if (n === 1) return first
      return { total_count: 9, sum_amount: 990, receipts: [summary(103)], next_cursor: null }
    })
    const { wrapper } = await mountApp('/search?q=牛乳')
    // the first load stays pending; a new commit wins
    await wrapper.find('[data-test="search-input"]').setValue('パン')
    await wrapper.find('[data-test="search-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(wrapper.find('[data-test="search-meta"]').text()).toMatch(/9件/)
    expect(wrapper.findAll('[data-test="search-row"]')).toHaveLength(1)

    // the stale first response resolves late and is dropped
    releaseFirst({ total_count: 1, sum_amount: 220, receipts: [summary(101)], next_cursor: null })
    await settle()
    expect(wrapper.find('[data-test="search-meta"]').text()).toMatch(/9件/)
    expect(wrapper.findAll('[data-test="search-row"]')).toHaveLength(1)
  })

  it('[covers:web-search.input-commit] dialog 実行等で URL の q が変わったら draft が追従し残留 timer を停止する', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳')
    fakeTimersWithDebounce()
    const input = wrapper.find('[data-test="search-input"]')

    // a debounce is pending with the stale draft when the URL changes
    // underneath (the topbar dialog run does exactly this)
    await input.setValue('牛乳1L')
    await router.replace({ query: { ...router.currentRoute.value.query, q: '牛乳 1L' } })
    await nextTick()
    await flushPromises()
    expect((input.element as HTMLInputElement).value).toBe('牛乳 1L')

    // the stale timer never fires: 300ms later the URL still holds the new term
    await vi.advanceTimersByTimeAsync(600)
    expect(router.currentRoute.value.query['q']).toBe('牛乳 1L')
  })

  // PR#5 review: TASK-174 queued every commit behind the FIFO, so a period
  // push held in flight delays the page's own q write — and the older
  // acknowledgement landing in route.query.q must not read as the external
  // follow case above (which reverts the draft and stops the debounce)
  it('[covers:web-search.queued-ack] pending期間push背後の自Q確定ackが遅れて届いても draft と debounce timer を守る（外部変更のみ追従）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?scope=period&month=2026-10')
    fakeTimersWithDebounce()
    const input = wrapper.find('[data-test="search-input"]')
    const q = () => router.currentRoute.value.query['q']

    // hold every navigation (the url-sync tests' holdGuard window): the
    // period push below stays in flight while the page keeps accepting input
    const waiting: Array<() => void> = []
    let held = true
    router.beforeEach(async () => {
      if (!held) return true
      await new Promise<void>((resolve) => waiting.push(resolve))
      return true
    })
    const release = (): void => {
      held = false
      for (const resolve of waiting.splice(0)) resolve()
    }

    // a period operation enqueues the push (held pending) and the Enter
    // commit queues its q write behind it — TASK-174's FIFO
    usePeriodStore().setMonth('2026-05')
    await input.setValue('卵')
    await input.trigger('keydown', { key: 'Enter' })
    expect(q()).toBeUndefined()

    // the user keeps typing: a NEWER draft with its 300ms debounce pending
    await input.setValue('酒')

    // the push completes and the queued q=卵 write lands — an owned ack, not
    // an external change: the newer draft and its timer must survive it
    release()
    await flushPromises()
    await nextTick()
    expect(q()).toBe('卵')
    expect((input.element as HTMLInputElement).value).toBe('酒')

    // the debounce still fires 300ms after the last keystroke: the newer
    // term is searched, never reverted to the stale acknowledgement
    await vi.advanceTimersByTimeAsync(299)
    expect(q()).toBe('卵')
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(q()).toBe('酒')
  })
})


// TASK-167 A系: the search tab's receipt rows join the shared two-line
// grammar (the 1-line shape that page had been left with). REVIEW-15 中1
// moves the ITEM tab onto the same component (D-13: both tabs of /search are
// the shared grammar — the per-surface .search-item-* composition is gone).
describe('search rows two-line hierarchy (TASK-167)', () => {
  it('[covers:web-common.data-row-grammar] 検索レシートtabの行も共通2行文法（主行+副行・取り残された1行構成の廃止）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳')
    await settle()
    const rows = wrapper.findAll('.data-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]!.find('.row-main').exists()).toBe(true)
    expect(rows[0]!.find('.row-main .amount').exists()).toBe(true)
    expect(rows[0]!.find('.row-sub').exists()).toBe(true)
  })

  it('[covers:web-common.data-row-grammar] 検索品物tabの行も共通2行文法（副行のカテゴリは inline when-link）', async () => {
    stubSearchItems(api)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/search?q=牛乳&tab=items')
    await settle()
    const row = wrapper.find('[data-test="search-item-row"]')
    expect(row.exists()).toBe(true)
    expect(row.classes()).toContain('data-row')
    expect(row.find('.row-main').exists()).toBe(true)
    expect(row.find('.row-main .amount').exists()).toBe(true)
    expect(row.find('.row-sub').exists()).toBe(true)
    // the category rides the sub line as plain muted text (REVIEW-15 裁断
    // 2026-11-07: single row action — no in-row link)
    const cat = row.find('[data-test="search-item-category"]')
    expect(cat.exists()).toBe(true)
    expect(cat.element?.tagName).toBe('SPAN')
    expect(cat.classes()).not.toContain('hover-ink')
  })
})
