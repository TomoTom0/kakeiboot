// Static checks of frontend/src/web/styles.css (TASK-16 / TASK-27): layout
// rules that jsdom cannot evaluate are asserted on the stylesheet text, and
// the shell structure (topbar over the drawer) on the mounted App. Vitest
// runs with the frontend dir as cwd.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setDataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { cleanup, ME, mockFetch, mountApp } from './helpers'

const css = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

interface Rule {
  selectors: string[]
  body: string
}

/** Innermost rules (`selector { decls }`), including those inside @media blocks. */
function rules(text: string): Rule[] {
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    body: m[2]!,
  }))
}

function rulesFor(selector: string, text = css): Rule[] {
  return rules(text).filter((r) => r.selectors.includes(selector))
}

/** Value of `prop` in a declaration block (last one wins), whitespace-normalized. */
function decl(body: string, prop: string): string | undefined {
  const all = [...body.matchAll(new RegExp(`(?:^|;|\\s)${prop.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+)`, 'g'))]
  return all.at(-1)?.[1]!.trim().replace(/\s+/g, ' ')
}

/** Body of the first balanced block that starts at `head` (e.g. an @media). */
function blockAfter(head: RegExp, text = css): string | undefined {
  const m = head.exec(text)
  if (!m) return undefined
  const open = text.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return undefined
}

/** Top-level text with every nested at-rule block removed. */
function topLevel(text = css): string {
  let out = ''
  let depth = 0
  let atDepth = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '@' && depth === 0) atDepth = 0
    if (atDepth >= 0) {
      if (c === ';' && atDepth === 0) atDepth = -1
      else if (c === '{') atDepth++
      else if (c === '}' && --atDepth === 0) atDepth = -1
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    out += c
  }
  return out
}

describe('layout: grid children shrink', () => {
  it('[covers:web-layout.grid-children-shrinkable] .dash-grid 全メディアクエリで minmax(0、.kpi-sub・.sub-row も minmax(0、.hscroll、overflow-x hidden なし', () => {
    const grids = rulesFor('.dash-grid').filter((r) => decl(r.body, 'grid-template-columns') !== undefined)
    expect(grids.length).toBeGreaterThanOrEqual(2)
    for (const r of grids) {
      const v = decl(r.body, 'grid-template-columns')!
      expect(v).toContain('minmax(0')
      // no bare 1fr outside minmax(...)
      expect(v.replace(/minmax\([^()]*\)/g, '')).not.toMatch(/\b1fr\b/)
    }
    expect(rulesFor('.dash-grid > *').some((r) => decl(r.body, 'min-width') === '0')).toBe(true)
    expect(rulesFor('.kpi-sub').map((r) => decl(r.body, 'grid-template-columns'))).toContain(
      'repeat(3, minmax(0, 1fr))',
    )
    expect(rulesFor('.sub-row').map((r) => decl(r.body, 'grid-template-columns'))).toContain(
      'minmax(0, 1fr) auto auto',
    )
    expect(rulesFor('.hscroll').some((r) => decl(r.body, 'overflow-x') === 'auto')).toBe(true)
    // the page itself is never clipped to hide overflow
    for (const sel of ['body', '.main-col', 'html', '.app-main']) {
      for (const r of rulesFor(sel)) {
        expect(decl(r.body, 'overflow-x') ?? '', sel).not.toMatch(/hidden|clip/)
        expect(decl(r.body, 'overflow') ?? '', sel).not.toMatch(/hidden|clip/)
      }
    }
  })
})

describe('receipt feed CSS (no snap)', () => {
  it('[covers:web-receipts.feed-no-snap] scroll-snap 系と snap-feed / snap-paused の定義が無く、.receipt-panel は scroll-margin-top で着地、--feed-nav-h は残る', () => {
    // the snap wiring is gone entirely
    expect(css).not.toMatch(/scroll-snap/)
    expect(css).not.toMatch(/snap-feed/)
    expect(css).not.toMatch(/snap-paused/)
    // prev/next moves land below the sticky topbar and the feed nav instead
    expect(
      rulesFor('.receipt-panel').some((r) =>
        /^calc\(var\(--topbar-h\) \+ var\(--feed-nav-h\)/.test(decl(r.body, 'scroll-margin-top') ?? ''),
      ),
    ).toBe(true)
    expect(css).toMatch(/--feed-nav-h\s*:/)
  })
})

describe('topbar title', () => {
  it('[covers:web-shell.topbar-title-ellipsis] .topbar-title は 1 行 ellipsis（nowrap + hidden + ellipsis + min-width 0）で折り返さない', () => {
    const titles = rulesFor('.topbar-title')
    expect(titles.length).toBeGreaterThan(0)
    expect(
      titles.some(
        (r) =>
          decl(r.body, 'white-space') === 'nowrap' &&
          decl(r.body, 'overflow') === 'hidden' &&
          decl(r.body, 'text-overflow') === 'ellipsis' &&
          decl(r.body, 'min-width') === '0',
      ),
    ).toBe(true)
    for (const r of titles) expect(decl(r.body, 'overflow-wrap') ?? '', 'overflow-wrap').not.toBe('anywhere')
  })
})

describe('shell: topbar over drawer (TASK-27)', () => {
  it('[covers:web-shell.drawer-below-topbar] topbar は .shell 直下（.main-col の外）の全幅で、899px 以下の sidebar・scrim は topbar の下端から展開し z-index も topbar が上', async () => {
    // template structure: the topbar is a direct child of the shell, never
    // inside the main column (so the drawer cannot cover it)
    setDataApi(createMockDataApi())
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/')
    const topbar = wrapper.get('header.topbar')
    expect(topbar.element.parentElement?.classList.contains('shell')).toBe(true)
    expect(wrapper.find('.main-col header.topbar').exists()).toBe(false)
    setDataApi(null)
    cleanup()

    // CSS: the mobile drawer and its scrim start at the topbar's bottom edge
    const mobile = blockAfter(/@media\s*\(max-width:\s*899px\)/)
    expect(mobile).toBeDefined()
    expect(rulesFor('.sidebar', mobile!).map((r) => decl(r.body, 'top'))).toContain('var(--topbar-h)')
    expect(rulesFor('.drawer-open .scrim', mobile!).some((r) => decl(r.body, 'top') === 'var(--topbar-h)')).toBe(true)
    // and the topbar stacks above both
    const zOf = (sel: string, text: string) =>
      rulesFor(sel, text)
        .map((r) => Number(decl(r.body, 'z-index')))
        .filter((n) => !Number.isNaN(n))
    const topZ = zOf('.topbar', css)
    const sideZ = zOf('.sidebar', css)
    const scrimZ = zOf('.drawer-open .scrim', css)
    expect(topZ.length, 'topbar z-index').toBeGreaterThan(0)
    expect(sideZ.length, 'sidebar z-index').toBeGreaterThan(0)
    expect(scrimZ.length, 'scrim z-index').toBeGreaterThan(0)
    expect(Math.max(...topZ)).toBeGreaterThan(Math.max(...sideZ))
    expect(Math.max(...topZ)).toBeGreaterThan(Math.max(...scrimZ))
  })
})

describe('shell: menu button breakpoint (TASK-27)', () => {
  it('[covers:web-shell.menu-btn-desktop-hidden] .menu-btn の display:none は .icon-btn の display 規則より後に定義され 900px 以上で非表示・899px 以下は 44x44 で表示', () => {
    // the element carries both classes (icon-btn menu-btn), so the hiding
    // rule only wins over .icon-btn's display by coming later in source
    // order (same specificity)
    const top = rules(topLevel())
    const iconAt = top.findIndex(
      (r) => r.selectors.includes('.icon-btn') && decl(r.body, 'display') !== undefined,
    )
    expect(iconAt, '.icon-btn display rule').toBeGreaterThanOrEqual(0)
    const menuAt = top.findIndex(
      (r) => r.selectors.includes('.menu-btn') && decl(r.body, 'display') === 'none',
    )
    expect(menuAt, 'top-level .menu-btn display:none rule').toBeGreaterThanOrEqual(0)
    expect(menuAt, '.menu-btn hides after .icon-btn').toBeGreaterThan(iconAt)
    // no later top-level .menu-btn rule turns the button back on
    for (const r of top.slice(menuAt + 1).filter((r) => r.selectors.includes('.menu-btn'))) {
      expect(decl(r.body, 'display'), 'later .menu-btn display').toBeUndefined()
    }
    // below 900px the button is a 44x44 tap target
    const mobile = blockAfter(/@media\s*\(max-width:\s*899px\)/)
    expect(mobile).toBeDefined()
    expect(
      rulesFor('.menu-btn', mobile!).some(
        (r) =>
          decl(r.body, 'display') === 'inline-grid' &&
          decl(r.body, 'width') === '44px' &&
          decl(r.body, 'height') === '44px',
      ),
    ).toBe(true)
  })
})

describe('topbar logo switch (520px)', () => {
  it('[covers:web-shell.topbar-logo-responsive] 520px メディアクエリで full を隠し compact を出す', () => {
    const narrow = blockAfter(/@media\s*\(max-width:\s*520px\)/)
    expect(narrow).toBeDefined()
    expect(rulesFor('.topbar-logo-full', narrow!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    expect(
      rulesFor('.topbar-logo-compact', narrow!).some((r) => {
        const d = decl(r.body, 'display')
        return d !== undefined && d !== 'none'
      }),
    ).toBe(true)
  })
})

describe('ledger palette CSS', () => {
  const KEYS = ['teal', 'orange', 'pink', 'brown', 'slate', 'graphite']

  it('[covers:web-shell.ledger-palette-css] 6色の --ledger-* が :root と dark の両方、ラベル色名なし、--label-* を参照しない', () => {
    const light = rulesFor(':root', topLevel())
      .map((r) => r.body)
      .join('\n')
    const darkMedia = blockAfter(/@media\s*\(prefers-color-scheme:\s*dark\)/)
    expect(darkMedia).toBeDefined()
    const dark = rules(darkMedia!)
      .filter((r) => r.selectors.some((s) => s.startsWith(':root')))
      .map((r) => r.body)
      .join('\n')
    for (const k of KEYS) {
      expect(light, `light --ledger-${k}`).toMatch(new RegExp(`--ledger-${k}\\s*:`))
      expect(dark, `dark --ledger-${k}`).toMatch(new RegExp(`--ledger-${k}\\s*:`))
    }
    expect(css).not.toMatch(/--ledger-(red|yellow|green|blue|purple)\b/)
    for (const m of css.matchAll(/--ledger-[\w-]+\s*:\s*([^;]+);/g)) {
      expect(m[1]).not.toContain('var(--label-')
    }
  })

  it('[covers:web-shell.ledger-color-band] .topbar.ledger-scoped に --ledger-current の下端色帯', () => {
    const band = rulesFor('.topbar.ledger-scoped').map((r) => decl(r.body, 'box-shadow') ?? '')
    expect(band.some((v) => /inset 0 -3px 0 var\(--ledger-current\)/.test(v))).toBe(true)
  })
})
