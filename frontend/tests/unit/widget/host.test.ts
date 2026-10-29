import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { applyTheme, createOpenAiHost, normalizeCallResult, resolveHost } from '@/widget/host'
import { fakeHost } from './helpers'

afterEach(() => {
  delete window.openai
  document.documentElement.removeAttribute('data-theme')
})

describe('host adapter', () => {
  it('[covers:widget.host-fallback-without-openai] picks openai, mock (dev) or null host', async () => {
    window.openai = { toolOutput: { view: 'draft' } }
    expect((await resolveHost(window, false)).kind).toBe('openai')
    delete window.openai
    const mock = await resolveHost(window, true)
    expect(mock.kind).toBe('mock')
    expect(mock.toolOutput()).toMatchObject({ view: 'draft' })
    const none = await resolveHost(window, false)
    expect(none.kind).toBe('none')
    await expect(none.callTool('get_receipt', { receipt_id: 1 })).rejects.toThrow()
  })

  it('[covers:widget.host-fallback-without-openai] openai host reads globals and forwards callTool', async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { view: 'images', ledger: null }, _meta: { images: {} } }))
    const setWidgetState = vi.fn()
    window.openai = { toolOutput: { view: 'stats' }, toolResponseMetadata: { images: {} }, widgetState: { draft_id: 1 }, callTool, setWidgetState, theme: 'dark' }
    const host = createOpenAiHost(window)
    expect(host.toolOutput()).toEqual({ view: 'stats' })
    expect(host.widgetState()).toEqual({ draft_id: 1 })
    expect(host.theme()).toBe('dark')
    const res = await host.callTool('refresh_widget_images', { refs: [] })
    expect(callTool).toHaveBeenCalledWith('refresh_widget_images', { refs: [] })
    expect(res.isError).toBe(false)
    host.setWidgetState({ draft_id: 2 })
    expect(setWidgetState).toHaveBeenCalledWith({ draft_id: 2 })
  })

  it('[covers:widget.call-result-normalization] accepts CallToolResult and {result} wrappers', () => {
    const raw = {
      structuredContent: { view: 'draft' },
      _meta: { images: { 'draft:1': null } },
      isError: true,
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    }
    const a = normalizeCallResult(raw)
    expect(a).toEqual({ structuredContent: { view: 'draft' }, meta: { images: { 'draft:1': null } }, isError: true, text: 'a\nb' })
    expect(normalizeCallResult({ result: raw })).toEqual(a)
    expect(normalizeCallResult(null).isError).toBe(true)
    expect(normalizeCallResult({ structuredContent: { view: 'stats' } })).toMatchObject({ isError: false, meta: {}, text: '' })
  })
})

describe('theme', () => {
  const mq = (dark: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) => ({ matches: dark && q.includes('dark'), media: q }) as unknown as MediaQueryList,
    )

  it('[covers:widget.theme-dark-mode] follows openai theme, then prefers-color-scheme', () => {
    if (!window.matchMedia) window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
    expect(applyTheme(fakeHost({ theme: 'dark' }))).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(applyTheme(fakeHost({ theme: 'light' }))).toBe('light')
    const s1 = mq(true)
    expect(applyTheme(fakeHost())).toBe('dark')
    s1.mockRestore()
    const s2 = mq(false)
    expect(applyTheme(fakeHost())).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    s2.mockRestore()
  })

  it('[covers:widget.theme-dark-mode] style.css defines palette variables for light and dark', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/widget/style.css'), 'utf8')
    for (const theme of ['light', 'dark']) {
      const block = css.split(`[data-theme='${theme}']`)[1]?.split('}')[0] ?? ''
      // TASK-116: the series palette joins the web tokens (--series-1..7 +
      // --series-rest, both themes) and the old --bb-series-* is gone
      const vars = [
        '--bb-bg',
        '--bb-fg',
        '--bb-muted',
        '--bb-accent',
        '--bb-warn',
        '--bb-danger',
        ...Array.from({ length: 7 }, (_, i) => `--series-${i + 1}`),
        '--series-rest',
      ]
      for (const v of vars) {
        expect(block, `${theme} ${v}`).toContain(`${v}:`)
      }
    }
    expect(css, 'the old widget palette is retired (definitions and references)').not.toMatch(/--bb-series-/)
  })
})
