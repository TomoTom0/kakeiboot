// In-memory host for development without ChatGPT (`pnpm dev` -> /widget.html).
// Choose the initial view with `?view=draft|draft_list|draft_batch|receipt|receipt_list|item_list|stats`.
// Loaded lazily from host.ts only in DEV builds.
import type { ApproveBatchResult, DraftBatchEnvelope, DraftView, LedgerRef, ReportKind, WidgetMeta } from '@/shared/types'
import type { DisplayMode, Theme, ToolCallResult, WidgetHost, WidgetState } from './host'
import * as fx from './fixtures'

const ok = (structuredContent: unknown, meta: WidgetMeta = {}, text = ''): ToolCallResult => ({
  structuredContent,
  meta,
  isError: false,
  text,
})

function initial(view: string): { out: unknown; meta: WidgetMeta } {
  switch (view) {
    case 'draft_list':
      return { out: fx.draftListEnvelope(), meta: {} }
    case 'draft_batch':
      return { out: fx.draftBatchEnvelope(), meta: fx.draftBatchMeta() }
    case 'receipt':
      return { out: fx.receiptEnvelope(), meta: fx.receiptMeta() }
    case 'receipt_list':
      return { out: fx.receiptListEnvelope(), meta: fx.receiptListMeta() }
    case 'item_list':
      return { out: fx.itemListEnvelope(), meta: {} }
    case 'stats':
      return { out: fx.statsEnvelope(), meta: {} }
    default:
      return { out: fx.draftEnvelope(), meta: fx.draftMeta() }
  }
}

export function createMockHost(view?: string): WidgetHost {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
  const start = initial(view ?? params.get('view') ?? 'draft')
  const drafts = new Map<number, DraftView>([[12, fx.sampleDraft()]])
  let state: WidgetState | null = null
  let mode: DisplayMode = 'inline'
  const theme: Theme | null = params.get('theme') === 'dark' ? 'dark' : params.get('theme') === 'light' ? 'light' : null

  return {
    kind: 'mock',
    toolOutput: () => start.out,
    toolResponseMetadata: () => start.meta,
    widgetState: () => state,
    setWidgetState: (s) => {
      state = s
    },
    callTool: async (name, args) => {
      await new Promise((r) => setTimeout(r, 300))
      switch (name) {
        case 'approve_receipt_draft': {
          const id = Number(args.draft_id)
          const d = drafts.get(id) ?? fx.sampleDraft({ draft_id: id })
          if (d.status === 'approved' && d.revision === args.revision) {
            return ok({ ...fx.draftEnvelope(d), receipt_id: d.approved_receipt_id, idempotent_hit: true })
          }
          if (d.revision !== args.revision) {
            return { structuredContent: fx.draftEnvelope(d), meta: fx.draftMeta(id), isError: true, text: 'stale_revision' }
          }
          const approved: DraftView = { ...d, status: 'approved', approved_receipt_id: 101 }
          drafts.set(id, approved)
          return ok({ ...fx.draftEnvelope(approved), receipt_id: 101, idempotent_hit: false })
        }
        case 'approve_receipt_drafts': {
          const items = (args.items as { draft_id: number; revision: number }[]) ?? []
          const ledger = (start.out as { ledger?: LedgerRef | null }).ledger ?? null
          const latest: DraftView[] = []
          const results: ApproveBatchResult[] = []
          for (const it of items) {
            const d = drafts.get(it.draft_id) ?? fx.sampleDraft({ draft_id: it.draft_id, revision: it.revision })
            if (d.status === 'approved' && d.revision === it.revision) {
              latest.push(d)
              results.push({ draft_id: it.draft_id, outcome: 'idempotent', receipt_id: d.approved_receipt_id, revision: it.revision })
              continue
            }
            if (d.revision !== it.revision) {
              const redrawn = { ...d, revision: it.revision + 1 }
              drafts.set(it.draft_id, redrawn)
              latest.push(redrawn)
              results.push({ draft_id: it.draft_id, outcome: 'stale_revision', revision: it.revision + 1 })
              continue
            }
            const approved: DraftView = { ...d, status: 'approved', approved_receipt_id: 100 + it.draft_id }
            drafts.set(it.draft_id, approved)
            latest.push(approved)
            results.push({ draft_id: it.draft_id, outcome: 'approved', receipt_id: 100 + it.draft_id, revision: it.revision })
          }
          const batch: DraftBatchEnvelope = { view: 'draft_batch', ledger, batch_id: null, drafts: latest, results }
          return ok(batch)
        }
        case 'get_receipt_drafts': {
          if (typeof args.draft_id === 'number') {
            const d = drafts.get(args.draft_id) ?? fx.sampleDraft({ draft_id: args.draft_id, revision: 1 })
            return ok(fx.draftEnvelope(d), fx.draftMeta(d.draft_id))
          }
          return ok(fx.draftListEnvelope())
        }
        case 'get_receipt': {
          const id = Number(args.receipt_id)
          return ok(fx.receiptEnvelope(id), fx.receiptMeta(id))
        }
        case 'summarize_spending': {
          const report = (args.report as ReportKind) ?? 'monthly_overview'
          const period = args.period as { preset?: string } | undefined
          // TASK-116: monthly_overview / monthly_trend carry the stacked
          // composition matrix in `_meta` for the bar_v widget chart
          return ok(fx.statsEnvelope(report, period?.preset ?? '2026年10月'), fx.statsMeta(report))
        }
        case 'refresh_widget_images': {
          const refs = (args.refs as { kind: string; id: number }[]) ?? []
          const images: WidgetMeta['images'] = {}
          for (const r of refs) {
            images[`${r.kind}:${r.id}`] = {
              url: fx.mockImageUrl(`${r.kind}${r.id}fresh`),
              expires_at: '2099-01-01T00:00:00+09:00',
              width: 600,
              height: 1200,
            }
          }
          return ok({ view: 'images', ledger: null }, { images })
        }
      }
    },
    theme: () => theme,
    displayMode: () => mode,
    requestDisplayMode: (m) => {
      mode = m
    },
    maxHeight: () => null,
    onGlobalsChange: () => () => {},
  }
}
