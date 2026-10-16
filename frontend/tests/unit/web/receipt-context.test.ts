// Receipt list context (TASK-16 item 1): the single CONTEXT_FIELDS table that
// converts URL query <-> ReceiptListQuery symmetrically (shared by the list
// and the feed).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReceiptListQuery } from '@/web/api/data'
import { CONTEXT_FIELDS, contextToListQuery, listQueryToContext } from '@/web/composables/receiptContext'

const CTX = { from: '2026-10-01', to: '2026-10-31' }

describe('receiptContext (CONTEXT_FIELDS)', () => {
  it('[covers:web-receipts.feed-sequence-from-context] query ↔ ReceiptListQuery の往復一致と CONTEXT_FIELDS の網羅', () => {
    // symmetric conversion through the single field table
    const query = { ...CTX, store: 'Aマート', item: '牛乳', category: '食費', include_deleted: '1' }
    const listQuery: ReceiptListQuery = {
      ...CTX,
      store: 'Aマート',
      item_query: '牛乳',
      category: '食費',
      include_deleted: true,
    }
    expect(contextToListQuery(query)).toEqual(listQuery)
    expect(listQueryToContext(listQuery)).toEqual(query)
    expect(contextToListQuery(listQueryToContext(listQuery))).toEqual(listQuery)
    expect(listQueryToContext(contextToListQuery(query))).toEqual(query)

    // the table covers every ReceiptListQuery field except limit / cursor
    const typesText = readFileSync(resolve(process.cwd(), 'src/web/api/data/types.ts'), 'utf8')
    const body = /export interface ReceiptListQuery \{([^}]*)\}/.exec(typesText)![1]!
    const fields = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!).filter((f) => f !== 'limit' && f !== 'cursor')
    const tableFields = CONTEXT_FIELDS.map((f: { field: string }) => f.field)
    expect([...tableFields].sort()).toEqual([...fields].sort())
  })

  it('[covers:web-receipts.feed-label-context] labels（URL・カンマ区切り）と label_colors（ReceiptListQuery）の対応が往復一致し、未知色は捨てられる', () => {
    // the table has the labels <-> label_colors row (TASK-17 design 2-5):
    // URL key "labels" (comma separated) maps to the ReceiptListQuery field
    // label_colors, so list links, the feed order and the back link all
    // carry the label filter automatically.
    const tableFields = CONTEXT_FIELDS.map((f: { field: string }) => f.field)
    expect(tableFields).toContain('label_colors')

    // symmetric conversion with the period context
    const query = { ...CTX, labels: 'red,blue' }
    const listQuery: ReceiptListQuery & { label_colors?: string[] } = {
      ...CTX,
      label_colors: ['red', 'blue'],
    }
    expect(contextToListQuery(query)).toEqual(listQuery)
    expect(listQueryToContext(listQuery)).toEqual(query)
    expect(contextToListQuery(listQueryToContext(listQuery))).toEqual(listQuery)

    // unknown colors are dropped; empty selection omits the key
    expect(contextToListQuery({ labels: 'red,orange' })).toEqual({ label_colors: ['red'] })
    expect(contextToListQuery({ labels: 'orange' })).toEqual({ label_colors: [] })
    expect(listQueryToContext({ label_colors: [] })).toEqual({})
  })
})
