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
  it('[covers:web-layout.grid-children-shrinkable] .dash-grid 全メディアクエリで minmax(0、.sub-row も minmax(0、.hscroll、overflow-x hidden なし', () => {
    const grids = rulesFor('.dash-grid').filter((r) => decl(r.body, 'grid-template-columns') !== undefined)
    expect(grids.length).toBeGreaterThanOrEqual(2)
    for (const r of grids) {
      const v = decl(r.body, 'grid-template-columns')!
      expect(v).toContain('minmax(0')
      // no bare 1fr outside minmax(...)
      expect(v.replace(/minmax\([^()]*\)/g, '')).not.toMatch(/\b1fr\b/)
    }
    expect(rulesFor('.dash-grid > *').some((r) => decl(r.body, 'min-width') === '0')).toBe(true)
    expect(rulesFor('.sub-row').map((r) => decl(r.body, 'grid-template-columns'))).toContain(
      'minmax(0, 1fr) auto auto',
    )
    expect(rulesFor('.hscroll').some((r) => decl(r.body, 'overflow-x') === 'auto')).toBe(true)
    // the page itself is never clipped to hide overflow — .app-main is the
    // slide transition's stage since TASK-74 (overflow-x: clip so the parked
    // leaving page and the entering translateX(100%) never widen the
    // document), so it stays out of this rule
    for (const sel of ['body', '.main-col', 'html']) {
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
  it('[covers:web-shell.topbar-title-ellipsis] .topbar-title は icon + .topbar-title-text の flex 行で、テキスト側が 1 行 ellipsis（nowrap + hidden + ellipsis + min-width 0）', () => {
    // the h1 is a flex row (icon + text, TASK-35) that shrinks without overflowing
    const titles = rulesFor('.topbar-title')
    expect(titles.length).toBeGreaterThan(0)
    expect(
      titles.some(
        (r) =>
          decl(r.body, 'display') === 'flex' &&
          decl(r.body, 'gap') === '0.375rem' &&
          decl(r.body, 'min-width') === '0' &&
          decl(r.body, 'overflow') === 'hidden',
      ),
    ).toBe(true)
    // the icon keeps its size; the text takes the rest and ellipsizes there
    expect(rulesFor('.topbar-title .icon').some((r) => decl(r.body, 'flex') === 'none')).toBe(true)
    const texts = rulesFor('.topbar-title-text')
    expect(texts.length).toBeGreaterThan(0)
    expect(
      texts.some(
        (r) =>
          decl(r.body, 'white-space') === 'nowrap' &&
          decl(r.body, 'overflow') === 'hidden' &&
          decl(r.body, 'text-overflow') === 'ellipsis' &&
          decl(r.body, 'min-width') === '0',
      ),
    ).toBe(true)
    for (const r of [...titles, ...texts]) {
      expect(decl(r.body, 'overflow-wrap') ?? '', 'overflow-wrap').not.toBe('anywhere')
    }
    // TASK-44 (§11-4): the title folds by width band to free the center for
    // the filter chips — icon-only below 390px, gone entirely below 360px
    // (the same media-query pattern as the 520px logo switch)
    const n390 = blockAfter(/@media\s*\(max-width:\s*390px\)/)
    expect(n390, 'max-width: 390px block').toBeDefined()
    expect(rulesFor('.topbar-title-text', n390!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    const n360 = blockAfter(/@media\s*\(max-width:\s*360px\)/)
    expect(n360, 'max-width: 360px block').toBeDefined()
    expect(rulesFor('.topbar-title', n360!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
  })
})

describe('topbar filter bar CSS (TASK-44)', () => {
  it('[covers:web-browse.topbar-filter-bar] .topbar-filters は flex + margin-left auto、.filter-chip-btn は高さ36px・pill・surface-2背景・44px タップ領域、選択中は accent 枠', () => {
    // the wrapper takes the margin-left:auto over from topbar-actions (§11-6)
    expect(
      rulesFor('.topbar-filters').some(
        (r) => decl(r.body, 'display') === 'flex' && decl(r.body, 'margin-left') === 'auto',
      ),
    ).toBe(true)
    // the chips (§11-3): 36px tall pills on surface-2 with a 44px minimum
    // tap area and an accent border while a filter is active
    const chips = rulesFor('.filter-chip-btn')
    expect(chips.length, '.filter-chip-btn rules').toBeGreaterThan(0)
    expect(chips.some((r) => decl(r.body, 'height') === '36px')).toBe(true)
    expect(chips.some((r) => /44px/.test(r.body)), '44px tap area').toBe(true)
    expect(chips.some((r) => decl(r.body, 'border-radius') === '999px')).toBe(true)
    expect(chips.some((r) => /--bb-surface-2/.test(decl(r.body, 'background') ?? ''))).toBe(true)
    expect(
      rulesFor('.filter-chip-btn.active').some((r) => decl(r.body, 'border-color') === 'var(--bb-accent)'),
    ).toBe(true)
  })

  it('[covers:web-browse.topbar-filter-bar] .filter-chip-search は幅 44px・padding 0 のアイコン入口（高さは他チップと同じ 36px）で、検索語の .chip-label-q は max-width + ellipsis に収まる', () => {
    // TASK-41: the third chip is the icon-only search entry — 44px wide with
    // no padding (the height rides the shared .filter-chip-btn 36px pill
    // with the 44px tap area); with a q running the term rides .chip-label-q,
    // clamped so a long term cannot push the topbar wide
    const chip = rulesFor('.filter-chip-search')
    expect(chip.length, '.filter-chip-search rules').toBeGreaterThan(0)
    expect(chip.some((r) => decl(r.body, 'width') === '44px')).toBe(true)
    expect(chip.some((r) => decl(r.body, 'min-width') === '44px')).toBe(true)
    expect(chip.some((r) => decl(r.body, 'padding') === '0')).toBe(true)
    const q = rulesFor('.chip-label-q')
    expect(q.length, '.chip-label-q rules').toBeGreaterThan(0)
    expect(
      q.some(
        (r) =>
          decl(r.body, 'overflow') === 'hidden' &&
          decl(r.body, 'text-overflow') === 'ellipsis' &&
          decl(r.body, 'max-width') !== undefined,
      ),
    ).toBe(true)
    // TASK-77: /search is ledger-scoped since TASK-74, so the 360px band
    // carries the ledger chip too and the q word folds away there (the same
    // word-hiding recipe as the logo's "kb") — the chip returns to the 44px
    // icon entry; aria-label keeps the term and the page's own input shows it
    const n360 = blockAfter(/@media\s*\(max-width:\s*360px\)/)
    expect(n360, 'max-width: 360px block').toBeDefined()
    expect(rulesFor('.chip-label-q', n360!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    expect(
      rulesFor('.filter-chip-search:has(.chip-label-q)', n360!).some(
        (r) => decl(r.body, 'width') === '44px' && decl(r.body, 'padding') === '0',
      ),
    ).toBe(true)
  })

  it('[covers:web-search.layout-real] /search の2行構成（.search-head・.search-tabs）と品目2行・件数行の規則がある', () => {
    // the layout facts jsdom cannot measure live in verify.spec.ts
    // (web-search.layout-real, 360px two rows / no overflow); the stylesheet
    // side is pinned here: the head row, the tab row, the item rows' two-line
    // composition and the meta line all have rules
    for (const sel of ['.search-head', '.search-input', '.search-tabs', '.search-item-main', '.search-item-sub', '.search-meta']) {
      expect(rulesFor(sel).length, sel).toBeGreaterThan(0)
    }
    expect(rulesFor('.search-head').some((r) => decl(r.body, 'display') === 'flex')).toBe(true)
    expect(rulesFor('.search-item-sub').some((r) => /--bb-muted|color/.test(r.body))).toBe(true)
  })
})

describe('one-row page toolbar CSS (TASK-75)', () => {
  it('[covers:web-layout.toolbar-one-row] .page-toolbar は nowrap の1行・.page-chips が flex:1/min-width:0/横スクロール・menu slot は右端で .page-menu 単独行規則は無く・絞り込みボタンは390px以下で語が消え44pxに畳む', () => {
    // the toolbar is one row at every width: the chips area takes the rest
    // and scrolls sideways, so nothing ever wraps (the 720px column-ization
    // of the two-row design stays deleted)
    const bars = rulesFor('.page-toolbar')
    expect(bars.length, '.page-toolbar rules').toBeGreaterThan(0)
    expect(bars.some((r) => decl(r.body, 'flex-wrap') === 'nowrap')).toBe(true)
    const chips = rulesFor('.page-toolbar .page-chips')
    expect(chips.length, '.page-toolbar .page-chips rules').toBeGreaterThan(0)
    expect(chips.some((r) => decl(r.body, 'flex') === '1' && decl(r.body, 'min-width') === '0')).toBe(true)
    expect(rulesFor('.page-chips').some((r) => decl(r.body, 'overflow-x') === 'auto')).toBe(true)
    // the "..." menu slot pins to the right end on the same row — no
    // standalone .page-menu row rule survives the merge (§6-5)
    expect(rulesFor('.page-menu')).toHaveLength(0)
    const menu = rulesFor('.page-toolbar-menu')
    expect(menu.length, '.page-toolbar-menu rules').toBeGreaterThan(0)
    expect(menu.some((r) => decl(r.body, 'margin-left') === 'auto' && decl(r.body, 'flex') === 'none')).toBe(true)
    // the 絞り込み button folds to the 44px icon + count badge through
    // 390px (§6-3's 360px budget: 44 + 8 + chips ~232 + 44 = 328px)
    const n390 = blockAfter(/@media\s*\(max-width:\s*390px\)/)
    expect(n390, 'max-width: 390px block').toBeDefined()
    expect(rulesFor('.toolbar-filter-word', n390!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    expect(rulesFor('.toolbar-filter-btn', n390!).some((r) => decl(r.body, 'width') === '44px')).toBe(true)
    expect(rulesFor('.toolbar-filter-count').length, '.toolbar-filter-count rules').toBeGreaterThan(0)
    // the 720px column-ization stays gone
    const n720 = blockAfter(/@media\s*\(max-width:\s*720px\)/)
    if (n720 !== undefined) expect(n720).not.toMatch(/\.page-toolbar/)
  })
})

describe('density: two-row KPI + 720px card rhythm (TASK-75 §6-4)', () => {
  it('[covers:web-home.dashboard-month-overview] KPI カードは padding 12px の2行（1行目 .kpi-head の flex 行・金額 1.5rem / 2行目 .kpi-sub は1行 ellipsis で3列 grid・dt・dd は無い）', () => {
    // the KPI card itself: 12px padding at every width (§6-4's ~64px card)
    expect(rulesFor('.card.kpi').some((r) => decl(r.body, 'padding') === '12px')).toBe(true)
    // the first row: label + amount + the diff chip pinned right (baseline)
    const head = rulesFor('.kpi-head')
    expect(head.length, '.kpi-head rules').toBeGreaterThan(0)
    expect(head.some((r) => decl(r.body, 'display') === 'flex' && decl(r.body, 'min-width') === '0')).toBe(true)
    expect(rulesFor('.kpi-value').some((r) => decl(r.body, 'font-size') === '1.5rem')).toBe(true)
    // the second row: one 0.8rem summary line joined with 「・」, ellipsized
    const sub = rulesFor('.kpi-sub')
    expect(sub.length, '.kpi-sub rules').toBeGreaterThan(0)
    expect(
      sub.some(
        (r) =>
          decl(r.body, 'white-space') === 'nowrap' &&
          decl(r.body, 'overflow') === 'hidden' &&
          decl(r.body, 'text-overflow') === 'ellipsis' &&
          decl(r.body, 'display') === undefined &&
          decl(r.body, 'grid-template-columns') === undefined,
      ),
    ).toBe(true)
    // the 3-column dl grid is gone entirely (no dt/dd rules either)
    expect(css).not.toMatch(/\.kpi-sub dt/)
    expect(css).not.toMatch(/\.kpi-sub dd/)
    expect(rulesFor('.kpi .label').some((r) => decl(r.body, 'font-size') === '0.8rem')).toBe(true)
  })

  it('[covers:web-home.dashboard-month-overview] 720px 以下は gap 0.75rem・カード padding 12px・ドーナツ 120px・推移 .bars 96px', () => {
    const n720 = blockAfter(/@media\s*\(max-width:\s*720px\)/)
    expect(n720, 'max-width: 720px block').toBeDefined()
    expect(rulesFor('.dash-grid', n720!).some((r) => decl(r.body, 'gap') === '0.75rem')).toBe(true)
    expect(rulesFor('.card', n720!).some((r) => decl(r.body, 'padding') === '12px')).toBe(true)
    expect(rulesFor('.donut', n720!).some((r) => decl(r.body, 'width') === '120px' && decl(r.body, 'height') === '120px')).toBe(true)
    expect(rulesFor('.bars', n720!).some((r) => decl(r.body, 'height') === '96px')).toBe(true)
    // the base sizes the narrow band shrinks from
    expect(rulesFor('.donut').some((r) => decl(r.body, 'width') === '170px')).toBe(true)
    expect(rulesFor('.bars').some((r) => decl(r.body, 'height') === '150px')).toBe(true)
  })

  it('[covers:web-receipts.dashboard] レシート行は1行 grid（3.2rem minmax(0,1fr) auto auto）で .recent-icon の規則は無く、日ごと見出しは 28px', () => {
    // the one-line receipt row: date / store (ellipsis) / labels / amount
    expect(
      rulesFor('.recent-row').map((r) => decl(r.body, 'grid-template-columns')),
    ).toContain('3.2rem minmax(0, 1fr) auto auto')
    // the 34px icon column is gone from the stylesheet entirely
    expect(rulesFor('.recent-icon')).toHaveLength(0)
    expect(css).not.toMatch(/\.recent-icon/)
    expect(rulesFor('.day-head').some((r) => decl(r.body, 'min-height') === '28px')).toBe(true)
    // review L5: the labels cell never wraps — overflow clips the dots (or
    // the 削除済み badge row) so the row keeps its one 44px line
    expect(
      rulesFor('.row-labels').some(
        (r) => decl(r.body, 'flex-wrap') === 'nowrap' && decl(r.body, 'overflow') === 'hidden',
      ),
    ).toBe(true)
  })
})

describe('ranked row single line (TASK-75 §6-4)', () => {
  it('[covers:web-layout.ranked-row-single-line] .ranked-row は 10px minmax(0,1fr) auto auto auto 12px の1行44px・下端2pxの linear-gradient・container query で差額を隠す・.meter 規則は無い', () => {
    const rows = rulesFor('.ranked-row')
    expect(rows.length, '.ranked-row rules').toBeGreaterThan(0)
    expect(
      rows.some(
        (r) =>
          decl(r.body, 'grid-template-columns') === '10px minmax(0, 1fr) auto auto auto 12px' &&
          decl(r.body, 'gap') === '8px' &&
          decl(r.body, 'min-height') === '44px' &&
          decl(r.body, 'container-type') === 'inline-size',
      ),
    ).toBe(true)
    // the share bar rides the row's bottom edge as a 2px gradient (no meter);
    // origin border-box spans the padding too so the bar reaches the row's
    // rounded ends (review L1 — padding-box 100% stops short of the sides)
    expect(
      rows.some(
        (r) =>
          /linear-gradient/.test(decl(r.body, 'background-image') ?? '') &&
          decl(r.body, 'background-origin') === 'border-box' &&
          decl(r.body, 'background-size') === '100% 2px' &&
          decl(r.body, 'background-position') === 'bottom',
      ),
    ).toBe(true)
    // the diff column: 0.75rem, danger up / accent down
    expect(rulesFor('.ranked-diff').some((r) => decl(r.body, 'font-size') === '0.75rem')).toBe(true)
    expect(rulesFor('.ranked-diff.up').some((r) => decl(r.body, 'color') === 'var(--bb-danger)')).toBe(true)
    expect(rulesFor('.ranked-diff.down').some((r) => decl(r.body, 'color') === 'var(--bb-accent)')).toBe(true)
    // through 340px of the row's own container the diff cell folds away
    const c340 = blockAfter(/@container\s*\(max-width:\s*340px\)/)
    expect(c340, '@container (max-width: 340px) block').toBeDefined()
    expect(rulesFor('.ranked-diff', c340!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    // the standalone meter element is gone from the ranked list (and the
    // stylesheet — Home's rank rows became RankedList rows too)
    expect(css).not.toMatch(/\.meter/)
    // the link hover keeps the gradient: background-color, never the shorthand
    for (const r of rulesFor('a.ranked-row.is-link:hover')) {
      expect(decl(r.body, 'background'), 'hover background shorthand').toBeUndefined()
    }
    expect(rulesFor('a.ranked-row.is-link:hover').some((r) => decl(r.body, 'background-color') === 'var(--bb-hover)')).toBe(true)
  })
})

describe('shell: topbar over drawer (TASK-27)', () => {
  it('[covers:web-shell.drawer-below-topbar] topbar は .shell 直下（.main-col の外）の全幅で、sidebar（全幅 overlay）・899px 以下の scrim は topbar の下端から展開し z-index も topbar が上', async () => {
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

    // CSS: the sidebar overlay (every width, TASK-33) and the mobile scrim
    // start at the topbar's bottom edge
    expect(rulesFor('.sidebar', css).map((r) => decl(r.body, 'top'))).toContain('var(--topbar-h)')
    const mobile = blockAfter(/@media\s*\(max-width:\s*899px\)/)
    expect(mobile).toBeDefined()
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

describe('shell: sidebar overlay at every width (TASK-33 real-device review)', () => {
  it('[covers:web-shell.sidebar-overlay] .sidebar は全幅で fixed overlay（translateX slide 0.2s・reduced-motion で無効）、.shell-body は main 1列のみ、scrim は899px 以下のみ', () => {
    // the sidebar is the same fixed overlay at every width: closed it sits
    // off-canvas via transform, open it slides in — at 900px+ too, in place
    // of the old instant grid-column swap
    const top = topLevel()
    const side = rulesFor('.sidebar', top)
    expect(side.some((r) => decl(r.body, 'position') === 'fixed')).toBe(true)
    expect(side.some((r) => decl(r.body, 'transform') === 'translateX(-100%)')).toBe(true)
    expect(side.some((r) => decl(r.body, 'transition') === 'transform 0.2s ease')).toBe(true)
    expect(rulesFor('.drawer-open .sidebar', top).some((r) => decl(r.body, 'transform') === 'none')).toBe(true)
    // the main column is a single grid column at every width: no sidebar
    // column to swap away, so main never moves or reflows
    expect(
      rulesFor('.shell-body', top).some((r) => decl(r.body, 'grid-template-columns') === 'minmax(0, 1fr)'),
    ).toBe(true)
    expect(top).not.toMatch(/grid-template-columns:\s*var\(--sidebar-w\)/)
    // the fold mechanism is gone entirely
    expect(css).not.toMatch(/sidebar-collapsed/)
    // the scrim is a mobile-only layer: display:none at the top level, the
    // only rule showing it lives inside the 899px block
    expect(rulesFor('.scrim', top).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    const mobile = blockAfter(/@media\s*\(max-width:\s*899px\)/)!
    expect(rulesFor('.drawer-open .scrim', mobile).some((r) => decl(r.body, 'display') === 'block')).toBe(true)
    expect(rulesFor('.drawer-open .scrim', top)).toHaveLength(0)
    // reduced motion disables the slide
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)!
    expect(rulesFor('.sidebar', rm).some((r) => decl(r.body, 'transition') === 'none')).toBe(true)
  })
})

describe('shell: menu button at every width (real-device review)', () => {
  it('[covers:web-shell.menu-btn-always-visible] .menu-btn はどの幅でも非表示にされず、desktop も同じ slide overlay の開閉に使う', () => {
    // the old desktop hiding (top-level .menu-btn { display: none }) is
    // gone: the button stays visible at every width so it can toggle the
    // sidebar overlay at 900px+ too
    const top = rules(topLevel())
    const menuRules = top.filter((r) => r.selectors.includes('.menu-btn'))
    expect(menuRules.length, 'top-level .menu-btn rules').toBeGreaterThan(0)
    for (const r of menuRules) {
      expect(decl(r.body, 'display'), 'top-level .menu-btn display').toBeUndefined()
    }
    // below 900px the button is a 44x44 tap target
    const mobile = blockAfter(/@media\s*\(max-width:\s*899px\)/)
    expect(mobile).toBeDefined()
    expect(
      rulesFor('.menu-btn', mobile!).some(
        (r) => decl(r.body, 'width') === '44px' && decl(r.body, 'height') === '44px',
      ),
    ).toBe(true)
  })
})

describe('topbar logo switch (520px)', () => {
  it('[covers:web-shell.topbar-logo-responsive] 520px メディアクエリで full を隠し compact を出す。360px 以下では compact の語（kb）も隠しマークのみ', () => {
    const narrow = blockAfter(/@media\s*\(max-width:\s*520px\)/)
    expect(narrow).toBeDefined()
    expect(rulesFor('.topbar-logo-full', narrow!).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    expect(
      rulesFor('.topbar-logo-compact', narrow!).some((r) => {
        const d = decl(r.body, 'display')
        return d !== undefined && d !== 'none'
      }),
    ).toBe(true)
    // through 360px the band budget counts the mark alone (§11-4): with the
    // three filter chips the "kb" word overflows the topbar by 9px
    const n360 = blockAfter(/@media\s*\(max-width:\s*360px\)/)
    expect(n360, 'max-width: 360px block').toBeDefined()
    expect(
      rulesFor('.topbar-logo-compact .logo-word', n360!).some((r) => decl(r.body, 'display') === 'none'),
    ).toBe(true)
  })
})

describe('motion: page transition, message fade, skeleton (TASK-39)', () => {
  it('[covers:web-shell.page-transition] .page-* は opacity + 軽い translateY の 0.2s、reduced-motion で無効化、.msg は fade-in', () => {
    // the page transition: fade with a slight drift, 200ms class
    expect(
      rulesFor('.page-enter-active').some(
        (r) => decl(r.body, 'transition') === 'opacity 0.2s ease, transform 0.2s ease',
      ),
    ).toBe(true)
    expect(
      rulesFor('.page-enter-from').some(
        (r) => decl(r.body, 'opacity') === '0' && decl(r.body, 'transform') === 'translateY(8px)',
      ),
    ).toBe(true)
    expect(rulesFor('.page-leave-to').some((r) => decl(r.body, 'opacity') === '0')).toBe(true)
    // reduced motion turns it off entirely (instant swap, no drift)
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(rm).toBeDefined()
    expect(rulesFor('.page-enter-active', rm!).some((r) => decl(r.body, 'transition-duration') === '0s')).toBe(true)
    expect(rulesFor('.page-enter-from', rm!).some((r) => decl(r.body, 'transform') === 'none')).toBe(true)
    expect(rulesFor('.page-leave-to', rm!).some((r) => decl(r.body, 'transform') === 'none')).toBe(true)
    // messages (errors / notices / copy confirmations) fade in on insert
    expect(rulesFor('.msg').some((r) => decl(r.body, 'animation') === 'bb-fade-in 0.16s ease')).toBe(true)
    expect(rulesFor('.msg', rm!).some((r) => decl(r.body, 'animation') === 'none')).toBe(true)
  })

  it('[covers:web-shell.loading-skeleton] .skeleton は単色 block（shimmer 定義なし）・.sr-only があり reduced-motion で静止', () => {
    expect(css).toMatch(/@keyframes bb-fade-in/)
    expect(rulesFor('.skeleton .sk').some((r) => decl(r.body, 'background') === 'var(--bb-surface-2)')).toBe(true)
    // single flat color: no shimmer keyframes / gradient animation
    expect(css).not.toMatch(/shimmer/)
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)!
    expect(rulesFor('.skeleton .sk', rm).some((r) => decl(r.body, 'animation') === 'none')).toBe(true)
    // the loading state stays readable for screen readers
    expect(rulesFor('.sr-only').some((r) => decl(r.body, 'position') === 'absolute' && decl(r.body, 'width') === '1px')).toBe(true)
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

  it('[covers:web-shell.ledger-color-band] .topbar.ledger-scoped に --ledger-current の下端色帯、色帯・チップは遷移的に変わる', () => {
    const band = rulesFor('.topbar.ledger-scoped').map((r) => decl(r.body, 'box-shadow') ?? '')
    expect(band.some((v) => /inset 0 -3px 0 var\(--ledger-current\)/.test(v))).toBe(true)
    // the band and the switcher chip cross-fade on a ledger switch (TASK-39)
    // so the color change reads with the dimming main, not ahead of it
    expect(
      rulesFor('.topbar.ledger-scoped').some((r) => decl(r.body, 'transition') === 'box-shadow 0.2s ease'),
    ).toBe(true)
    expect(
      rulesFor('.ledger-chip').some((r) => decl(r.body, 'transition') === 'background-color 0.2s ease'),
    ).toBe(true)
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(rm).toBeDefined()
    expect(rulesFor('.ledger-chip', rm!).some((r) => decl(r.body, 'transition') === 'none')).toBe(true)
  })
})
