import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef } from 'vue'
import type {
  DraftBatchEnvelope,
  DraftEnvelope,
  DraftView,
  ImageRef,
  Period,
  ReportKind,
  StatsFilters,
  WidgetCallableTool,
  WidgetEnvelope,
  WidgetMeta,
  WidgetView,
} from '@/shared/types'
import { isStackableTrendResult, type StackableTrendResult } from '@/shared/lib/stackedBars'
import type { DisplayMode, ToolCallResult, WidgetHost, WidgetState } from '../host'
import { createNullHost } from '../host'

const VIEWS: readonly WidgetView[] = ['draft', 'draft_list', 'draft_batch', 'receipt', 'receipt_list', 'item_list', 'stats']

export type Screen = { envelope: WidgetEnvelope; meta: WidgetMeta }
export type ApprovePhase = 'idle' | 'submitting' | 'done' | 'stale' | 'conflict' | 'error'

export function isWidgetEnvelope(v: unknown): v is WidgetEnvelope {
  if (typeof v !== 'object' || v === null) return false
  const view = (v as { view?: unknown }).view
  if (typeof view !== 'string' || !(VIEWS as readonly string[]).includes(view)) return false
  const body = v as Record<string, unknown>
  switch (view as WidgetView) {
    case 'draft':
      return typeof body.draft === 'object' && body.draft !== null
    case 'draft_list':
      return Array.isArray(body.drafts)
    case 'draft_batch':
      return Array.isArray(body.drafts) && (typeof body.batch_id === 'string' || body.batch_id === null)
    case 'receipt':
      return typeof body.receipt === 'object' && body.receipt !== null
    case 'receipt_list':
      return Array.isArray(body.receipts)
    case 'item_list':
      return Array.isArray(body.items)
    case 'stats':
      return Array.isArray(body.sections) && typeof body.totals === 'object'
  }
}

function isDraftEnvelope(v: unknown): v is DraftEnvelope {
  return isWidgetEnvelope(v) && v.view === 'draft'
}

function isDraftBatchEnvelope(v: unknown): v is DraftBatchEnvelope {
  return isWidgetEnvelope(v) && v.view === 'draft_batch'
}

const CONFLICT_MESSAGES: Record<string, string> = {
  discarded: 'この下書きは破棄されています。',
  expired: 'この下書きは期限切れです。',
}

// Widget entry store (toolOutput driven, spec §12: Pinia store per entry).
export const useWidgetStore = defineStore('widget', () => {
  const title = ref('kakeiboot widget')
  const host = shallowRef<WidgetHost>(markRaw(createNullHost()))
  const screen = shallowRef<Screen | null>(null)
  const history = shallowRef<Screen[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const approvePhase = ref<ApprovePhase>('idle')
  const approveMessage = ref<string | null>(null)
  const approvedReceiptId = ref<number | null>(null)
  /** Approvals done in this widget: draft_id -> receipt_id (TASK-18). Restored from widgetState on load. */
  const approvedMap = ref<Record<string, number>>({})
  const approvedLedgerName = ref<string | null>(null)
  /** Guards the batch approve-all button while a call is in flight (spec §11-3). */
  const batchApproving = ref(false)
  const displayMode = ref<DisplayMode>('inline')

  const view = computed<WidgetView | null>(() => screen.value?.envelope.view ?? null)
  const envelope = computed(() => screen.value?.envelope ?? null)
  const draft = computed(() => (screen.value?.envelope.view === 'draft' ? screen.value.envelope.draft : null))
  /** TASK-116: `_meta.trend_matrix` of the CURRENT screen (null when the
   *  response ships none) — the stats view stacks its bar_v bars off it. It
   *  rides the call-result normalization: every new screen swaps the meta
   *  along with the envelope (a meta-less response clears it). */
  const trendMatrix = computed<StackableTrendResult | null>(() => {
    const m = screen.value?.meta
    if (!m) return null
    return isStackableTrendResult(m['trend_matrix']) ? m['trend_matrix'] : null
  })
  const canGoBack = computed(() => history.value.length > 0)
  /** Approve button is shown only for pending drafts that this widget has not approved (spec §11-2). */
  const showApproveButton = computed(() => {
    const d = draft.value
    if (!d || d.status !== 'pending') return false
    if (typeof approvedMap.value[d.draft_id] === 'number') return false
    return approvePhase.value !== 'done' && approvePhase.value !== 'conflict'
  })
  const approveDisabled = computed(() => approvePhase.value === 'submitting')

  function persistState() {
    const d = draft.value
    const prev = host.value.widgetState() ?? {}
    const next: WidgetState = {
      ...prev,
      draft_id: d?.draft_id ?? null,
      revision: d?.revision ?? null,
      stack: [...history.value.map((s) => s.envelope.view), ...(view.value ? [view.value] : [])],
      approved: { ...approvedMap.value },
    }
    if (approvedLedgerName.value) next.approved_ledger_name = approvedLedgerName.value
    // The legacy single-approval keys live on in `approved` (TASK-18 migration).
    delete next.approved_draft_id
    delete next.approved_receipt_id
    host.value.setWidgetState(next)
  }

  /** widgetState -> approved map, migrating the legacy single-approval keys (TASK-18). */
  function readApprovedMap(saved: WidgetState | null): Record<string, number> {
    const map: Record<string, number> = {}
    if (!saved) return map
    if (saved.approved && typeof saved.approved === 'object') {
      for (const [k, v] of Object.entries(saved.approved)) {
        if (typeof v === 'number' && Number.isFinite(v)) map[k] = v
      }
    }
    if (typeof saved.approved_draft_id === 'number' && typeof saved.approved_receipt_id === 'number') {
      map[String(saved.approved_draft_id)] = saved.approved_receipt_id
    }
    return map
  }

  function resetApprove() {
    approvePhase.value = 'idle'
    approveMessage.value = null
    approvedReceiptId.value = null
  }

  function show(next: Screen, push: boolean) {
    if (push && screen.value) history.value = [...history.value, screen.value]
    screen.value = next
    resetApprove()
    persistState()
  }

  /** Read toolOutput / toolResponseMetadata / widgetState from the host (spec §11-3). */
  function init(h: WidgetHost) {
    host.value = markRaw(h)
    history.value = []
    error.value = null
    displayMode.value = h.displayMode()
    resetApprove()
    const out = h.toolOutput()
    if (out === null || out === undefined) {
      screen.value = null
      return
    }
    if (!isWidgetEnvelope(out)) {
      screen.value = null
      error.value = 'この結果は表示できません。'
      return
    }
    screen.value = { envelope: out, meta: h.toolResponseMetadata() }
    const saved = h.widgetState()
    approvedMap.value = readApprovedMap(saved)
    if (typeof saved?.approved_ledger_name === 'string') approvedLedgerName.value = saved.approved_ledger_name
    const d = draft.value
    const savedReceiptId = d ? approvedMap.value[d.draft_id] : undefined
    if (d && typeof savedReceiptId === 'number') {
      approvedReceiptId.value = savedReceiptId
      approvePhase.value = 'done'
      approveMessage.value = approvedText(approvedLedgerName.value ?? out.ledger?.name, savedReceiptId)
    }
  }

  async function call(name: WidgetCallableTool, args: Record<string, unknown>): Promise<ToolCallResult | null> {
    loading.value = true
    error.value = null
    try {
      return await host.value.callTool(name, args)
    } catch (e) {
      error.value = e instanceof Error && e.message ? e.message : '通信に失敗しました。'
      return null
    } finally {
      loading.value = false
    }
  }

  /** Call a tool and switch the widget to its result view (list -> detail, period switch). */
  async function navigate(name: WidgetCallableTool, args: Record<string, unknown>, push: boolean) {
    const res = await call(name, args)
    if (!res) return false
    if (res.isError || !isWidgetEnvelope(res.structuredContent)) {
      error.value = res.text || '表示できませんでした。'
      return false
    }
    show({ envelope: res.structuredContent, meta: res.meta }, push)
    return true
  }

  const openDraft = (draftId: number) => navigate('get_receipt_drafts', { draft_id: draftId }, true)
  const openReceipt = (receiptId: number) => navigate('get_receipt', { receipt_id: receiptId }, true)

  /** Open a draft_batch row as the detail view from structuredContent, without callTool (TASK-18). */
  function openBatchDraft(d: DraftView) {
    const cur = screen.value
    // while approve-all is in flight the list stays put (its response redraws it)
    if (!cur || cur.envelope.view !== 'draft_batch' || loading.value || batchApproving.value) return
    const detail: DraftEnvelope = { view: 'draft', ledger: cur.envelope.ledger, draft: d }
    show({ envelope: detail, meta: cur.meta }, true)
  }

  function back() {
    const stack = history.value
    const prev = stack[stack.length - 1]
    if (!prev) return
    history.value = stack.slice(0, -1)
    screen.value = prev
    error.value = null
    resetApprove()
    persistState()
  }

  async function loadStats(report: ReportKind, period: Period | null, filters?: StatsFilters | null) {
    const args: Record<string, unknown> = { report }
    if (period) args.period = period
    if (filters && Object.keys(filters).length > 0) args.filters = filters
    const ledgerId = envelope.value?.ledger?.id
    if (envelope.value?.ledger?.source === 'explicit' && typeof ledgerId === 'number') args.ledger_id = ledgerId
    return navigate('summarize_spending', args, false)
  }

  function approvedText(ledgerName: string | null | undefined, receiptId: number | null | undefined) {
    return `登録しました（家計簿 ${ledgerName ?? '-'} / レシート #${receiptId ?? '-'}）`
  }

  /** Approve button state machine (spec §11-3). Never re-approves automatically. */
  async function approve() {
    const d = draft.value
    if (!d || d.status !== 'pending' || approvePhase.value === 'submitting') return
    approvePhase.value = 'submitting'
    approveMessage.value = '登録中'
    let res: ToolCallResult
    try {
      res = await host.value.callTool('approve_receipt_draft', { draft_id: d.draft_id, revision: d.revision })
    } catch (e) {
      approvePhase.value = 'error'
      approveMessage.value = e instanceof Error && e.message ? e.message : '登録できませんでした。'
      return
    }
    const sc = res.structuredContent
    const meta = Object.keys(res.meta).length > 0 ? res.meta : (screen.value?.meta ?? {})
    if (!res.isError && isDraftEnvelope(sc)) {
      screen.value = { envelope: sc, meta }
      const receiptId = sc.receipt_id ?? sc.draft.approved_receipt_id ?? null
      approvedReceiptId.value = receiptId
      if (typeof receiptId === 'number') {
        approvedMap.value = { ...approvedMap.value, [sc.draft.draft_id]: receiptId }
      }
      if (sc.ledger?.name) approvedLedgerName.value = sc.ledger.name
      approvePhase.value = 'done'
      approveMessage.value = approvedText(sc.ledger?.name, receiptId)
      persistState()
      return
    }
    if (res.isError && isDraftEnvelope(sc)) {
      screen.value = { envelope: sc, meta }
      const latest = sc.draft
      if (latest.status === 'pending') {
        approvePhase.value = 'stale'
        approveMessage.value = '内容が更新されています。確認して再度登録してください。'
      } else {
        approvePhase.value = 'conflict'
        approveMessage.value =
          latest.status === 'approved'
            ? `この下書きは別の内容で登録済みです（レシート #${latest.approved_receipt_id ?? '-'}）。`
            : (CONFLICT_MESSAGES[latest.status] ?? 'この下書きは登録できません。')
      }
      persistState()
      return
    }
    approvePhase.value = 'error'
    approveMessage.value = res.text || '登録できませんでした。'
  }

  /** Approve-all button of the draft_batch view (TASK-18, spec §11-3). Sends the still-pending
   *  drafts once, reflects the per-item results and never re-approves automatically. */
  async function approveAll() {
    const cur = screen.value
    if (!cur || cur.envelope.view !== 'draft_batch' || batchApproving.value) return
    // rows parked as 要確認 by the previous answer (invalid / conflict / ...) are not resent;
    // stale rows are, at the latest revision the answer carried
    const parked = new Set(
      (cur.envelope.results ?? []).filter((r) => r.outcome !== 'stale_revision').map((r) => r.draft_id),
    )
    const items = cur.envelope.drafts
      .filter((d) => d.status === 'pending' && typeof approvedMap.value[d.draft_id] !== 'number' && !parked.has(d.draft_id))
      .map((d) => ({ draft_id: d.draft_id, revision: d.revision }))
    if (items.length === 0) return
    batchApproving.value = true
    let res: ToolCallResult
    try {
      res = await host.value.callTool('approve_receipt_drafts', { items })
    } catch (e) {
      error.value = e instanceof Error && e.message ? e.message : '登録できませんでした。'
      return
    } finally {
      batchApproving.value = false
    }
    const sc = res.structuredContent
    // A draft_batch result is reflected even with isError (zero successes, e.g. all stale):
    // its drafts carry the latest revisions so the next press sends those (spec §11-3).
    if (isDraftBatchEnvelope(sc)) {
      const map = { ...approvedMap.value }
      for (const r of sc.results ?? []) {
        if ((r.outcome === 'approved' || r.outcome === 'idempotent') && typeof r.receipt_id === 'number') {
          map[r.draft_id] = r.receipt_id
        }
      }
      approvedMap.value = map
      if (sc.ledger?.name) approvedLedgerName.value = sc.ledger.name
      // Merge by draft_id into the list this call was sent from: rows that were not sent
      // (approved earlier from the detail, not pending, not found) stay, and so does the count.
      const latest = new Map(sc.drafts.map((d) => [d.draft_id, d] as const))
      const merged: DraftBatchEnvelope = {
        ...cur.envelope,
        drafts: cur.envelope.drafts.map((d) => latest.get(d.draft_id) ?? d),
        results: sc.results ?? [],
      }
      const meta: WidgetMeta = Object.keys(res.meta).length > 0 ? { ...cur.meta, ...res.meta } : cur.meta
      const next: Screen = { envelope: merged, meta }
      if (screen.value === cur) {
        screen.value = next
      } else {
        // the user left the list meanwhile: update it where it sits in the history
        history.value = history.value.map((s) => (s === cur ? next : s))
      }
      if (res.isError) error.value = res.text || 'どの下書きも登録できませんでした。'
      persistState()
      return
    }
    error.value = res.text || '登録できませんでした。'
  }

  /** Image ref for the current detail view from `_meta.images` (spec §7-2 / §7-20). */
  function imageFor(kind: 'draft' | 'receipt', id: number): ImageRef | null {
    const images = screen.value?.meta.images
    if (!images) return null
    return images[`${kind}:${id}`] ?? (kind === 'draft' ? batchDraftImage(images, id) : null) ?? images[`${kind}_image`] ?? null
  }

  /** create_receipt_drafts' `_meta.images.drafts["<draft_id>"]` (spec §7-22). */
  function batchDraftImage(images: NonNullable<WidgetMeta['images']>, id: number): ImageRef | null {
    const drafts: unknown = (images as Record<string, unknown>).drafts
    if (typeof drafts !== 'object' || drafts === null) return null
    const ref: unknown = (drafts as Record<string, unknown>)[String(id)]
    if (typeof ref !== 'object' || ref === null || typeof (ref as { url?: unknown }).url !== 'string') return null
    return ref as ImageRef
  }

  /** Re-issue expired image URLs via refresh_widget_images (spec §11-5). */
  async function refreshImages(refs: { kind: 'draft' | 'receipt'; id: number }[]) {
    if (refs.length === 0 || !screen.value) return false
    let res: ToolCallResult
    try {
      res = await host.value.callTool('refresh_widget_images', { refs: refs.slice(0, 20) })
    } catch {
      return false
    }
    if (res.isError || !res.meta.images) return false
    const cur = screen.value
    screen.value = { envelope: cur.envelope, meta: { ...cur.meta, images: { ...cur.meta.images, ...res.meta.images } } }
    return true
  }

  function toggleFullscreen() {
    const next: DisplayMode = displayMode.value === 'fullscreen' ? 'inline' : 'fullscreen'
    host.value.requestDisplayMode(next)
    displayMode.value = next
  }

  return {
    title,
    host,
    screen,
    history,
    loading,
    error,
    approvePhase,
    approveMessage,
    approvedReceiptId,
    approvedMap,
    approvedLedgerName,
    batchApproving,
    displayMode,
    view,
    envelope,
    draft,
    trendMatrix,
    canGoBack,
    showApproveButton,
    approveDisabled,
    init,
    openDraft,
    openReceipt,
    openBatchDraft,
    back,
    loadStats,
    approve,
    approveAll,
    imageFor,
    refreshImages,
    toggleFullscreen,
  }
})
