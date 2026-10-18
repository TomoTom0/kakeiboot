import { afterEach, describe, expect, it } from 'vitest'
import { createDataApi, setDataApi } from '@/web/api/data'
import { cleanup, mockFetch } from './helpers'

afterEach(() => {
  cleanup()
  setDataApi(null)
})

describe('web/api/data', () => {
  it('[covers:web-data-api.always-http] モック切替はなく常に HTTP 実装（backend 同一生成元）', () => {
    expect(createDataApi().kind).toBe('http')
  })

  it('[covers:web-data-api.http-contract] backend 接続時の契約どおりのパスとメソッド', async () => {
    const reply = { body: {} }
    const f = mockFetch({
      'GET /api/ledgers/3/catalog?include_archived=true': reply,
      'POST /api/ledgers/3/categories': reply,
      'GET /api/ledgers/3/stores?query=A': reply,
      'PATCH /api/ledgers/3/stores/5': reply,
      'POST /api/ledgers/3/stores/5/merge': reply,
      'GET /api/ledgers/3/receipts?from=2026-10-01&include_deleted=true': reply,
      'GET /api/ledgers/3/receipts/9': reply,
      'PATCH /api/ledgers/3/receipts/9': reply,
      'POST /api/ledgers/3/receipts/9/delete': reply,
      'GET /api/ledgers/3/labels': reply,
      'PATCH /api/ledgers/3/labels/red': reply,
      'POST /api/ledgers/3/receipts/9/labels': reply,
      'GET /api/ledgers/3/receipts?from=2026-10-01&label_colors=red,blue': reply,
      'GET /api/ledgers/3/stats?month=2026-10&label_colors=red,blue': reply,
    })
    const api = createDataApi()
    await api.getCatalog(3, true)
    await api.manageCategory(3, { kind: 'item', action: 'rename', category: '食費', new_name: '食' })
    await api.listStores(3, 'A')
    await api.updateStore(3, 5, { category: null })
    await api.mergeStores(3, 5, 6)
    await api.listReceipts(3, { from: '2026-10-01', include_deleted: true })
    await api.getReceipt(3, 9)
    await api.updateReceipt(3, 9, { revision: 4, set: { note: 'n' } })
    await api.deleteReceipt(3, 9, { confirm: true, revision: 4 })
    // label methods (TASK-17): definitions, title update, receipt assignment
    await api.listLabels(3)
    await api.updateLabelTitle(3, 'red', { title: '旅行' })
    await api.setReceiptLabels(3, 9, { add: ['red'], remove: ['blue'] })
    // label_colors is a comma-separated query on list and stats
    await api.listReceipts(3, { from: '2026-10-01', label_colors: ['red', 'blue'] } as never)
    await api.getStats(3, { month: '2026-10', label_colors: ['red', 'blue'] } as never)
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/ledgers/3/catalog?include_archived=true',
      'POST /api/ledgers/3/categories',
      'GET /api/ledgers/3/stores?query=A',
      'PATCH /api/ledgers/3/stores/5',
      'POST /api/ledgers/3/stores/5/merge',
      'GET /api/ledgers/3/receipts?from=2026-10-01&include_deleted=true',
      'GET /api/ledgers/3/receipts/9',
      'PATCH /api/ledgers/3/receipts/9',
      'POST /api/ledgers/3/receipts/9/delete',
      'GET /api/ledgers/3/labels',
      'PATCH /api/ledgers/3/labels/red',
      'POST /api/ledgers/3/receipts/9/labels',
      'GET /api/ledgers/3/receipts?from=2026-10-01&label_colors=red,blue',
      'GET /api/ledgers/3/stats?month=2026-10&label_colors=red,blue',
    ])
    expect(f.calls[1]!.body).toEqual({ kind: 'item', action: 'rename', category: '食費', new_name: '食' })
    expect(f.calls[3]!.body).toEqual({ category: null })
    expect(f.calls[4]!.body).toEqual({ into_store_id: 6 })
    expect(f.calls[7]!.body).toEqual({ revision: 4, set: { note: 'n' } })
    expect(f.calls[8]!.body).toEqual({ confirm: true, revision: 4 })
    expect(f.calls[10]!.body).toEqual({ title: '旅行' })
    expect(f.calls[11]!.body).toEqual({ add: ['red'], remove: ['blue'] })
  })

  it('[covers:web-data-api.http-contract] /search 用の契約（TASK-41）: searchItems は GET /items へ q・期間・category・store_id・label_colors・limit・cursor を渡し、listReceipts は q・store_id も渡す', async () => {
    const reply = { body: {} }
    const f = mockFetch({
      'GET /api/ledgers/3/items?q=milk&label_colors=red,blue': reply,
      'GET /api/ledgers/3/items?q=milk&from=2026-10-01&to=2026-10-31': reply,
      'GET /api/ledgers/3/receipts?q=milk&store_id=5': reply,
    })
    const api = createDataApi()
    await api.searchItems(3, { q: 'milk', label_colors: ['red', 'blue'] })
    await api.searchItems(3, { q: 'milk', from: '2026-10-01', to: '2026-10-31' })
    // the receipts list carries the cross-field q and the exact store_id
    await api.listReceipts(3, { q: 'milk', store_id: 5 } as never)
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/ledgers/3/items?q=milk&label_colors=red,blue',
      'GET /api/ledgers/3/items?q=milk&from=2026-10-01&to=2026-10-31',
      'GET /api/ledgers/3/receipts?q=milk&store_id=5',
    ])
  })
})
