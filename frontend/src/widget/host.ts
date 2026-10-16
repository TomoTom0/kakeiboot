// Host API adapter (spec §11-1, §11-3). Every use of `window.openai` goes through
// here so a postMessage-based host can be added later without touching views.
import type { WidgetCallableTool, WidgetMeta, WidgetView } from '@/shared/types'

export type Theme = 'light' | 'dark'
export type DisplayMode = 'inline' | 'fullscreen' | 'pip'

/** Display-only state persisted with the message (spec §11-3: never the source of business data). */
export type WidgetState = {
  /** Draft currently shown and the revision the approve button will send. */
  draft_id?: number | null
  revision?: number | null
  /** Approvals done in this widget: draft_id -> receipt_id (TASK-18). Covers both the single and the batch view. */
  approved?: Record<string, number>
  /** Legacy single-approval keys (pre TASK-18); migrated into `approved` on load. */
  approved_draft_id?: number | null
  approved_receipt_id?: number | null
  approved_ledger_name?: string | null
  /** History of views opened inside the widget (for the back button). */
  stack?: WidgetView[]
}

export type ToolCallResult = {
  structuredContent: unknown
  meta: WidgetMeta
  isError: boolean
  text: string
}

export interface WidgetHost {
  readonly kind: 'openai' | 'mock' | 'none'
  toolOutput(): unknown
  toolResponseMetadata(): WidgetMeta
  widgetState(): WidgetState | null
  setWidgetState(state: WidgetState): void
  callTool(name: WidgetCallableTool, args: Record<string, unknown>): Promise<ToolCallResult>
  theme(): Theme | null
  displayMode(): DisplayMode
  requestDisplayMode(mode: DisplayMode): void
  maxHeight(): number | null
  /** Subscribe to host global changes (theme, toolOutput, ...). Returns an unsubscribe fn. */
  onGlobalsChange(cb: () => void): () => void
}

/** Subset of the Apps SDK `window.openai` object used by the widget. */
export type OpenAiGlobals = {
  toolOutput?: unknown
  toolResponseMetadata?: unknown
  widgetState?: unknown
  setWidgetState?: (state: unknown) => unknown
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>
  theme?: unknown
  displayMode?: unknown
  requestDisplayMode?: (args: { mode: DisplayMode }) => unknown
  maxHeight?: unknown
}

declare global {
  interface Window {
    openai?: OpenAiGlobals
  }
}

const SET_GLOBALS_EVENT = 'openai:set_globals'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asMeta(v: unknown): WidgetMeta {
  return isRecord(v) ? (v as WidgetMeta) : {}
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (isRecord(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Normalize the value resolved by `callTool`. The exact shape is a TASK-7 check
 * item (spec §14 T10), so accept both the MCP CallToolResult and a `{result}` wrapper.
 */
export function normalizeCallResult(raw: unknown): ToolCallResult {
  let r: unknown = raw
  if (isRecord(r) && !('structuredContent' in r) && isRecord(r.result)) r = r.result
  if (!isRecord(r)) return { structuredContent: null, meta: {}, isError: true, text: '' }
  return {
    structuredContent: r.structuredContent ?? null,
    meta: asMeta(r._meta ?? r.meta),
    isError: r.isError === true,
    text: contentText(r.content),
  }
}

export function createOpenAiHost(target: Window = window): WidgetHost {
  const g = (): OpenAiGlobals => target.openai ?? {}
  return {
    kind: 'openai',
    toolOutput: () => g().toolOutput ?? null,
    toolResponseMetadata: () => asMeta(g().toolResponseMetadata),
    widgetState: () => (isRecord(g().widgetState) ? (g().widgetState as WidgetState) : null),
    setWidgetState: (state) => {
      void g().setWidgetState?.(state)
    },
    callTool: async (name, args) => {
      const fn = g().callTool
      if (!fn) throw new Error('callTool is not available')
      return normalizeCallResult(await fn(name, args))
    },
    theme: () => {
      const t = g().theme
      return t === 'dark' || t === 'light' ? t : null
    },
    displayMode: () => {
      const m = g().displayMode
      return m === 'fullscreen' || m === 'pip' ? m : 'inline'
    },
    requestDisplayMode: (mode) => {
      void g().requestDisplayMode?.({ mode })
    },
    maxHeight: () => {
      const h = g().maxHeight
      return typeof h === 'number' && Number.isFinite(h) ? h : null
    },
    onGlobalsChange: (cb) => {
      target.addEventListener(SET_GLOBALS_EVENT, cb)
      return () => target.removeEventListener(SET_GLOBALS_EVENT, cb)
    },
  }
}

/** Host used when nothing is available (production build outside ChatGPT). */
export function createNullHost(): WidgetHost {
  return {
    kind: 'none',
    toolOutput: () => null,
    toolResponseMetadata: () => ({}),
    widgetState: () => null,
    setWidgetState: () => {},
    callTool: async () => {
      throw new Error('ホストに接続されていません')
    },
    theme: () => null,
    displayMode: () => 'inline',
    requestDisplayMode: () => {},
    maxHeight: () => null,
    onGlobalsChange: () => () => {},
  }
}

/**
 * Pick the host: `window.openai` when present, the in-memory mock in development,
 * otherwise the null host. The mock is loaded lazily so it stays out of the
 * production bundle.
 */
export async function resolveHost(target: Window = window, dev = import.meta.env.DEV): Promise<WidgetHost> {
  if (target.openai) return createOpenAiHost(target)
  if (dev) {
    const { createMockHost } = await import('./mock')
    return createMockHost()
  }
  return createNullHost()
}

/** Apply the theme to <html data-theme> (spec §11-3 `theme`, §11-7). */
export function applyTheme(host: WidgetHost, doc: Document = document): Theme {
  let theme = host.theme()
  if (!theme) {
    const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
    theme = mq?.matches ? 'dark' : 'light'
  }
  doc.documentElement.setAttribute('data-theme', theme)
  return theme
}
