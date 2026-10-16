// LabelPicker in the ReceiptPanel labels slot (TASK-17): immediate toggles
// with per-receipt serialization, diff composition, per-color rollback and
// the applyReceipt write-back through the real Feed mount. The slot contract
// itself is covered by receipt-panel.test.ts; this file fills the slot with
// the real component (the TASK-17 implementation of ReceiptDetailPage).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataApi, type DataApi, type ReceiptView } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

interface Label {
  color: string
  title: string | null
}
interface SetLabelsInput {
  add?: string[]
  remove?: string[]
}

let api: DataApi

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

const ME_VIEWER = { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] }
const DETAIL = '/receipts/101?from=2026-10-01&to=2026-10-31'

/** getReceipt responses carrying the given labels (every receipt id). */
async function withLabels(labels: Label[]) {
  const base = await api.getReceipt(1, 101)
  return vi.spyOn(api, 'getReceipt').mockImplementation(async (_l, id) =>
    ({ ...base, receipt_id: id, labels }) as ReceiptView,
  )
}

/** Inject a setReceiptLabels implementation (absent from the mock until the
 * TASK-17 implementation adds it) and return the spy. */
function injectSetLabels(
  impl: (ledgerId: number, receiptId: number, input: SetLabelsInput) => Promise<{ receipt_id: number; labels: Label[] }>,
) {
  const fn = vi.fn(impl)
  Object.assign(api, { setReceiptLabels: fn })
  return fn
}

const picker = (w: W, id = 101) => w.find(`[data-test="receipt-panel-${id}"] [data-test="label-picker"]`)
const toggle = (w: W, color: string, id = 101) =>
  w.find(`[data-test="receipt-panel-${id}"] [data-test="label-toggle-${color}"]`)
const isPressed = (w: W, color: string, id = 101) => toggle(w, color, id).attributes('aria-pressed') === 'true'

describe('LabelPicker (Feed)', () => {
  it('[covers:web-receipts.label-picker] トグルで即時 setReceiptLabels・aria-pressed・applyReceipt 書き戻し・タイトル編集リンク', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL)

    expect(toggle(wrapper, 'red').attributes('aria-pressed')).toBe('false')
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledWith(1, 101, { add: ['red'] })
    // the response writes back through applyReceipt: pressed + dot stay on
    expect(isPressed(wrapper, 'red')).toBe(true)
    expect(picker(wrapper).find('[data-test="label-dot"]').exists()).toBe(true)
    // off again is a remove
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenLastCalledWith(1, 101, { remove: ['red'] })
    expect(isPressed(wrapper, 'red')).toBe(false)
    // the visible text is the color name (or the title when set)
    expect(picker(wrapper).text()).toContain('赤')
    // the edit link points at the settings page
    expect(picker(wrapper).find('[data-test="label-edit-link"]').attributes('href')).toBe('/settings/labels')
  })

  it('[covers:web-receipts.label-picker] 連続タップは1要求に合成される', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL)

    // two taps in the same tick compose into one request
    await toggle(wrapper, 'red').trigger('click')
    await toggle(wrapper, 'blue').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith(1, 101, { add: ['red', 'blue'] })
    expect(isPressed(wrapper, 'red')).toBe(true)
    expect(isPressed(wrapper, 'blue')).toBe(true)
  })

  it('[covers:web-receipts.label-picker] 送信保留中の追撃は1度に1要求、応答後に差分を再送（直列）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    let gateFirst = true
    let release: ((v: { receipt_id: number; labels: Label[] }) => void) | null = null
    const set = injectSetLabels(
      (_l, r, input) =>
        new Promise((resolve) => {
          confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter(
            (c) => !(input.remove ?? []).includes(c),
          )
          const labels = confirmed.map((color) => ({ color, title: null }))
          if (gateFirst) {
            gateFirst = false
            release = () => resolve({ receipt_id: r, labels })
          } else {
            resolve({ receipt_id: r, labels })
          }
        }),
    )
    const { wrapper } = await mountApp(DETAIL)

    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    // while the first request is in flight a second tap only queues
    await toggle(wrapper, 'blue').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(isPressed(wrapper, 'blue')).toBe(true)
    // the first reply lands; the queued diff is sent as one follow-up
    release!({ receipt_id: 101, labels: [{ color: 'red', title: null }] })
    await settle()
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith(1, 101, { add: ['blue'] })
    expect(isPressed(wrapper, 'red')).toBe(true)
    expect(isPressed(wrapper, 'blue')).toBe(true)
  })

  it('[covers:web-receipts.label-picker] 失敗時は要求に含めた色を confirmed へ戻しメッセージ表示', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      if (input.add?.includes('red')) throw new Error('conflict')
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL)

    await toggle(wrapper, 'red').trigger('click')
    await toggle(wrapper, 'blue').trigger('click')
    await settle()
    // the whole request rolls back to the confirmed (empty) set (design 2-5);
    // colors with unsent changes keep their intent (not exercised here)
    expect(isPressed(wrapper, 'red')).toBe(false)
    expect(isPressed(wrapper, 'blue')).toBe(false)
    expect(picker(wrapper).find('[data-test="label-error"]').exists()).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-receipts.label-picker] viewer と削除済み（canEdit=false）は LabelDots にフォールバックし操作不可', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME_VIEWER } })
    await withLabels([{ color: 'red', title: '旅行' }])
    const set = injectSetLabels(async (_l, r) => ({ receipt_id: r, labels: [] }))
    const viewer = await mountApp(DETAIL)
    expect(picker(viewer.wrapper).find('[data-test="label-toggle-red"]').exists()).toBe(false)
    expect(picker(viewer.wrapper).find('[data-test="label-dot"]').attributes('aria-label')).toBe('赤: 旅行')
    expect(set).not.toHaveBeenCalled()
    viewer.wrapper.unmount()
    cleanup()

    // a soft-deleted receipt is also not editable
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const deleted = await mountApp('/receipts/102?from=2026-10-01&to=2026-10-31&include_deleted=1')
    expect(picker(deleted.wrapper, 102).find('[data-test="label-toggle-red"]').exists()).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('[covers:web-receipts.label-picker] editing=true はトグル disabled（送信中の要求とキューは止めない）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL)
    const p = wrapper.find('[data-test="receipt-panel-101"]')

    await p.find('[data-test="edit"]').trigger('click')
    await settle()
    const red = toggle(wrapper, 'red')
    expect(red.attributes('disabled')).toBeDefined()
    await red.trigger('click')
    await settle()
    expect(set).not.toHaveBeenCalled()
    // leaving edit mode re-enables the toggles
    await p.find('[data-test="cancel-edit"]').trigger('click')
    await settle()
    expect(toggle(wrapper, 'red').attributes('disabled')).toBeUndefined()
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledWith(1, 101, { add: ['red'] })
  })

  it('[covers:web-receipts.label-picker] ラベル送信中に修正を保存しても revision は保存後の値のまま', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let release: ((v: { receipt_id: number; labels: Label[] }) => void) | null = null
    const set = injectSetLabels(
      (_l, r) =>
        new Promise((resolve) => {
          release = () => resolve({ receipt_id: r, labels: [{ color: 'red', title: null }] })
        }),
    )
    const { wrapper } = await mountApp(DETAIL)
    const p = wrapper.find('[data-test="receipt-panel-101"]')

    await toggle(wrapper, 'red').trigger('click')
    await settle()
    // while the label request is in flight, save a content edit
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('特売')
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    expect(p.find('[data-test="revision"]').text()).toBe('2')
    // the label reply arrives after the save: the revision stays at 2
    release!({ receipt_id: 101, labels: [{ color: 'red', title: null }] })
    await settle()
    expect(wrapper.find('[data-test="receipt-panel-101"] [data-test="revision"]').text()).toBe('2')
    expect(isPressed(wrapper, 'red')).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-receipts.label-picker] 送信中でないとき props.receipt.labels から confirmed/desired を取り直す', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    const set = injectSetLabels(async (_l, r) => ({ receipt_id: r, labels: [] }))
    const base = await api.getReceipt(1, 101)
    const update = vi.spyOn(api, 'updateReceipt').mockResolvedValue({
      receipt: { ...base, revision: 2, labels: [{ color: 'green', title: null }] },
      changed: ['note'],
    })
    const { wrapper } = await mountApp(DETAIL)
    const p = wrapper.find('[data-test="receipt-panel-101"]')

    // a content save returns a view whose labels include green; the picker
    // resyncs confirmed/desired from the fresh props.receipt.labels
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('メモ')
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    expect(update).toHaveBeenCalled()
    expect(isPressed(wrapper, 'green')).toBe(true)
    expect(isPressed(wrapper, 'red')).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })
})
