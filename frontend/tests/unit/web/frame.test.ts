import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFramed } from '@/web/composables/frame'
import { cleanup, mockFetch, mountApp } from './helpers'

// The pages see a framed window; isFramed itself is checked with fakes below.
vi.mock('@/web/composables/frame', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/web/composables/frame')>()
  return { ...orig, isFramed: (win?: Window) => (win ? orig.isFramed(win) : true) }
})

afterEach(cleanup)

describe('frame guard', () => {
  it('[covers:web-frame.framed-page-refuses] iframe 内ではログイン・同意の操作部品を描画しない', async () => {
    const top = {} as Window
    expect(isFramed({ top, self: {} } as unknown as Window)).toBe(true)
    const self = {} as Window
    expect(isFramed({ top: self, self } as unknown as Window)).toBe(false)

    const f = mockFetch({})
    const login = await mountApp('/login')
    expect(login.wrapper.find('[data-test="framed"]').exists()).toBe(true)
    expect(login.wrapper.find('[data-test="login"]').exists()).toBe(false)
    cleanup()

    mockFetch({})
    const consent = await mountApp('/oauth/consent?req=R')
    expect(consent.wrapper.find('[data-test="framed"]').exists()).toBe(true)
    expect(consent.wrapper.find('[data-test="allow"]').exists()).toBe(false)
    expect(consent.wrapper.find('[data-test="deny"]').exists()).toBe(false)
    expect(f.calls).toHaveLength(0)
  })
})

describe('web.html', () => {
  it('[covers:web-frame.html-title-and-icon] title は kakeiboot、SVG favicon の link と public/favicon.svg', async () => {
    const { readFileSync, existsSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const html = readFileSync(resolve(process.cwd(), 'web.html'), 'utf8')
    expect(html).toContain('<title>kakeiboot</title>')
    expect(html).not.toMatch(/<title>[^<]*budget-book/)
    expect(html).toMatch(/<link\s+rel="icon"\s+href="\/favicon\.svg"\s+type="image\/svg\+xml"\s*\/?>/)
    const icon = resolve(process.cwd(), 'public/favicon.svg')
    expect(existsSync(icon)).toBe(true)
    expect(readFileSync(icon, 'utf8')).toMatch(/<svg[\s>]/)
  })
})

describe('favicon.svg', () => {
  it('[covers:web-frame.favicon-no-css-vars] 実色（#e3f2e7 / #2e9a5e）でマークのみ描き var() に依存しない', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    // a standalone file cannot resolve CSS variables, so the colors must be real
    const svg = readFileSync(resolve(process.cwd(), 'public/favicon.svg'), 'utf8')
    expect(svg).not.toContain('var(')
    expect(svg).toContain('#e3f2e7')
    expect(svg).toContain('#2e9a5e')
    // the mark only: no wordmark at 16px (neither <text> nor letter strokes)
    expect(svg).not.toMatch(/<text[\s>]/)
    expect(svg).not.toContain('kakeiboot')
  })
})
