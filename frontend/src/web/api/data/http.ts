// HTTP implementation of DataApi: the contract the backend web adapter is
// expected to implement (spec_mcp-tools.md 12: same domain functions and
// DTOs as the MCP tools).
//
// | method | path                                         | MCP counterpart          |
// |--------|----------------------------------------------|--------------------------|
// | GET    | /api/ledgers/{l}/catalog?include_archived=   | get_catalog              |
// | POST   | /api/ledgers/{l}/categories                  | manage_category          |
// | GET    | /api/ledgers/{l}/stores?query=               | get_catalog(stores)      |
// | PATCH  | /api/ledgers/{l}/stores/{id}                 | manage_store             |
// | POST   | /api/ledgers/{l}/stores/{id}/merge           | (web only)               |
// | GET    | /api/ledgers/{l}/stats?report=&month=...     | summarize_spending       |
// | GET    | /api/ledgers/{l}/receipts?from=&to=&store=&q=&store_id= | search_receipts |
// | GET    | /api/ledgers/{l}/items?q=&from=&to=          | search_receipts(mode=items) |
// | GET    | /api/ledgers/{l}/receipts/{id}               | get_receipt              |
// | PATCH  | /api/ledgers/{l}/receipts/{id}               | update_receipt           |
// | POST   | /api/ledgers/{l}/receipts/{id}/delete        | delete_receipt           |
// | GET    | /api/ledgers/{l}/labels                      | get_catalog(labels)      |
// | PATCH  | /api/ledgers/{l}/labels/{color}              | (web only, TASK-17)      |
// | POST   | /api/ledgers/{l}/receipts/{id}/labels        | label_receipts           |
// | PATCH  | /api/ledgers/{l}                             | rename_ledger            |
// | POST   | /api/ledgers/{l}/export                      | (web only, TASK-58)      |
// | POST   | /api/ledgers/import                          | (web only, TASK-58)      |

import type { LabelColor } from '@/shared/labels'
import { request, requestBlob } from '../http'
import type { DataApi, ItemListQuery, ReceiptListQuery, StatsQuery } from './types'

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v))
  }
  // label_colors=red,blue: keep the comma literal (URLSearchParams encodes
  // it as %2C, which the backend contract does not use)
  const s = q.toString().replaceAll('%2C', ',')
  return s ? `?${s}` : ''
}

/** label_colors=[red,blue] -> "red,blue"; empty -> omitted. */
function labelQuery(colors: LabelColor[] | undefined): string | undefined {
  return colors && colors.length > 0 ? colors.join(',') : undefined
}

const base = (ledgerId: number) => `/api/ledgers/${ledgerId}`

export function createHttpDataApi(): DataApi {
  return {
    kind: 'http',
    getCatalog: (l, includeArchived) =>
      request('GET', `${base(l)}/catalog${query({ include_archived: includeArchived })}`),
    manageCategory: (l, input) => request('POST', `${base(l)}/categories`, input),
    listStores: (l, q) => request('GET', `${base(l)}/stores${query({ query: q })}`),
    updateStore: (l, id, input) => request('PATCH', `${base(l)}/stores/${id}`, input),
    mergeStores: (l, sourceId, intoId) =>
      request('POST', `${base(l)}/stores/${sourceId}/merge`, { into_store_id: intoId }),
    getStats: (l, q: StatsQuery) =>
      request('GET', `${base(l)}/stats${query({ ...q, label_colors: labelQuery(q.label_colors) })}`),
    listReceipts: (l, q: ReceiptListQuery) =>
      request('GET', `${base(l)}/receipts${query({ ...q, label_colors: labelQuery(q.label_colors) })}`),
    searchItems: (l, q: ItemListQuery) =>
      request('GET', `${base(l)}/items${query({ ...q, label_colors: labelQuery(q.label_colors) })}`),
    getReceipt: (l, id) => request('GET', `${base(l)}/receipts/${id}`),
    updateReceipt: (l, id, input) => request('PATCH', `${base(l)}/receipts/${id}`, input),
    deleteReceipt: (l, id, input) => request('POST', `${base(l)}/receipts/${id}/delete`, input),
    listLabels: (l) => request('GET', `${base(l)}/labels`),
    updateLabelTitle: (l, color, input) => request('PATCH', `${base(l)}/labels/${color}`, input),
    setReceiptLabels: (l, r, input) => request('POST', `${base(l)}/receipts/${r}/labels`, input),
    renameLedger: (l, input) => request('PATCH', base(l), input),
    exportLedger: (l) => requestBlob('POST', `${base(l)}/export`),
    importLedger: (payload) => request('POST', '/api/ledgers/import', payload),
  }
}
