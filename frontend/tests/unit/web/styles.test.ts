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
  // TASK-105 (web-layout.grid-children-shrinkable revised): .dash-grid is
  // abolished (ReceiptsPage was its last user) and the selector under test
  // becomes .dash-cols (the one-column base + the 48rem two-column band).
  it('[covers:web-layout.grid-children-shrinkable] .dash-cols 全メディアクエリで minmax(0、.sub-row も minmax(0、.hscroll、overflow-x hidden なし', () => {
    const grids = rulesFor('.dash-cols').filter((r) => decl(r.body, 'grid-template-columns') !== undefined)
    expect(grids.length).toBeGreaterThanOrEqual(2)
    for (const r of grids) {
      const v = decl(r.body, 'grid-template-columns')!
      expect(v).toContain('minmax(0')
      // no bare 1fr outside minmax(...)
      expect(v.replace(/minmax\([^()]*\)/g, '')).not.toMatch(/\b1fr\b/)
    }
    expect(rulesFor('.dash-cols > *').some((r) => decl(r.body, 'min-width') === '0')).toBe(true)
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
  it('[covers:web-browse.topbar-filter-bar] .topbar-filters は flex + margin-left auto、.filter-chip-btn は高さ36px（時期チップ）・pill・surface-2背景・44px タップ領域、選択中は accent 枠', () => {
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
    // TASK-101: the label chip is gone with its .topbar-label-chip rules
    expect(rulesFor('.topbar-label-chip').length, '.topbar-label-chip rules').toBe(0)
  })

  it('[covers:web-browse.topbar-filter-bar] .filter-chip-search は 44px 正方・padding 0 のアイコン入口で、検索語の .chip-label-q は max-width + ellipsis に収まる', () => {
    // TASK-41: the third chip is the icon-only search entry — 44px wide with
    // no padding; TASK-60 §9-2 (a) lifts the height to 44px too (the label
    // chip's square, off the shared 36px pill the period chip keeps); with a
    // q running the term rides .chip-label-q, clamped so a long term cannot
    // push the topbar wide
    const chip = rulesFor('.filter-chip-search')
    expect(chip.length, '.filter-chip-search rules').toBeGreaterThan(0)
    expect(chip.some((r) => decl(r.body, 'width') === '44px')).toBe(true)
    expect(chip.some((r) => decl(r.body, 'min-width') === '44px')).toBe(true)
    expect(chip.some((r) => decl(r.body, 'height') === '44px')).toBe(true)
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
  it('[covers:web-receipts.kpi-parity] KPI カードは padding 12px の2行（1行目 .kpi-head の flex 行・金額 1.5rem / 2行目 .kpi-sub は1行 ellipsis で3列 grid・dt・dd は無い）', () => {
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

  it('720px 以下は gap 0.75rem・カード padding 12px・zone の詰まった余白・推移 .bars 96px（ドーナツは廃止）', () => {
    const n720 = blockAfter(/@media\s*\(max-width:\s*720px\)/)
    expect(n720, 'max-width: 720px block').toBeDefined()
    // TASK-105: the dashboards' gap moved onto .dash-cols itself (one column
    // below 48rem by default — the 720px fold no longer redefines a grid)
    expect(rulesFor('.dash-cols').some((r) => decl(r.body, 'gap') === '0.75rem')).toBe(true)
    expect(rulesFor('.card', n720!).some((r) => decl(r.body, 'padding') === '12px')).toBe(true)
    expect(rulesFor('.bars', n720!).some((r) => decl(r.body, 'height') === '96px')).toBe(true)
    // TASK-89: the reading screens' zone tightens; the donut rules are gone
    expect(rulesFor('.zone', n720!).some((r) => decl(r.body, 'padding') === '0.85rem 1rem')).toBe(true)
    expect(css).not.toMatch(/\.donut\b/)
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
  // TASK-105 (web-layout.ranked-row-single-line revised, design §4-2): the
  // grid gains the leading swatch track (12px minmax(0,1fr) auto auto 12px),
  // the gradient's first stop becomes var(--rank-color, var(--bb-accent))
  // （未設定行は accent へフォールバック）and the .ranked-swatch rule
  // appears — the "dashboard visual (TASK-105)" block at the bottom of this
  // file carries the swatch rule and the fallback as their own checks.
  it('[covers:web-layout.ranked-row-single-line] .ranked-row は行頭12px swatch列の5列1行44px（dot・diff 列なし）・下端2pxの系列色 linear-gradient（accentフォールバック付き）・.meter 規則は無い', () => {
    const rows = rulesFor('.ranked-row')
    expect(rows.length, '.ranked-row rules').toBeGreaterThan(0)
    expect(
      rows.some(
        (r) =>
          decl(r.body, 'grid-template-columns') === '12px minmax(0, 1fr) auto auto 12px' &&
          decl(r.body, 'gap') === '8px' &&
          decl(r.body, 'min-height') === '44px',
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
    // the compare/diff column is gone with TASK-93 (no .ranked-diff rule at
    // all); the standalone meter element is gone from the ranked list too
    expect(rulesFor('.ranked-diff')).toHaveLength(0)
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

    // CSS: the sidebar overlay (every width, TASK-33) and the scrim (every
    // width since TASK-89) start at the topbar's bottom edge
    expect(rulesFor('.sidebar', css).map((r) => decl(r.body, 'top'))).toContain('var(--topbar-h)')
    expect(rulesFor('.scrim', css).map((r) => decl(r.body, 'top'))).toContain('var(--topbar-h)')
    // and the topbar stacks above both
    const zOf = (sel: string, text: string) =>
      rulesFor(sel, text)
        .map((r) => Number(decl(r.body, 'z-index')))
        .filter((n) => !Number.isNaN(n))
    const topZ = zOf('.topbar', css)
    const sideZ = zOf('.sidebar', css)
    const scrimZ = zOf('.scrim', css)
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
    // TASK-89: the scrim shows at every width (the desktop overlay closes
    // on an outside tap too) — display:none at rest, block under .drawer-open
    // at the top level, no 899px-only rule
    expect(rulesFor('.scrim', top).some((r) => decl(r.body, 'display') === 'none')).toBe(true)
    expect(rulesFor('.drawer-open .scrim', top).some((r) => decl(r.body, 'display') === 'block')).toBe(true)
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

describe('receipts filter popover (TASK-76 §6-3)', () => {
  it('[covers:web-receipts.filter-popover] .filters は dialog 内1列（旧3列 grid・720px 1列化は削除）・左端トリガの dialog は左寄せ', () => {
    // the form lives inside the toolbar button's PopoverPanel now: one
    // column of fields at every width (the three-across card grid and its
    // 720px fold are gone), with a floor so the anchored dialog keeps a
    // usable width off its shrink-to-fit host
    expect(
      rulesFor('.filters').some(
        (r) => decl(r.body, 'grid-template-columns') === '1fr' && decl(r.body, 'min-width') === '16rem',
      ),
    ).toBe(true)
    expect(css).not.toMatch(/\.filters[^{]*\{[^}]*repeat\(3/)
    const n720 = blockAfter(/@media\s*\(max-width:\s*720px\)/)
    expect(n720, 'max-width: 720px block').toBeDefined()
    expect(n720!).not.toMatch(/\.filters/)
    // the anchored 絞り込み dialog hangs left-aligned off the row's left-end
    // trigger (the shared right:0 serves the right-end menus); :not(.is-narrow)
    // keeps the rule off the 480px bottom sheet, whose full-width right:0 the
    // same-specificity right:auto would otherwise clobber (TASK-60 real-browser
    // catch)
    expect(
      rulesFor('.filters-popover .popover-dialog:not(.is-narrow)').some(
        (r) => decl(r.body, 'left') === '0' && decl(r.body, 'right') === 'auto',
      ),
    ).toBe(true)
  })
})

describe('icon-only action buttons (TASK-47)', () => {
  it('[covers:web-settings.passkey-icon-actions][covers:web-settings.issue-url-icons][covers:web-manage.editor-icon-actions] .ibtn は44px正方・variant・disabled の規則を持つ', () => {
    const base = rulesFor('.ibtn')
    expect(base.length).toBeGreaterThan(0)
    expect(base.some((r) => decl(r.body, 'width') === '44px' && decl(r.body, 'height') === '44px')).toBe(true)
    expect(base.some((r) => decl(r.body, 'padding') === '0')).toBe(true)
    // the variants: primary paints the accent, danger colors the glyph
    expect(
      rulesFor('.ibtn.primary').some(
        (r) => decl(r.body, 'background') === 'var(--bb-accent)' && decl(r.body, 'color') === 'var(--bb-accent-fg)',
      ),
    ).toBe(true)
    expect(rulesFor('.ibtn.danger').some((r) => decl(r.body, 'color') === 'var(--bb-danger)')).toBe(true)
    expect(rulesFor('.ibtn:disabled').some((r) => (decl(r.body, 'opacity') ?? '') !== '')).toBe(true)
  })
})

describe('topbar title position (TASK-69)', () => {
  it('[covers:web-shell.topbar-title-position] .topbar-title は中央寄せで ellipsis 系は不変', () => {
    const title = rulesFor('.topbar-title')
    expect(title.some((r) => decl(r.body, 'justify-content') === 'center')).toBe(true)
    // the flex growth and the ellipsis machinery stay as they were
    expect(title.some((r) => decl(r.body, 'flex') === '1 1 auto' && decl(r.body, 'min-width') === '0')).toBe(true)
    const text = rulesFor('.topbar-title-text')
    expect(text.some((r) => decl(r.body, 'white-space') === 'nowrap' && decl(r.body, 'text-overflow') === 'ellipsis')).toBe(true)
  })
})

describe('label picker chip motion (TASK-51)', () => {
  it('[covers:web-labels.picker-chip-motion] .label-picker 配下の label-anim は幅・不透明度・縮尺の遷移で 0 へ縮み、scope 外・reduced-motion では無効', () => {
    const enterActive = rulesFor('.label-picker .label-anim-enter-active')
    expect(enterActive.length).toBeGreaterThan(0)
    expect(
      enterActive.some((r) => {
        const t = decl(r.body, 'transition') ?? ''
        const durs = (t.match(/[\d.]+s/g) ?? []).map((d) => parseFloat(d))
        return /max-width/.test(t) && /opacity/.test(t) && /transform/.test(t) && durs.length > 0 && Math.min(...durs) >= 0.15
      }),
    ).toBe(true)
    expect(enterActive.some((r) => decl(r.body, 'overflow') === 'hidden')).toBe(true)
    const from = rulesFor('.label-picker .label-anim-enter-from')
    expect(
      from.some(
        (r) =>
          decl(r.body, 'max-width') === '0' &&
          decl(r.body, 'opacity') === '0' &&
          (decl(r.body, 'min-width') ?? '') === '0' &&
          /^0/.test(decl(r.body, 'padding-left') ?? 'x') &&
          /-/.test(decl(r.body, 'margin-left') ?? ''),
      ),
    ).toBe(true)
    expect(from.some((r) => /scale/.test(decl(r.body, 'transform') ?? ''))).toBe(true)
    const leaveTo = rulesFor('.label-picker .label-anim-leave-to')
    expect(leaveTo.some((r) => decl(r.body, 'max-width') === '0' && decl(r.body, 'opacity') === '0')).toBe(true)
    expect(rulesFor('.label-picker .label-anim-move').some((r) => (decl(r.body, 'transition') ?? '') !== '')).toBe(true)
    // scoped: the animation classes carry no styles outside .label-picker
    expect(rulesFor('.label-anim-enter-active').length).toBe(0)
    // reduced motion turns the row motion off entirely
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(rm, 'reduced-motion block').toBeDefined()
    expect(rm!).toMatch(/\.label-picker \.label-anim/)
  })
})

describe('copy feedback motion (TASK-48)', () => {
  it('[covers:web-usage.copy-motion] .copy-btn.is-done は check icon に pop animation・reduced-motion で無効・box 内 text 行の規則は廃止', () => {
    expect(rulesFor('.copy-btn.is-done').some((r) => decl(r.body, 'color') === 'var(--bb-accent)')).toBe(true)
    expect(rulesFor('.copy-btn.is-done .icon').length).toBeGreaterThan(0)
    expect(rulesFor('.copy-btn.is-done .icon').some((r) => /bb-copy-pop/.test(decl(r.body, 'animation') ?? ''))).toBe(true)
    expect(css).toMatch(/@keyframes bb-copy-pop/)
    // the keyframes animate scale + opacity (a pop, not a plain fade)
    const kf = blockAfter(/@keyframes bb-copy-pop/)
    expect(kf, 'bb-copy-pop keyframes').toBeDefined()
    expect(kf!).toMatch(/scale\(/)
    // the old visible done-line inside the URL box is gone
    expect(css).not.toMatch(/\.usage-copy-done/)
    // reduced motion keeps the swap but not the animation
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)
    expect(rm, 'reduced-motion block').toBeDefined()
    expect(rm!).toMatch(/copy-btn/)
  })
})

describe('sidebar settings nav (TASK-56)', () => {
  it('[covers:web-shell.sidebar-settings-nav] .side-nav-secondary は主 nav の下の区切り付き group', () => {
    const sec = rulesFor('.side-nav-secondary')
    expect(sec.length).toBeGreaterThan(0)
    expect(sec.some((r) => decl(r.body, 'border-top') !== undefined && decl(r.body, 'padding-top') !== undefined)).toBe(
      true,
    )
  })
})

// --- TASK-105 dashboard visual (design: tmp/tasks/tm-105/
// design_dashboard-visual.md §3 / §5): the series palette tokens, the
// .dash-cols two-column zone layout, the .zone--list width tier and the
// ranked-row swatch. Written test-first against the not-yet-implemented
// stylesheet (kept skipped until the implementation landed; live now). ---

describe('dashboard visual (TASK-105 §3/§5, post-implementation static checks)', () => {
  it('[covers:web-common.zone-layout] .dash-cols は1fr 1列（外）+ 48rem media 内 minmax(0,1.2fr) minmax(0,24rem) の2列・子は min-width 0・.dash-grid 規則は廃止', () => {
    const top = topLevel()
    expect(rulesFor('.dash-cols', top).some((r) => decl(r.body, 'display') === 'grid' && decl(r.body, 'grid-template-columns') === 'minmax(0, 1fr)')).toBe(true)
    expect(rulesFor('.dash-cols > *', top).some((r) => decl(r.body, 'min-width') === '0')).toBe(true)
    const w48 = blockAfter(/@media\s*\(min-width:\s*48rem\)/)
    expect(w48, 'min-width: 48rem block').toBeDefined()
    expect(
      rulesFor('.dash-cols', w48!).some(
        (r) => decl(r.body, 'grid-template-columns') === 'minmax(0, 1.2fr) minmax(0, 24rem)' && decl(r.body, 'align-items') === 'start',
      ),
    ).toBe(true)
    // the old .dash-grid is gone entirely (base rules and the 720px fold)
    expect(rulesFor('.dash-grid').length).toBe(0)
    expect(css).not.toMatch(/\.dash-grid/)
  })

  it('[covers:web-common.zone-layout] list系zone は .zone--list の max-width 38rem・chart系zone（trend 等）は全幅のまま', () => {
    expect(rulesFor('.zone--list').some((r) => decl(r.body, 'max-width') === '38rem')).toBe(true)
  })

  it('[covers:web-common.series-color-assignment] 系列token --series-1..7・--series-rest は light/dark 両定義・旧 --c1..5・--c-rest は全参照置換後に廃止', () => {
    const light = rulesFor(':root', topLevel())
      .map((r) => r.body)
      .join('\n')
    const darkMedia = blockAfter(/@media\s*\(prefers-color-scheme:\s*dark\)/)
    expect(darkMedia, 'prefers-color-scheme: dark block').toBeDefined()
    const dark = rules(darkMedia!)
      .filter((r) => r.selectors.some((s) => s.startsWith(':root')))
      .map((r) => r.body)
      .join('\n')
    for (let i = 1; i <= 7; i++) {
      expect(light, `light --series-${i}`).toMatch(new RegExp(`--series-${i}\\s*:`))
      expect(dark, `dark --series-${i}`).toMatch(new RegExp(`--series-${i}\\s*:`))
    }
    for (const mode of [light, dark]) {
      expect(mode, '--series-rest').toMatch(/--series-rest\s*:/)
    }
    // the old PALETTE tokens are gone with every reference (trendWindow's
    // PALETTE array included)
    expect(css).not.toMatch(/--c[1-5]\b/)
    expect(css).not.toMatch(/--c-rest\b/)
  })

  it('[covers:web-layout.ranked-row-single-line] .ranked-row は行頭12px swatch列の5列 grid・.ranked-swatch は丸で var(--rank-color)・行barのgradientは --rank-color フォールバック付き', () => {
    const rows = rulesFor('.ranked-row')
    expect(
      rows.some(
        (r) =>
          decl(r.body, 'grid-template-columns') === '12px minmax(0, 1fr) auto auto 12px' &&
          decl(r.body, 'gap') === '8px' &&
          decl(r.body, 'min-height') === '44px',
      ),
    ).toBe(true)
    const sw = rulesFor('.ranked-swatch')
    expect(sw.length, '.ranked-swatch rules').toBeGreaterThan(0)
    expect(sw.some((r) => decl(r.body, 'border-radius') === '50%' && /var\(--rank-color\)/.test(decl(r.body, 'background') ?? ''))).toBe(true)
    // the share-bar gradient keeps the accent fallback so rows without
    // --rank-color (WeekRows) never lose their bar
    expect(
      rows.some((r) =>
        /var\(--rank-color,\s*var\(--bb-accent\)\)/.test(decl(r.body, 'background-image') ?? ''),
      ),
    ).toBe(true)
  })
})
