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
    owner.wrapper.unmount()
  })
})
