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
  mockFetch({ 'GET /api/auth/me': { body: ME } })
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']
const sel = (path: string) => `[data-test="cat-${path}"]`

async function catAction(wrapper: W, path: string, action: string) {
  await wrapper.find(`${sel(path)} [data-test="${action}"]`).trigger('click')
  await settle()
}

describe('CategoriesPage', () => {
  it('[covers:web-categories.create-and-tree] 2階層で表示し作成できる、親なしはエラー', async () => {
    const { wrapper } = await mountApp('/settings/categories')
    expect(wrapper.find(sel('食費/外食')).exists()).toBe(true)
    await wrapper.find('[data-test="new-path"]').setValue('食費/おやつ')
    await wrapper.find('[data-test="create-form"]').trigger('submit')
    await settle()
    expect(wrapper.find(sel('食費/おやつ')).exists()).toBe(true)
    expect(wrapper.find(sel('食費/おやつ')).classes()).toContain('child')
    await wrapper.find('[data-test="new-path"]').setValue('存在しない/子')
    await wrapper.find('[data-test="create-form"]').trigger('submit')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('親カテゴリ')
    await wrapper.find('[data-test="kind-store"]').trigger('click')
    await settle()
    expect(wrapper.find(sel('コンビニ')).exists()).toBe(true)
    expect(wrapper.find(sel('食費')).exists()).toBe(false)
  })

  it('[covers:web-categories.rename-move-archive] 改名・移動・アーカイブ、削除操作なし', async () => {
    const { wrapper } = await mountApp('/settings/categories')
    await catAction(wrapper, '食費/外食', 'rename')
    await wrapper.find('[data-test="edit-input"]').setValue('外食費')
    await wrapper.find(`${sel('食費/外食')} form`).trigger('submit')
    await settle()
    expect(wrapper.find(sel('食費/外食費')).exists()).toBe(true)

    await catAction(wrapper, '食費/外食費', 'move')
    await wrapper.find('[data-test="move-select"]').setValue('日用品')
    await wrapper.find(`${sel('食費/外食費')} form`).trigger('submit')
    await settle()
    expect(wrapper.find(sel('日用品/外食費')).exists()).toBe(true)

    await catAction(wrapper, '日用品/外食費', 'archive')
    expect(wrapper.find(sel('日用品/外食費')).exists()).toBe(false)
    expect(wrapper.findAll('button').some((b) => b.text() === '削除')).toBe(false)
  })

  it('[covers:web-categories.archived-hidden-by-default] アーカイブ済みは既定で非表示、表示して戻せる', async () => {
    const { wrapper } = await mountApp('/settings/categories')
    expect(wrapper.find(sel('趣味')).exists()).toBe(false)
    await wrapper.find('[data-test="show-archived"]').setValue(true)
    await settle()
    expect(wrapper.find(sel('趣味')).text()).toContain('アーカイブ済み')
    await catAction(wrapper, '趣味', 'unarchive')
    await wrapper.find('[data-test="show-archived"]').setValue(false)
    await settle()
    expect(wrapper.find(sel('趣味')).exists()).toBe(true)
  })
})

describe('StoresPage', () => {
  it('[covers:web-stores.update-store] 店名・カテゴリ更新と過去分反映の注記', async () => {
    const { wrapper } = await mountApp('/settings/stores')
    await wrapper.find('[data-test="store-2"] [data-test="edit"]').trigger('click')
    await wrapper.find('[data-test="edit-name"]').setValue('エーマート駅前')
    await wrapper.find('[data-test="edit-category"]').setValue('スーパー')
    await wrapper.find('[data-test="edit-save"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="store-2"] [data-test="store-name"]').text()).toBe('エーマート駅前')
    expect(wrapper.find('[data-test="store-2"]').text()).toContain('スーパー')
    expect(wrapper.find('[data-test="info"]').text()).toContain('過去のレシートの集計にも反映')
  })

  it('[covers:web-stores.merge-requires-confirm] 確認後にだけ統合し、件数が移る', async () => {
    const merge = vi.spyOn(api, 'mergeStores')
    const { wrapper } = await mountApp('/settings/stores')
    await wrapper.find('[data-test="merge-source"]').setValue(2)
    await wrapper.find('[data-test="merge-target"]').setValue(1)
    await wrapper.find('[data-test="merge-review"]').trigger('click')
    await settle()
    const panel = wrapper.find('[data-test="merge-confirm-panel"]').text()
    expect(panel).toContain('エーマート')
    expect(panel).toContain('レシート 1 件')
    expect(panel).toContain('元に戻せません')
    expect(merge).not.toHaveBeenCalled()
    await wrapper.find('[data-test="merge-confirm"]').trigger('click')
    await settle()
    expect(merge).toHaveBeenCalledWith(1, 2, 1)
    expect(wrapper.find('[data-test="store-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="store-1"] [data-test="receipt-count"]').text()).toBe('2')
  })

  it('[covers:web-stores.merge-same-store-rejected] 同じ店どうしは確認に進めない', async () => {
    const { wrapper } = await mountApp('/settings/stores')
    await wrapper.find('[data-test="merge-source"]').setValue(1)
    await wrapper.find('[data-test="merge-target"]').setValue(1)
    await wrapper.find('[data-test="merge-review"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('同じ店')
    expect(wrapper.find('[data-test="merge-confirm-panel"]').exists()).toBe(false)
  })
})

describe('Receipts', () => {
  /** The feed panel of one receipt (data-test values repeat across panels). */
  const panel = (w: W, id: number) => w.find(`[data-test="receipt-panel-${id}"]`)

  it('[covers:web-receipts.list-and-detail] 一覧（件数・合計）から文脈付きリンクで詳細の Feed へ', async () => {
    const { wrapper, router } = await mountApp('/receipts?store=Aマート')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('1 件')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('400円')
    expect(wrapper.find('[data-test="receipt-101"]').text()).toContain('Aマート')
    // the row link carries the list context (period + filters)
    const href = wrapper.find('[data-test="receipt-101"] a').attributes('href')!
    const u = new URL(href, 'http://localhost')
    expect(u.pathname).toBe('/receipts/101')
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: '2026-10-01', to: '2026-10-31', store: 'Aマート' })
    await wrapper.find('[data-test="receipt-101"] a').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/receipts/101')
    expect(router.currentRoute.value.query).toEqual({ from: '2026-10-01', to: '2026-10-31', store: 'Aマート' })
    const p = panel(wrapper, 101)
    expect(p.exists()).toBe(true)
    expect(p.find('[data-test="items"]').text()).toContain('牛乳')
    expect(p.find('[data-test="items-total"]').text()).toContain('400円')
  })

  it('[covers:web-receipts.update-with-revision] 表示中の revision 付きで保存し版が進む', async () => {
    const update = vi.spyOn(api, 'updateReceipt')
    const { wrapper } = await mountApp('/receipts/101')
    const p = panel(wrapper, 101)
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('特売')
    await p.find('[data-test="f-item-0"] [data-test="f-item-amount"]').setValue(250)
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    expect(update).toHaveBeenCalledWith(1, 101, {
      revision: 1,
      set: { note: '特売' },
      upsert_items: [{ item_id: 1001, amount: 250 }],
    })
    expect(panel(wrapper, 101).find('[data-test="revision"]').text()).toBe('2')
    expect(panel(wrapper, 101).find('[data-test="note"]').text()).toBe('特売')
  })

  it('[covers:web-receipts.stale-revision-reload] revision 不一致は上書きせず最新を読み直す', async () => {
    const { wrapper } = await mountApp('/receipts/101')
    await api.updateReceipt(1, 101, { revision: 1, set: { note: '会話で変更' } })
    const p = panel(wrapper, 101)
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('web で変更')
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    const after = panel(wrapper, 101)
    expect(after.find('[data-test="error"]').text()).toContain('他の画面や会話で更新')
    expect(after.find('[data-test="revision"]').text()).toBe('2')
    expect(after.find('[data-test="note"]').text()).toBe('会話で変更')
  })

  it('[covers:web-receipts.delete-preview-confirm] preview を示してから revision 付きで削除、Feed のパネル・位置・URL は不変', async () => {
    const del = vi.spyOn(api, 'deleteReceipt')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/receipts/101?from=2026-10-01&to=2026-10-31')
    const position = wrapper.find('[data-test="feed-position"]').text()
    const fullPath = router.currentRoute.value.fullPath
    const listCalls = list.mock.calls.length
    const p = panel(wrapper, 101)
    // deletion is only reachable from the edit mode's danger zone
    expect(p.find('[data-test="delete"]').exists()).toBe(false)
    await p.find('[data-test="edit"]').trigger('click')
    await panel(wrapper, 101).find('[data-test="delete"]').trigger('click')
    await settle()
    expect(del).toHaveBeenLastCalledWith(1, 101, {})
    const preview = panel(wrapper, 101).find('[data-test="delete-preview"]').text()
    expect(preview).toContain('Aマート')
    expect(preview).toContain('90日以内なら復元できます')
    expect(panel(wrapper, 101).find('[data-test="deleted"]').exists()).toBe(false)
    await panel(wrapper, 101).find('[data-test="delete-confirm"]').trigger('click')
    await settle()
    expect(del).toHaveBeenLastCalledWith(1, 101, { confirm: true, revision: 1 })
    // the panel stays in the feed, shown as deleted
    const after = panel(wrapper, 101)
    expect(after.exists()).toBe(true)
    expect(after.find('[data-test="deleted"]').exists()).toBe(true)
    expect(after.find('.deleted-banner').exists()).toBe(true)
    expect(after.find('[data-test="restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="feed-position"]').text()).toBe(position)
    expect(router.currentRoute.value.fullPath).toBe(fullPath)
    expect(list.mock.calls.length).toBe(listCalls)
  })

  it('[covers:web-receipts.restore] 削除済みは確認なしで復元、Feed の位置・URL は不変', async () => {
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const del = vi.spyOn(api, 'deleteReceipt')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/receipts/102?from=2026-10-01&to=2026-10-31&include_deleted=1')
    const position = wrapper.find('[data-test="feed-position"]').text()
    const fullPath = router.currentRoute.value.fullPath
    const listCalls = list.mock.calls.length
    expect(panel(wrapper, 102).find('[data-test="deleted"]').exists()).toBe(true)
    await panel(wrapper, 102).find('[data-test="restore"]').trigger('click')
    await settle()
    expect(del).toHaveBeenCalledWith(1, 102, { restore: true, revision: 2 })
    expect(panel(wrapper, 102).exists()).toBe(true)
    expect(panel(wrapper, 102).find('[data-test="deleted"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="feed-position"]').text()).toBe(position)
    expect(router.currentRoute.value.fullPath).toBe(fullPath)
    expect(list.mock.calls.length).toBe(listCalls)
  })
})

describe('XSS', () => {
  it('[covers:web-xss.text-rendering] 利用者由来の文字列はテキストとして表示', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    await api.updateStore(1, 1, { name: evil })
    const stores = await mountApp('/settings/stores')
    expect(stores.wrapper.find('img').exists()).toBe(false)
    expect(stores.wrapper.find('[data-test="store-1"] [data-test="store-name"]').text()).toBe(evil)
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const detail = await mountApp('/receipts/101')
    expect(detail.wrapper.find('img[src="x"]').exists()).toBe(false)
    expect(detail.wrapper.find('[data-test="store-name"]').text()).toBe(evil)
  })
})

describe('ReceiptDetail image', () => {
  it('[covers:web-receipts.detail-image] API由来の/media/img URLのみ表示、期限切れは再取得、画像なしは省略', async () => {
    const { wrapper } = await mountApp('/receipts/101')
    const p = () => wrapper.find('[data-test="receipt-panel-101"]')
    const img = p().find('[data-test="receipt-image"]')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://localhost:40281/media/img/mock-token-101')
    expect(p().find('[data-test="image-expired"]').exists()).toBe(false)

    // token expiry -> img load error -> message + reload re-fetches the detail
    await img.trigger('error')
    await settle()
    expect(p().find('[data-test="receipt-image"]').exists()).toBe(false)
    expect(p().find('[data-test="image-expired"]').exists()).toBe(true)
    const spy = vi.spyOn(api, 'getReceipt')
    await p().find('[data-test="image-reload"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith(1, 101)
    expect(p().find('[data-test="receipt-image"]').exists()).toBe(true)

    // receipt without an image: nothing rendered in its panel
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const plain = await mountApp('/receipts/102')
    const pp = plain.wrapper.find('[data-test="receipt-panel-102"]')
    expect(pp.exists()).toBe(true)
    expect(pp.find('[data-test="receipt-image"]').exists()).toBe(false)
    expect(pp.find('[data-test="image-expired"]').exists()).toBe(false)

    // a URL outside /media/img/ is never used as the src (spec 11-7 rule)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const r = await api.getReceipt(1, 103)
    vi.spyOn(api, 'getReceipt').mockResolvedValue({
      ...r,
      image_url: { url: 'javascript:alert(1)', expires_at: '2099-01-01T00:00:00+09:00', width: 1, height: 1 },
    })
    const evil = await mountApp('/receipts/103')
    const ep = evil.wrapper.find('[data-test="receipt-panel-103"]')
    expect(ep.exists()).toBe(true)
    expect(ep.find('[data-test="receipt-image"]').exists()).toBe(false)
  })
})

describe('ReceiptsPage label filter (TASK-17)', () => {
  /** listReceipts responses with labels on receipt 101 (red). */
  function withRowLabels() {
    const orig = api.listReceipts.bind(api)
    return vi.spyOn(api, 'listReceipts').mockImplementation(async (l, q) => {
      const r = await orig(l, q)
      return {
        ...r,
        receipts: r.receipts.map((x) => ({
          ...x,
          labels: x.receipt_id === 101 ? [{ color: 'red' as const, title: null }] : [],
        })),
      }
    })
  }

  it('[covers:web-receipts.label-filter] 選択は URL labels に同期し listReceipts・getStats に label_colors、チップと解除、行に LabelDots compact', async () => {
    const list = withRowLabels()
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/receipts')

    // select red + blue on the LabelFilter (color toggles, OR)
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBe('red,blue')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    // the same-page stats (summary / payments / daily) get the filter too
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    // both toggles show the pressed state
    expect(wrapper.find('[data-test="label-filter-red"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="label-filter-blue"]').attributes('aria-pressed')).toBe('true')

    // the chip names the colors in Japanese and clears the selection
    const chips = wrapper.findAll('.filter-chip')
    const labelChip = chips.find((c) => c.text().includes('ラベル'))
    expect(labelChip).toBeTruthy()
    expect(labelChip!.text()).toContain('赤・青')
    await labelChip!.find('.chip-x').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBeUndefined()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: [] }))
    expect(wrapper.find('[data-test="label-filter-red"]').attributes('aria-pressed')).toBe('false')

    // the reserved row-labels element of a labeled row holds the dots
    expect(
      wrapper.find('[data-test="receipt-101"] [data-test="row-labels"] [data-test="label-dot"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-test="receipt-102"] [data-test="row-labels"] [data-test="label-dot"]').exists(),
    ).toBe(false)
  })
})
