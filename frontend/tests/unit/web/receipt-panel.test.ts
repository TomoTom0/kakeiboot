// ReceiptPanel labels slot (TASK-16 item 1, the TASK-17 interface).
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { h } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '@/web/api/auth'
import { setDataApi, type DataApi, type ReceiptView } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import ReceiptPanel from '@/web/components/ReceiptPanel.vue'
import { createAppRouter } from '@/web/router'
import { usePeriodStore } from '@/web/stores/period'
import { useSessionStore } from '@/web/stores/session'
import { ME, cleanup, mockFetch, settle } from './helpers'

let api: DataApi

beforeEach(() => {
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

describe('ReceiptPanel labels slot (TASK-17 interface)', () => {
  interface SlotProps {
    receipt: ReceiptView
    ledgerId: number
    canEdit: boolean
    editing: boolean
    applyReceipt: (next: ReceiptView) => void
  }

  async function mountPanel(me: Me, receiptId: number) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useSessionStore(pinia).setMe(me)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push(`/receipts/${receiptId}`)
    const recorded: SlotProps[] = []
    const wrapper = mount(ReceiptPanel, {
      props: { ledgerId: 1, receiptId },
      slots: {
        labels: (p: SlotProps) => {
          recorded.push(p)
          return h('span', { 'data-test': 'labels-probe' })
        },
      },
      global: { plugins: [pinia, router] },
    })
    await settle()
    return { wrapper, recorded, last: () => recorded.at(-1)! }
  }

  const withRole = (role: 'owner' | 'editor' | 'viewer'): Me => ({
    ...ME,
    ledgers: [{ id: 1, name: '家計', role, color: 'teal' }],
  })

  it('[covers:web-receipts.panel-labels-slot] labels slot に receipt・ledgerId・canEdit・editing・applyReceipt を渡す', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const editor = await mountPanel(withRole('editor'), 101)
    expect(editor.last().receipt.receipt_id).toBe(101)
    expect(editor.last().ledgerId).toBe(1)
    expect(editor.last().canEdit).toBe(true)
    expect(editor.last().editing).toBe(false)
    // placed at the end of the tags row inside .receipt-head (TASK-26: the
    // tags element is a div so the labels slot rides as its last child)
    const probe = editor.wrapper.find('[data-test="labels-probe"]').element
    const tags = editor.wrapper.find('.receipt-head .tags').element
    expect(probe.closest('.tags')).toBe(tags)
    expect(tags.tagName).toBe('DIV')
    expect(tags.lastElementChild).toBe(probe)

    // edit mode
    await editor.wrapper.find('[data-test="edit"]').trigger('click')
    await settle()
    expect(editor.last().editing).toBe(true)
    editor.wrapper.unmount()

    // viewer cannot edit
    const viewer = await mountPanel(withRole('viewer'), 101)
    expect(viewer.last().canEdit).toBe(false)
    viewer.wrapper.unmount()

    // a deleted receipt cannot be edited
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const deleted = await mountPanel(withRole('owner'), 102)
    expect(deleted.last().canEdit).toBe(false)
    deleted.wrapper.unmount()

    // applyReceipt replaces the panel's receipt and emits changed
    const owner = await mountPanel(withRole('owner'), 101)
    const next: ReceiptView = { ...owner.last().receipt, revision: 9, total_amount: 1234 }
    owner.last().applyReceipt(next)
    await settle()
    expect(owner.wrapper.find('[data-test="total"]').text()).toBe('1,234円')
    expect(owner.wrapper.find('[data-test="revision"]').text()).toBe('9')
    expect(owner.last().receipt.revision).toBe(9)
    const changed = owner.wrapper.emitted('changed')
    expect(changed).toBeTruthy()
    expect((changed!.at(-1)![0] as ReceiptView).revision).toBe(9)
    expect((changed!.at(-1)![0] as ReceiptView).total_amount).toBe(1234)
    // the panel never re-lists the sequence (Feed order / position are untouched)
    expect(list).not.toHaveBeenCalled()
  })

  it('[covers:web-receipts.payment-tag-link] 支払方法タグは /receipts?payment_method=&<購入月> へのリンク', async () => {
    const { wrapper } = await mountPanel(withRole('viewer'), 101)
    const tag = wrapper.find('[data-test="payment-method"]')
    expect(tag.exists()).toBe(true)
    expect(tag.element.tagName).toBe('A')
    expect(tag.classes()).toContain('tag-link')
    const url = new URL(tag.attributes('href')!, 'http://localhost')
    expect(url.pathname).toBe('/receipts')
    expect(url.searchParams.get('payment_method')).toBe('cash')
    expect(url.searchParams.get('month')).toBe('2026-10') // the purchase month
  })
})

describe('ReceiptPanel detail links (TASK-74 §4-8)', () => {
  /** Read-mode mount without the labels slot (the links are plain children). */
  async function mountReadonly(receiptId: number) {
    const pinia = createPinia()
    setActivePinia(pinia)
    useSessionStore(pinia).setMe(ME)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push(`/receipts/${receiptId}`)
    const wrapper = mount(ReceiptPanel, {
      props: { ledgerId: 1, receiptId },
      global: { plugins: [pinia, router] },
    })
    await settle()
    return { wrapper, router, pinia }
  }

  /** A detached copy of a mock receipt the test can reshape freely. */
  async function copyOf(receiptId: number): Promise<ReceiptView> {
    return JSON.parse(JSON.stringify(await api.getReceipt(1, receiptId))) as ReceiptView
  }

  it('[covers:web-receipts.item-category-link] 品目カテゴリは閲覧モードで購入月つきのカテゴリ詳細へリンク・未分類/未知パスは span・修正モードではリンクにならない', async () => {
    const { wrapper, router } = await mountReadonly(101)
    // 牛乳 (1001) / パン (1002): 食費/食料品 -> /categories/1/2 + the purchase month
    const link = wrapper.find('[data-test="item-cat-1001"]')
    expect(link.exists()).toBe(true)
    expect(link.element.tagName).toBe('A')
    expect(link.classes()).toContain('cat-link')
    const u = new URL(link.attributes('href')!, 'http://localhost')
    expect(u.pathname).toBe('/axes/category/1/2')
    expect(Object.fromEntries(u.searchParams)).toEqual({ month: '2026-10' })
    expect(wrapper.find('[data-test="item-cat-1002"]').attributes('href')).toBe('/axes/category/1/2?month=2026-10')
    await link.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/axes/category/1/2')
    wrapper.unmount()

    // 洗剤 (1003): 日用品 — a top-level category links one segment deep
    const daily = await mountReadonly(102)
    expect(daily.wrapper.find('[data-test="item-cat-1003"]').attributes('href')).toBe('/axes/category/4?month=2026-10')
    daily.wrapper.unmount()

    // 未分類 and a path the active catalog cannot resolve stay plain spans
    const r = await copyOf(101)
    r.items.push(
      { ...r.items[0]!, item_id: 1005, name: '備品', category: null },
      { ...r.items[0]!, item_id: 1006, name: '謎の品', category: '存在しない/パス' },
    )
    vi.spyOn(api, 'getReceipt').mockResolvedValue(r)
    const edited = await mountReadonly(101)
    const rows = edited.wrapper.findAll('[data-test="items"] tbody tr')
    expect(rows[2]!.find('[data-test="item-cat-1005"]').exists()).toBe(false)
    expect(rows[2]!.find('span.muted.small.block').text()).toBe('未分類')
    expect(rows[2]!.find('a').exists()).toBe(false)
    expect(rows[3]!.find('[data-test="item-cat-1006"]').exists()).toBe(false)
    expect(rows[3]!.find('span.muted.small.block').text()).toBe('存在しない/パス')

    // edit mode swaps the item table for the form: no category links
    await edited.wrapper.find('[data-test="edit"]').trigger('click')
    await settle()
    expect(edited.wrapper.find('[data-test="items-card"]').exists()).toBe(false)
    expect(edited.wrapper.find('[data-test="item-cat-1001"]').exists()).toBe(false)
    edited.wrapper.unmount()

    // no purchase date: the current period rides as-is (urlQuery's 3 forms)
    const undated = await copyOf(101)
    undated.purchased_on = null
    vi.spyOn(api, 'getReceipt').mockResolvedValue(undated)
    const ranged = await mountReadonly(101)
    usePeriodStore(ranged.pinia).fromQuery({ from: '2026-09-01', to: '2026-09-30' })
    await settle()
    expect(ranged.wrapper.find('[data-test="item-cat-1001"]').attributes('href')).toBe(
      '/axes/category/1/2?from=2026-09-01&to=2026-09-30',
    )
    ranged.wrapper.unmount()
  })

  it('[covers:web-receipts.store-links] 店名は店詳細・店カテゴリは店一覧の絞り込みへ、店不明は span のまま', async () => {
    const { wrapper, router } = await mountReadonly(101)
    const store = wrapper.find('[data-test="store-name"] a')
    expect(store.exists()).toBe(true)
    expect(store.classes()).toContain('store-link')
    expect(store.attributes('href')).toBe('/axes/store/1?month=2026-10')
    await store.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/axes/store/1')

    const cat = wrapper.find('[data-test="store-category"]')
    expect(cat.exists()).toBe(true)
    expect(cat.element.tagName).toBe('A')
    expect(cat.classes()).toContain('tag-link')
    const cu = new URL(cat.attributes('href')!, 'http://localhost')
    expect(cu.pathname).toBe('/stores')
    expect(Object.fromEntries(cu.searchParams)).toEqual({ store_category: 'スーパー', month: '2026-10' })
    wrapper.unmount()

    // エーマート: a resolved store without a category — no tag at all
    const second = await mountReadonly(102)
    expect(second.wrapper.find('[data-test="store-name"] a').attributes('href')).toBe('/axes/store/2?month=2026-10')
    expect(second.wrapper.find('[data-test="store-category"]').exists()).toBe(false)
    second.wrapper.unmount()

    // 店不明 (store null, raw name only): the plain span text
    const raw = await copyOf(102)
    raw.store = null
    raw.store_name_raw = '読み取れなかった店'
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const third = await mountReadonly(102)
    const name = third.wrapper.find('[data-test="store-name"]')
    expect(name.text()).toBe('読み取れなかった店')
    expect(name.find('a').exists()).toBe(false)
    third.wrapper.unmount()
  })
})
