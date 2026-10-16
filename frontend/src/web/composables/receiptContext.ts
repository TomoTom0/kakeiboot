// Receipt list context (TASK-16 item 1): the conversion between the URL
// query and ReceiptListQuery, shared by the receipts list and the receipt
// feed. CONTEXT_FIELDS is the single field table both directions walk, so
// the list link, the feed order and the feed's back link stay symmetric.
// TASK-17 adds one row (labels <-> label_colors) and every link follows.
import type { ReceiptListQuery } from '../api/data'
import type { LabelColor } from '@/shared/labels'
import { formatLabelQuery, parseLabelQuery } from '@/shared/labels'

export interface ContextField {
  /** URL query key */
  query: string
  /** ReceiptListQuery field */
  field: string
  /** non-string fields: URL value -> query value (labels: parse colors) */
  parse?: (v: string) => unknown
  /** non-string fields: query value -> URL value; undefined omits the key */
  format?: (v: unknown) => string | undefined
}

/** Context fields: every ReceiptListQuery field except limit / cursor. */
export const CONTEXT_FIELDS: readonly ContextField[] = [
  { query: 'from', field: 'from' },
  { query: 'to', field: 'to' },
  { query: 'store', field: 'store' },
  { query: 'item', field: 'item_query' },
  { query: 'category', field: 'category' },
  { query: 'include_deleted', field: 'include_deleted' },
  // TASK-17: the URL key stays short ("labels=red,blue"), the query field
  // follows the API name (label_colors). Unknown colors are dropped.
  {
    query: 'labels',
    field: 'label_colors',
    parse: parseLabelQuery,
    format: (v) => formatLabelQuery(Array.isArray(v) ? (v as LabelColor[]) : []),
  },
]

type QuerySource = Record<string, unknown>

function firstString(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null
  return typeof v === 'string' ? v : null
}

/** URL query (route.query or a link's query) -> ReceiptListQuery without limit/cursor. */
export function contextToListQuery(query: QuerySource): ReceiptListQuery {
  const out: ReceiptListQuery = {}
  for (const f of CONTEXT_FIELDS) {
    if (f.field === 'include_deleted') {
      const v = firstString(query[f.query])
      if (v === '1' || v === 'true' || query[f.query] === true) out.include_deleted = true
      continue
    }
    const v = firstString(query[f.query])
    if (f.parse) {
      if (v !== null) (out as Record<string, unknown>)[f.field] = f.parse(v)
      continue
    }
    if (v) (out as Record<string, string>)[f.field] = v
  }
  return out
}

/** ReceiptListQuery -> URL query object (string values; include_deleted -> '1'). */
export function listQueryToContext(q: ReceiptListQuery): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of CONTEXT_FIELDS) {
    const v = (q as Record<string, unknown>)[f.field]
    if (f.field === 'include_deleted') {
      if (v === true) out[f.query] = '1'
      continue
    }
    if (f.format) {
      const s = f.format(v)
      if (s !== undefined) out[f.query] = s
      continue
    }
    if (typeof v === 'string' && v) out[f.query] = v
  }
  return out
}

/** Normalized key that identifies the context across navigations. */
export function contextKeyOf(query: QuerySource): string {
  return JSON.stringify(listQueryToContext(contextToListQuery(query)))
}

/** Receipt row the feed asks the list to scroll to when going back. */
export const feedReturn = { receiptId: null as number | null }
