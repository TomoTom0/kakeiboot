import { vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { WidgetMeta } from '@/shared/types'
import type { DisplayMode, Theme, ToolCallResult, WidgetHost, WidgetState } from '@/widget/host'
import App from '@/widget/App.vue'
import { useWidgetStore } from '@/widget/stores/widget'

export type FakeHostOptions = {
  toolOutput?: unknown
  meta?: WidgetMeta
  widgetState?: WidgetState | null
  theme?: Theme | null
  callTool?: (name: string, args: Record<string, unknown>) => Promise<ToolCallResult>
}

export type FakeHost = WidgetHost & {
  callTool: ReturnType<typeof vi.fn<WidgetHost['callTool']>>
  setWidgetState: ReturnType<typeof vi.fn<WidgetHost['setWidgetState']>>
  requestDisplayMode: ReturnType<typeof vi.fn<WidgetHost['requestDisplayMode']>>
}

export function result(structuredContent: unknown, opts: { meta?: WidgetMeta; isError?: boolean; text?: string } = {}): ToolCallResult {
  return { structuredContent, meta: opts.meta ?? {}, isError: opts.isError ?? false, text: opts.text ?? '' }
}

/** In-memory host with spies; mirrors window.openai through the WidgetHost interface. */
export function fakeHost(opts: FakeHostOptions = {}): FakeHost {
  let state: WidgetState | null = opts.widgetState ?? null
  let mode: DisplayMode = 'inline'
  const callTool = vi.fn<WidgetHost['callTool']>(
    opts.callTool ?? (async () => result(null, { isError: true, text: 'not mocked' })),
  )
  const setWidgetState = vi.fn<WidgetHost['setWidgetState']>((s) => {
    state = s
  })
  const requestDisplayMode = vi.fn<WidgetHost['requestDisplayMode']>((m) => {
    mode = m
  })
  return {
    kind: 'mock',
    toolOutput: () => opts.toolOutput ?? null,
    toolResponseMetadata: () => opts.meta ?? {},
    widgetState: () => state,
    setWidgetState,
    callTool,
    theme: () => opts.theme ?? null,
    displayMode: () => mode,
    requestDisplayMode,
    maxHeight: () => null,
    onGlobalsChange: () => () => {},
  }
}

/** Fresh pinia + store initialised from the host, then App mounted. */
export async function mountWidget(host: WidgetHost) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useWidgetStore(pinia)
  store.init(host)
  const wrapper = mount(App, { global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, store }
}

/** Promise whose resolution is controlled by the test. */
export function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
