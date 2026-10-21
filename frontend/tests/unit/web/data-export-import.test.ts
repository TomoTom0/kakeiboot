// TASK-58 settings data tab: the 書き出し・取り込み card. Export turns the
// POST /api/ledgers/{l}/export blob into a file download (busy + inline error
// states); import is two-step (file, then 取り込む), POSTs /api/ledgers/import
// with the parsed file, shows counts + the new ledger name and re-fetches me
// so the new membership reaches every me-driven UI. Error copy branches by
// code (import_invalid / import_too_large / http_413 / export_too_large).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '@/web/api/auth'
import { setDataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, mockFetch, mountApp, settle, type Handler } from './helpers'

beforeEach(() => {
  // the download name stamps JST time: 2026-10-15 12:00 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

/** ME plus a viewer membership: exporting is every member's right (the card
 *  offers all memberships — the backend decides, the UI never gates). */
const ME3: Me = {
  ...ME,
  ledgers: [...ME.ledgers, { id: 3, name: '別家計', role: 'viewer', color: 'pink' }],
}

const EXPORT_BODY = {
  format: 'kakeiboot-ledger-export',
  version: 1,
  exported_at: 1_766_000_000_000,
  ledger: { id: 2, name: '実家', created_at: 1_760_000_000_000 },
  labels: [{ color: 'red', title: null }],
  item_categories: [{ name: '食費', archived_at: null }],
  store_categories: [],
  stores: [{ name: 'Aマート', category: null, aliases: [] }],
  images: [],
  receipts: [
    {
      source: 'image',
      store_name: 'Aマート',
      purchased_on: '2026-10-01',
      items: [{ line_no: 1, line_kind: 'item', name: '牛乳', quantity: 1, amount: 200, amount_incl: 220 }],
      labels: ['red'],
    },
  ],
}

const IMPORT_REPLY = {
  ledger: { id: 5, name: '復元' },
  counts: { receipts: 3, items: 7, images: 0, stores: 1, item_categories: 2, store_categories: 1 },
}

// download capture: jsdom ships no URL.createObjectURL and an anchor click
// would try to navigate — stub both and record what the card handed over
let created: Blob[] = []
let clicks: HTMLAnchorElement[] = []
const protoClick = HTMLAnchorElement.prototype.click
function stubDownload(): void {
  created = []
  clicks = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((b: Blob) => {
      created.push(b)
      return 'blob:mock'
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicks.push(this)
  }
}

function restoreDownload(): void {
  delete (URL as { createObjectURL?: unknown }).createObjectURL
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  HTMLAnchorElement.prototype.click = protoClick
}

/**
 * Mount /settings/data with `extra` fetch handlers plus the me handler. The
 * first me fetch answers ME3; `meLater` (when set) answers the post-import
 * re-fetch so the new membership lands mid-test.
 */
async function open(
  extra: Record<string, Handler | Handler[]> = {},
  meLater: Me | null = null,
): Promise<{ wrapper: Awaited<ReturnType<typeof mountApp>>['wrapper']; f: ReturnType<typeof mockFetch> }> {
  const f = mockFetch({
    'GET /api/auth/me': ((_b: unknown, n: number) => ({ body: n === 0 || !meLater ? ME3 : meLater })) satisfies Handler,
    ...extra,
  })
  const { wrapper } = await mountApp('/settings/data')
  return { wrapper, f }
}

/** Attach a file to the import input and fire change. */
async function pickFile(wrapper: Awaited<ReturnType<typeof mountApp>>['wrapper'], payload: unknown): Promise<void> {
  const input = wrapper.find('[data-test="import-file"]')
  const file = new File([JSON.stringify(payload)], 'export.json', { type: 'application/json' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await settle()
}

describe('settings data tab: 書き出し・取り込み', () => {
  it('[covers:web-settings.data-export-import] 書き出し: 自分のledger全て（viewer含む）から選び blob を file download する', async () => {
    stubDownload()
    try {
      const { wrapper, f } = await open({ 'POST /api/ledgers/2/export': { body: EXPORT_BODY } })
      const select = wrapper.find('[data-test="export-ledger"]')
      // every membership is offered — viewer included, no UI-side gating
      expect(select.findAll('option').map((o) => o.text())).toEqual(['家計', '実家', '別家計'])
      // default is the first membership; pick 実家 and export
      await select.setValue('2')
      await wrapper.find('[data-test="export-run"]').trigger('click')
      await settle()
      expect(f.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /api/ledgers/2/export')
      // the blob handed to the browser download is the response body itself
      expect(created).toHaveLength(1)
      expect(JSON.parse(await created[0]!.text())).toEqual(EXPORT_BODY)
      // file name: kakeiboot-<家計簿名>-<YYYYMMDD-HHmm JST>.json
      expect(clicks).toHaveLength(1)
      expect(clicks[0]!.download).toBe('kakeiboot-実家-20261015-1200.json')
      expect(wrapper.find('[data-test="export-msg"]').attributes('role')).toBe('status')
    } finally {
      restoreDownload()
    }
  })

  it('[covers:web-settings.data-export-import] export_too_large は運用者への案内を含む行内error・downloadしない', async () => {
    stubDownload()
    try {
      const { wrapper } = await open({
        'POST /api/ledgers/1/export': { status: 400, body: { error: 'export_too_large' } },
      })
      await wrapper.find('[data-test="export-run"]').trigger('click')
      await settle()
      const msg = wrapper.find('[data-test="export-msg"]')
      expect(msg.attributes('role')).toBe('alert')
      expect(msg.text()).toContain('運用者に相談')
      expect(created).toHaveLength(0)
      expect(clicks).toHaveLength(0)
    } finally {
      restoreDownload()
    }
  })

  it('[covers:web-settings.data-export-import] 取り込みは2step: file 選択まで button 無効・成功は件数と新ledger名・me再取得', async () => {
    const meAfter: Me = { ...ME3, ledgers: [...ME3.ledgers, { id: 5, name: '復元', role: 'owner', color: 'brown' }] }
    const { wrapper, f } = await open({ 'POST /api/ledgers/import': { body: IMPORT_REPLY } }, meAfter)
    const run = wrapper.find('[data-test="import-run"]')
    expect((run.element as HTMLButtonElement).disabled).toBe(true)
    // pick the export file -> the button unlocks
    await pickFile(wrapper, EXPORT_BODY)
    expect((run.element as HTMLButtonElement).disabled).toBe(false)
    await run.trigger('click')
    await settle()
    // the file body is POSTed as parsed JSON to the import endpoint
    const imports = f.to('POST', '/api/ledgers/import')
    expect(imports).toHaveLength(1)
    expect(imports[0]!.body).toEqual(EXPORT_BODY)
    // success copy carries the new ledger name and the receipt count
    const msg = wrapper.find('[data-test="import-msg"]')
    expect(msg.attributes('role')).toBe('status')
    expect(msg.text()).toBe('復元を取り込みました（3件のレシート）。上部の家計簿切替から選べます。')
    // me was re-fetched and the new membership now shows in the export select
    expect(f.to('GET', '/api/auth/me')).toHaveLength(2)
    expect(wrapper.find('[data-test="export-ledger"]').findAll('option').map((o) => o.text())).toEqual([
      '家計',
      '実家',
      '別家計',
      '復元',
    ])
  })

  it('[covers:web-settings.data-export-import] import_invalid・import_too_large/http_413 は code 別の文言', async () => {
    // format violation -> the file-copy message
    const invalid = await open({ 'POST /api/ledgers/import': { status: 400, body: { error: 'import_invalid' } } })
    await pickFile(invalid.wrapper, { format: 'other', version: 1 })
    await invalid.wrapper.find('[data-test="import-run"]').trigger('click')
    await settle()
    let msg = invalid.wrapper.find('[data-test="import-msg"]')
    expect(msg.attributes('role')).toBe('alert')
    expect(msg.text()).toContain('ファイル形式が正しくありません')
    cleanup()

    // count cap -> the too-large copy
    const tooLarge = await open({ 'POST /api/ledgers/import': { status: 400, body: { error: 'import_too_large' } } })
    await pickFile(tooLarge.wrapper, EXPORT_BODY)
    await tooLarge.wrapper.find('[data-test="import-run"]').trigger('click')
    await settle()
    msg = tooLarge.wrapper.find('[data-test="import-msg"]')
    expect(msg.text()).toContain('データが大きすぎます')
    cleanup()

    // body-limit 413 (rejected before the handler; no JSON error body) ->
    // http_413 falls into the same too-large copy
    const bodyLimited = await open({ 'POST /api/ledgers/import': { status: 413, body: {} } })
    await pickFile(bodyLimited.wrapper, EXPORT_BODY)
    await bodyLimited.wrapper.find('[data-test="import-run"]').trigger('click')
    await settle()
    msg = bodyLimited.wrapper.find('[data-test="import-msg"]')
    expect(msg.text()).toContain('データが大きすぎます')
  })

  it('[covers:web-settings.data-export-import] モック実装も同一契約: export は version 1 の blob・import は ledger 追加して counts を返す', async () => {
    const api = createMockDataApi()
    setDataApi(api)
    const blob = await api.exportLedger(1)
    expect(blob).toBeInstanceOf(Blob)
    const file = JSON.parse(await blob.text()) as { format: string; version: number; receipts: unknown[] }
    expect(file.format).toBe('kakeiboot-ledger-export')
    expect(file.version).toBe(1)
    expect(file.receipts).toHaveLength(3)
    // a mock-side round trip: importing the export adds a fresh ledger
    const res = await api.importLedger(file)
    expect(res.ledger.id).toBeGreaterThan(0)
    expect(res.counts.receipts).toBe(3)
    expect(res.counts.images).toBe(0)
    const restored = await api.listReceipts(res.ledger.id, {})
    expect(restored.total_count).toBe(3)
  })
})
