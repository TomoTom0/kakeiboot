// LabelPicker in the ReceiptPanel labels slot (TASK-17, reshaped in
// TASK-26): the assigned labels show as chips at the end of the when line
// and a small tag-plus button opens the popover with the five-label toggle
// group — with per-receipt serialization, diff composition, per-color
// rollback and the applyReceipt write-back through the real Feed mount.
// The slot contract itself is covered by receipt-panel.test.ts; this file
// fills the slot with the real component (the ReceiptDetailPage wiring).
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
const addBtn = (w: W, id = 101) => w.find(`[data-test="receipt-panel-${id}"] [data-test="label-add"]`)
const toggle = (w: W, color: string, id = 101) =>
  w.find(`[data-test="receipt-panel-${id}"] [data-test="label-toggle-${color}"]`)
const isPressed = (w: W, color: string, id = 101) => toggle(w, color, id).attributes('aria-pressed') === 'true'

/** Open the picker popover (the toggles live inside it). */
async function openPopover(w: W, id = 101): Promise<void> {
  await addBtn(w, id).trigger('click')
  await settle()
}

describe('LabelPicker (Feed)', () => {
  it('[covers:web-receipts.label-picker][covers:web-labels.no-color-names-on-screen] popover 内トグルで即時 setReceiptLabels・tap で popover が閉じ chip が現れる・可視テキストに色名なし', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL, { attach: true })
    await openPopover(wrapper)

    expect(toggle(wrapper, 'red').attributes('aria-pressed')).toBe('false')
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledWith(1, 101, { add: ['red'] })
    // TASK-51: a selection closes the popover (the chip appearing in the row
    // is the confirmation) and returns the focus to the trigger
    expect(picker(wrapper).find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(addBtn(wrapper).element)
    expect(picker(wrapper).find('.label-chip').exists()).toBe(true)
    // reopening shows the pressed state; toggling off closes again (remove)
    await openPopover(wrapper)
    expect(isPressed(wrapper, 'red')).toBe(true)
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenLastCalledWith(1, 101, { remove: ['red'] })
    expect(picker(wrapper).find('.label-chip').exists()).toBe(false)
    // a second color joins through another open-select round (each selection
    // is its own send now that the popover closes on tap)
    await openPopover(wrapper)
    await toggle(wrapper, 'blue').trigger('click')
    await settle()
    expect(set).toHaveBeenLastCalledWith(1, 101, { add: ['blue'] })
    expect(picker(wrapper).find('.label-chip').exists()).toBe(true)
    // the visible text carries no color names (open popover included) and
    // the name-edit link is gone
    await openPopover(wrapper)
    expect(picker(wrapper).text()).not.toMatch(/赤|黄|緑|青|紫|ラベル[1-5]|名前なし/)
    expect(picker(wrapper).find('[data-test="label-edit-link"]').exists()).toBe(false)
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
    await openPopover(wrapper)

    // the first selection closes the popover and its send is in flight
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(picker(wrapper).find('[role="dialog"]').exists()).toBe(false)
    // while the first request is in flight a second selection (after
    // reopening) only queues — desired already shows the chip
    await openPopover(wrapper)
    await toggle(wrapper, 'blue').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(picker(wrapper).findAll('.label-chip')).toHaveLength(2)
    // the first reply lands; the queued diff is sent as one follow-up
    release!({ receipt_id: 101, labels: [{ color: 'red', title: null }] })
    await settle()
    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenLastCalledWith(1, 101, { add: ['blue'] })
    expect(picker(wrapper).findAll('.label-chip')).toHaveLength(2)
  })

  it('[covers:web-receipts.label-picker] 失敗時は要求に含めた色を confirmed へ戻し、閉じた後はボタン部の警告バッジ・開き直しで popover 内に表示', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    let confirmed: string[] = []
    const set = injectSetLabels(async (_l, r, input) => {
      if (input.add?.includes('red')) throw new Error('conflict')
      confirmed = [...new Set([...confirmed, ...(input.add ?? [])])].filter((c) => !(input.remove ?? []).includes(c))
      return { receipt_id: r, labels: confirmed.map((color) => ({ color, title: null })) }
    })
    const { wrapper } = await mountApp(DETAIL)
    await openPopover(wrapper)

    // the failed tap has already closed the popover (TASK-51): the rollback
    // lands with the button's warning badge + visually-hidden note in view
    await toggle(wrapper, 'red').trigger('click')
    await settle()
    expect(set).toHaveBeenCalledTimes(1)
    expect(picker(wrapper).find('[role="dialog"]').exists()).toBe(false)
    expect(picker(wrapper).find('.label-chip').exists()).toBe(false)
    expect(addBtn(wrapper).find('.label-add-badge').exists()).toBe(true)
    expect(addBtn(wrapper).find('.sr-only').exists()).toBe(true)
    // reopening resurfaces the error inside the popover
    await openPopover(wrapper)
    expect(picker(wrapper).find('[data-test="label-error"]').exists()).toBe(true)
    expect(picker(wrapper).find('[data-test="label-error"]').attributes('role')).toBe('alert')
    // a fresh tap clears the error, closes the popover and sends again
    await toggle(wrapper, 'green').trigger('click')
    await settle()
    expect(set).toHaveBeenLastCalledWith(1, 101, { add: ['green'] })
    expect(picker(wrapper).find('[data-test="label-error"]').exists()).toBe(false)
    expect(addBtn(wrapper).find('.label-add-badge').exists()).toBe(false)
  })

  it('[covers:web-receipts.label-picker] viewer と削除済み（canEdit=false）はチップ表示のみで操作不可', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME_VIEWER } })
    await withLabels([{ color: 'red', title: '旅行' }])
    const set = injectSetLabels(async (_l, r) => ({ receipt_id: r, labels: [] }))
    const viewer = await mountApp(DETAIL)
    expect(addBtn(viewer.wrapper).exists()).toBe(false)
    // the chips carry the spoken name as aria; the visible text has no color names
    const chip = picker(viewer.wrapper).find('.label-chip')
    expect(chip.attributes('aria-label')).toBe('旅行')
    expect(chip.text()).toBe('旅行')
    expect(picker(viewer.wrapper).find('[data-test="label-toggle-red"]').exists()).toBe(false)
    expect(set).not.toHaveBeenCalled()
    viewer.wrapper.unmount()
    cleanup()

    // a soft-deleted receipt is also not editable
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const deleted = await mountApp('/receipts/102?from=2026-10-01&to=2026-10-31&include_deleted=1')
    expect(addBtn(deleted.wrapper, 102).exists()).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('[covers:web-receipts.label-picker] editing=true はボタン disabled（送信中の要求とキューは止めない）', async () => {
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
    const btn = addBtn(wrapper)
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    await settle()
    expect(picker(wrapper).find('[data-test="label-toggle-red"]').exists()).toBe(false)
    // leaving edit mode re-enables the button and the popover works again
    await p.find('[data-test="cancel-edit"]').trigger('click')
    await settle()
    expect(addBtn(wrapper).attributes('disabled')).toBeUndefined()
    await openPopover(wrapper)
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
    await openPopover(wrapper)

    await toggle(wrapper, 'red').trigger('click')
    await settle()
    // while the label request is in flight, save a content edit
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('特売')
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    // the label reply arrives after the save: the revision stays at the
    // post-save value and the chip (desired) stays on the row
    release!({ receipt_id: 101, labels: [{ color: 'red', title: null }] })
    await settle()
    expect(picker(wrapper).find('.label-chip').exists()).toBe(true)
    await openPopover(wrapper)
    expect(isPressed(wrapper, 'red')).toBe(true)
    expect(set).toHaveBeenCalledTimes(1)
    // TASK-167 D-8: the panel shows no revision readout — the revision
    // still riding the post-save value is proven by a probe save after
    // closing the popover with Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    const update = vi.spyOn(api, 'updateReceipt')
    const after = wrapper.find('[data-test="receipt-panel-101"]')
    await after.find('[data-test="edit"]').trigger('click')
    await after.find('[data-test="f-note"]').setValue('再修正')
    await after.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    expect(update).toHaveBeenLastCalledWith(1, 101, { revision: 2, set: { note: '再修正' } })
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
    await openPopover(wrapper)
    expect(isPressed(wrapper, 'green')).toBe(true)
    expect(isPressed(wrapper, 'red')).toBe(false)
    expect(set).not.toHaveBeenCalled()
  })

  it('[covers:web-receipts.label-picker-compact] ボタンは .receipt-when 内末尾・押下で PopoverPanel・Escape・外側押下で閉じトリガへ・editing で disabled', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    await withLabels([])
    injectSetLabels(async (_l, r) => ({ receipt_id: r, labels: [] }))
    const { wrapper } = await mountApp(DETAIL, { attach: true })
    const p = wrapper.find('[data-test="receipt-panel-101"]')

    // the button rides at the end of the when line (no dedicated label row)
    const btn = addBtn(wrapper)
    expect(btn.element.closest('.receipt-when')).not.toBeNull()
    const when = p.find('.receipt-head .receipt-when').element
    expect(when.lastElementChild?.contains?.(btn.element)).toBe(true)
    expect(btn.attributes('aria-label')).toBe('ラベルを付ける・外す')

    // pressing it opens the PopoverPanel dialog with the toggle group
    await btn.trigger('click')
    await settle()
    const dialog = p.find('[role="dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('aria-label')).toBe('ラベルの選択')
    expect(dialog.find('.label-toggle-group').exists()).toBe(true)
    expect(dialog.findAll('.label-toggle-group button')).toHaveLength(5)

    // Escape closes and returns the focus to the trigger
    ;(btn.element as HTMLElement).focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(p.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(btn.element)

    // an outside pointerdown closes too; the trigger aria-expanded follows
    await btn.trigger('click')
    await settle()
    expect(btn.attributes('aria-expanded')).toBe('true')
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    await settle()
    expect(p.find('[role="dialog"]').exists()).toBe(false)
    expect(btn.attributes('aria-expanded')).toBe('false')

    // editing disables the button (covered in detail above, pinned here for
    // the compact condition as well)
    await p.find('[data-test="edit"]').trigger('click')
    await settle()
    expect(addBtn(wrapper).attributes('disabled')).toBeDefined()
  })
})
