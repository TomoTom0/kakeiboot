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
    // TASK-175 H-5: the chip tags row stays gone — the labels slot rides
    // inside the head sub-row's RIGHT-EDGE host (.receipt-sub-end), not
    // inline in the context text line
    const probe = editor.wrapper.find('[data-test="labels-probe"]').element
    expect(editor.wrapper.find('.receipt-header .tags').exists()).toBe(false)
    expect(probe.closest('.receipt-sub-end')).not.toBeNull()
    const pay = editor.wrapper.find('[data-test="payment-method"]').element
    expect(pay.parentElement?.classList.contains('receipt-sub-context')).toBe(true)
    expect(probe.closest('.receipt-sub-context')).toBeNull()

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
    // TASK-175 H-2: at the head MAIN row's right end — right AFTER the total
    // (the row's last child), never a footer, never a row of its own
    expect(btn.element.closest('.receipt-header')).not.toBeNull()
    const main = wrapper.find('.receipt-header .receipt-mainrow')
    expect(btn.element.closest('.receipt-mainrow')).not.toBeNull()
    expect(main.element.lastElementChild).toBe(btn.element)
    expect(btn.element.previousElementSibling?.classList.contains('receipt-total')).toBe(true)
    expect(wrapper.text()).not.toContain('内容を修正')
    await btn.trigger('click')
    await settle()
    expect(wrapper.find('[data-test="edit-form"]').exists()).toBe(true)
  })

  it('[covers:web-receipts.meta-footer-removed] footer運用meta行は廃止（revision は edit form の楽観lock用 data として継続）', async () => {
    const raw = await copyOf(101)
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(101)
    // D-8: レシート #N ・ 版 ・ 更新 — the operating meta is gone entirely
    // (TASK-170: the note box is BACK on the read view — its display is
    // web-receipts.note-display's own expectation now)
    expect(wrapper.find('.receipt-foot').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('レシート #')
    expect(wrapper.text()).not.toContain('版')
  })

  it('[covers:web-receipts.note-display] 読み取りviewは明細table直下に .receipt-note で note を表示（edit formのtextareaは不変）', async () => {
    const raw = await copyOf(101)
    raw.note = 'ユーザー申告のamazon購入履歴から入力'
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(101)
    // TASK-170 W-4: the note rides the shared .receipt-note vocabulary (the
    // same class the widget's receipt/draft screens use) as one block right
    // under the items table
    const note = wrapper.find('[data-test="note"]')
    expect(note.exists()).toBe(true)
    expect(note.classes()).toContain('receipt-note')
    expect(note.text()).toBe('ユーザー申告のamazon購入履歴から入力')
    expect(note.element.previousElementSibling).toBe(wrapper.find('[data-test="items"]').element)
    // the edit form keeps reading and writing it (textarea unchanged)
    await wrapper.find('[data-test="edit"]').trigger('click')
    await settle()
    expect(wrapper.find<HTMLTextAreaElement>('[data-test="f-note"]').element.value).toBe('ユーザー申告のamazon購入履歴から入力')
  })

  it('[covers:web-receipts.head-tags-inline] 頭部のchip行は廃止: 支払・店categoryは副行の文脈要素内inline link・「画像あり」chipは除去', async () => {
    const raw = await copyOf(101)
    raw.has_image = true
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(101)
    expect(wrapper.find('.receipt-header .tags').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('画像あり')
    // the payment and store-category links sit inside the head sub-row's
    // ONE context element (.receipt-sub-context), inline — their filter
    // destinations are unchanged
    const pay = wrapper.find('[data-test="payment-method"]')
    const cat = wrapper.find('[data-test="store-category"]')
    expect(pay.element.parentElement).toBe(cat.element.parentElement)
    expect(pay.element.closest('.receipt-sub-context')).not.toBeNull()
    expect(new URL(pay.attributes('href')!, 'http://localhost').searchParams.get('payment_method')).toBe('cash')
  })
})

// TASK-175 (design: tmp/tasks/tm-175/design_receipt-header-layout.md v3
// §1 H-1..H-9): the receipt head takes the LIST-ROW grammar via the shared
// ReceiptHeader component — one MAIN row (store name + the inline-label
// total at its right + the pencil at the row's far right) over one SUB row
// (the context links + the labels picker at the right edge). The total never
// takes a row of its own (the .receipt-side column stack is gone) and the
// store name is the ONLY ellipsis target. Test-first: red until the
// implementation lands.
describe('ReceiptPanel head row grammar (TASK-175)', () => {
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
    return { wrapper }
  }

  async function copyOf(receiptId: number): Promise<ReceiptView> {
    // structuredClone keeps the ReceiptView type (no as-cast — TASK-175
    // review #3: the type-safe convention holds in test code too)
    return structuredClone(await api.getReceipt(1, receiptId))
  }

  it('[covers:web-receipts.head-row-grammar] 頭部はReceiptHeaderの2行構成: 主行=店名+合計（label inline）右端+pencil最右端 / 副行=文脈要素+右端host・.receipt-side廃止', async () => {
    const { wrapper } = await mountReadonly(101)
    const header = wrapper.find('.receipt-header')
    expect(header.exists()).toBe(true)
    // H-9: the title keeps the goTo focus target (-1 tabindex rides on the
    // component's own h2)
    const main = header.find('.receipt-mainrow')
    expect(main.exists()).toBe(true)
    const title = main.find('h2.receipt-title')
    expect(title.exists()).toBe(true)
    expect(title.attributes('tabindex')).toBe('-1')
    // the store name alone ellipsizes: it rides its own .receipt-title-name
    // span INSIDE the title
    expect(title.find('.receipt-title-name').exists()).toBe(true)
    expect(title.find('[data-test="store-name"]').exists()).toBe(true)
    // the total never stacks: the label rides INLINE ahead of the value in
    // the same .receipt-total element
    const total = main.find('.receipt-total')
    expect(total.exists()).toBe(true)
    expect(total.find('.receipt-total__label').text()).toBe('合計')
    const totalValue = total.find('[data-test="total"]')
    expect(totalValue.exists()).toBe(true)
    expect(totalValue.element.parentElement).toBe(total.element)
    // the DOM order on the main row: title → total → edit (the pencil is the
    // row's LAST child, right of the total)
    const edit = main.find('[data-test="edit"]')
    expect(edit.exists()).toBe(true)
    expect(main.element.children[0]).toBe(title.element)
    expect(main.element.children[1]).toBe(total.element)
    expect(main.element.lastElementChild).toBe(edit.element)
    // the sub row: ONE context element + the right-edge host (the labels
    // slot target)
    const sub = header.find('.receipt-sub')
    expect(sub.exists()).toBe(true)
    expect(sub.find('.receipt-sub-context').exists()).toBe(true)
    expect(sub.find('.receipt-sub-end').exists()).toBe(true)
    // the old right-column stack and its vocabulary are gone entirely
    expect(wrapper.find('.receipt-side').exists()).toBe(false)
    expect(wrapper.find('.detail-title').exists()).toBe(false)
    expect(wrapper.find('.receipt-when').exists()).toBe(false)
  })

  it('[covers:web-receipts.head-row-grammar] total_diff は主行直下の条件付きwarn行（なしのとき存在しない）', async () => {
    // 101 itself carries no diff (total matches the items sum): no warn line
    const plain = await mountReadonly(101)
    expect(plain.wrapper.find('.receipt-header .warn').exists()).toBe(false)

    // a printed total off the items sum shows the warn line directly under
    // the MAIN row (before the sub row)
    const raw = await copyOf(101)
    raw.total_amount = (raw.items_total ?? 0) + 30
    raw.total_diff = 30
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const diff = await mountReadonly(101)
    const main = diff.wrapper.find('.receipt-header .receipt-mainrow')
    const warn = diff.wrapper.find('.receipt-header .warn')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toContain('明細合計')
    expect(warn.text()).toContain('差額')
    expect(warn.element.previousElementSibling).toBe(main.element)
    expect(diff.wrapper.find('.receipt-sub').element.previousElementSibling).toBe(warn.element)
  })

  it('[covers:web-receipts.head-row-grammar] 削除済みはpencil不在でbadgeはtitle内に残る・長店名+大きい金額+badge併存でも店名のみが省略対象', async () => {
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const raw = await copyOf(102)
    if (raw.store) raw.store.name = 'とても長い店名のスーパーマーケット成城石井ヒルズ店'
    raw.total_amount = 12345678
    vi.spyOn(api, 'getReceipt').mockResolvedValue(raw)
    const { wrapper } = await mountReadonly(102)
    const main = wrapper.find('.receipt-header .receipt-mainrow')
    // deleted: no pencil — the main row is [title(name+badge) … total]
    expect(main.find('[data-test="edit"]').exists()).toBe(false)
    const badge = main.find('[data-test="deleted"]')
    expect(badge.exists()).toBe(true)
    // the badge rides INSIDE the title but OUTSIDE the ellipsis span (the
    // name alone shrinks)
    expect(badge.element.closest('.receipt-title')).not.toBeNull()
    expect(badge.element.closest('.receipt-title-name')).toBeNull()
    const name = main.find('.receipt-title-name')
    expect(name.text()).toContain('とても長い店名の')
    // the full name stays readable via the title attribute (H-1)
    expect(name.attributes('title')).toBe('とても長い店名のスーパーマーケット成城石井ヒルズ店')
    // the big total rides the same main row, right of the title
    expect(main.find('[data-test="total"]').text()).toBe('12,345,678円')
    expect(main.element.lastElementChild?.classList.contains('receipt-total')).toBe(true)
  })
})
