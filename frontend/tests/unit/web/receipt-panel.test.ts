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
    // TASK-167 D-10: the chip tags row is gone — the labels slot rides at
    // the end of the head's datetime line, the same line that carries the
    // inline payment / store-category links
    const probe = editor.wrapper.find('[data-test="labels-probe"]').element
    expect(editor.wrapper.find('.receipt-head .tags').exists()).toBe(false)
    const line = editor.wrapper.find('[data-test="payment-method"]').element.parentElement
    expect(probe.parentElement).toBe(line)
    expect(line!.lastElementChild).toBe(probe)

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
    // TASK-167 D-8: the operating-meta footer (レシート #N・版・更新) is gone
    // — the revision is edit-lock data, never displayed
    expect(owner.wrapper.find('[data-test="revision"]').exists()).toBe(false)
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
    // TASK-167 D-10: inline on the datetime line, not a chip — the chip
    // vocabulary (.tag/.tag-link) is gone with the tags row
    expect(tag.classes()).not.toContain('tag-link')
    expect(tag.classes()).not.toContain('tag')
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

  it('[covers:web-receipts.item-category-link][covers:web-receipts.item-category-inline] 品目カテゴリは閲覧モードで購入月つきのカテゴリ詳細へリンク（inline muted・単独行なし）・未分類/未知パスは span・修正モードではリンクにならない', async () => {
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
    expect(rows[2]!.find('span.muted.small').text()).toBe('未分類')
    // TASK-167 D-5: the unresolved category is inline muted text — it no
    // longer takes its own line (the .block shape is gone)
    expect(rows[2]!.find('span.block').exists()).toBe(false)
    expect(rows[2]!.find('a').exists()).toBe(false)
    expect(rows[3]!.find('[data-test="item-cat-1006"]').exists()).toBe(false)
    expect(rows[3]!.find('span.muted.small').text()).toBe('存在しない/パス')

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
    // TASK-167 D-10: inline on the datetime line (no chip vocabulary)
    expect(cat.classes()).not.toContain('tag-link')
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


// TASK-167 B系 (design: tmp/tasks/tm-167/design_row_hierarchy.md v2
// §2 D-5..D-10): the receipt detail's leftover chrome goes and the item
// list takes a three-tier hierarchy (品目 < 明細合計 < レシート合計). The
// category rides inline muted after the name, the 見出し語「明細」「画像」
// the operating-meta footer, the note box and the chip tags row are gone,
// and 修正 becomes a pencil icon-only ibtn at the head. Test-first: red
// until the implementation lands.
describe('ReceiptPanel detail hierarchy (TASK-167)', () => {
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
    return { wrapper, pinia }
  }

  async function copyOf(receiptId: number): Promise<ReceiptView> {
    return JSON.parse(JSON.stringify(await api.getReceipt(1, receiptId))) as ReceiptView
  }

  it('[covers:web-receipts.items-typography] 明細zoneは見出し語なしでtable+tfootの階層のみ（h2「明細」「画像」廃止）', async () => {
    const { wrapper } = await mountReadonly(101)
    // D-6: the list and its total row describe themselves — no zone heading
    expect(wrapper.find('[data-test="items-card"] h2').exists()).toBe(false)
    // the image card shows the image itself (when one exists), no heading
    expect(wrapper.text()).not.toContain('画像</h2>')
    // the table body carries the items and the tfoot the 明細合計 pair
    expect(wrapper.findAll('[data-test="items"] tbody tr').length).toBeGreaterThan(0)
    const foot = wrapper.find('[data-test="items"] tfoot')
    expect(foot.text()).toContain('明細合計')
    expect(foot.find('[data-test="items-total"]').exists()).toBe(true)
  })

  it('[covers:web-receipts.edit-pencil-icon] 修正は頭部のpencil icon-only ibtn（aria-label=修正・「内容を修正」文言なし）でedit formへ', async () => {
    const { wrapper } = await mountReadonly(101)
    const btn = wrapper.find('[data-test="edit"]')
    expect(btn.exists()).toBe(true)
    // D-7: icon-only, its name lives in the aria-label alone
    expect(btn.attributes('aria-label')).toBe('修正')
    expect(btn.text()).toBe('')
    // at the head card's top-right (the 合計 block's side), not a footer
    expect(btn.element.closest('.receipt-head')).not.toBeNull()
    expect(wrapper.text()).not.toContain('内容を修正')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('[data-test="edit-form"]').exists()).toBe(true)
  })

  it('[covers:web-receipts.meta-footer-removed] footer運用meta行は廃止・note boxは読み取りviewから除去（edit formのtextareaは存続）', async () => {
    const raw = await copyOf(101)
    raw.note = 'ユーザー申告のamazon購入履歴から入力'
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(101)
    // D-8: レシート #N ・ 版 ・ 更新 — the operating meta is gone entirely
    expect(wrapper.find('.receipt-foot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('レシート #')
    expect(wrapper.text()).not.toContain('版')
    // D-9: the note stays DATA — the read view drops the box, the edit
    // form's textarea keeps reading and writing it
    expect(wrapper.find('[data-test="note"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('ユーザー申告')
    await wrapper.find('[data-test="edit"]').trigger('click')
    await settle()
    expect(wrapper.find<HTMLTextAreaElement>('[data-test="f-note"]').element.value).toBe('ユーザー申告のamazon購入履歴から入力')
  })

  it('[covers:web-receipts.head-tags-inline] 頭部のchip行は廃止: 支払・店categoryは日時行のinline link・「画像あり」chipは除去', async () => {
    const raw = await copyOf(101)
    raw.has_image = true
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(101)
    expect(wrapper.find('.receipt-head .tags').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('画像あり')
    // the payment and store-category links sit on the datetime line (the
    // same parent element), inline — their filter destinations are unchanged
    const pay = wrapper.find('[data-test="payment-method"]')
    const cat = wrapper.find('[data-test="store-category"]')
    expect(pay.element.parentElement).toBe(cat.element.parentElement)
    expect(new URL(pay.attributes('href')!, 'http://localhost').searchParams.get('payment_method')).toBe('cash')
  })
})
