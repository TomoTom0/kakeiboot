import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { ToolCallResult } from '@/widget/host'
import { draftEnvelope, draftMeta, sampleDraft } from '@/widget/fixtures'
import { deferred, fakeHost, mountWidget, result } from './helpers'

const button = '[data-test="approve-button"]'
const message = '[data-test="approve-message"]'

describe('approve button (spec 11-3)', () => {
  it('[covers:widget.approve-sends-revision] sends draft_id + revision and shows the submitting state', async () => {
    const pending = deferred<ToolCallResult>()
    const host = fakeHost({ toolOutput: draftEnvelope(), meta: draftMeta(), callTool: () => pending.promise })
    const { wrapper } = await mountWidget(host)
    expect(wrapper.find(button).text()).toBe('この内容で登録')
    await wrapper.find(button).trigger('click')
    expect(host.callTool).toHaveBeenCalledTimes(1)
    expect(host.callTool).toHaveBeenCalledWith('approve_receipt_draft', { draft_id: 12, revision: 2 })
    const b = wrapper.find(button)
    expect(b.attributes('disabled')).toBeDefined()
    expect(b.text()).toBe('登録中')
    // A second tap while submitting does not send another request.
    await b.trigger('click')
    expect(host.callTool).toHaveBeenCalledTimes(1)
    pending.resolve(result(null, { isError: true, text: 'x' }))
    await flushPromises()
  })

  it('[covers:widget.approve-success-persists-state] shows the registered message and persists the approved map', async () => {
    const approved = { ...draftEnvelope({ status: 'approved', approved_receipt_id: 101 }), receipt_id: 101, idempotent_hit: false }
    const host = fakeHost({ toolOutput: draftEnvelope(), meta: draftMeta(), callTool: async () => result(approved) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(button).trigger('click')
    await flushPromises()
    expect(wrapper.find(message).text()).toBe('登録しました（家計簿 我が家 / レシート #101）')
    expect(wrapper.find(button).exists()).toBe(false)
    // TASK-18: the approval is persisted as a draft_id -> receipt_id map so a
    // batch view can hold several approvals at once
    const last = host.setWidgetState.mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({ approved: { 12: 101 }, draft_id: 12 })
  })

  it('[covers:widget.approve-success-persists-state] idempotent hit is shown as success too', async () => {
    const approved = { ...draftEnvelope({ status: 'approved', approved_receipt_id: 101 }), receipt_id: 101, idempotent_hit: true }
    const host = fakeHost({ toolOutput: draftEnvelope(), callTool: async () => result(approved) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(button).trigger('click')
    await flushPromises()
    expect(wrapper.find(message).text()).toContain('レシート #101')
    const last = host.setWidgetState.mock.calls.at(-1)?.[0]
    expect(last).toMatchObject({ approved: { 12: 101 } })
  })

  it('[covers:widget.approve-stale-rerenders] redraws the latest revision and does not re-approve automatically', async () => {
    const latest = draftEnvelope({
      revision: 3,
      payload: { ...sampleDraft().payload, items: [{ line_no: 1, name: '豆乳', amount: 198, category: '食費/食料品' }] },
    })
    const host = fakeHost({ toolOutput: draftEnvelope(), meta: draftMeta(), callTool: async () => result(latest, { isError: true, text: 'stale' }) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(button).trigger('click')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('rev 3')
    expect(wrapper.text()).toContain('豆乳')
    expect(wrapper.find(message).text()).toContain('内容が更新されています')
    const b = wrapper.find(button)
    expect(b.attributes('disabled')).toBeUndefined()
    await b.trigger('click')
    expect(host.callTool).toHaveBeenLastCalledWith('approve_receipt_draft', { draft_id: 12, revision: 3 })
  })

  it('[covers:widget.approve-conflict-hides-button] discarded / approved elsewhere hide the button', async () => {
    for (const [over, text] of [
      [{ status: 'discarded' as const }, '破棄されています'],
      [{ status: 'approved' as const, approved_receipt_id: 77 }, '別の内容で登録済みです（レシート #77）'],
      [{ status: 'expired' as const }, '期限切れ'],
    ] as const) {
      const host = fakeHost({ toolOutput: draftEnvelope(), callTool: async () => result(draftEnvelope(over), { isError: true }) })
      const { wrapper } = await mountWidget(host)
      await wrapper.find(button).trigger('click')
      await flushPromises()
      expect(wrapper.find(message).text()).toContain(text)
      expect(wrapper.find(button).exists()).toBe(false)
    }
  })

  it('[covers:widget.approve-other-error-reenables] shows the error text and re-enables the button', async () => {
    const host = fakeHost({ toolOutput: draftEnvelope(), callTool: async () => result(null, { isError: true, text: '承認の検証に失敗しました: purchased_on' }) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find(button).trigger('click')
    await flushPromises()
    expect(wrapper.find(message).text()).toBe('承認の検証に失敗しました: purchased_on')
    expect(wrapper.find(button).attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('rev 2')

    const throwing = fakeHost({
      toolOutput: draftEnvelope(),
      callTool: async () => {
        throw new Error('ネットワークエラー')
      },
    })
    const m2 = await mountWidget(throwing)
    await m2.wrapper.find(button).trigger('click')
    await flushPromises()
    expect(m2.wrapper.find(message).text()).toBe('ネットワークエラー')
    expect(m2.wrapper.find(button).attributes('disabled')).toBeUndefined()
  })

  it('[covers:widget.approved-state-restored] widgetState approval map suppresses the stale button', async () => {
    // the approved map (draft_id -> receipt_id) restores the done state
    const host = fakeHost({
      toolOutput: draftEnvelope(),
      widgetState: { approved: { 12: 101 }, approved_ledger_name: '我が家' } as never,
    })
    const { wrapper } = await mountWidget(host)
    expect(wrapper.find(button).exists()).toBe(false)
    expect(wrapper.find(message).text()).toContain('レシート #101')

    // a map without this draft keeps the button
    const other = fakeHost({ toolOutput: draftEnvelope(), widgetState: { approved: { 99: 55 } } as never })
    const m2 = await mountWidget(other)
    expect(m2.wrapper.find(button).exists()).toBe(true)

    // legacy widgetState (approved_draft_id / approved_receipt_id) migrates
    // into the map on load and renders the same
    const legacy = fakeHost({
      toolOutput: draftEnvelope(),
      widgetState: { approved_draft_id: 12, approved_receipt_id: 101, approved_ledger_name: '我が家' },
    })
    const m3 = await mountWidget(legacy)
    expect(m3.wrapper.find(button).exists()).toBe(false)
    expect(m3.wrapper.find(message).text()).toContain('レシート #101')
  })
})
