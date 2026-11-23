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

/**
 * TASK-170: the shared row-grammar / motion stylesheets — the home of the
 * .data-row family, the hover family, the .items item tokens and bb-appear
 * (web/styles.css only imports them). Read lazily INSIDE each test: the
 * files land with the implementation, and a module-level read would fail the
 * whole file's collection before then.
 */
function sharedCss(name: 'row-grammar.css' | 'motion.css'): string {
  return readFileSync(resolve(process.cwd(), `src/shared/styles/${name}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

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
  it('[covers:web-layout.grid-children-shrinkable] .dash-cols 全メディアクエリで minmax(0、.hscroll、overflow-x hidden なし（.sub-row 規則はPR#4レビュー4で dead CSS 削除済み）', () => {
    const grids = rulesFor('.dash-cols').filter((r) => decl(r.body, 'grid-template-columns') !== undefined)
    expect(grids.length).toBeGreaterThanOrEqual(2)
    for (const r of grids) {
      const v = decl(r.body, 'grid-template-columns')!
      expect(v).toContain('minmax(0')
      // no bare 1fr outside minmax(...)
      expect(v.replace(/minmax\([^()]*\)/g, '')).not.toMatch(/\b1fr\b/)
    }
    expect(rulesFor('.dash-cols > *').some((r) => decl(r.body, 'min-width') === '0')).toBe(true)
    // PR#4 review 4: the .sub-rows/.sub-row rules are gone entirely (no
    // template renders them — the dead CSS the shrink check once pinned)
    expect(rulesFor('.sub-row')).toHaveLength(0)
    expect(rulesFor('.sub-rows')).toHaveLength(0)
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

  it('[covers:web-search.layout-real] /search の2行構成（.search-head・.search-tabs）と件数行の規則がある（品目行は .data-row 共通文法）', () => {
    // the layout facts jsdom cannot measure live in verify.spec.ts
    // (web-search.layout-real, 360px two rows / no overflow); the stylesheet
    // side is pinned here: the head row, the tab row and the meta line keep
    // their rules. REVIEW-15 中1: the item tab's rows ride the shared
    // .data-row grammar now — the per-surface .search-item-* composition
    // (its own two-line rules) is gone from the stylesheet
    for (const sel of ['.search-head', '.search-input', '.search-tabs', '.search-meta']) {
      expect(rulesFor(sel).length, sel).toBeGreaterThan(0)
    }
    expect(rulesFor('.search-head').some((r) => decl(r.body, 'display') === 'flex')).toBe(true)
    expect(css).not.toMatch(/\.search-item-(row|main|sub|name|category)/)
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

  it('[covers:web-receipts.dashboard] レシート行は共通2行 .data-row（min-height 52px）で .recent-row の規則は無く、日ごと見出しは 28px', () => {
    // TASK-167 D-1/D-2: the per-surface one-line grid is gone — the receipt
    // rows ride the shared two-line DataRow grammar
    expect(rulesFor('.recent-row')).toHaveLength(0)
    expect(css).not.toMatch(/\.recent-row/)
    // the 34px icon column is gone from the stylesheet entirely
    expect(rulesFor('.recent-icon')).toHaveLength(0)
    expect(css).not.toMatch(/\.recent-icon/)
    // TASK-170: the row grammar's home is the shared sheet (web/styles.css
    // keeps none of it)
    const rowCss = sharedCss('row-grammar.css')
    expect(rulesFor('.data-row', rowCss).some((r) => decl(r.body, 'min-height') === '52px')).toBe(true)
    expect(rulesFor('.data-row', rowCss).some((r) => decl(r.body, 'flex-direction') === 'column')).toBe(true)
    expect(rulesFor('.row-sub', rowCss).some((r) => decl(r.body, 'font-size') === '0.8rem')).toBe(true)
    expect(rulesFor('.day-head').some((r) => decl(r.body, 'min-height') === '28px')).toBe(true)
    // review L5: the labels cell never wraps — overflow clips the dots (or
    // the 削除済み badge row)
    expect(
      rulesFor('.row-labels', rowCss).some(
        (r) => decl(r.body, 'flex-wrap') === 'nowrap' && decl(r.body, 'overflow') === 'hidden',
      ),
    ).toBe(true)
  })
})

describe('ranked row single line (TASK-75 §6-4)', () => {
  // TASK-105 (web-layout.ranked-row-single-line revised, design §4-2): the
  // grid gains the leading swatch track (12px minmax(0,1fr) auto auto 12px)
  // and the .ranked-swatch rule appears. TASK-129 (design §4-2/§3-5 e1): the
  // bottom 2px gradient is GONE — the row's proportional bar is a 6px DOM
  // bar inside an absolutely-positioned bottom track (.ranked-bar-track,
  // spanning the row's full width including the paddings the old
  // background-origin: border-box used to cover). The bar grammar rules
  // (.row-bar/.row-seg) live in the TASK-129 block below.
  it('[covers:web-layout.ranked-row-single-line] .ranked-row はgrid規則無し・relative・下端bar分の padding-bottom・.week-row は旧5列gridを保持・行washのhoverは a.data-row.is-link', () => {
    const rows = rulesFor('.ranked-row')
    expect(rows.length, '.ranked-row rules').toBeGreaterThan(0)
    // TASK-167 D-1: the row rides the shared DataRow grammar — no grid on
    // the row itself anymore
    for (const r of rows) {
      expect(decl(r.body, 'grid-template-columns'), 'no ranked-row grid').toBeUndefined()
    }
    // TASK-129: the absolute track needs the row as its containing block;
    // TASK-167: the padding keeps the text and the bottom bar apart
    expect(rows.some((r) => decl(r.body, 'position') === 'relative')).toBe(true)
    expect(rows.some((r) => decl(r.body, 'padding-bottom') === 'calc(var(--row-bar-h) + 4px)')).toBe(true)
    // the week row keeps its own grid (its two-line composition predates the
    // shared grammar)
    expect(
      rulesFor('.week-row').some(
        (r) =>
          decl(r.body, 'grid-template-columns') === '12px minmax(0, 1fr) auto auto 12px' &&
          decl(r.body, 'gap') === '8px' &&
          decl(r.body, 'min-height') === '44px',
      ),
    ).toBe(true)
    // the gradient era is fully gone: no background-image on the row, no
    // --rank-fill token anywhere (the bar is a DOM element now)
    for (const r of rows) {
      expect(decl(r.body, 'background-image'), 'no ranked-row gradient').toBeUndefined()
      expect(r.body, '.ranked-row must not reference --rank-fill').not.toContain('--rank-fill')
    }
    expect(css).not.toMatch(/--rank-fill/)
    // the absolutely-positioned bottom track (full row width incl. padding);
    // TASK-161 §7: the thickness reads --row-bar-h (the 6px literal is gone)
    const track = rulesFor('.ranked-bar-track')
    expect(track.length, '.ranked-bar-track rules').toBeGreaterThan(0)
    expect(
      track.some(
        (r) =>
          decl(r.body, 'position') === 'absolute' &&
          decl(r.body, 'bottom') === '0' &&
          decl(r.body, 'left') === '0' &&
          decl(r.body, 'right') === '0' &&
          decl(r.body, 'height') === 'var(--row-bar-h)',
      ),
    ).toBe(true)
    // the compare/diff column is gone with TASK-93 (no .ranked-diff rule at
    // all); the standalone meter element is gone from the ranked list too
    expect(rulesFor('.ranked-diff')).toHaveLength(0)
    expect(css).not.toMatch(/\.meter/)
    // TASK-167 D-4: the row wash lives on the shared link rows only — the
    // ranked row itself has no :hover rule anymore. TASK-170: the wash rule's
    // home is the shared row-grammar sheet (web/styles.css imports it)
    const sharedRow = sharedCss('row-grammar.css')
    for (const r of rulesFor('a.data-row.is-link:hover', sharedRow)) {
      expect(decl(r.body, 'background'), 'hover background shorthand').toBeUndefined()
    }
    expect(rulesFor('a.data-row.is-link:hover', sharedRow).some((r) => decl(r.body, 'background-color') === 'var(--bb-hover)')).toBe(true)
    expect(`${css}\n${sharedRow}`).not.toMatch(/\.ranked-row[^{]*:hover/)
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
    // on an outside tap too); TASK-146 §3 #17 turned the display flip into
    // an opacity fade — transparent + hit-through at rest, visible under
    // .drawer-open at the top level, no 899px-only rule
    expect(rulesFor('.scrim', top).some((r) => decl(r.body, 'opacity') === '0')).toBe(true)
    expect(rulesFor('.scrim', top).some((r) => /^opacity/.test(decl(r.body, 'transition') ?? 'x'))).toBe(true)
    expect(rulesFor('.drawer-open .scrim', top).some((r) => decl(r.body, 'opacity') === '1')).toBe(true)
    // the always-mounted scrim must stay inert at rest (and only react to
    // pointer events while the drawer is open)
    expect(rulesFor('.scrim', top).some((r) => decl(r.body, 'pointer-events') === 'none')).toBe(true)
    expect(rulesFor('.drawer-open .scrim', top).some((r) => decl(r.body, 'pointer-events') === 'auto')).toBe(true)
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
    // the whole skeleton stays invisible for the first 250ms of a load
    // (a fast load never shows it — cards included, not just the blocks),
    // then fades in; the blocks pulse while the load runs
    expect(css).toMatch(/@keyframes bb-sk-pulse/)
    expect(rulesFor('.skeleton').some((r) => (decl(r.body, 'animation') ?? '').includes('0.25s'))).toBe(true)
    expect(rulesFor('.skeleton').some((r) => (decl(r.body, 'animation') ?? '').includes('backwards'))).toBe(true)
    expect(rulesFor('.skeleton .sk').some((r) => (decl(r.body, 'animation') ?? '').includes('bb-sk-pulse'))).toBe(true)
    // the skeleton <-> content handover cross-fades (no blank, no cut)
    expect(rulesFor('.handover-leave-active').some((r) => decl(r.body, 'position') === 'absolute')).toBe(true)
    expect(rulesFor('.handover-enter-active').some((r) => (decl(r.body, 'transition') ?? '').includes('opacity'))).toBe(true)
    expect(rulesFor('.handover-leave-to').some((r) => decl(r.body, 'opacity') === '0')).toBe(true)
    const rm = blockAfter(/@media\s*\(prefers-reduced-motion:\s*reduce\)/)!
    expect(rulesFor('.skeleton .sk', rm).some((r) => decl(r.body, 'animation') === 'none')).toBe(true)
    // reduced motion: no delay, no pulse — static and visible at once
    expect(rulesFor('.skeleton', rm).some((r) => decl(r.body, 'opacity') === '1')).toBe(true)
    expect(rulesFor('.skeleton .sk', rm).some((r) => decl(r.body, 'opacity') === '1')).toBe(true)
    expect(rulesFor('.handover-enter-active', rm).some((r) => decl(r.body, 'transition') === 'none')).toBe(true)
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

  it('[covers:web-layout.ranked-row-single-line] .ranked-swatch は丸で var(--rank-color)', () => {
    const sw = rulesFor('.ranked-swatch')
    expect(sw.length, '.ranked-swatch rules').toBeGreaterThan(0)
    expect(sw.some((r) => decl(r.body, 'border-radius') === '50%' && /var\(--rank-color\)/.test(decl(r.body, 'background') ?? ''))).toBe(true)
    // TASK-129: the share-bar gradient (and its accent fallback) is gone —
    // the row's bar is a DOM .row-seg whose background comes from the
    // component's --rank-color; the swatch rule above is the CSS-side
    // consumer of the same token. No surface-scoped bar grammar overrides
    // exist (the .row-bar/.row-seg rules are shared, checked below)
    expect(rulesFor('.ranked-row .row-bar')).toHaveLength(0)
    expect(rulesFor('.week-row .row-bar')).toHaveLength(0)
  })
})

// --- TASK-123 stacked-breakdown visual (design: tmp/tasks/tm-123/
// design_breakdown-visual.md v5 §4-2/§4-3/§4-4/§4-7): the palette values,
// the --seg-outline token and the full-perimeter segment border, the corner
// rules (no mid-stack rounding, top-only cap radius) and the week row's DOM
// stacked bar. Written test-first against the not-yet-revised stylesheet. ---

describe('stacked breakdown visual (TASK-123, static checks)', () => {
  /** The joined declaration bodies of :root (light) and the dark override. */
  const rootBodies = () => {
    const light = rulesFor(':root', topLevel())
      .map((r) => r.body)
      .join('\n')
    const darkMedia = blockAfter(/@media\s*\(prefers-color-scheme:\s*dark\)/)
    const dark = rules(darkMedia ?? '')
      .filter((r) => r.selectors.some((s) => s.startsWith(':root')))
      .map((r) => r.body)
      .join('\n')
    return { light, dark }
  }
  /** A custom-property value out of a declaration body (lowercased). */
  const token = (body: string, name: string): string | undefined =>
    body
      .match(new RegExp(`${name}\\s*:\\s*([^;]+)`, 'm'))?.[1]
      ?.trim()
      .toLowerCase()

  // §4-2's validated candidate values — the permanent pin of the swapped
  // palette (seriesColor only returns variable refs; these are the values
  // the variables must resolve to, light and dark, web side)
  it('[covers:web-common.series-palette-values] :root の --series-1..7 実値は TASK-123 §4-2 候補値（light/dark・rest は従来値のまま）', () => {
    const { light, dark } = rootBodies()
    expect(light, 'light :root block').not.toBe('')
    expect(dark, 'dark :root block').not.toBe('')
    for (const [slot, [lightHex, darkHex]] of [
      ['#803a0d', '#934149'], // series-1
      ['#c4b45d', '#c6824c'], // series-2
      ['#506204', '#7c6c01'], // series-3
      ['#44bead', '#279a7a'], // series-4
      ['#0a6390', '#2f9ce1'], // series-5
      ['#a591fd', '#5d64aa'], // series-6
      ['#a02d5c', '#b57cb9'], // series-7
    ].entries()) {
      expect(token(light, `--series-${slot + 1}`), `light --series-${slot + 1}`).toBe(lightHex)
      expect(token(dark, `--series-${slot + 1}`), `dark --series-${slot + 1}`).toBe(darkHex)
    }
    // the residual keeps the current rest tone (the retiring grey, §4-2)
    expect(token(light, '--series-rest')).toBe('#8f9a94')
    expect(token(dark, '--series-rest')).toBe('#5f6b65')
  })

  it('[covers:web-common.stack-segment-outline] --seg-outline（light 黒40% / dark 白40%）と .bar-seg/.daily-seg/.row-seg の全周 1px border・旧 border-top 境界線と min-height は廃止', () => {
    const { light, dark } = rootBodies()
    // §4-4 o3: the outline token is the half-transparent ink, one token for
    // every fill (the compose darkens light fills / lightens dark fills)
    expect(token(light, '--seg-outline')).toBe('rgb(0 0 0 / 0.4)')
    expect(token(dark, '--seg-outline')).toBe('rgb(255 255 255 / 0.4)')
    // every stack site's segments carry the full-perimeter 1px outline.
    // TASK-129: the week row's .week-seg became the shared .row-seg (the
    // ranked rows ride the same rule — one grammar, no per-site forks)
    for (const sel of ['.bar-seg', '.daily-seg', '.row-seg']) {
      expect(
        rulesFor(sel).some((r) => decl(r.body, 'border') === '1px solid var(--seg-outline)'),
        `${sel} border rule`,
      ).toBe(true)
    }
    // the old separation means are gone: the 1px surface border-top between
    // neighbors (web) and the min-height floors (the §4-5 allocation feeds
    // explicit sizes instead — rule E)
    expect(rulesFor('.bar-seg + .bar-seg')).toHaveLength(0)
    expect(rulesFor('.daily-seg + .daily-seg')).toHaveLength(0)
    for (const sel of ['.bar-seg', '.daily-seg']) {
      expect(rulesFor(sel).some((r) => decl(r.body, 'min-height') !== undefined), `${sel} min-height`).toBe(false)
    }
  })

  it('[covers:web-common.stack-corner-rules] .bar-seg:first-child の中段角丸規則は廃止・.bar-stack/.daily-bar は角もclipも持たず（角は最上段セグメントのJS計算cap radiusのみ）', () => {
    // §2-1's main culprit: the :first-child radius rounded the VISUAL
    // bottom segment's top corners (column-reverse), rounding mid-stack
    expect(rulesFor('.bar-seg:first-child')).toHaveLength(0)
    expect(css).not.toMatch(/\.bar-seg:first-child/)
    // §4-3 (REVIEW-5 medium-2): the container carries NO radius and no
    // clip — a static 2px container radius + overflow:hidden owned the
    // painted outline below 8px widths (a 4px bar pinned back to the
    // full-semicircle pill, defeating the JS cap), so the corner lives
    // ONLY on the top segment's inline cap radius (min(2px, width/4)),
    // whose border follows it. Rule D already removed the clip role (the
    // allocation always fits), so no rule may set either property
    for (const sel of ['.bar-stack', '.daily-bar']) {
      const rs = rulesFor(sel)
      expect(rs.length, `${sel} rules`).toBeGreaterThan(0)
      for (const r of rs) {
        expect(decl(r.body, 'border-radius') ?? '', `${sel} must not set border-radius`).toBe('')
        expect(decl(r.body, 'overflow') ?? '', `${sel} must not set overflow`).toBe('')
      }
    }
  })

  it('[covers:web-home.week-row-stack-bar] 週行は gradient を持たず bar は共通 .row-bar（flex row・高さは--row-bar-h）+ .row-seg（旧 .week-bar/.week-seg 規則は廃止）', () => {
    // §4-7 + TASK-129: no rule may paint .week-row with a gradient (the
    // composition lives in the shared .row-bar's segment elements)
    for (const r of rulesFor('.week-row')) {
      expect(r.body, `.week-row rule must not paint a gradient: ${r.selectors.join(',')}`).not.toMatch(/linear-gradient/)
    }
    expect(rulesFor('.week-row').some((r) => decl(r.body, 'background-image') !== undefined)).toBe(false)
    // the ranked row is gradient-free too now (TASK-129): see the
    // ranked-row block above — this block owns the shared bar grammar
    // the DOM bar: a flex row of segments at the ONE shared thickness —
    // TASK-161 §7: the height reads the --row-bar-h variable (12px), never a
    // per-surface literal
    const bar = rulesFor('.row-bar')
    expect(bar.length, '.row-bar rules').toBeGreaterThan(0)
    expect(bar.some((r) => decl(r.body, 'display') === 'flex')).toBe(true)
    expect(bar.some((r) => decl(r.body, 'height') === 'var(--row-bar-h)')).toBe(true)
    // the segments: full height, the shared outline, and the data-end cap
    const seg = rulesFor('.row-seg')
    expect(seg.length, '.row-seg rules').toBeGreaterThan(0)
    expect(seg.some((r) => decl(r.body, 'height') === '100%')).toBe(true)
    expect(seg.some((r) => decl(r.body, 'flex') === 'none')).toBe(true)
    // the old week-scoped classes are gone (extracted into the component)
    expect(rulesFor('.week-bar')).toHaveLength(0)
    expect(rulesFor('.week-seg')).toHaveLength(0)
    expect(rulesFor('.week-seg:last-child')).toHaveLength(0)
    // the week row keeps its own full-width track (the grid-row variant —
    // the ranked row's absolute track is checked in the ranked-row block)
    const track = rulesFor('.week-bar-track')
    expect(track.length, '.week-bar-track rules').toBeGreaterThan(0)
    expect(track.some((r) => decl(r.body, 'grid-column') === '1 / -1')).toBe(true)
    expect(track.some((r) => decl(r.body, 'height') === 'var(--row-bar-h)')).toBe(true)
  })
})

// --- TASK-129 (design: tmp/tasks/tm-129/design_ranked-row-bar.md v3 §4-2/
// §4-3): the row bars (ranked rows + week rows) ride ONE shared DOM bar
// component — .row-bar/.row-seg defined once, the data-end cap on
// :last-child, no per-surface grammar forks. Written test-first against the
// gradient rows and the week-scoped classes. ---

describe('shared row bar component (TASK-129, static checks)', () => {
  it('[covers:web-common.row-bar-component] .row-seg:last-child のデータ端cap（0 2px 2px 0）・bar文法は1組のみで track は行種別（ranked=absolute / week=grid）', () => {
    // the cap: the data end (right) alone rounds — TASK-161 §7: the DOM twin
    // of BarSegs' capR min(2, thickness/4), 2px at the --row-bar-h 12px; the
    // base (left) stays square
    const cap = rulesFor('.row-seg:last-child')
    expect(cap.length, '.row-seg:last-child cap rule').toBeGreaterThan(0)
    expect(cap.some((r) => decl(r.body, 'border-radius') === '0 2px 2px 0')).toBe(true)
    // no mid-bar rounding on the other segments and no other radius rule
    for (const r of rulesFor('.row-seg')) {
      const radius = decl(r.body, 'border-radius')
      if (radius !== undefined) expect(r.selectors.join(','), 'only :last-child rounds').toContain(':last-child')
    }
    // the grammar rules exist exactly once per selector — no surface-scoped
    // forks (.ranked-row .row-seg / .week-row .row-bar etc.)
    for (const scoped of ['.ranked-row .row-bar', '.week-row .row-bar', '.ranked-row .row-seg', '.week-row .row-seg']) {
      expect(rulesFor(scoped), `no surface-scoped bar grammar: ${scoped}`).toHaveLength(0)
    }
  })
})

// --- TASK-130 (design: tmp/tasks/tm-130/design_trend-bar-hover-current.md
// v2 §2-1/§2-2/§5): the bar-color emphasis rules died with the stacked
// expansion (.bar is the zero-bucket fallback only, so .bar-col:hover .bar /
// .bar-col.current .bar lost their subject). The recovered grammar is the
// COLUMN wash — hover paints the column with --bb-hover inside
// @media (hover: hover) only (a touch sticky hover can never clobber the
// current wash), current paints it with --bb-accent-soft at all times (the
// column exists for 0円 buckets too, so the emphasis survives an empty
// month) plus the label foreground emphasis, and the bar itself never
// changes color. Written test-first against the not-yet-revised stylesheet. ---

describe('trend bar column state emphasis (TASK-130, static checks)', () => {
  it('[covers:web-browse.trend-bar-hover-current] 旧2規則（棒色変更）と .bar の transition は廃止・.bar-col は radius 6px + background-color 0.15s・hover wash（--bb-hover）は @media (hover: hover) 内のみで current 規則より後置・current wash（--bb-accent-soft）+ .bar-val 前景強調（600/var(--bb-fg)）', () => {
    // the dead bar-color grammar is gone for good: the stacked columns are
    // painted by the segments' inline series colors, so no rule may recolor
    // .bar on hover/current — and .bar's orphaned background transition goes
    // with it (its color never changes now)
    expect(rulesFor('.bar-col:hover .bar')).toHaveLength(0)
    expect(rulesFor('.bar-col.current .bar')).toHaveLength(0)
    expect(css).not.toMatch(/\.bar-col:hover \.bar(?![\w-])/)
    expect(css).not.toMatch(/\.bar-col\.current \.bar(?![\w-])/)
    for (const r of rulesFor('.bar')) {
      expect(decl(r.body, 'transition'), '.bar must not animate its background').toBeUndefined()
    }
    // the column is the wash surface: the focus outline's 6px radius and the
    // row-hover-grade 0.15s background fade, always on .bar-col itself
    const cols = rulesFor('.bar-col')
    expect(cols.some((r) => decl(r.body, 'border-radius') === '6px')).toBe(true)
    expect(cols.some((r) => decl(r.body, 'transition') === 'background-color 0.15s')).toBe(true)
    // hover wash exists ONLY inside the hover-capability guard — no
    // top-level .bar-col:hover rule (touch must not keep a sticky wash over
    // the current column)
    const hoverMedia = blockAfter(/@media\s*\(\s*hover:\s*hover\s*\)/)
    expect(hoverMedia, '@media (hover: hover) block').toBeDefined()
    expect(
      rulesFor('.bar-col:hover', hoverMedia!).some((r) => decl(r.body, 'background') === 'var(--bb-hover)'),
    ).toBe(true)
    expect(rulesFor('.bar-col:hover', topLevel())).toHaveLength(0)
    // current: the always-on column wash + the label foreground emphasis
    // (weight like the week row's current, muted→fg for the 0.7rem label)
    expect(rulesFor('.bar-col.current').some((r) => decl(r.body, 'background') === 'var(--bb-accent-soft)')).toBe(true)
    expect(
      rulesFor('.bar-col.current .bar-val').some(
        (r) => decl(r.body, 'font-weight') === '600' && decl(r.body, 'color') === 'var(--bb-fg)',
      ),
    ).toBe(true)
    // .bar-col:hover and .bar-col.current share specificity (0,2,0), so
    // source order decides the overlay: the hover wash sits after the
    // current rule and wins on desktop (PR#4 review 7 grouped .daily-col
    // :hover into the same rule — the [^{]* rides the selector group)
    expect(css.search(/\.bar-col:hover[^{]*\{/)).toBeGreaterThan(css.search(/\.bar-col\.current\s*\{/))
  })
})

// --- PR#4 review (TASK-171): the visual-bar review fixes — the end-flush
// tick value (review 2), the row-seg FLIP move rule (review 3), the
// daily-col hover guard (review 7) and the fill-only ::before (review 8).
// Static checks against styles.css. ---

describe('visual bar review fixes (PR#4, static checks)', () => {
  it('[covers:web-home.breakdown-absolute-ticks][covers:web-common.row-bar-component][covers:web-browse.trend-bar-hover-current][covers:web-common.stack-dimension-rules] 右端tick値はend-flush（track内へ伸長）・.row-seg-move は transform+width の FLIP move・.daily-col:hover は @media (hover: hover) 内のみ・fill-only button の ::before 縁取りなし', () => {
    // review 2: the ratio-1 tick's value grows INTO the track — the tick
    // sits at left:100%, so the value pins its END side instead of running
    // past the track's right edge (the axis-labels end-flush twin)
    const endFlush = rulesFor('.breakdown-tick:last-child .breakdown-tick-val')
    expect(endFlush.length, '.breakdown-tick:last-child end-flush rule').toBeGreaterThan(0)
    expect(endFlush.some((r) => decl(r.body, 'left') === 'auto' && decl(r.body, 'right') === '0')).toBe(true)
    // review 3: the keyed FLIP move — Vue needs the -move class's transform
    // transition to slide a repositioned segment (the width transition does
    // not animate positions); the width ride stays declared so the shorthand
    // does not clobber the .row-seg width transition mid-move
    const move = rulesFor('.row-seg-move')
    expect(move.length, '.row-seg-move rule').toBeGreaterThan(0)
    const moveTransition = move.map((r) => decl(r.body, 'transition')).find((v) => v !== undefined)!
    expect(moveTransition).toContain('transform')
    expect(moveTransition).toContain('width')
    // review 7: the daily column's wash lives ONLY inside the hover
    // capability guard (a media-bare wash sticks after a tap)
    const hoverMedia = blockAfter(/@media\s*\(\s*hover:\s*hover\s*\)/)
    expect(
      rulesFor('.daily-col:hover', hoverMedia!).some((r) => decl(r.body, 'background') === 'var(--bb-hover)'),
    ).toBe(true)
    expect(rulesFor('.daily-col:hover', topLevel())).toHaveLength(0)
    // review 8: rule F's fill-only contract holds on the pressable side —
    // the is-fill button draws no ::before outline (the inline border:none
    // hits the button itself only)
    expect(rulesFor('button.row-seg.is-fill::before').some((r) => decl(r.body, 'border') === 'none')).toBe(true)
  })
})

// --- TASK-146 §3 (design: tmp/tasks/tm-146/design_period_navigation.md §3
// 方針1/方針3・遷移全数表 #12/#15/#17/#18/#20): the transition vocabulary
// gains its missing members — the zone loading fade (the .view-stack.loading
// behavior, zone-scoped), the scrim / dialog-backdrop fades, and the single
// appear-fade grammar (bb-appear) the row additions and the manage screens'
// inline state changes share. Written test-first against the not-yet-revised
// stylesheet. ---

describe('transition vocabulary additions (TASK-146, static checks)', () => {
  it('[covers:web-shell.loading-skeleton] loading の dim は全廃（.view-stack.loading / .zone.is-loading の opacity 規則は存在しない）', () => {
    // a refetch keeps the committed content at full opacity until the
    // commit — no half-transparent in-between state anywhere
    expect(rulesFor('.view-stack.loading')).toHaveLength(0)
    expect(rulesFor('.zone.is-loading')).toHaveLength(0)
    expect(rulesFor('.zone').some((r) => (decl(r.body, 'transition') ?? '').includes('opacity'))).toBe(false)
    expect(rulesFor('.view-stack').some((r) => (decl(r.body, 'transition') ?? '').includes('opacity'))).toBe(false)
  })

  it('[covers:web-common.overlay-transition] scrim と dialog-backdrop は fade（opacity 遷移）で出現・消滅し reduced-motion で無効', () => {
    // #17: the drawer scrim leaves the display toggle's instant appear
    expect(css).toMatch(/\.scrim[^{}]*\{[^}]*transition:\s*opacity/)
    // #16: the modal frames' backdrop fades with the dialog
    expect(css).toMatch(/\.dialog-backdrop[^{}]*\{[^}]*transition:\s*opacity/)
    // the reduced-motion block disables both (the second guard)
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.scrim[^{]*\{[^}]*transition:\s*none/)
    expect(reduced).toMatch(/\.dialog-backdrop[^{]*\{[^}]*transition:\s*none/)
  })

  it('[covers:web-common.appear-fade][covers:web-common.appear-move] 出現/消滅fade語彙は bb-appear 1組（opacity fade・0.15-0.2s・離脱listの FLIP move は同gradeの transform）で reduced-motion で無効', () => {
    // #18/#20: ONE shared grammar class carries the row additions and the
    // manage screens' inline state changes — an opacity fade in the
    // bb-fade-in family, nothing fancier
    // (the reduced-motion block's own `transition: none` rules start with
    // .bb-appear too — they are the second guard below, not the vocabulary)
    // TASK-170 W-9: the vocabulary's home is shared/styles/motion.css (both
    // entry points import it); web/styles.css carries no bb-appear rule
    const motion = sharedCss('motion.css')
    const appear = rules(motion).filter(
      (r) => r.selectors.some((s) => s.startsWith('.bb-appear')) && decl(r.body, 'transition') !== 'none',
    )
    expect(appear.length, 'the bb-appear grammar exists').toBeGreaterThan(0)
    // the fade timing lives on the -active pair once; the from/to pair only
    // sets the origin (opacity 0) — a fade and only a fade
    const active = appear.filter((r) => r.selectors.some((s) => /-active$/.test(s)))
    // TASK-171 (PR#4 review): the FLIP move member — a departing row keeps
    // its layout box through the leave fade, so the survivors' close-up
    // eases instead of teleporting
    const move = appear.filter((r) => r.selectors.some((s) => /-move$/.test(s)))
    const origin = appear.filter((r) => !r.selectors.some((s) => /-active$|-move$/.test(s)))
    expect(active.length, 'the bb-appear active pair exists').toBeGreaterThan(0)
    expect(move.length, 'the bb-appear move member exists').toBeGreaterThan(0)
    for (const r of active) {
      const t = decl(r.body, 'transition') ?? decl(r.body, 'animation') ?? ''
      expect(t, `${r.selectors.join(',')}: a fade and only a fade`).toMatch(/opacity/)
      expect(t).toMatch(/0\.(15|2|16)s/)
    }
    for (const r of move) {
      const t = decl(r.body, 'transition') ?? ''
      expect(t, `${r.selectors.join(',')}: the FLIP move, transform only`).toMatch(/transform/)
      expect(t, `${r.selectors.join(',')}: the fade's own grade`).toMatch(/0\.(15|2|16)s/)
    }
    for (const r of origin) {
      expect(r.selectors.join(','), 'every timing-less rule is the origin pair').toMatch(/-from|-to/)
      expect(decl(r.body, 'opacity'), 'the origin sets opacity 0').toBe('0')
    }
    // reduced-motion turns the vocabulary off (the second guard)
    const reduced = motion.slice(motion.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.bb-appear[^{]*\{[^}]*(?:animation|transition):\s*none/)
    expect(reduced).toMatch(/\.bb-appear-move[^{]*\{[^}]*transition:\s*none/)
    // the sheet pair is wired into BOTH entry points (web + widget)
    for (const entry of ['src/web/main.ts', 'src/widget/main.ts']) {
      const src = readFileSync(resolve(process.cwd(), entry), 'utf8')
      expect(src, `${entry} imports motion.css`).toMatch(/motion\.css/)
      expect(src, `${entry} imports row-grammar.css`).toMatch(/row-grammar\.css/)
    }
  })
})

// TASK-161 (design: tmp/tasks/tm-161/design_period_ui.md v2 §7 + §2-2, 指摘9
// and 指摘3): the row-bar thickness becomes ONE CSS variable (--row-bar-h)
// that every horizontal bar rule references (no per-surface literals), the
// list gaps widen, the data-end radius follows min(2, thickness/4) (the DOM
// twin of BarSegs' capR), and the bar length eases through a width transition
// (the period-move row vocabulary, off under reduced motion). TASK-162 §4
// (design: tmp/tasks/tm-162/design_breakdown_stack.md v2, 指摘4) lifts the
// value 12px -> 16px — the value that houses the §3 11px/600 in-bar label
// (11px + 2.5px breathing room each side). Test-first: red until styles.css
// lands it.
describe('row bar thickness variable (TASK-161 §7 + TASK-162 §4)', () => {
  it('[covers:web-common.row-bar-thickness] --row-bar-h 一元管理: .row-bar/track は var(--row-bar-h) 参照で 6px/12px 直置きなし・16px・gap 4px・radius は min(2, thickness/4) の DOM 双生（0 2px 2px 0）・width transition は reduced-motion で無効', () => {
    // the ONE variable definition (TASK-162 §4: 16px)
    expect(css).toMatch(/--row-bar-h:\s*16px/)
    expect(css).not.toMatch(/--row-bar-h:\s*12px/)
    // every horizontal-bar rule reads it — no per-surface height literal
    for (const sel of ['.row-bar', '.ranked-bar-track', '.week-bar-track']) {
      const r = rulesFor(sel).at(-1)
      expect(r, sel).toBeDefined()
      expect(decl(r!.body, 'height')).toBe('var(--row-bar-h)')
    }
    expect(css).not.toMatch(/height:\s*6px/)
    expect(css).not.toMatch(/height:\s*12px/)
    // the row list gaps widen (2px -> 4px; the week row's label/bar gap too)
    expect(decl(rulesFor('.ranked').at(-1)!.body, 'gap')).toBe('4px')
    expect(decl(rulesFor('.week-rows').at(-1)!.body, 'gap')).toBe('4px')
    expect(decl(rulesFor('.week-row').at(-1)!.body, 'row-gap')).toBe('4px')
    // the row's padding-bottom keeps the bar band the BAR's alone — the text
    // clears it by the bar height + 4px (20px at the 16px bar)
    expect(decl(rulesFor('.ranked-row').at(-1)!.body, 'padding-bottom')).toBe('calc(var(--row-bar-h) + 4px)')
    // the data-end cap follows min(2, thickness/4) — 2px at the 16px
    // thickness (the old fixed 1.5px is gone)
    expect(decl(rulesFor('.row-seg:last-child').at(-1)!.body, 'border-radius')).toBe('0 2px 2px 0')
    // the bar length eases (§2-2's row vocabulary) and reduced motion kills
    // it (the width transition lives on the base rule; the reduced-motion
    // block's later rule overrides it with none — the second guard). The
    // SEGMENTS carry it too (review 中6): they paint at their own fixed px
    // widths, so the outer bar's transition alone would swap the coloured
    // shape at once
    expect(rulesFor('.row-bar').some((r) => /width/.test(decl(r.body, 'transition') ?? ''))).toBe(true)
    expect(rulesFor('.row-seg').some((r) => /width/.test(decl(r.body, 'transition') ?? ''))).toBe(true)
    const rm = blockAfter(/@media \(prefers-reduced-motion[^{]*\)/)
    expect(rm).toBeDefined()
    expect(rulesFor('.row-bar', rm).length).toBeGreaterThan(0)
    expect(decl(rulesFor('.row-bar', rm).at(-1)!.body, 'transition')).toBe('none')
    expect(rulesFor('.row-seg', rm).length).toBeGreaterThan(0)
    expect(decl(rulesFor('.row-seg', rm).at(-1)!.body, 'transition')).toBe('none')
  })
})

// TASK-162 (design: tmp/tasks/tm-162/design_breakdown_stack.md v2 — §2/§3/§6,
// 指摘2/3/6): three new static guards. (1) the trend bars' width cap becomes
// ONE CSS variable (--trend-bar-w: 48px, the twin of --row-bar-h) with no
// 34px literals left in .bar/.bar-stack; (2) the vertical bars' in-segment
// label is UPRIGHT vertical-rl writing — the shared .bar-seg-label class the
// TrendBars and Receipts bars both read; (3) the label type tokens: the
// in-bar labels (11px/600/0.02em) and the axis/tick family (0.7rem/500/
// tabular-nums, axis-labels 0.8rem/500) live in CSS variables with no
// per-surface literals. Test-first: red until styles.css lands them.
describe('trend bar width / vertical segment labels / label type tokens (TASK-162)', () => {
  it('[covers:web-browse.trend-bar-width-margin] --trend-bar-w 一元管理: 48px 定義・.bar/.bar-stack は var 参照で 34px 直置きなし・y軸gutterは2.25rem帯', () => {
    // the ONE variable definition (§6-1: 48px)
    expect(css).toMatch(/--trend-bar-w:\s*48px/)
    // both vertical-bar rules read it — the 34px literal is gone
    for (const sel of ['.bar', '.bar-stack']) {
      const found = rulesFor(sel).filter((r) => /max-width/.test(r.body))
      expect(found.length, sel).toBeGreaterThan(0)
      for (const r of found) expect(decl(r.body, 'max-width')).toBe('var(--trend-bar-w)')
    }
    expect(css).not.toMatch(/max-width:\s*34px/)
    // the y-axis gutter narrows (2.5rem -> 2.25rem, ±0.25rem at implement
    // time — the guard accepts the band)
    const gutter = decl(rulesFor('.trend-wrap').at(-1)!.body, 'grid-template-columns')
    expect(gutter ?? '').toMatch(/2(\.25)?\.?/)
  })

  it('[covers:web-browse.trend-bar-segment-label] .bar-seg-label は直立縦書き（vertical-rl + upright）— TrendBars と Receipts が共用する一つのclass', () => {
    const r = rulesFor('.bar-seg-label').at(-1)
    expect(r, '.bar-seg-label rule exists').toBeDefined()
    expect(decl(r!.body, 'writing-mode')).toBe('vertical-rl')
    expect(decl(r!.body, 'text-orientation')).toBe('upright')
  })

  it('[covers:web-common.label-type-tokens] label type token一元: bar内label（11px/600/0.02em）とtick系（0.7rem/500/tabular）と軸label（0.8rem/500・狭幅0.65rem）はCSS変数参照で直置きなし', () => {
    // the token group exists and the in-bar labels read it
    expect(css).toMatch(/--bar-label-size:\s*11px/)
    expect(css).toMatch(/--bar-label-weight:\s*600/)
    expect(css).toMatch(/--bar-label-tracking:\s*0\.02em/)
    // TASK-162 review 低8: the vertical label's needed WIDTH is a token too
    // (the Receipts daily grid's track floor reads it — 高1's containment fix)
    expect(css).toMatch(/--bar-label-w:\s*15px/)
    for (const sel of ['.row-seg-label', '.bar-seg-label']) {
      const r = rulesFor(sel).at(-1)
      expect(r, sel).toBeDefined()
      expect(decl(r!.body, 'font-size'), sel).toBe('var(--bar-label-size)')
      expect(decl(r!.body, 'font-weight'), sel).toBe('var(--bar-label-weight)')
      expect(decl(r!.body, 'letter-spacing'), sel).toBe('var(--bar-label-tracking)')
    }
    // the old literal-sized in-bar label rule is gone
    const rowLabel = rulesFor('.row-seg-label').at(-1)
    expect(decl(rowLabel!.body, 'font-size')).not.toBe('10px')
    // the tick family: 0.7rem/500/tabular-nums off the token
    expect(css).toMatch(/--tick-label-size:\s*0\.7rem/)
    expect(css).toMatch(/--tick-label-weight:\s*500/)
    for (const sel of ['.y-axis', '.bar-val']) {
      const r = rulesFor(sel).at(-1)
      expect(r, sel).toBeDefined()
      expect(decl(r!.body, 'font-size'), sel).toBe('var(--tick-label-size)')
      expect(decl(r!.body, 'font-weight'), sel).toBe('var(--tick-label-weight)')
      expect(decl(r!.body, 'font-variant-numeric'), sel).toBe('tabular-nums')
    }
    // the AXIS labels (review 低8): the month row AND the year row read the
    // axis token pair — no per-surface 0.8rem/500/0.65rem literals (the
    // ≤420px override rides the narrow token)
    expect(css).toMatch(/--axis-label-size:\s*0\.8rem/)
    expect(css).toMatch(/--axis-label-weight:\s*500/)
    expect(css).toMatch(/--axis-label-size-narrow:\s*0\.65rem/)
    for (const sel of ['.axis-labels', '.axis-years']) {
      const r = rulesFor(sel).at(-1)
      expect(r, sel).toBeDefined()
      expect(decl(r!.body, 'font-size'), sel).toBe('var(--axis-label-size)')
      expect(decl(r!.body, 'font-weight'), sel).toBe('var(--axis-label-weight)')
    }
    const narrow = blockAfter(/@media \(max-width: 420px\)[^{}]*\{[^{}]*\.trend-wrap \.axis-labels/)
    expect(narrow, 'the ≤420px axis override block exists').toBeDefined()
    expect(decl(narrow!, 'font-size')).toBe('var(--axis-label-size-narrow)')
  })
})


// TASK-167 (design: tmp/tasks/tm-167/design_row_hierarchy.md v2 §2
// D-2/D-4/D-6) + TASK-170 (design: tmp/tasks/tm-170/design_widget-row-grammar.md
// v3 §2 W-1/W-3/W-7): the row hierarchy tokens (the amount is the strongest
// figure at w700 tabular, the sub line drops to 0.8rem, the rows grow past
// the old 44px), the hover family (an element-local underline + accent
// reaction for pressable elements only, inside the hover-capable media,
// focus-visible mirrors it) and the receipt detail's three-tier item
// typography. TASK-170 moves the rules' HOME to shared/styles/row-grammar.css
// (both entry points import it; web/styles.css keeps none of them) and pins
// the .data-row font order (inherit shorthand, then the 16px size — the
// button root keeps the inherited family). Test-first: red until the
// implementation lands.
describe('row hierarchy tokens + hover family (TASK-167/170)', () => {
  it('[covers:web-common.data-row-grammar] 行token: 主行の金額は w700・tabular・副行は 0.8rem・行は2行分の高さ・font は inherit→16px の順', () => {
    const rowCss = sharedCss('row-grammar.css')
    const amount = rulesFor('.data-row .amount', rowCss)
    expect(amount.some((r) => decl(r.body, 'font-weight') === '700'), 'amount w700').toBe(true)
    expect(
      amount.some((r) => /tabular/.test(decl(r.body, 'font-variant-numeric') ?? '')),
      'amount tabular',
    ).toBe(true)
    const sub = rulesFor('.row-sub', rowCss)
    expect(sub.some((r) => decl(r.body, 'font-size') === '0.8rem'), 'sub 0.8rem').toBe(true)
    // two text lines grow past the old 44px single-line height
    const row = rulesFor('.data-row', rowCss)
    expect(
      row.some((r) => {
        const h = decl(r.body, 'min-height')
        return h !== undefined && parseFloat(h) >= 52
      }),
      'row min-height >= 52px',
    ).toBe(true)
    // TASK-170 W-7: `font: inherit` (the family etc.) comes FIRST, the
    // 16px size AFTER it — a button root keeps the inherited family while
    // the size matches the web/widget surfaces exactly
    const withFont = row.find((r) => /font:\s*inherit/.test(r.body))
    expect(withFont, '.data-row font: inherit').toBeDefined()
    expect(withFont!.body).toMatch(/font-size:\s*16px/)
    expect(withFont!.body.indexOf('font:'), 'inherit shorthand precedes the size').toBeLessThan(withFont!.body.indexOf('font-size:'))
    // the vocabulary's home is the shared sheet — web/styles.css keeps no
    // .data-row root rule of its own
    expect(rulesFor('.data-row'), 'no .data-row root rule left in web/styles.css').toHaveLength(0)
  })

  it('[covers:web-common.hover-ink-family] hover族: .hover-ink は underline+accent（hover可能media内のみ）・focus-visible も同表現・行washは .data-row へ移行・実体は shared', () => {
    const rowCss = sharedCss('row-grammar.css')
    // every @media (hover: hover) block's inner text (the TASK-130 guard the
    // family extends): the hover-ink reaction lives ONLY there
    const hoverBlocks: string[] = []
    for (const m of rowCss.matchAll(/@media[^{]*hover:\s*hover[^{]*\{/g)) {
      const open = rowCss.indexOf('{', m.index)
      let depth = 0
      for (let i = open; i < rowCss.length; i++) {
        if (rowCss[i] === '{') depth++
        else if (rowCss[i] === '}' && --depth === 0) {
          hoverBlocks.push(rowCss.slice(open + 1, i))
          break
        }
      }
    }
    expect(hoverBlocks.length).toBeGreaterThan(0)
    const hoverAll = hoverBlocks.join('\n')
    expect(hoverAll).toMatch(/\.hover-ink[^{]*:hover[^{]*\{[^}]*text-decoration:\s*underline/)
    expect(hoverAll).toMatch(/\.hover-ink[^{]*:hover[^{]*\{[^}]*color:\s*var\(--bb-accent[^)]*\)/)
    // the keyboard focus takes the same local reaction (outside the media:
    // focus-visible exists regardless of hover capability)
    expect(rowCss).toMatch(/\.hover-ink[^{]*:focus-visible[^{]*\{[^}]*color:\s*var\(--bb-accent[^)]*\)/)
    // the row wash survives on the shared row vocabulary
    expect(hoverAll).toMatch(/\.data-row[^{]*:hover[^{]*\{[^}]*background/)
    // and the touch sticky-hover guard holds: NO hover-ink hover rule
    // outside the hover-capable media (in either sheet)
    const outside = topLevel(rowCss).replace(/@media[^{]*hover:\s*hover[^{]*\{[\s\S]*?\n\}/g, '')
    expect(outside).not.toMatch(/\.hover-ink[^{]*:hover/)
    // REVIEW-15 中2: the AppsPage text link rides the family too — its bare
    // .more:hover is gone (the reaction is the .hover-ink rule alone) and the
    // dead a.sub-row wash rule no longer claims a media-bare row hover
    expect(outside + topLevel()).not.toMatch(/\.more\s*:hover/)
    expect(`${rowCss}\n${css}`).not.toMatch(/a\.sub-row/)
    // TASK-170: the family rules are GONE from web/styles.css (the shared
    // sheet is the one home) and the web entry imports it ahead of its own
    const webSrc = readFileSync(resolve(process.cwd(), 'src/web/main.ts'), 'utf8')
    expect(webSrc).toMatch(/row-grammar\.css/)
    expect(webSrc.indexOf('row-grammar.css'), 'shared css precedes web/styles.css').toBeLessThan(webSrc.search(/styles\.css/))
    expect(css, 'no hover-ink rules left in web/styles.css').not.toMatch(/\.hover-ink[^{]*\{/)
  })

  it('[covers:web-receipts.items-typography] 明細3層: 品目金額は w600・明細合計は label縮小+w600・値 w700・上辺rule（実体は shared）', () => {
    const rowCss = sharedCss('row-grammar.css')
    const itemNum = rulesFor('.items td.num', rowCss)
    expect(itemNum.some((r) => decl(r.body, 'font-weight') === '600'), 'item amount w600').toBe(true)
    const foot = rules(rowCss).filter((r) => r.selectors.some((s) => s.includes('.items') && s.includes('tfoot')))
    expect(foot.some((r) => decl(r.body, 'font-weight') === '700'), 'foot value w700').toBe(true)
    expect(
      foot.some((r) => {
        const f = decl(r.body, 'font-size')
        return f !== undefined && parseFloat(f) < 1
      }),
      'foot label smaller than the base',
    ).toBe(true)
    expect(
      foot.some((r) => /border-top/.test(r.body) && !/border-top-style:\s*none/.test(r.body)),
      'the rule above 明細合計',
    ).toBe(true)
    // TASK-170: the .items token family's home is the shared sheet — the
    // widget's ItemTable (ul/li) references the same tokens
    expect(css, 'no .items rules left in web/styles.css').not.toMatch(/\.items[\s,{]/)
  })
})

// TASK-175 (design: tmp/tasks/tm-175/design_receipt-header-layout.md v3
// §1 H-1..H-9): the receipt head's grammar lives in the SHARED sheet — the
// .receipt-header family (main row / sub row) — and the feed nav becomes a
// grid whose middle column hosts the ‹ position › group. Static checks, read
// lazily (the rules land with the implementation; red until then).
describe('TASK-175 receipt header + feed nav (static)', () => {
  it('[covers:web-receipts.head-row-grammar] .receipt-header 族は shared: 主行 baseline・min-height 44px・店名のみ ellipsis・合計は flex:none の label inline+1.9rem・副行は context+sub-end 右端・web側旧語彙と -8px 補正は不在', () => {
    const rowCss = sharedCss('row-grammar.css')
    // the main row: baseline alignment across the 1.25rem name and the
    // 1.9rem value, tall enough to hold the 44px actions
    const main = rulesFor('.receipt-mainrow', rowCss)
    expect(main.length, '.receipt-mainrow defined in shared').toBeGreaterThan(0)
    expect(main.some((r) => decl(r.body, 'align-items') === 'baseline'), 'mainrow baseline').toBe(true)
    expect(
      main.some((r) => parseFloat(decl(r.body, 'min-height') ?? '0') >= 44),
      'mainrow min-height >= 44px',
    ).toBe(true)
    // the title flexes and the NAME alone ellipsizes
    const title = rulesFor('.receipt-title', rowCss)
    expect(title.some((r) => decl(r.body, 'flex') === '1'), 'title flex:1').toBe(true)
    expect(title.some((r) => decl(r.body, 'min-width') === '0'), 'title min-width:0').toBe(true)
    const name = rulesFor('.receipt-title-name', rowCss)
    expect(name.some((r) => decl(r.body, 'text-overflow') === 'ellipsis'), 'title-name ellipsis').toBe(true)
    expect(name.some((r) => decl(r.body, 'min-width') === '0'), 'title-name min-width:0').toBe(true)
    // the total keeps its width (never the ellipsis target): the label
    // rides INLINE ahead of the value
    const total = rulesFor('.receipt-total', rowCss)
    expect(total.some((r) => decl(r.body, 'flex') === 'none'), 'total flex:none').toBe(true)
    const totalValue = rulesFor('.receipt-total__value', rowCss)
    expect(totalValue.some((r) => decl(r.body, 'font-size') === '1.9rem'), 'total value 1.9rem').toBe(true)
    expect(totalValue.some((r) => decl(r.body, 'font-weight') === '700'), 'total value w700').toBe(true)
    const totalLabel = rulesFor('.receipt-total__label', rowCss)
    expect(
      totalLabel.some((r) => parseFloat(decl(r.body, 'font-size') ?? '1') < 1),
      'total label 0.85rem',
    ).toBe(true)
    expect(totalLabel.some((r) => decl(r.body, 'font-weight') === '600'), 'total label w600').toBe(true)
    // the sub row: the right-edge host pushes itself to the end and keeps
    // its wrapped lines right-aligned (the picker never falls back to a
    // left-aligned second line — and neither do the chips inside their own
    // .label-dots host, TASK-175 review #1)
    const subEnd = rulesFor('.receipt-sub-end', rowCss)
    expect(subEnd.some((r) => decl(r.body, 'margin-left') === 'auto'), 'sub-end margin-left:auto').toBe(true)
    expect(rowCss).toMatch(/\.receipt-sub-end \.label-picker[^{]*\{[^}]*justify-content:\s*flex-end\s*;?\s*\}/)
    expect(rowCss).toMatch(/\.receipt-sub-end \.label-dots[^{]*\{[^}]*justify-content:\s*flex-end\s*;?\s*\}/)
    expect(rulesFor('.receipt-sub-context', rowCss).length, 'sub-context defined in shared').toBeGreaterThan(0)
    // the vocabulary's home is the shared sheet — web/styles.css keeps no
    // head rules of its own (the .receipt-head column stack, .receipt-side,
    // .receipt-when, .detail-title and the web-side .receipt-total are gone)
    for (const gone of ['.receipt-head', '.receipt-side', '.receipt-when', '.detail-title', '.receipt-total']) {
      expect(css, `no ${gone} rules left in web/styles.css`).not.toMatch(new RegExp(`${gone.replace('.', '\\.')}[\\s,{:.[]`))
    }
    // H-5: the label button's -8px vertical fudge is gone (the flex sub row
    // hosts the 44px button with its own height)
    expect(css, 'no -8px margin on .label-add-btn').not.toMatch(/\.label-add-btn[^{]*\{[^}]*-8px/)
  })

  it('[covers:web-receipts.feed-nav-flanked-position] .feed-nav は grid（minmax(0,1fr) auto minmax(0,1fr)）・.feed-move は nowrap の中央group・44px は .feed-move .icon-btn・.feed-nav-buttons 廃止', () => {
    // TASK-175 H-6: the equal 1fr sides carry minmax(0,…) so the middle
    // group sits at the nav's exact centre
    const nav = rulesFor('.feed-nav')
    expect(nav.some((r) => decl(r.body, 'display') === 'grid'), 'feed-nav grid').toBe(true)
    expect(
      nav.some((r) => /minmax\(0\s*,\s*1fr\)\s+auto\s+minmax\(0\s*,\s*1fr\)/.test(decl(r.body, 'grid-template-columns') ?? '')),
      'grid-template-columns minmax(0,1fr) auto minmax(0,1fr)',
    ).toBe(true)
    const move = rulesFor('.feed-move')
    expect(move.length, '.feed-move defined').toBeGreaterThan(0)
    expect(move.some((r) => /flex/.test(decl(r.body, 'display') ?? '')), 'feed-move flex').toBe(true)
    expect(move.some((r) => decl(r.body, 'flex-wrap') === 'nowrap'), 'feed-move nowrap').toBe(true)
    expect(move.some((r) => decl(r.body, 'justify-self') === 'center'), 'feed-move justify-self:center').toBe(true)
    // the 44px tap target moved with the group vocabulary (a miss here
    // would fall back to the generic .icon-btn's 40px)
    expect(css).toMatch(/\.feed-move \.icon-btn[^{]*\{[^}]*width:\s*44px[^}]*height:\s*44px/)
    expect(css, '.feed-nav-buttons vocabulary gone').not.toMatch(/\.feed-nav-buttons/)
  })
})
