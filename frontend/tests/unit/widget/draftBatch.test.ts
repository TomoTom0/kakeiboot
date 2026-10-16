// TASK-18: the draft_batch widget view (create_receipt_drafts #20 /
// approve_receipt_drafts #21). Rows reuse the draft list presentation with a
// per-row state, the header carries the counts and the approve-all button,
// and the approved state lives in a draft_id -> receipt_id map restored from
// widgetState (spec_mcp-tools.md 11-2 / 11-3; design
// tmp/tasks/tm-18/design_mcp-batch.md 2-7).
import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockImageUrl, sampleDraft } from '@/widget/fixtures'
import type { DraftView } from '@/shared/types'
import type { ToolCallResult } from '@/widget/host'
import { deferred, fakeHost, mountWidget, result } from './helpers'

/** draft_batch envelope for the tests below. */
function batchEnvelope(over: {
  batchId?: string | null
  drafts?: unknown[]
  results?: unknown[]
  rejected?: unknown[]
  images?: unknown[]
} = {}) {
  const drafts = (over.drafts ?? [pending(12, 2), pending(15, 1), pending(18, 1)]) as DraftView[]
  return {
    view: 'draft_batch',
    ledger: { id: 1, name: '我が家', source: 'draft' as const },
    batch_id: over.batchId ?? '01JBATCHWIDGET00000000',
    drafts,
    entry_draft_ids: drafts.map((_d, i) => i + 1),
    rejected: over.rejected ?? [],
    images: over.images ?? [],
    ...(over.results ? { results: over.results } : {}),
  }
}

function pending(draftId: number, revision: number, imageOver: Partial<DraftView['image']> = {}): DraftView {
  return sampleDraft({
    draft_id: draftId,
    revision,
    possible_duplicates: [],
    image: { status: 'attached', reason: null, display: '画像あり', ...imageOver },
  })
}

const row = (id: number) => `[data-draft="${id}"]`
const rowState = (id: number) => `${row(id)} [data-test="row-state"]`
const approveAll = '[data-test="approve-all-button"]'

const callsOf = (host: { callTool: unknown }) =>
  (host.callTool as unknown as { mock: { calls: unknown[][] } }).mock.calls

describe('draft_batch view', () => {
  it('[covers:widget.draft-batch-rows] shows counts, row states and the detail without callTool', async () => {
    const d12 = sampleDraft({}) // attached, possible_duplicates: receipt #88
    const d15 = pending(15, 1, { status: 'unavailable', reason: 'chat_upload', display: '画像なし' })
    const d18 = sampleDraft({ draft_id: 18, status: 'approved' as const, approved_receipt_id: 55, possible_duplicates: [] })
    const env = batchEnvelope({
      batchId: '01JBATCHWIDGET00000000',
      drafts: [d12, d15, d18],
      rejected: [{ entry_index: 5, errors: ['payload: 3行以内'] }],
      images: [{ index: 0, outcome: 'unreferenced', draft_ids: [] }],
    })
    const host = fakeHost({ toolOutput: env as never })
    const { wrapper } = await mountWidget(host)

    // header: ledger badge, counts, approve-all with the pending count
    expect(wrapper.find('[data-test="batch-count"]').text()).toContain('下書き 3 件')
    expect(wrapper.find('[data-test="batch-count"]').text()).toContain('画像あり 2')
    expect(wrapper.find('[data-test="batch-count"]').text()).toContain('画像なし 1')
    const all = wrapper.find(approveAll)
    expect(all.exists()).toBe(true)
    expect(all.text()).toBe('すべて登録（2 件）')

    // rows: the same presentation as the draft list (store / date / lines /
    // total / image wording / duplicate mark) plus the per-row state
    const r12 = wrapper.find(row(12))
    expect(r12.text()).toContain('スーパーみどり 駅前店')
    expect(r12.text()).toContain('2026-10-12')
    expect(r12.text()).toContain('画像あり')
    expect(r12.find('[data-test="dup-mark"]').exists()).toBe(true)
    expect(wrapper.find(rowState(12)).text()).toContain('未登録')
    expect(wrapper.find(rowState(15)).text()).toContain('未登録')
    expect(wrapper.find(row(15)).text()).toContain('画像なし')
    // already-approved draft shows its receipt number
    expect(wrapper.find(rowState(18)).text()).toContain('登録済み #55')

    // rejected entries and unreferenced images are not rendered as rows
    expect(wrapper.findAll('[data-draft]').length).toBe(3)

    // row tap opens the detail from structuredContent, without callTool
    await wrapper.find(row(12)).trigger('click')
    await flushPromises()
    expect(callsOf(host).length, 'the detail comes from the envelope').toBe(0)
    expect(wrapper.find('[data-test="draft-screen"]').exists()).toBe(true)
    // back returns to the list
    await wrapper.find('[data-test="back-button"]').trigger('click')
    expect(wrapper.find('[data-test="draft-batch-screen"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="draft-screen"]').exists()).toBe(false)
  })

  it('[covers:widget.batch-approve-all] sends the pending items once and reflects the results per row', async () => {
    const d20 = pending(20, 3)
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1), d20] })
    const singleApproved = {
      view: 'draft',
      ledger: { id: 1, name: '我が家', source: 'draft' as const },
      draft: sampleDraft({ draft_id: 20, status: 'approved' as const, approved_receipt_id: 77, possible_duplicates: [] }),
      receipt_id: 77,
    }
    const gate = deferred<ToolCallResult>()
    const host = fakeHost({
      toolOutput: env as never,
      callTool: (name) => {
        if (name === 'approve_receipt_draft') return Promise.resolve(result(singleApproved as never))
        return gate.promise
      },
    })
    const { wrapper } = await mountWidget(host)

    // one draft is approved individually in its detail first
    await wrapper.find(row(20)).trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="approve-button"]').trigger('click')
    await flushPromises()
    expect(callsOf(host).at(-1)).toEqual(['approve_receipt_draft', { draft_id: 20, revision: 3 }])
    await wrapper.find('[data-test="back-button"]').trigger('click')

    // approve-all: only the still-pending drafts are sent
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(callsOf(host).at(-1)).toEqual([
      'approve_receipt_drafts',
      { items: [{ draft_id: 12, revision: 2 }, { draft_id: 15, revision: 1 }] },
    ])
    // while running, a second tap sends nothing more
    const callsBefore = callsOf(host).length
    await wrapper.find(approveAll).trigger('click')
    expect(callsOf(host).length).toBe(callsBefore)

    // all-approved answer: every row turns into its receipt number
    gate.resolve(
      result(
        batchEnvelope({
          batchId: null,
          drafts: [
            sampleDraft({ draft_id: 12, status: 'approved' as const, approved_receipt_id: 101, possible_duplicates: [] }),
            sampleDraft({ draft_id: 15, status: 'approved' as const, approved_receipt_id: 102, possible_duplicates: [] }),
            sampleDraft({ draft_id: 20, status: 'approved' as const, approved_receipt_id: 77, possible_duplicates: [] }),
          ],
          results: [
            { draft_id: 12, outcome: 'approved', receipt_id: 101, revision: 2 },
            { draft_id: 15, outcome: 'approved', receipt_id: 102, revision: 1 },
          ],
        }) as never,
      ),
    )
    await flushPromises()
    expect(wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    expect(wrapper.find(rowState(15)).text()).toContain('登録済み #102')
    expect(wrapper.find(rowState(20)).text()).toContain('登録済み #77')
    // the approved map is persisted (draft_id -> receipt_id)
    const last = host.setWidgetState.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(last).toMatchObject({ approved: { 12: 101, 15: 102, 20: 77 } })
  })

  it('[covers:widget.batch-approve-partial] redraws stale rows, parks conflicts, never re-approves', async () => {
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1), pending(18, 1)] })
    const answered = batchEnvelope({
      batchId: null,
      drafts: [
        sampleDraft({ draft_id: 12, status: 'approved' as const, approved_receipt_id: 101, possible_duplicates: [] }),
        sampleDraft({
          draft_id: 15,
          revision: 3,
          possible_duplicates: [],
          payload: { ...sampleDraft().payload, store_name: '新しい店', purchased_on: '2026-10-14' },
        }),
        sampleDraft({ draft_id: 18, status: 'discarded' as const, possible_duplicates: [] }),
      ],
      results: [
        { draft_id: 12, outcome: 'approved', receipt_id: 101, revision: 2 },
        { draft_id: 15, outcome: 'stale_revision', revision: 3 },
        { draft_id: 18, outcome: 'conflict', revision: 1 },
      ],
    })
    const host = fakeHost({ toolOutput: env as never, callTool: async () => result(answered as never) })
    const { wrapper } = await mountWidget(host)

    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(callsOf(host).length, 'one approve_receipt_drafts call').toBe(1)

    // approved row
    expect(wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    // stale row: redrawn at the latest content with the guidance
    const r15 = wrapper.find(row(15))
    expect(r15.text()).toContain('新しい店')
    expect(r15.text()).toContain('2026-10-14')
    // the stale row stays pending (it goes out again at its latest revision)
    expect(r15.find('[data-test="row-state"]').text()).toContain('内容が更新されています')
    expect(wrapper.find(approveAll).text()).toBe('すべて登録（1 件）')
    expect(wrapper.find('[data-test="draft-batch-screen"]').text()).toContain('内容が更新されています')
    // conflict row: state only, no approval action, stays 要確認
    expect(wrapper.find(rowState(18)).text()).toContain('要確認')
    expect(wrapper.find(row(18)).find('[data-test="approve-button"]').exists()).toBe(false)
    // no automatic re-approval
    await flushPromises()
    expect(callsOf(host).length).toBe(1)
  })

  it('[covers:widget.approved-map-restored] restores row states from the approved map and legacy keys', async () => {
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1), pending(18, 1)] })
    const host = fakeHost({
      toolOutput: env as never,
      widgetState: { approved: { 12: 101, 15: 102 } } as never,
      callTool: async () =>
        result(
          batchEnvelope({
            batchId: null,
            drafts: [sampleDraft({ draft_id: 18, status: 'approved' as const, approved_receipt_id: 30, possible_duplicates: [] })],
            results: [{ draft_id: 18, outcome: 'approved', receipt_id: 30, revision: 1 }],
          }) as never,
        ),
    })
    const { wrapper } = await mountWidget(host)
    // rows known to the map render as registered and leave the pending set
    expect(wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    expect(wrapper.find(rowState(15)).text()).toContain('登録済み #102')
    expect(wrapper.find(rowState(18)).text()).toContain('未登録')
    expect(wrapper.find(approveAll).text()).toBe('すべて登録（1 件）')

    // the remaining draft is the only one submitted
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(callsOf(host).at(-1)).toEqual([
      'approve_receipt_drafts',
      { items: [{ draft_id: 18, revision: 1 }] },
    ])

    // legacy widgetState keys migrate into the same display
    const legacy = fakeHost({
      toolOutput: batchEnvelope({ drafts: [pending(12, 2), pending(15, 1)] }) as never,
      widgetState: { approved_draft_id: 12, approved_receipt_id: 101, approved_ledger_name: '我が家' },
    })
    const m2 = await mountWidget(legacy)
    expect(m2.wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    expect(m2.wrapper.find(rowState(15)).text()).toContain('未登録')
    expect(m2.wrapper.find(approveAll).text()).toBe('すべて登録（1 件）')
  })

  it('[covers:widget.draft-batch-rows] the detail uses the initial image URL of _meta.images.drafts without callTool', async () => {
    const url = mockImageUrl('batch12token')
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1)] })
    const host = fakeHost({
      toolOutput: env as never,
      meta: { images: { drafts: { 12: { url, expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 } } } } as never,
    })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(row(12)).trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="image-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe(url)
    expect(callsOf(host).length, 'no refresh_widget_images for a fresh batch URL').toBe(0)
  })

  it('[covers:widget.batch-approve-all] keeps the rows that were not sent and the counts after approve-all', async () => {
    const d18 = sampleDraft({ draft_id: 18, status: 'approved' as const, approved_receipt_id: 55, possible_duplicates: [] })
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1, { status: 'unavailable', reason: 'chat_upload', display: '画像なし' }), d18] })
    // #21 returns only the drafts it resolved (the sent ones)
    const answered = batchEnvelope({
      batchId: null,
      drafts: [
        sampleDraft({ draft_id: 12, status: 'approved' as const, approved_receipt_id: 101, possible_duplicates: [] }),
        sampleDraft({
          draft_id: 15,
          status: 'approved' as const,
          approved_receipt_id: 102,
          possible_duplicates: [],
          image: { status: 'unavailable', reason: 'chat_upload', display: '画像なし' },
        }),
      ],
      results: [
        { draft_id: 12, outcome: 'approved', receipt_id: 101, revision: 2 },
        { draft_id: 15, outcome: 'approved', receipt_id: 102, revision: 1 },
      ],
    })
    const host = fakeHost({ toolOutput: env as never, callTool: async () => result(answered as never) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(callsOf(host).at(-1)).toEqual([
      'approve_receipt_drafts',
      { items: [{ draft_id: 12, revision: 2 }, { draft_id: 15, revision: 1 }] },
    ])
    expect(wrapper.findAll('[data-draft]').length, 'the unsent row stays').toBe(3)
    expect(wrapper.find(rowState(18)).text()).toContain('登録済み #55')
    expect(wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    expect(wrapper.find(rowState(15)).text()).toContain('登録済み #102')
    const count = wrapper.find('[data-test="batch-count"]').text()
    expect(count).toContain('下書き 3 件')
    expect(count).toContain('画像あり 2')
    expect(count).toContain('画像なし 1')
  })

  it('[covers:widget.batch-approve-partial] an all-stale isError answer redraws the rows and the next press sends the new revisions', async () => {
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1)] })
    const stale = batchEnvelope({
      batchId: null,
      drafts: [
        sampleDraft({ draft_id: 12, revision: 4, possible_duplicates: [], payload: { ...sampleDraft().payload, store_name: '更新後の店' } }),
        sampleDraft({ draft_id: 15, revision: 3, possible_duplicates: [] }),
      ],
      results: [
        { draft_id: 12, outcome: 'stale_revision', revision: 4 },
        { draft_id: 15, outcome: 'stale_revision', revision: 3 },
      ],
    })
    const host = fakeHost({
      toolOutput: env as never,
      callTool: async () => result(stale as never, { isError: true, text: 'どの下書きも確定できませんでした。' }),
    })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="stale-band"]').exists()).toBe(true)
    expect(wrapper.find(row(12)).text()).toContain('更新後の店')
    expect(wrapper.find(rowState(12)).text()).toContain('内容が更新されています')
    expect(wrapper.find(approveAll).text()).toBe('すべて登録（2 件）')
    // no automatic re-approval; the user's next press sends the latest revisions
    expect(callsOf(host).length).toBe(1)
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(callsOf(host).at(-1)).toEqual([
      'approve_receipt_drafts',
      { items: [{ draft_id: 12, revision: 4 }, { draft_id: 15, revision: 3 }] },
    ])
  })

  it('[covers:widget.batch-approve-all] rows cannot open the detail while approve-all is in flight', async () => {
    const gate = deferred<ToolCallResult>()
    const env = batchEnvelope({ drafts: [pending(12, 2), pending(15, 1)] })
    const host = fakeHost({ toolOutput: env as never, callTool: () => gate.promise })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(approveAll).trigger('click')
    await flushPromises()
    expect(wrapper.find(row(12)).attributes('disabled')).toBeDefined()
    await wrapper.find(row(12)).trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="draft-screen"]').exists()).toBe(false)
    gate.resolve(
      result(
        batchEnvelope({
          batchId: null,
          drafts: [sampleDraft({ draft_id: 12, status: 'approved' as const, approved_receipt_id: 101, possible_duplicates: [] })],
          results: [{ draft_id: 12, outcome: 'approved', receipt_id: 101, revision: 2 }],
        }) as never,
      ),
    )
    await flushPromises()
    expect(wrapper.find('[data-test="draft-batch-screen"]').exists()).toBe(true)
    expect(wrapper.find(rowState(12)).text()).toContain('登録済み #101')
    expect(wrapper.find(rowState(15)).text()).toContain('未登録')
  })
})
