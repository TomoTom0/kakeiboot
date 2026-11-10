import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { draftEnvelope, draftListEnvelope, draftMeta, itemListEnvelope, receiptEnvelope, receiptListEnvelope, receiptListMeta, receiptMeta, sampleDraft, statsEnvelope } from '@/widget/fixtures'
import { fakeHost, mountWidget, result } from './helpers'

/** draft_batch envelope (TASK-18): DraftView[] + batch_id string|null. */
function draftBatchEnvelope(batchId: string | null, drafts: unknown[] = [sampleDraft()]) {
  return {
    view: 'draft_batch',
    ledger: { id: 1, name: '我が家', source: 'draft' as const },
    batch_id: batchId,
    drafts,
    entry_draft_ids: drafts.map((_d, i) => i + 1),
    rejected: [],
    images: [],
  }
}

describe('routing', () => {
  it('[covers:widget.routes-by-view] each view renders its screen', async () => {
    const cases: [unknown, string][] = [
      [draftEnvelope(), 'draft-screen'],
      [draftListEnvelope(), 'draft-list-screen'],
      [draftBatchEnvelope('01JBATCH0000000000000'), 'draft-batch-screen'],
      [draftBatchEnvelope(null), 'draft-batch-screen'],
      [receiptEnvelope(), 'receipt-screen'],
      [receiptListEnvelope(), 'receipt-list-screen'],
      [itemListEnvelope(), 'receipt-list-screen'],
      [statsEnvelope(), 'stats-screen'],
    ]
    for (const [out, testId] of cases) {
      const { wrapper } = await mountWidget(fakeHost({ toolOutput: out }))
      expect(wrapper.find(`[data-test="${testId}"]`).exists(), testId).toBe(true)
      expect(wrapper.find('[data-test="error"]').exists()).toBe(false)
    }
  })

  it('[covers:widget.routes-by-view] draft_batch accepts only an array body with batch_id string|null', async () => {
    // valid: drafts is an array and batch_id is a string or null (above);
    // invalid: drafts not an array, or batch_id missing / wrong type
    for (const bad of [
      { view: 'draft_batch', ledger: null, drafts: { a: 1 }, batch_id: '01J' },
      { view: 'draft_batch', ledger: null, drafts: [sampleDraft()] },
      { view: 'draft_batch', ledger: null, drafts: [sampleDraft()], batch_id: 7 },
    ]) {
      const { wrapper } = await mountWidget(fakeHost({ toolOutput: bad }))
      expect(wrapper.find('[data-test="draft-batch-screen"]').exists()).toBe(false)
      expect(wrapper.find('[data-test="error"]').text()).toBe('この結果は表示できません。')
    }
  })

  it('[covers:widget.initial-and-invalid-output] waits for output, rejects unknown shapes', async () => {
    const empty = await mountWidget(fakeHost({ toolOutput: null }))
    expect(empty.wrapper.find('[data-test="initial"]').exists()).toBe(true)
    for (const bad of [{ view: 'catalog', ledger: null }, { view: 'draft', ledger: null }]) {
      const { wrapper } = await mountWidget(fakeHost({ toolOutput: bad }))
      expect(wrapper.find('[data-test="error"]').text()).toBe('この結果は表示できません。')
      expect(wrapper.find('article').exists()).toBe(false)
    }
  })
})

describe('list -> detail', () => {
  it('[covers:widget.list-to-detail-navigation] draft list row opens the draft via get_receipt_drafts, back returns', async () => {
    const host = fakeHost({ toolOutput: draftListEnvelope(), callTool: async () => result(draftEnvelope(), { meta: draftMeta() }) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-draft="12"]').trigger('click')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledWith('get_receipt_drafts', { draft_id: 12 })
    expect(wrapper.find('[data-test="draft-screen"]').exists()).toBe(true)
    expect(host.setWidgetState.mock.calls.at(-1)?.[0]).toMatchObject({ stack: ['draft_list', 'draft'], draft_id: 12, revision: 2 })
    await wrapper.find('[data-test="back-button"]').trigger('click')
    expect(wrapper.find('[data-test="draft-list-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="back-button"]').exists()).toBe(false)
    expect(host.setWidgetState.mock.calls.at(-1)?.[0]).toMatchObject({ stack: ['draft_list'], draft_id: null })
  })

  it('[covers:widget.list-to-detail-navigation] receipt / item list rows open get_receipt; errors keep the list', async () => {
    const host = fakeHost({ toolOutput: receiptListEnvelope(), callTool: async (_n, a) => result(receiptEnvelope(Number(a.receipt_id)), { meta: receiptMeta() }) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-receipt="88"]').trigger('click')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledWith('get_receipt', { receipt_id: 88 })
    expect(wrapper.find('[data-test="receipt-screen"]').exists()).toBe(true)

    const items = fakeHost({ toolOutput: itemListEnvelope(), callTool: async (_n, a) => result(receiptEnvelope(Number(a.receipt_id))) })
    const m2 = await mountWidget(items)
    await m2.wrapper.find('[data-receipt="70"]').trigger('click')
    await flushPromises()
    expect(items.callTool).toHaveBeenCalledWith('get_receipt', { receipt_id: 70 })
    // TASK-170: the receipt detail no longer prints the運用meta行 (レシート #N)
    // — the store name proves the screen rendered
    expect(m2.wrapper.find('[data-test="receipt-screen"]').exists()).toBe(true)
    expect(m2.wrapper.text()).toContain('スーパーみどり')

    const failing = fakeHost({ toolOutput: receiptListEnvelope(), callTool: async () => result(null, { isError: true, text: '見つかりません' }) })
    const m3 = await mountWidget(failing)
    await m3.wrapper.find('[data-receipt="88"]').trigger('click')
    await flushPromises()
    expect(m3.wrapper.find('[data-test="error"]').text()).toBe('見つかりません')
    expect(m3.wrapper.find('[data-test="receipt-list-screen"]').exists()).toBe(true)
  })

  it('[covers:widget.draft-list-rows] rows show ledger name, image display and duplicate mark', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftListEnvelope() }))
    const r12 = wrapper.find('[data-draft="12"]')
    const r15 = wrapper.find('[data-draft="15"]')
    expect(r12.text()).toContain('我が家')
    expect(r12.text()).toContain('画像あり')
    expect(r12.find('[data-test="dup-mark"]').exists()).toBe(true)
    expect(r15.text()).toContain('実家')
    expect(r15.text()).toContain('画像なし')
    expect(r15.find('[data-test="dup-mark"]').exists()).toBe(false)
  })

  it('[covers:widget.receipt-list-row-grammar] 一覧行は .data-row 2行文法（top_items 副行・matched_items/N行は廃止・item_list 行は品名+日付・店名・category）', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: receiptListEnvelope(), meta: receiptListMeta() }))
    const r88 = wrapper.find('[data-receipt="88"]')
    // the root is the shared DataRow button; the thumb rides the main line
    expect(r88.element.tagName).toBe('BUTTON')
    expect(r88.classes()).toContain('data-row')
    expect(r88.classes()).toContain('is-link')
    const main = r88.find('.row-main')
    expect(main.exists()).toBe(true)
    expect(main.find('.bb-thumb').exists()).toBe(true)
    expect(main.text()).toContain('スーパーみどり 駅前店')
    expect(r88.find('.amount').text()).toContain('900円')
    // the sub line: representative items (top_items) + the date-time figure
    // + the label dots at its right end
    const sub = r88.find('.row-sub')
    expect(sub.exists()).toBe(true)
    expect(sub.text()).toContain('りんご・ティッシュ')
    expect(sub.text()).toContain('2026-10-11')
    expect(sub.text()).toContain('17:40')
    expect(sub.find('[data-test="row-labels"]').exists()).toBe(true)
    // review指摘4: the sub line's order is 代表品目 → 日時 → the labels at
    // the right end (the shared DataRow contract, spec §11-2)
    const subOrder = ['row-items', 'row-fig', 'row-labels'].map((cls) =>
      Array.from(sub.element.children).findIndex((el) => el.classList.contains(cls)),
    )
    expect(subOrder[0]).toBeGreaterThanOrEqual(0)
    expect(subOrder[0]!).toBeLessThan(subOrder[1]!)
    expect(subOrder[1]!).toBeLessThan(subOrder[2]!)
    // the search-match items and the item_count（「N 行」）are GONE: row 90
    // keeps matched_items in the fixture but shows the date alone
    const r90 = wrapper.find('[data-receipt="90"]')
    expect(r90.find('.row-sub').text()).not.toContain('牛乳')
    expect(r90.find('.row-sub').text()).toContain('2026-10-05')
    for (const r of [r88, r90]) expect(r.text(), 'item_count is not shown').not.toMatch(/\d行/)

    // top_items missing (an old response) and an empty array both fall back
    // to the date-only sub line
    const missing = receiptListEnvelope()
    const missing88 = missing.receipts[0]
    if (missing88) delete missing88.top_items
    const m1 = await mountWidget(fakeHost({ toolOutput: missing }))
    expect(m1.wrapper.find('[data-receipt="88"] .row-sub').text()).not.toContain('りんご')
    expect(m1.wrapper.find('[data-receipt="88"] .row-sub').text()).toContain('2026-10-11')
    const empty = receiptListEnvelope()
    const empty88 = empty.receipts[0]
    if (empty88) empty88.top_items = []
    const m2 = await mountWidget(fakeHost({ toolOutput: empty }))
    expect(m2.wrapper.find('[data-receipt="88"] .row-sub').text()).not.toContain('りんご')

    // item_list rows: main = the item name + amount_incl, sub = the date /
    // store name / category (non-pressable muted text)
    const items = await mountWidget(fakeHost({ toolOutput: itemListEnvelope() }))
    const it1 = items.wrapper.find('[data-receipt="90"]')
    expect(it1.classes()).toContain('data-row')
    expect(it1.find('.row-main').text()).toContain('牛乳')
    expect(it1.find('.amount').text()).toContain('248円')
    const isub = it1.find('.row-sub')
    expect(isub.exists()).toBe(true)
    expect(isub.text()).toContain('2026-10-05')
    expect(isub.text()).toContain('コンビニ北口')
    expect(isub.text()).toContain('食費/食料品')
  })

  it('[covers:widget.draft-rows-grammar] DraftList 行は .data-row 2行（主行=店名+合計・副行=日付+画像状態+ledger chip+重複 chip・「N 行」なし）', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftListEnvelope() }))
    const r12 = wrapper.find('[data-draft="12"]')
    expect(r12.element.tagName).toBe('BUTTON')
    expect(r12.classes()).toContain('data-row')
    expect(r12.find('.row-main').text()).toContain('スーパーみどり')
    expect(r12.find('.amount').text()).toContain('1,280円')
    const sub = r12.find('.row-sub')
    expect(sub.exists()).toBe(true)
    expect(sub.text()).toContain('2026-10-12')
    expect(sub.text()).toContain('画像あり')
    expect(sub.text()).toContain('我が家')
    // the duplicate chip rides inside the sub line (inline)
    const dup = r12.find('[data-test="dup-mark"]')
    expect(dup.exists()).toBe(true)
    expect(dup.element.closest('.row-sub')).not.toBeNull()
    for (const id of [12, 15]) expect(wrapper.find(`[data-draft="${id}"]`).text()).not.toMatch(/\d行/)
  })
})
