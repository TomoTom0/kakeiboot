import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { draftEnvelope, draftListEnvelope, draftMeta, itemListEnvelope, receiptEnvelope, receiptListEnvelope, receiptMeta, sampleDraft, statsEnvelope } from '@/widget/fixtures'
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
    expect(m2.wrapper.text()).toContain('レシート #70')

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
})
