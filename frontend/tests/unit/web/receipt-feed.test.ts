// Receipt continuous feed (TASK-16 item 1): ReceiptDetailPage as a feed of
// ReceiptPanel components in the list order of the URL context. The
// conversion table is tested in receipt-context.test.ts and the Panel's
// labels slot in receipt-panel.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  setDataApi,
  type DataApi,
  type ReceiptListQuery,
  type ReceiptListResult,
  type ReceiptSummary,
  type ReceiptView,
} from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { useSessionStore } from '@/web/stores/session'
import { ME, cleanup, intersect, mockFetch, mountApp, scrollMocks, setReducedMotion, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are 101 (10-10), 102 (10-08), 103 (10-05); "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
  mockFetch({ 'GET /api/auth/me': { body: ME } })
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

const CTX = { from: '2026-10-01', to: '2026-10-31' }
const CTX_QS = 'from=2026-10-01&to=2026-10-31'

const panel = (w: W, id: number) => w.find(`[data-test="receipt-panel-${id}"]`)

/** Receipt ids of the feed panels in DOM order. */
function panelIds(w: W): number[] {
  return w
    .findAll('[data-test^="receipt-panel-"]')
    .map((e) => /^receipt-panel-(\d+)$/.exec(e.attributes('data-test') ?? '')?.[1])
    .filter((x): x is string => x !== undefined)
    .map(Number)
}

/** Whether scrollIntoView was called on (or inside) the panel of `id`. */
function scrolledTo(id: number): boolean {
  return scrollMocks().intoView.some((c) => c.el.closest(`[data-test="receipt-panel-${id}"]`) !== null)
}

function keydown(key: string, target: EventTarget = document.activeElement ?? document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function summary(id: number, on: string | null = '2026-10-01'): ReceiptSummary {
  return {
    receipt_id: id,
    purchased_on: on,
    purchased_time: '18:30',
    store_name: `店${id}`,
    amount: 100,
    item_count: 1,
    has_image: false,
    deleted_at: null,
  }
}

/** listReceipts over fixed pages; cursor "c<n>" is page n. */
function pagedList(pages: number[][], total = pages.flat().length) {
  return async (_l: number, q: ReceiptListQuery): Promise<ReceiptListResult> => {
    const i = q.cursor ? Number(q.cursor.slice(1)) : 0
    return {
      total_count: total,
      sum_amount: 0,
      receipts: (pages[i] ?? []).map((id) => summary(id)),
      next_cursor: i + 1 < pages.length ? `c${i + 1}` : null,
    }
  }
}

/** getReceipt for any id, built from a real mock receipt. */
async function anyReceipt(over: (id: number) => Partial<ReceiptView> = () => ({})) {
  const base = await api.getReceipt(1, 102)
  return vi.spyOn(api, 'getReceipt').mockImplementation(async (_l, id) => ({
    ...base,
    receipt_id: id,
    store: { store_id: 2, name: `店${id}`, category: null },
    ...over(id),
  }))
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

describe('Feed sequence', () => {
  it('[covers:web-receipts.feed-sequence-from-context] 文脈 query で listReceipts を呼び一覧と同じ並び', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    await mountApp(`/receipts/102?${CTX_QS}&store=Aマート&item=牛乳&category=食費&include_deleted=1`)
    // fixed order regardless of the filters (the list API is the source of the order)
    expect(list).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        ...CTX,
        store: 'Aマート',
        item_query: '牛乳',
        category: '食費',
        include_deleted: true,
      }),
    )
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([[101, 102, 103]]))
    const feed = await mountApp(`/receipts/102?${CTX_QS}`)
    expect(panelIds(feed.wrapper)).toEqual([101, 102, 103])

  })
})

describe('Feed context', () => {
  it('[covers:web-receipts.feed-direct-link-default-context] 直リンクは購入月を文脈、purchased_on なしは単票', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/receipts/101')
    expect(list).toHaveBeenCalledWith(1, expect.objectContaining(CTX))
    expect(panelIds(wrapper)).toEqual([101, 102, 103])
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await anyReceipt((id) => (id === 105 ? { purchased_on: null } : {}))
    const list2 = vi.spyOn(api, 'listReceipts')
    const single = await mountApp('/receipts/105')
    expect(list2).not.toHaveBeenCalled()
    expect(panelIds(single.wrapper)).toEqual([105])
    expect(single.wrapper.find('[data-test="feed-prev"]').attributes('disabled')).toBeDefined()
    expect(single.wrapper.find('[data-test="feed-next"]').attributes('disabled')).toBeDefined()
  })

  it('[covers:web-receipts.feed-back-keeps-context] 戻るリンクは文脈付き /receipts、一覧では該当行へスクロール', async () => {
    // make 102 an Aマート receipt so it is in the filtered list
    await api.updateReceipt(1, 102, { revision: 1, set: { store_name: 'Aマート' } })
    const { wrapper, router } = await mountApp(`/receipts/102?store=Aマート&${CTX_QS}`)
    const back = wrapper.find('[data-test="feed-back"]')
    const u = new URL(back.attributes('href')!, 'http://localhost')
    expect(u.pathname).toBe('/receipts')
    expect(Object.fromEntries(u.searchParams)).toEqual({ ...CTX, store: 'Aマート' })
    scrollMocks().intoView.length = 0
    await back.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/receipts')
    expect(router.currentRoute.value.query).toEqual({ ...CTX, store: 'Aマート' })
    expect(scrollMocks().intoView.some((c) => c.el.closest('#receipt-102') !== null)).toBe(true)
  })

  it('[covers:web-receipts.feed-label-context] labels 文脈は Feed の並び（listReceipts の label_colors）と戻るリンクに引き継がれる', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp(`/receipts/102?labels=red,blue&${CTX_QS}`)
    // the feed order is the list order under the label filter (the single
    // CONTEXT_FIELDS row feeds listReceipts the label_colors)
    expect(list).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ ...CTX, label_colors: ['red', 'blue'] }),
    )
    // the back link carries the label filter
    const back = wrapper.find('[data-test="feed-back"]')
    const u = new URL(back.attributes('href')!, 'http://localhost')
    expect(Object.fromEntries(u.searchParams)).toEqual({ ...CTX, labels: 'red,blue' })
    await back.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/receipts')
    expect(router.currentRoute.value.query).toEqual({ ...CTX, labels: 'red,blue' })
  })

  it('[covers:web-receipts.feed-sequence-from-context] q・store_id つき文脈（/search の行リンク）は Feed の一覧取得と「戻る」の両方に引き継がれる', async () => {
    // TASK-41: /search rows link into the feed with the search term, so the
    // feed's list query and the back link both carry the same q context
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/receipts/102?q=牛乳&store_id=3')
    expect(list).toHaveBeenCalledWith(1, expect.objectContaining({ q: '牛乳', store_id: 3 }))
    const back = wrapper.find('[data-test="feed-back"]')
    const u = new URL(back.attributes('href')!, 'http://localhost')
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: '牛乳', store_id: '3' })
  })
})

describe('Feed URL sync and navigation', () => {
  it('[covers:web-receipts.feed-url-sync] 表示中パネルの変化で router.replace（push しない）、自分の replace では再取得・スクロールなし', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp(`/receipts/101?${CTX_QS}`)
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    const listCalls = list.mock.calls.length
    scrollMocks().intoView.length = 0
    scrollMocks().scrollBy.mockClear()

    intersect(panel(wrapper, 102))
    await settle()
    expect(replace).toHaveBeenCalledTimes(1)
    const arg = replace.mock.calls[0]![0] as { name?: string; params?: { id?: unknown }; query?: unknown }
    expect(arg.name).toBe('receipt')
    expect(String(arg.params?.id)).toBe('102')
    expect(arg.query).toEqual(CTX)
    expect(push).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/receipts/102')
    expect(router.currentRoute.value.query).toEqual(CTX)
    // the id prop change from our own replace is ignored
    expect(list.mock.calls.length).toBe(listCalls)
    expect(scrollMocks().intoView).toHaveLength(0)
    expect(scrollMocks().scrollBy).not.toHaveBeenCalled()
  })

  it('[covers:web-receipts.feed-external-nav] 外部ナビ: 読込済み id はスクロールのみ、未読込 id と文脈変化は取り直し', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const { router } = await mountApp(`/receipts/101?${CTX_QS}`)
    const n0 = list.mock.calls.length
    scrollMocks().intoView.length = 0

    await router.push(`/receipts/103?${CTX_QS}`)
    await settle()
    expect(scrolledTo(103)).toBe(true)
    expect(list.mock.calls.length).toBe(n0)

    await router.push(`/receipts/999?${CTX_QS}`)
    await settle()
    expect(list.mock.calls.length).toBeGreaterThan(n0)
    const n1 = list.mock.calls.length

    await router.push(`/receipts/102?store=Aマート&${CTX_QS}`)
    await settle()
    expect(list.mock.calls.length).toBeGreaterThan(n1)
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ ...CTX, store: 'Aマート' }))
  })

  it('[covers:web-receipts.feed-ledger-switch-returns-list] 家計簿切替で文脈付き一覧へ replace、旧 id を新家計簿で読まない', async () => {
    const { router, pinia } = await mountApp(`/receipts/101?${CTX_QS}`)
    // the initial (immediate) ledger callback keeps the feed
    expect(router.currentRoute.value.path).toBe('/receipts/101')
    const get = vi.spyOn(api, 'getReceipt')
    const replace = vi.spyOn(router, 'replace')
    useSessionStore(pinia).selectedLedgerId = 2
    await settle()
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({ path: '/receipts', query: CTX }))
    expect(get).not.toHaveBeenCalledWith(2, 101)
    expect(router.currentRoute.value.path).toBe('/receipts')
    expect(router.currentRoute.value.query).toEqual(CTX)
  })
})

describe('Feed loading', () => {
  it('[covers:web-receipts.feed-pagination] anchor のページまで cursor 追従、4 ページで見つからなければ単票、末尾で追加取得', async () => {
    // anchor on the second page
    await anyReceipt()
    const list = vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(201, 250), range(251, 300)]))
    const two = await mountApp(`/receipts/260?${CTX_QS}`)
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[0]![1].cursor).toBeUndefined()
    expect(list.mock.calls[1]![1].cursor).toBe('c1')
    expect(panel(two.wrapper, 259).exists()).toBe(true)
    expect(panel(two.wrapper, 260).exists()).toBe(true)
    expect(panel(two.wrapper, 261).exists()).toBe(true)
    cleanup()

    // not found within 4 pages (more pages exist): single panel + note
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await anyReceipt()
    const endless = vi.spyOn(api, 'listReceipts').mockImplementation(async (_l, q) => {
      const i = q.cursor ? Number(q.cursor.slice(1)) : 0
      return {
        total_count: 1000,
        sum_amount: 0,
        receipts: range(1000 + i * 50, 1049 + i * 50).map((id) => summary(id)),
        next_cursor: `c${i + 1}`,
      }
    })
    const lost = await mountApp(`/receipts/999?${CTX_QS}`)
    expect(endless).toHaveBeenCalledTimes(4)
    expect(panelIds(lost.wrapper)).toEqual([999])
    expect(lost.wrapper.find('[data-test="feed-fallback"]').exists()).toBe(true)
    expect(lost.wrapper.find('[data-test="feed-prev"]').attributes('disabled')).toBeDefined()
    expect(lost.wrapper.find('[data-test="feed-next"]').attributes('disabled')).toBeDefined()
    cleanup()

    // reaching the loaded end fetches the next page with next_cursor
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await anyReceipt()
    const more = vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(401, 450), range(451, 453)]))
    const tail = await mountApp(`/receipts/401?${CTX_QS}`)
    expect(more.mock.calls.some((c) => c[1].cursor === 'c1')).toBe(false)
    intersect(panel(tail.wrapper, 450))
    await settle()
    expect(more.mock.calls.some((c) => c[1].cursor === 'c1')).toBe(true)
    expect(panelIds(tail.wrapper).slice(-4)).toEqual([450, 451, 452, 453])
  })

  it('[covers:web-receipts.feed-render-window] 詳細 API を呼ぶ Panel は前後 2 件まで、それ以外は min-height のプレースホルダ', async () => {
    const get = await anyReceipt()
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(101, 110)]))
    const { wrapper } = await mountApp(`/receipts/105?${CTX_QS}`)
    const fetched = () => [...new Set(get.mock.calls.map((c) => c[1]))].sort((a, b) => a - b)
    const isPlaceholder = (id: number) =>
      !panel(wrapper, id).find('[data-test="total"]').exists() && panel(wrapper, id).html().includes('min-height')
    expect(fetched()).toEqual([103, 104, 105, 106, 107])
    for (const id of [101, 102, 108, 109, 110]) expect(isPlaceholder(id), String(id)).toBe(true)
    for (const id of [103, 104, 105, 106, 107]) expect(isPlaceholder(id), String(id)).toBe(false)

    intersect(panel(wrapper, 108))
    await settle()
    for (const id of [108, 109, 110]) expect(get.mock.calls.some((c) => c[1] === id), String(id)).toBe(true)
    for (const id of [103, 104, 105]) expect(isPlaceholder(id), String(id)).toBe(true)
    for (const id of [106, 107, 108, 109, 110]) expect(isPlaceholder(id), String(id)).toBe(false)
  })

  it('[covers:web-receipts.feed-scroll-compensation] 上方向の展開で表示中パネルの top が動いた分だけ scrollBy で補正、差分 0 なら補正なし', async () => {
    for (const [after, expected] of [
      [420, 300],
      [120, 0],
    ] as const) {
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      // the current panel moves down once receipt 101 above it has loaded
      let expanded = false
      const base = await api.getReceipt(1, 102)
      vi.spyOn(api, 'getReceipt').mockImplementation(async (_l, id) => {
        if (id === 101) expanded = true
        return { ...base, receipt_id: id }
      })
      vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(101, 110)]))
      const { wrapper } = await mountApp(`/receipts/105?${CTX_QS}`)
      const current = panel(wrapper, 103).element
      current.getBoundingClientRect = () =>
        ({ top: expanded ? after : 120, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
      scrollMocks().scrollBy.mockClear()
      intersect(current)
      await settle()
      const calls = scrollMocks().scrollBy.mock.calls.filter((c) => {
        const top = typeof c[0] === 'object' && c[0] !== null ? (c[0] as ScrollToOptions).top : c[1]
        return typeof top === 'number' && top !== 0
      })
      if (expected === 0) {
        expect(calls).toHaveLength(0)
      } else {
        expect(calls).toHaveLength(1)
        const c = calls[0]!
        const top = typeof c[0] === 'object' && c[0] !== null ? (c[0] as ScrollToOptions).top : c[1]
        expect(top).toBe(expected)
      }
      cleanup()
    }
  })
})

describe('Feed controls', () => {
  it('[covers:web-receipts.feed-no-snap] Feed は html に snap-feed・snap-paused を付けず、snapFeed.ts は存在しない', async () => {
    const { existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const { router } = await mountApp('/receipts/101')
    // plain scrolling: no snap classes on <html>, mounted or not
    expect(document.documentElement.classList.contains('snap-feed')).toBe(false)
    expect(document.documentElement.classList.contains('snap-paused')).toBe(false)
    await router.push('/receipts')
    await settle()
    expect(document.documentElement.classList.contains('snap-feed')).toBe(false)
    expect(document.documentElement.classList.contains('snap-paused')).toBe(false)
    // the composable itself is deleted
    expect(existsSync(resolve(process.cwd(), 'src/web/composables/snapFeed.ts'))).toBe(false)
  })

  it('[covers:web-receipts.feed-prev-next] 右=次（古い）・左=前（新しい）、端で disabled、矢印キー、入力欄では無効、見出しへフォーカス、reduce は auto', async () => {
    // total_count (7) differs from the loaded count (3): the position must
    // use the total, not how many panels the feed has loaded
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([[101, 102, 103]], 7))
    const { wrapper, router } = await mountApp(`/receipts/102?${CTX_QS}`, { attach: true })
    const prev = () => wrapper.find('[data-test="feed-prev"]')
    const next = () => wrapper.find('[data-test="feed-next"]')
    expect(prev().attributes('aria-label')).toBe('前のレシート（新しい）')
    expect(next().attributes('aria-label')).toBe('次のレシート（古い）')
    expect(wrapper.find('[data-test="feed-position"]').text()).toContain('2 / 7')
    const s = scrollMocks()

    s.intoView.length = 0
    const replace = vi.spyOn(router, 'replace')
    await next().trigger('click')
    await settle()
    expect(scrolledTo(103)).toBe(true)
    // the button move rewrites the URL itself (the panels crossing the
    // viewport mid-scroll must not leave it on the pre-move receipt)
    expect(router.currentRoute.value.path).toBe('/receipts/103')
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'receipt', params: { id: 103 }, query: CTX }),
    )
    expect(s.intoView.at(-1)!.arg).toEqual(expect.objectContaining({ block: 'start', behavior: 'smooth' }))
    const focused = document.activeElement
    expect(focused?.closest('[data-test="receipt-panel-103"]')).not.toBeNull()
    expect(focused?.getAttribute('tabindex')).toBe('-1')

    intersect(panel(wrapper, 102))
    await settle()
    s.intoView.length = 0
    await prev().trigger('click')
    await settle()
    expect(scrolledTo(101)).toBe(true)

    intersect(panel(wrapper, 101))
    await settle()
    expect(prev().attributes('disabled')).toBeDefined()
    expect(next().attributes('disabled')).toBeUndefined()
    intersect(panel(wrapper, 103))
    await settle()
    expect(next().attributes('disabled')).toBeDefined()
    expect(prev().attributes('disabled')).toBeUndefined()

    // keyboard
    intersect(panel(wrapper, 102))
    await settle()
    s.intoView.length = 0
    keydown('ArrowRight', document.body)
    await settle()
    expect(scrolledTo(103)).toBe(true)
    expect(router.currentRoute.value.path).toBe('/receipts/103')

    intersect(panel(wrapper, 102))
    await settle()
    s.intoView.length = 0
    keydown('ArrowLeft', document.body)
    await settle()
    expect(scrolledTo(101)).toBe(true)

    // not while typing in an input
    intersect(panel(wrapper, 102))
    await settle()
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    s.intoView.length = 0
    keydown('ArrowRight', input)
    await settle()
    expect(s.intoView).toHaveLength(0)
    input.remove()

    // reduced motion
    setReducedMotion(true)
    s.intoView.length = 0
    await next().trigger('click')
    await settle()
    expect(s.intoView.at(-1)!.arg).toEqual(expect.objectContaining({ block: 'start', behavior: 'auto' }))
  })

  it('[covers:web-receipts.feed-prev-next] drawer 開放中は矢印キーで Feed が動かない', async () => {
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([[101, 102, 103]]))
    const { wrapper, router } = await mountApp(`/receipts/102?${CTX_QS}`, { attach: true })
    await wrapper.find('[data-test="menu-button"]').trigger('click')
    await settle()
    // the drawer holds the focus (inert does not stop its key events from
    // bubbling to window); the background feed must not move
    expect(document.activeElement?.closest('[data-test="sidebar"]')).not.toBeNull()
    scrollMocks().intoView.length = 0
    keydown('ArrowRight', document.activeElement ?? document.body)
    await settle()
    expect(scrollMocks().intoView).toHaveLength(0)
    expect(router.currentRoute.value.path).toBe('/receipts/102')
  })

  it('[covers:web-receipts.feed-edit-suspends-nav] 修正中は前後移動・URL 更新を止め、やめると再開', async () => {
    const { wrapper, router } = await mountApp(`/receipts/102?${CTX_QS}`, { attach: true })
    const prev = () => wrapper.find('[data-test="feed-prev"]')
    const next = () => wrapper.find('[data-test="feed-next"]')
    await panel(wrapper, 102).find('[data-test="edit"]').trigger('click')
    await settle()
    expect(prev().attributes('disabled')).toBeDefined()
    expect(next().attributes('disabled')).toBeDefined()

    scrollMocks().intoView.length = 0
    keydown('ArrowRight', document.body)
    await settle()
    expect(scrollMocks().intoView).toHaveLength(0)

    const replace = vi.spyOn(router, 'replace')
    intersect(panel(wrapper, 103))
    await settle()
    expect(replace).not.toHaveBeenCalled()

    await panel(wrapper, 102).find('[data-test="cancel-edit"]').trigger('click')
    await settle()
    intersect(panel(wrapper, 102))
    await settle()
    expect(prev().attributes('disabled')).toBeUndefined()
    expect(next().attributes('disabled')).toBeUndefined()
  })
})

// TASK-49: a direct link (or any re-initialization) must land on the anchor
// itself. The design (tmp/tasks/tm-49/design_direct-link.md §3-2) has the
// initial scroll wait for the panels above the anchor in the window (they
// grow from the 18rem placeholder), suppress IO deliveries while waiting
// (compPending), and never run on the setSingle fallback.
describe('Feed direct link initial scroll', () => {
  it('[covers:web-receipts.feed-direct-link-initial-scroll] 深い位置の直リンクは上側 loaded 後に behavior auto で一度だけ着地し URL を置き換えない', async () => {
    await anyReceipt()
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(201, 212)]))
    const { router } = await mountApp('/receipts/209') // idx 8 of 12, window [6,10]
    const replace = vi.spyOn(router, 'replace')
    expect(scrolledTo(209)).toBe(true)
    expect(scrollMocks().intoView.filter((c) => c.el.closest('[data-test="receipt-panel-209"]'))).toHaveLength(1)
    expect(scrollMocks().intoView.at(-1)!.arg).toEqual({ block: 'start', behavior: 'auto' })
    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/receipts/209')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('[covers:web-receipts.feed-direct-link-initial-scroll] 単票へのフォールバック（purchased_on なし・4 ページ超え）ではスクロールしない', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await anyReceipt((id) => (id === 105 ? { purchased_on: null } : {}))
    const single = await mountApp('/receipts/105')
    expect(panelIds(single.wrapper)).toEqual([105])
    expect(scrollMocks().intoView).toHaveLength(0)
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await anyReceipt()
    vi.spyOn(api, 'listReceipts').mockImplementation(async (_l, q) => {
      const i = q.cursor ? Number(q.cursor.slice(1)) : 0
      return {
        total_count: 1000,
        sum_amount: 0,
        receipts: range(1000 + i * 50, 1049 + i * 50).map((id) => summary(id)),
        next_cursor: `c${i + 1}`,
      }
    })
    const lost = await mountApp('/receipts/999')
    expect(panelIds(lost.wrapper)).toEqual([999])
    expect(scrollMocks().intoView).toHaveLength(0)
  })

  it('[covers:web-receipts.feed-direct-link-initial-scroll] loaded 待ちの間の IO 配送は無視され、loaded 後に着地する', async () => {
    // defer ONLY the panels above the anchor in the window (207, 208); the
    // anchor's own getReceipt (also reinitialize's) resolves at once
    // — gating every getReceipt would stall reinitialize itself: sequence
    // never lands, no panel is observed, and intersect() below would be a
    // no-op (a vacuous pass)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = await api.getReceipt(1, 102)
    vi.spyOn(api, 'getReceipt').mockImplementation(async (_l, id) => {
      if (id === 207 || id === 208) await gate
      return { ...base, receipt_id: id }
    })
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(201, 212)]))
    const { wrapper, router } = await mountApp('/receipts/209')
    const replace = vi.spyOn(router, 'replace')
    // a delivery naming the top-of-document panel lands while the wait is pending
    intersect(panel(wrapper, 201))
    await settle()
    expect(replace).not.toHaveBeenCalled() // suppressed: compPending
    expect(scrolledTo(209)).toBe(false) // no premature scroll either
    release()
    await settle()
    expect(scrolledTo(209)).toBe(true)
    expect(router.currentRoute.value.path).toBe('/receipts/209')
  })

  it('[covers:web-receipts.feed-direct-link-initial-scroll] 待ち中の窓内移動は初期スクロールに優先し anchor へ引き戻さない', async () => {
    // same gate as above: the initial scroll is waiting for 207 / 208 when a
    // move inside the window (route watch: moveSeq bump + scrollTo) supersedes
    // it — after the gate opens the aborted initial scroll must not yank the
    // position back to the old anchor (209), the move target (211) stands
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const base = await api.getReceipt(1, 102)
    vi.spyOn(api, 'getReceipt').mockImplementation(async (_l, id) => {
      if (id === 207 || id === 208) await gate
      return { ...base, receipt_id: id }
    })
    vi.spyOn(api, 'listReceipts').mockImplementation(pagedList([range(201, 212)]))
    const { router } = await mountApp('/receipts/209')
    scrollMocks().intoView.length = 0
    // 209 (anchor) and 211 (move target) both resolve at once (outside the
    // gate): only with this setup does the push complete and the handover
    // become observable
    await router.push(`/receipts/211?${CTX_QS}`)
    await settle()
    release()
    await settle()
    expect(scrolledTo(209)).toBe(false)
    expect(scrolledTo(211)).toBe(true)
  })

  it('[covers:web-receipts.feed-direct-link-initial-scroll] listReceipts 待ちの handleCurrent の bump を経たら旧世代の初期スクロールは中止し yank しない', async () => {
    // capture-at-bump pin: while the September listReceipts (a context
    // change push) is gated, an IO delivery on the old sequence's panel
    // runs handleCurrent — its moveSeq bump supersedes the pending
    // loadSequence's generation. When the gate opens, the anchor branch
    // must still abort the initial scroll on the stale generation; a naive
    // `void initialScroll(anchor, moveSeq)` at the branch would pass the
    // bumped generation and scrollIntoView the superseded anchor (yank).
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const oct = pagedList([range(201, 212)])
    vi.spyOn(api, 'listReceipts').mockImplementation(async (_l, q) => {
      if (q.from !== '2026-09-01') return oct(_l, q)
      await gate
      return { total_count: 12, sum_amount: 0, receipts: range(101, 112).map((id) => summary(id)), next_cursor: null }
    })
    await anyReceipt()
    const { wrapper, router } = await mountApp('/receipts/209')
    scrollMocks().intoView.length = 0
    await router.push('/receipts/105?from=2026-09-01&to=2026-09-30')
    // the delivery lands on the old (October) sequence while the September
    // list is still gated: handleCurrent bumps moveSeq mid-await
    intersect(panel(wrapper, 203))
    await settle()
    release()
    await settle()
    // the September sequence landed on 105 …
    expect(panelIds(wrapper)).toEqual(range(101, 112))
    // … but its initial scroll aborted on the stale generation: no landing
    expect(scrollMocks().intoView).toHaveLength(0)
  })
})
