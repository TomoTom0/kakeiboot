// TASK-19 real-browser verification (chromium): the layout facts jsdom
// cannot compute, asserted as pass/fail numbers. capture.spec.ts takes the
// pictures; this spec measures. Each test title carries its [covers:<id>]
// tag for scripts/design/verify-conditions.py; the conditions live in
// tests/design/conditions.toml (design: tmp/tasks/tm-19/design_browser.md
// §2). Test 2 (feed-scroll-compensation-real) is the red-first spec for the
// §2-7 determinism work in ReceiptPanel / ReceiptDetailPage.
// Run: mise run frontend:browser (or
//   pnpm exec playwright test tests/browser/verify.spec.ts).

import { expect, test, type Page } from '@playwright/test'
import { installApiStub } from './stub'
import { createMockDataApi } from '@/web/api/data/mock'

// The period-pop scroll test counts the programmatic scrolls of one pop
// (the same-path pop must issue none); the counter rides on the window.
declare global {
  interface Window {
    __periodPopScrolls?: unknown[][]
  }
}

/**
 * Landing expectation of a feed panel: the effective px of .receipt-panel's
 * scroll-margin-top (topbar height + feed-nav height + 0.5rem), plus the
 * panel's current top / height.
 */
function panelTop(page: Page, id: number): Promise<{ top: number; expected: number; height: number }> {
  return page.evaluate((rid) => {
    const el = document.querySelector(`[data-test="receipt-panel-${rid}"]`)!
    const r = el.getBoundingClientRect()
    return {
      top: r.top,
      expected: parseFloat(getComputedStyle(el).scrollMarginTop),
      height: r.height,
    }
  }, id)
}

/** Click feed-next once and verify the landing of `id` (|top - scroll-margin-top| <= 2). */
async function nextAndAssertLanding(page: Page, id: number): Promise<void> {
  await page.locator('[data-test="feed-next"]').click()
  await expect
    .poll(() => panelTop(page, id).then((r) => Math.abs(r.top - r.expected)), { timeout: 3_000 })
    .toBeLessThanOrEqual(2)
}

// Browser-side issue logging (capture.spec.ts recipe; vite HMR websocket
// noise from headless chromium is expected and skipped).
const NOISE = /\[vite\]|WebSocket|Vite server|server-hmr/

function logPageIssues(page: Page, tag: string): void {
  page.on('pageerror', (e) => console.log(`[pageerror ${tag}] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !NOISE.test(m.text())) console.log(`[console ${tag}] ${m.text()}`)
  })
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()} ${tag}] ${r.url()}`)
  })
}

// --- feed: landing + compensation (390px, reduced motion for instant scroll) ---

test.describe('feed (390x780, reduced motion)', () => {
  test.use({ viewport: { width: 390, height: 780 }, reducedMotion: 'reduce' })

  test('[covers:web-receipts.feed-nav-landing] 前後ボタンの着地は topbar と操作バーの下・ボタンは 44px', async ({ page }) => {
    logPageIssues(page, 'landing')
    await installApiStub(page, { feed: 9 })
    // /receipts/112 is the mock's newest (idx 0): the direct-link scroll
    // quirk (§2-8) does not apply — the walk below only uses the buttons.
    await page.goto('/receipts/112')
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-title')).toBeVisible()

    // 8 presses down: 112 -> 111 -> ... -> 104 (9th of 12), every landing verified
    for (let id = 111; id >= 104; id--) await nextAndAssertLanding(page, id)
    // one press back up: 104 -> 105
    await page.locator('[data-test="feed-prev"]').click()
    await expect
      .poll(() => panelTop(page, 105).then((r) => Math.abs(r.top - r.expected)), { timeout: 3_000 })
      .toBeLessThanOrEqual(2)

    // prev / next tap targets are 44x44
    for (const name of ['feed-prev', 'feed-next']) {
      const box = await page.locator(`[data-test="${name}"]`).boundingBox()
      expect(box, name).toBeTruthy()
      expect(box!.width, name).toBeCloseTo(44, 1)
      expect(box!.height, name).toBeCloseTo(44, 1)
    }

    // TASK-175: the sticky nav must not COVER the landed panel's top edge
    // (real coordinates — the scroll-margin match alone wouldn't prove it)
    const navBox = await page.locator('nav.feed-nav').boundingBox()
    const panelBox = await page.locator('[data-test="receipt-panel-105"]').boundingBox()
    expect(navBox && panelBox).toBeTruthy()
    expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(panelBox!.y + 2)
  })

  test('[covers:web-receipts.feed-scroll-compensation-real] 上方向展開でも表示中パネルの top を維持', async ({ page }) => {
    logPageIssues(page, 'compensation')
    await installApiStub(page, { feed: 9 })
    await page.goto('/receipts/112')
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-title')).toBeVisible()
    // same walk as the landing test: end on 104 (idx 8, window [6,10];
    // everything above is an 18rem placeholder)
    for (let id = 111; id >= 104; id--) await nextAndAssertLanding(page, id)

    // iOS Safari has no scroll anchoring: reproduce that in chromium so the
    // app's compensation is the only mechanism that can keep the position
    await page.addStyleTag({ content: 'html{overflow-anchor:none}' })
    // jump up to the placeholder 107 (idx 5): the window expands to [3,7]
    // and 108 / 109 mount above the visible panel
    await page.evaluate(() => {
      document.querySelector('[data-test="receipt-panel-107"]')!.scrollIntoView({ block: 'start', behavior: 'auto' })
    })
    await expect(page.locator('[data-test="receipt-panel-107"] .receipt-title')).toBeVisible({ timeout: 5_000 })
    // barrier: wait for 108 to grow past the 288px placeholder before
    // measuring — otherwise a pre-growth sample would green the poll at once
    await expect
      .poll(() => panelTop(page, 108).then((r) => r.height), { timeout: 5_000 })
      .toBeGreaterThan(320)
    // the visible panel keeps its landing position through the expansion
    await expect
      .poll(() => panelTop(page, 107).then((r) => Math.abs(r.top - r.expected)), { timeout: 5_000 })
      .toBeLessThanOrEqual(2)
    // non-vacuous proof: 108 really grew past the placeholder height
    const grown = await panelTop(page, 108)
    expect(grown.height).toBeGreaterThan(320)
  })

  test('[covers:web-receipts.feed-nav-flanked-position] ‹ 位置 › group は nav の中央（実座標）・先頭で prev disabled', async ({ page }) => {
    logPageIssues(page, 'task175-feed-move')
    await installApiStub(page, { feed: 9 })
    await page.goto('/receipts/112')
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-title')).toBeVisible()
    // TASK-175 H-6: the flanked group sits at the nav's exact centre — the
    // minmax(0,1fr) sides kill the auto-minimum drift space-between had
    const c = await page.evaluate(() => {
      const nav = document.querySelector('nav.feed-nav')!.getBoundingClientRect()
      const move = document.querySelector('.feed-move')!.getBoundingClientRect()
      return { navCx: nav.left + nav.width / 2, moveCx: move.left + move.width / 2 }
    })
    expect(Math.abs(c.navCx - c.moveCx)).toBeLessThanOrEqual(3)
    // 112 is the feed's newest: prev is disabled at the start edge
    await expect(page.locator('[data-test="feed-prev"]')).toBeDisabled()
    await expect(page.locator('[data-test="feed-next"]')).toBeEnabled()
  })

  // TASK-49 direct-link initial scroll (tmp/tasks/tm-49/design_direct-link.md
  // §3-1): a deep direct link must land on the anchor itself with the URL
  // unchanged. Before the fix the initial viewport is the top-of-document
  // placeholders, the first IO delivery re-currents one of them, and the URL
  // is replaced away from the anchor (the deep test is the red-first spec).
  test('[covers:web-receipts.feed-direct-link-initial-scroll-real] 深い位置の直リンクは URL そのままで着地し窓は anchor 中心', async ({ page }) => {
    logPageIssues(page, 'direct-link-deep')
    await installApiStub(page, { feed: 9 })
    // 104 is idx 8 of 12: window [6,10], six placeholders above it
    await page.goto('/receipts/104')
    await expect(page.locator('[data-test="receipt-panel-104"] .receipt-title')).toBeVisible()
    await expect
      .poll(() => panelTop(page, 104).then((r) => Math.abs(r.top - r.expected)), { timeout: 3_000 })
      .toBeLessThanOrEqual(2)
    // the URL stays the direct link: no params rewrite, no context query adoption
    // (an IO re-current would replace to another id AND add the context query)
    expect(new URL(page.url()).pathname).toBe('/receipts/104')
    expect(new URL(page.url()).search).toBe('')
    // the window is anchored at 104: 106 (in window) is a real panel,
    // 112 (above the window) stays a placeholder — the top-of-document
    // panels were not re-currented
    await expect(page.locator('[data-test="receipt-panel-106"] .receipt-title')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-panel-placeholder')).toBeVisible()
    await expect(page.locator('[data-test="feed-position"]')).toContainText('9 / 12')
  })

  test('[covers:web-receipts.feed-direct-link-initial-scroll-real] 浅い位置（先頭）の直リンクも URL そのままで着地', async ({ page }) => {
    logPageIssues(page, 'direct-link-shallow')
    await installApiStub(page, { feed: 9 })
    await page.goto('/receipts/112') // idx 0
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-title')).toBeVisible()
    await expect
      .poll(() => panelTop(page, 112).then((r) => Math.abs(r.top - r.expected)), { timeout: 3_000 })
      .toBeLessThanOrEqual(2)
    expect(new URL(page.url()).pathname).toBe('/receipts/112')
    expect(new URL(page.url()).search).toBe('')
    await expect(page.locator('[data-test="feed-position"]')).toContainText('1 / 12')
  })
})

// --- page width: the main screens never overflow horizontally ---

const PAGE_WIDTH_SCREENS = [
  { name: 'home', path: '/' },
  { name: 'categories', path: '/categories?month=2026-10' },
  { name: 'stores', path: '/stores?month=2026-10' },
  { name: 'axis-category', path: '/axes/category/1?month=2026-10' },
  { name: 'axis-store', path: '/axes/store/1?month=2026-10' },
  { name: 'receipt', path: '/receipts/101' },
] as const

for (const width of [360, 390, 768] as const) {
  test.describe(`page width ${width}`, () => {
    test.use({ viewport: { width, height: 780 } })

    test('[covers:web-layout.page-width-fits-viewport] 主要画面が横方向に溢れない', async ({ page }) => {
      logPageIssues(page, `width${width}`)
      await installApiStub(page)
      for (const s of PAGE_WIDTH_SCREENS) {
        await page.goto(s.path)
        await expect(page.locator('.topbar')).toBeVisible()
        await page.waitForLoadState('networkidle')
        const m = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }))
        expect(m.sw, `${s.name} @${width}px`).toBeLessThanOrEqual(m.cw)
      }
    })
  })
}

// --- daily bars: every column keeps the 0.25rem minimum track ---

test.describe('daily bars (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-receipts.daily-bars-min-track] daily-bars の各本は縦書きlabel幅（--bar-label-w 15px）を下回らず溢れは .hscroll が担う', async ({ page }) => {
    logPageIssues(page, 'daily')
    await installApiStub(page)
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('[data-test="daily"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const daily = document.querySelector('[data-test="daily"]')!
      const cols = Array.from(daily.querySelectorAll('.daily-col'))
      const bars = daily.querySelector<HTMLElement>('.daily-bars')
      const scroll = bars ? bars.closest<HTMLElement>('.hscroll') : null
      return {
        count: cols.length,
        minWidth: Math.min(...cols.map((c) => c.getBoundingClientRect().width)),
        scrollWidth: bars ? bars.scrollWidth : 0,
        clientWidth: bars ? bars.clientWidth : 0,
        // the .hscroll vessel: the overflow scrolls INSIDE it (never the page)
        vessel: scroll !== null,
        vesselScrollable: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    expect(m.count, '2026-10 has 31 day columns').toBe(31)
    // TASK-162 §2-6 (review 高1): the floor is the vertical label's needed
    // width now — a 31-column day grid at 360px once solved cells to ~7px
    // (narrower than the 11px glyphs) and the labels hung outside their
    // segments; the 15px floor keeps every cell at label width or wider
    expect(m.minWidth, 'every column keeps the 15px label floor (0.05px tolerance)').toBeGreaterThanOrEqual(14.95)
    // the columns no longer fit the card (31 x 15 + gaps > the ~294px track):
    // the .hscroll vessel carries the overflow (scrollable) while the PAGE
    // stays put — the containment fix's scroll grammar
    expect(m.vessel, 'the grid sits in the .hscroll vessel').toBe(true)
    expect(m.vesselScrollable, 'the day track scrolls inside the vessel').toBeGreaterThan(0)
    expect(m.pageScroll, 'the page itself never grows a horizontal scroll').toBeLessThanOrEqual(0)
  })
})

// --- TASK-116 (design tmp/tasks/tm-116/design_breakdown-expansion.md §5-3):
// the newly stacked bars measured in the real layout. TASK-123 (design
// tmp/tasks/tm-123/design_breakdown-visual.md v5) rewrote the segment
// grammar: the full-perimeter 1px var(--seg-outline) border (the old
// border-top / SEG_GAP separation is gone), the allocation always fits (the
// top-clip overshoot is structurally gone), the corners are top-only with
// the cap arithmetic, the palette values are swapped and the week row's
// gradient became a DOM stacked bar (TASK-129: the shared .row-bar +
// .row-seg component). ---

/** Channels of a computed color, tolerant of both the legacy
 * `rgba(r, g, b, a)` and the modern `rgb(r g b / a[%])` serializations
 * (the alpha normalizes to 0..1 either way). */
function colorChannels(c: string): number[] {
  const n = (c.match(/-?[\d.]+/g) ?? []).map(Number)
  if (n.length === 4 && n[3]! > 1) n[3] = n[3]! / 100
  return n
}

test.describe('stacked breakdown bars (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-receipts.trend-card-granularity][covers:web-common.stack-segment-outline] daily bars stack their series with the TASK-123 grammar: full 1px outline, allocation fits, first series at the base, new palette colors', async ({ page }) => {
    logPageIssues(page, 'daily-seg')
    await installApiStub(page)
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('[data-test="daily"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const daily = document.querySelector('[data-test="daily"]')!
      const bars = Array.from(daily.querySelectorAll('.daily-bar')) as HTMLElement[]
      const segBars = bars.filter((b) => b.querySelector('.daily-seg') !== null)
      // 10/5 (おにぎり 150円 食費) — the first recorded day, one segment
      const first = segBars[0]!
      const segs = Array.from(first.querySelectorAll('.daily-seg')) as HTMLElement[]
      const cs = getComputedStyle(segs[0]!)
      const barR = first.getBoundingClientRect()
      return {
        segBars: segBars.length,
        colH: (first.parentElement as HTMLElement).getBoundingClientRect().height,
        barH: barR.height,
        segSum: segs.reduce((a, s) => a + s.getBoundingClientRect().height, 0),
        borderWidths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
        borderStyle: cs.borderStyle,
        borderColor: cs.borderColor,
        bottomGap: segs.map((s) => barR.bottom - s.getBoundingClientRect().bottom),
        colors: segs.map((s) => getComputedStyle(s).backgroundColor),
        radiusTop: cs.borderTopLeftRadius,
        radiusBottom: cs.borderBottomLeftRadius,
      }
    })
    expect(m.segBars, 'the three recorded days carry segments').toBe(3)
    // the column keeps the fixed 110px track height and the bar stays inside
    expect(m.colH).toBeCloseTo(110, 0)
    expect(m.barH).toBeLessThanOrEqual(m.colH + 1)
    // TASK-123 §4-4: EVERY segment carries the full-perimeter 1px outline —
    // all four sides (the old single border-top between neighbors is gone)
    for (const w of m.borderWidths) expect(w, 'all four border sides at 1px').toBe('1px')
    expect(m.borderStyle).toBe('solid')
    // the outline is the light theme's black-40% ink
    const oc = colorChannels(m.borderColor)
    expect(oc[0]!).toBeCloseTo(0, 0)
    expect(oc[1]!).toBeCloseTo(0, 0)
    expect(oc[2]!).toBeCloseTo(0, 0)
    expect(oc[3]!).toBeCloseTo(0.4, 2)
    // §4-5 rule D: the allocation always fits — the segment sum equals the
    // bar (the min-height overshoot that clipped from the top is gone)
    expect(m.segSum).toBeLessThanOrEqual(m.barH + 1)
    expect(m.segSum).toBeGreaterThanOrEqual(m.barH - 1)
    // the FIRST series still anchors the bottom edge
    expect(Math.min(...m.bottomGap)).toBeLessThanOrEqual(1)
    // the segments paint the swapped palette's resolved colors (light
    // --series-1 #803A0D on 10/5's 食費), never transparent
    expect(m.colors.length).toBeGreaterThanOrEqual(1)
    for (const c of m.colors) expect(c).not.toBe('rgba(0, 0, 0, 0)')
    const seg = colorChannels(m.colors[0]!)
    expect([seg[0], seg[1], seg[2]].map((v) => Math.round(v!))).toEqual([128, 58, 13])
    // §4-3: the single-segment bar's segment is the top one — rounded top
    // corners within the 2px cap, square baseline corners
    expect(Number.parseFloat(m.radiusTop)).toBeLessThanOrEqual(2)
    expect(m.radiusBottom).toBe('0px')
  })

  test('[covers:web-home.week-card][covers:web-home.week-row-stack-bar] week rows: the inline bar is a DOM stacked bar (.row-bar segments with share titles) and zero weeks drop it', async ({ page }) => {
    logPageIssues(page, 'week-bar')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="week-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-test="week-card"] button.week-row')) as HTMLElement[]
      const filled = rows.find((r) => r.dataset.test === 'row-2026-10-05')!
      const zero = rows.find((r) => r.dataset.test === 'row-2026-10-12')!
      const bar = filled.querySelector('.row-bar') as HTMLElement | null
      const track = filled.querySelector('.week-bar-track') as HTMLElement | null
      const segs = bar ? (Array.from(bar.querySelectorAll('.row-seg')) as HTMLElement[]) : []
      const rowR = filled.getBoundingClientRect()
      return {
        barPresent: bar !== null,
        barH: bar ? bar.getBoundingClientRect().height : 0,
        segCount: segs.length,
        segColors: segs.map((s) => getComputedStyle(s).backgroundColor),
        segBorders: segs.map((s) => getComputedStyle(s).borderTopWidth),
        segTitles: segs.map((s) => s.getAttribute('title') ?? ''),
        rowH: rowR.height,
        rowW: rowR.width,
        rowKeys: rows.map((r) => r.dataset.test ?? ''),
        rowLabels: rows.map((r) => r.querySelector('.week-label')?.textContent ?? ''),
        amounts: rows.map((r) => r.querySelector('.amount')?.textContent ?? ''),
        currentKey: rows.find((r) => r.classList.contains('current'))?.dataset.test ?? null,
        rowImage: getComputedStyle(filled).backgroundImage,
        zeroBar: zero.querySelector('.row-bar') !== null,
        barW: bar ? bar.getBoundingClientRect().width : 0,
        trackW: track ? track.getBoundingClientRect().width : 0,
      }
    })
    // TASK-146 §2: the fetch range crosses the month, so every row is a FULL
    // 7-day week and the edge labels write the crossing as-is
    expect(m.rowKeys).toEqual(['row-2026-09-28', 'row-2026-10-05', 'row-2026-10-12', 'row-2026-10-19', 'row-2026-10-26'])
    expect(m.rowLabels).toEqual(['9/28〜10/4', '10/5〜10/11', '10/12〜10/18', '10/19〜10/25', '10/26〜11/1'])
    expect(m.amounts).toEqual(['0円', '948円', '0円', '0円', '0円'])
    expect(m.currentKey).toBe('row-2026-10-12')
    // the bar element exists at the readable height (TASK-162 §4: the
    // --row-bar-h variable lifts 12px -> 16px — the §3 11px/600 in-bar
    // labels ride inside it with breathing room)
    expect(m.barPresent).toBe(true)
    expect(m.barH).toBeCloseTo(16, 0)
    // the 948円 week splits into the month's two series — 食費 (the swapped
    // --series-1 #803A0D) then 日用品 (--series-4 #44BEAD), each titled with
    // the share form and carrying the 1px outline
    expect(m.segCount).toBe(2)
    const c0 = colorChannels(m.segColors[0]!).map((v) => Math.round(v))
    const c1 = colorChannels(m.segColors[1]!).map((v) => Math.round(v))
    expect(c0).toEqual([128, 58, 13])
    expect(c1).toEqual([68, 190, 173])
    for (const t of m.segTitles) expect(t, 'the share-form title').toMatch(/^(食費|日用品) [\d,]+円（\d+%）$/)
    for (const b of m.segBorders) expect(b).toBe('1px')
    // the row left the shared ranked-row gradient: no background-image on
    // the button anymore (the composition lives in the bar's elements)
    expect(m.rowImage).toBe('none')
    // the row keeps its 44px full-width shape and the bar fits inside it.
    // TASK-162 §4: the 16px bar + its 20px breathing room push the line's
    // content (25.6px label line + 4px gap + 16px bar = 45.6px) past the
    // 44px min-height — the floor still rules the row, the content now
    // measures slightly over it
    expect(m.rowH).toBeGreaterThanOrEqual(44)
    expect(m.rowH).toBeLessThanOrEqual(47)
    expect(m.barW).toBeGreaterThan(0)
    expect(m.barW).toBeLessThanOrEqual(m.rowW)
    // TASK-129 absolute scale: the 948円 week renders at 948 / screen-scale
    // 1000 of the track (barScale(max(550, 398, 948)) = 1000) — the week is
    // the screen's own max, so 0.948 and NOT the full track
    expect(m.barW / m.trackW).toBeCloseTo(0.948, 2)
    // zero-total weeks draw no bar element at all
    expect(m.zeroBar).toBe(false)
  })

  // The sub-100 proof (REVIEW-3 Low-1's non-vacuity, carried over to the
  // TASK-129 absolute scale): a week-trend-only route override (the later
  // registration wins the match; everything else falls through to the
  // installed stub — so the breakdown keeps the original 550/398 rows)
  // re-seeds the weeks to 798円 and 1200円. The screen scale aggregates the
  // breakdown max (550) and the week max (1200) into barScale(1200) = 2000,
  // and the week bar LENGTHS are the amounts over that shared scale —
  // 798/2000 = 0.399 and 1200/2000 = 0.6 of the track (the max week no
  // longer pegs the full track).
  test('[covers:web-home.week-row-stack-bar] week bar lengths follow the absolute scale (798/2000 and 1200/2000 of the track, the max week no longer full)', async ({ page }) => {
    logPageIssues(page, 'sub100-fill')
    await installApiStub(page)
    // the week-trend answer comes off a re-seeded mock: receipt 103 moves
    // into the 10/12 week at 1200円, so the 10/5 week keeps both series
    // (798円) and the breakdown's 食費 row grows to 1600円 (the screen max)
    const mock = createMockDataApi()
    await mock.updateReceipt(1, 103, {
      revision: 1,
      set: { purchased_on: '2026-10-13' },
      upsert_items: [{ item_id: 1004, amount: 1200 }],
    })
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis/trend' && url.searchParams.get('granularity') === 'week',
      async (route) => {
        const body = await mock.getAnalysisTrend(1, {
          axis: 'category',
          metric: 'amount',
          granularity: 'week',
          // TASK-146 §2: the week fetch crosses the month now — the Monday of
          // the week holding the 1st through the Sunday of the week holding
          // the 31st
          from: '2026-09-28',
          to: '2026-11-01',
          limit: 5,
        })
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/')
    await expect(page.locator('[data-test="week-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-test="week-card"] button.week-row')) as HTMLElement[]
      const read = (testId: string) => {
        const row = rows.find((r) => r.dataset.test === testId)!
        const bar = row.querySelector('.row-bar') as HTMLElement | null
        const track = row.querySelector('.week-bar-track') as HTMLElement | null
        return {
          amount: row.querySelector('.amount')?.textContent ?? '',
          segTitles: bar ? Array.from(bar.querySelectorAll('.row-seg')).map((s) => s.getAttribute('title') ?? '') : [],
          barW: bar ? bar.getBoundingClientRect().width : 0,
          trackW: track ? track.getBoundingClientRect().width : 0,
        }
      }
      return { light: read('row-2026-10-05'), max: read('row-2026-10-12') }
    })
    // the seeded month: the 10/5 week holds 798円, the moved 10/12 week
    // holds 1200円 — the screen scale is barScale(max(550, 1200)) = 2000
    expect(m.light.amount).toBe('798円')
    expect(m.max.amount).toBe('1,200円')
    // the light row's bar keeps BOTH series segments, and both bars render
    // their amounts over the shared scale (798/2000 and 1200/2000)
    expect(m.light.segTitles.length).toBe(2)
    expect(m.light.barW / m.light.trackW).toBeCloseTo(798 / 2000, 2)
    expect(m.max.segTitles.length).toBe(1)
    expect(m.max.barW / m.max.trackW).toBeCloseTo(1200 / 2000, 2)
    // the ratio between the bars equals the value ratio (one shared scale)
    expect(m.light.barW / m.max.barW).toBeCloseTo(798 / 1200, 2)
    expect(m.max.barW).toBeGreaterThan(m.light.barW)
  })

  test('[covers:web-receipts.daily-bars-min-track][covers:web-home.week-card] the stacked daily bars and the week rows keep the 360px fit', async ({ page }) => {
    logPageIssues(page, 'stacked-fit')
    await installApiStub(page)
    for (const path of ['/', '/receipts?month=2026-10']) {
      await page.goto(path)
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }))
      expect(m.sw, path).toBeLessThanOrEqual(m.cw)
    }
  })

  // TASK-123 §4-4: the outline on the OTHER sites and themes — the trend
  // .bar-seg pair, the week row's .row-seg children (TASK-129: the shared
  // component) and the dark theme's white 40% ink; the border-box inner
  // consumption keeps the bar's outer shape (the segment sum never exceeds
  // the stack).
  test('[covers:web-common.stack-segment-outline] trend・週行セグメントも全周1px縁取り（border-box内側消費で外形不変）・dark は白40%', async ({ page }) => {
    logPageIssues(page, 'outline')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const sample = () =>
      page.evaluate(() => {
        const stack = document.querySelector('[data-test="bar-2026-10"] .bar-stack') as HTMLElement | null
        const segs = stack ? (Array.from(stack.querySelectorAll('.bar-seg')) as HTMLElement[]) : []
        const weekSegs = Array.from(document.querySelectorAll('[data-test="week-card"] .row-seg')) as HTMLElement[]
        const cs = segs[0] ? getComputedStyle(segs[0]!) : null
        return {
          segCount: segs.length,
          borderWidths: cs ? [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth] : [],
          borderColor: cs ? cs.borderColor : '',
          segSum: segs.reduce((a, s) => a + s.getBoundingClientRect().height, 0),
          stackH: stack ? stack.getBoundingClientRect().height : 0,
          weekBorders: weekSegs.map((s) => getComputedStyle(s).borderTopWidth),
        }
      })
    const light = await sample()
    expect(light.segCount, 'the current month holds the two series').toBe(2)
    for (const w of light.borderWidths) expect(w).toBe('1px')
    // light: black 40% over the fills
    const lc = colorChannels(light.borderColor)
    expect(lc[0]!).toBeCloseTo(0, 0)
    expect(lc[3]!).toBeCloseTo(0.4, 2)
    // border-box inner consumption: the outline never widens the bar — the
    // segments' outer sum stays within the stack
    expect(light.segSum).toBeLessThanOrEqual(light.stackH + 1)
    // the week bar's segments carry the same outline
    for (const b of light.weekBorders) expect(b).toBe('1px')
    // dark: the SAME token resolves to white 40%
    await page.emulateMedia({ colorScheme: 'dark' })
    const dark = await sample()
    const dc = colorChannels(dark.borderColor)
    expect(dc[0]!).toBeCloseTo(255, 0)
    expect(dc[1]!).toBeCloseTo(255, 0)
    expect(dc[2]!).toBeCloseTo(255, 0)
    expect(dc[3]!).toBeCloseTo(0.4, 2)
  })

  // TASK-123 §4-3: the corner rules in the real paint — no mid-stack
  // rounding (the visual bottom segment's corners are all square), the top
  // segment rounds only its top corners within the cap min(2px, width/4)
  // (the narrow daily bars prove the cap: a ~9px bar tops out at ~2px, a
  // 4px bar would pin at 1px), and the baseline side stays square.
  // REVIEW-5 medium-2: the containers carry NO radius and no clip, so the
  // child's computed radius is the PAINTED shape — a static 2px container
  // radius + overflow:hidden used to own the outline below 8px widths (a
  // 4px bar's arc was fully clipped back to the container's pill), which a
  // child-only computed-style read cannot see. The assertions below pin
  // both halves: the child's radius obeys the cap AND every ancestor
  // container of the segment has zero radius with visible overflow.
  test('[covers:web-common.stack-corner-rules] 中段角丸なし（下段セグメント4隅直角）・最上段は上端のみcap式丸め（min(2px, 幅/4)）・容器は角もclipも持たず子の角丸が外形を支配', async ({ page }) => {
    logPageIssues(page, 'corners')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      // the 2-segment trend bar: DOM first child = visual BOTTOM (column-
      // reverse) — the mid-stack segment that TASK-95's :first-child radius
      // used to round
      const stack = document.querySelector('[data-test="bar-2026-10"] .bar-stack') as HTMLElement
      const segs = Array.from(stack.querySelectorAll('.bar-seg')) as HTMLElement[]
      const bottom = getComputedStyle(segs[0]!)
      const top = getComputedStyle(segs[segs.length - 1]!)
      const stackCs = getComputedStyle(stack)
      return {
        segCount: segs.length,
        bottomCorners: [bottom.borderTopLeftRadius, bottom.borderTopRightRadius, bottom.borderBottomLeftRadius, bottom.borderBottomRightRadius],
        topTop: Number.parseFloat(top.borderTopLeftRadius),
        topBottom: top.borderBottomLeftRadius,
        stackCorners: [stackCs.borderTopLeftRadius, stackCs.borderTopRightRadius, stackCs.borderBottomLeftRadius, stackCs.borderBottomRightRadius],
        stackOverflow: stackCs.overflow,
      }
    })
    expect(m.segCount).toBe(2)
    // no mid-stack rounding: the visual bottom (first series) segment keeps
    // ALL FOUR corners square
    for (const c of m.bottomCorners) expect(c).toBe('0px')
    // the top segment rounds only its top corners, within the 2px cap
    expect(m.topTop).toBeGreaterThanOrEqual(0.5)
    expect(m.topTop).toBeLessThanOrEqual(2)
    expect(m.topBottom).toBe('0px')
    // REVIEW-5 medium-2: the container paints no shape of its own — zero
    // radius on all four corners and no overflow clip, so the top segment's
    // cap radius above IS the bar's painted outline (never overridden by a
    // static container arc on narrow bars)
    for (const c of m.stackCorners) expect(c).toBe('0px')
    expect(m.stackOverflow).toBe('visible')
    // the cap arithmetic holds on every daily top segment (a narrow bar's
    // radius pins at width/4, never at the loose 2px+) — the daily bars
    // live on /receipts, so sample them there, container halves included
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('[data-test="daily"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const caps = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="daily"] .daily-bar'))
        .filter((b) => b.querySelector('.daily-seg') !== null)
        .map((b) => {
          const segs2 = Array.from(b.querySelectorAll('.daily-seg')) as HTMLElement[]
          const topSeg = segs2[segs2.length - 1]!
          const cs = getComputedStyle(topSeg)
          const barCs = getComputedStyle(b)
          const w = topSeg.getBoundingClientRect().width
          const r = Number.parseFloat(cs.borderTopLeftRadius)
          return {
            w,
            r,
            cap: Math.min(2, w / 4),
            barRadius: [barCs.borderTopLeftRadius, barCs.borderTopRightRadius, barCs.borderBottomLeftRadius, barCs.borderBottomRightRadius],
            barOverflow: barCs.overflow,
          }
        }),
    )
    expect(caps.length).toBeGreaterThanOrEqual(3)
    for (const c of caps) {
      expect(c.r, `width ${c.w}: radius within min(2, w/4)=${c.cap}`).toBeLessThanOrEqual(c.cap + 0.51)
      // the daily container paints no shape of its own either (REVIEW-5
      // medium-2 — the narrowest tracks are where the static 2px container
      // radius used to recreate the pill)
      for (const br of c.barRadius) expect(br, `width ${c.w}: container radius`).toBe('0px')
      expect(c.barOverflow, `width ${c.w}: container overflow`).toBe('visible')
    }
  })

  // TASK-123 §4-5 rule F: a bar whose outer size falls below 3px keeps the
  // data ratio and drops the outline (fill only) — a month-trend route
  // override seeds a 1-yen month whose bar is a fraction of a pixel next to
  // the 948円 month. The rule D no-clip property rides along: every stack's
  // segment sum stays within the bar.
  test('[covers:web-common.stack-dimension-rules] 1円月のbarはデータ比率どおり<1pxで縁取りなし（規則F）・通常棒は縁取りあり・セグメント合計は棒寸法内（規則D）', async ({ page }) => {
    logPageIssues(page, 'rule-f')
    await installApiStub(page)
    // the month-trend answer (display window and prefetch alike) holds one
    // 948円 month and one 1-yen month: niceMax(948)=1000, so the tiny bar
    // allocates ~0.08px of the 80px bar area (the 96px plot minus the 16px
    // headroom, TASK-131) — deep under the 3px minimum
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis/trend' && url.searchParams.get('granularity') === 'month',
      async (route) => {
        const buckets = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
        const body = {
          axis: 'category',
          metric: 'amount',
          granularity: 'month',
          period: { from: '2026-05-01', to: '2026-10-31', label: '' },
          buckets,
          series: [
            { key: 1, label: '食費', values: [550, 0, 0, 0, 0, 1], total: 551 },
            { key: 4, label: '日用品', values: [398, 0, 0, 0, 0, 0], total: 398 },
          ],
          bucket_totals: [948, 0, 0, 0, 0, 1],
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const read = (bar: string) => {
        const stack = document.querySelector(`[data-test="${bar}"] .bar-stack`) as HTMLElement | null
        const segs = stack ? (Array.from(stack.querySelectorAll('.bar-seg')) as HTMLElement[]) : []
        const cs = segs[0] ? getComputedStyle(segs[0]!) : null
        return {
          segH: segs[0] ? segs[0].getBoundingClientRect().height : -1,
          borderWidth: cs ? cs.borderTopWidth : '',
          segSum: segs.reduce((a, s) => a + s.getBoundingClientRect().height, 0),
          stackH: stack ? stack.getBoundingClientRect().height : -1,
        }
      }
      const fits = Array.from(document.querySelectorAll('[data-test="trend"] .bar-stack')).map((st) => {
        const segs = Array.from(st.querySelectorAll('.bar-seg')) as HTMLElement[]
        return segs.reduce((a, s) => a + s.getBoundingClientRect().height, 0) - (st as HTMLElement).getBoundingClientRect().height
      })
      return { big: read('bar-2026-05'), tiny: read('bar-2026-10'), fits }
    })
    // the normal month's segments carry the outline and its column fits
    expect(m.big.borderWidth).toBe('1px')
    // rule F: the 1-yen bar keeps its data-ratio outline (a fraction of a
    // pixel, NOT the old 2px min-height floor) and drops the outline — the
    // fill must not collapse under the 2px of border
    expect(m.tiny.segH).toBeLessThan(1)
    expect(m.tiny.segH).toBeGreaterThan(0)
    expect(m.tiny.borderWidth).toBe('0px')
    // rule D: every stack's allocation fits (no top-clip overshoot)
    for (const f of m.fits) expect(f).toBeLessThanOrEqual(1)
  })
})

// --- TASK-129 (design: tmp/tasks/tm-129/design_ranked-row-bar.md v3): the
// ranked rows' bottom gradient became the shared 6px DOM bar (.row-bar +
// .row-seg) inside an absolutely-positioned full-width track, every row bar
// renders its value over the screen's absolute scale (barScale(max outer
// amount) — mock month: max(550, 398, week 948) = 1000), and the same scale
// carries the week bars. The share-less「ほか」row paints from its own value,
// rule F drops the outline on a sub-3px bar, a resize recomputes the
// lengths, and the payments zone keeps its pressable 44px button rows. ---

test.describe('ranked row bars & the absolute scale (TASK-129, 360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-home.breakdown-absolute-ticks][covers:web-common.bar-scale][covers:web-common.stacked-of-rows] breakdown one-bar: top-5 segments + the「ほか」rest closing against the TOTAL, cumulative right edges on the tick ladder, one scale with the week bar', async ({ page }) => {
    logPageIssues(page, 'breakdown-bar')
    await installApiStub(page)
    // the breakdown answer comes off a richer analysis fixture (TASK-162
    // §1-6: rows sort amount-desc; the top-5+「ほか」assembly folds the sub-5%
    // series 文具20/趣味12/雑貨5 into the rest together with the tail, so the
    // rest closes against the TOTAL 948 — value 948-800=148 and count 7
    // categories, NOT the tail's 16円/4件). The week data stays the stub's
    // (948円 week), so the screen scale is barScale(max(500, 300, 948)) =
    // 1000 and the ONE bar spans 948/1000 of the track.
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis' && url.searchParams.get('axis') === 'category',
      async (route) => {
        const body = {
          axis: 'category',
          metric: 'amount',
          period: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
          totals: { amount: 948, count: 3, unit: 316, days: 31 },
          rows: [
            { key: 1, label: '食費', amount: 500, count: 2, unit: 250, share: 0.528 },
            { key: 4, label: '日用品', amount: 300, count: 1, unit: 300, share: 0.316 },
            { key: 3, label: '文具', amount: 20, count: 1, unit: 20, share: 0.021 },
            { key: 6, label: '趣味', amount: 12, count: 1, unit: 12, share: 0.013 },
            { key: 5, label: '雑貨', amount: 5, count: 1, unit: 5, share: 0.005 },
            { key: 7, label: 'その他', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 8, label: '飲料', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 9, label: '菓子', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 10, label: '雑誌', amount: 4, count: 1, unit: 4, share: 0.004 },
          ],
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/')
    await expect(page.locator('[data-test="breakdown"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      // TASK-162 §1: the surface is ONE stacked bar — the ranked-row list is
      // gone; the segments are the pressable series links
      const bar = document.querySelector('[data-test="breakdown-bar"]') as HTMLElement | null
      const track = document.querySelector('[data-test="breakdown-track"]') as HTMLElement | null
      const segs = Array.from(document.querySelectorAll('[data-test="breakdown-seg"]')) as HTMLElement[]
      const barRect = bar?.getBoundingClientRect() ?? null
      const trackRect = track?.getBoundingClientRect() ?? null
      const weekRow = document.querySelector('[data-test="week-card"] [data-test="row-2026-10-05"]') as HTMLElement | null
      const weekBar = weekRow?.querySelector('.row-bar') as HTMLElement | null
      const weekTrack = weekRow?.querySelector('.week-bar-track') as HTMLElement | null
      return {
        rowLeftovers: document.querySelectorAll('[data-test="breakdown"] .ranked-row').length,
        barPresent: bar !== null,
        barH: barRect ? barRect.height : 0,
        trackW: trackRect ? trackRect.width : 0,
        barW: barRect ? barRect.width : 0,
        segs: segs.map((s) => {
          const r = s.getBoundingClientRect()
          const cs = getComputedStyle(s)
          return {
            tag: s.tagName,
            title: s.getAttribute('title') ?? '',
            text: (s.textContent ?? '').trim(),
            w: r.width,
            // the cumulative right edge in track ratios — the tick ladder's
            // reading (each segment's right end = the cumulative amount)
            rightRatio: trackRect ? (r.right - trackRect.left) / trackRect.width : -1,
            fillColor: cs.backgroundColor,
          }
        }),
        week: {
          barW: weekBar ? weekBar.getBoundingClientRect().width : 0,
          trackW: weekTrack ? weekTrack.getBoundingClientRect().width : 0,
        },
      }
    })
    const dump = JSON.stringify(m)
    // the row list is gone; the ONE 16px bar spans the totals over the scale
    expect(m.rowLeftovers, dump).toBe(0)
    expect(m.barPresent, dump).toBe(true)
    expect(m.barH, dump).toBeCloseTo(16, 0)
    expect(m.barW / m.trackW, dump).toBeCloseTo(948 / 1000, 2)
    // three segments: 食費・日用品 stay (>= 5%), the folded sub-5% trio and
    // the tail merge into ONE「ほか」whose value/count close against the TOTAL
    expect(m.segs.map((s) => s.text), dump).toEqual(['食費', '日用品', 'ほか'])
    expect(m.segs[0]!.title, dump).toMatch(/^食費 500円（\d+%）$/)
    expect(m.segs[2]!.title, dump).toMatch(/^ほか 7件・計148円（\d+%）$/)
    // the segment lengths are the values over the ONE screen scale 1000
    expect(m.segs[0]!.w / m.trackW, dump).toBeCloseTo(500 / 1000, 2)
    expect(m.segs[1]!.w / m.trackW, dump).toBeCloseTo(300 / 1000, 2)
    expect(m.segs[2]!.w / m.trackW, dump).toBeCloseTo(148 / 1000, 2)
    // the cumulative right edges read on the tick ladder: 食費's right end =
    // the 500 tick (ratio 0.5), 食費+日用品 = the 800 mark (ratio 0.8), the
    // whole bar = the scale's 948/1000
    expect(m.segs[0]!.rightRatio, dump).toBeCloseTo(0.5, 2)
    expect(m.segs[1]!.rightRatio, dump).toBeCloseTo(0.8, 2)
    expect(m.segs[2]!.rightRatio, dump).toBeCloseTo(0.948, 2)
    // the series segments are the pressable links (buttons); the rest has no
    // destination of its own — it stays inert
    expect(m.segs[0]!.tag, dump).toBe('BUTTON')
    expect(m.segs[1]!.tag, dump).toBe('BUTTON')
    expect(m.segs[2]!.tag, dump).not.toBe('BUTTON')
    // one scale across surfaces: the week bar (948円) rides the same 1000
    expect(m.week.barW / m.week.trackW, dump).toBeCloseTo(948 / 1000, 2)
  })

  test('[covers:web-common.row-bar-component][covers:web-home.breakdown-rest-row] the /categories ranking keeps the ranked-row bar grammar: 16px DOM bar, 4-side 1px outline, right cap, bar/track = value/scale — the share-less rest row included', async ({ page }) => {
    logPageIssues(page, 'ranked-row')
    await installApiStub(page)
    // the same richer analysis fixture, read on the RANKING surface (Home's
    // breakdown is the one bar now — the ranked-row grammar lives on
    // /categories where the list form stays). The fixture mirrors a real
    // truncated answer: five shown rows + truncated_rows 4 (the 4×4円 tail),
    // so the page's own assembly appends the「ほか 4件・計16円」rest row
    // (share-less, its bar must still follow its own value), while 雑貨 5円
    // rides the 5th visible slot — the sub-3px bar proving rule F. The
    // screen scale here is the ROWS' own max (the trend joins the aggregate
    // at TASK-126): barScale(800) = 1000
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis' && url.searchParams.get('axis') === 'category',
      async (route) => {
        const body = {
          axis: 'category',
          metric: 'amount',
          period: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
          totals: { amount: 1153, count: 3, unit: 316, days: 31 },
          rows: [
            { key: 1, label: '食費', amount: 800, count: 2, unit: 400, share: 0.694 },
            { key: 4, label: '日用品', amount: 300, count: 1, unit: 300, share: 0.26 },
            { key: 3, label: '文具', amount: 20, count: 1, unit: 20, share: 0.017 },
            { key: 6, label: '趣味', amount: 12, count: 1, unit: 12, share: 0.01 },
            { key: 5, label: '雑貨', amount: 5, count: 1, unit: 5, share: 0.004 },
          ],
          truncated_rows: 4,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/categories?month=2026-10')
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('main .ranked-row')) as HTMLElement[]
      const read = (label: string) => {
        const row = rows.find((r) => (r.querySelector('.ranked-label')?.textContent ?? '').startsWith(label)) ?? null
        const bar = row?.querySelector('.row-bar') as HTMLElement | null
        const seg = bar?.querySelector('.row-seg') as HTMLElement | null
        const track = row?.querySelector('.ranked-bar-track') as HTMLElement | null
        const cs = seg ? getComputedStyle(seg) : null
        // the 16px bar owns the row's bottom band — the text cells must
        // clear it (no shared pixels) with the bar height + 4px of breathing
        // room (20px at the TASK-162 §4 thickness)
        const labelRect = row?.querySelector('.ranked-label')?.getBoundingClientRect() ?? null
        const barRect = bar?.getBoundingClientRect() ?? null
        return {
          found: row !== null,
          rowH: row ? row.getBoundingClientRect().height : 0,
          barPresent: bar !== null,
          barH: bar ? bar.getBoundingClientRect().height : 0,
          segW: seg ? seg.getBoundingClientRect().width : 0,
          trackW: track ? track.getBoundingClientRect().width : 0,
          textBarGap: labelRect && barRect ? labelRect.bottom - barRect.top : 0,
          borderWidths: cs ? [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth] : [],
          radius: cs
            ? [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius]
            : [],
          fillColor: cs ? cs.backgroundColor : '',
        }
      }
      return {
        top: read('食費'),
        daily: read('日用品'),
        rest: read('ほか'),
        tiny: read('雑貨'),
      }
    })
    // every keyed row renders the shared two-line shape (TASK-167 D-1..D-3:
    // the .data-row grammar — the main line + the sub line over the bar
    // band) with the shared bar inside the absolutely-positioned track that
    // spans the row (padding included). TASK-162 §4: the thickness rides
    // --row-bar-h (16px) and the data-end cap follows min(2, thickness/4) —
    // 2px at 16px. The 16px band is the BAR's alone: the text clears it by
    // the bar height + 4px (20px of padding-bottom over the two text lines —
    // the text never shares the bar's pixels; the row measures ~72px). The
    // client-built rest row keeps its single line (no top items, no share —
    // its label already carries the information) at the 52px floor
    for (const r of [m.top, m.daily, m.rest]) {
      expect(r.found).toBe(true)
      expect(r.rowH).toBeGreaterThanOrEqual(r === m.rest ? 52 : 68)
      expect(r.rowH).toBeLessThanOrEqual(r === m.rest ? 58 : 78)
      expect(r.barPresent).toBe(true)
      expect(r.barH).toBeCloseTo(16, 0)
      expect(r.trackW).toBeGreaterThan(0)
      // the text cell's bottom edge clears the bar's top edge by at least
      // the 4px breathing allowance (the padding-bottom band is the bar's
      // alone — the label never shares its pixels)
      expect(r.textBarGap).toBeLessThanOrEqual(-4)
      // the outline: all four sides at 1px; the cap: the data end (right)
      // alone rounds — BOTH right corners at 2px (min(2, 16/4)) — the base
      // end (left) stays square
      for (const w of r.borderWidths) expect(w).toBe('1px')
      expect(Number.parseFloat(r.radius[1]!)).toBeCloseTo(2, 1)
      expect(r.radius[0]).toBe('0px')
      expect(r.radius[2]).toBe('0px')
      expect(r.radius[3]).toBe('2px')
    }
    // the top row paints its series color (食費 key 1 → --series-1 #803A0D)
    const top = colorChannels(m.top.fillColor).map((v) => Math.round(v))
    expect(top.slice(0, 3)).toEqual([128, 58, 13])
    // the lengths are the values over the ONE screen scale — the rows' own
    // max, barScale(800) = 1000: the top row reads 800/1000 of the track,
    // the second 300/1000…
    expect(m.top.segW / m.top.trackW).toBeCloseTo(800 / 1000, 2)
    expect(m.daily.segW / m.daily.trackW).toBeCloseTo(300 / 1000, 2)
    // …and the share-less「ほか」row — its bar comes from its own value (the
    // folded tail's 16円), not from any share denominator
    expect(m.rest.segW / m.rest.trackW).toBeCloseTo(16 / 1000, 3)
    // rule F on the row bar: the 5円 row's bar is under 3px — the data ratio
    // wins and the outline drops (fill only), the bar itself stays visible
    expect(m.tiny.barPresent).toBe(true)
    expect(m.tiny.segW).toBeGreaterThan(0)
    expect(m.tiny.segW).toBeLessThan(3)
    for (const w of m.tiny.borderWidths) expect(w, 'rule F: no outline under 3px').toBe('0px')
  })

  test('[covers:web-home.breakdown-absolute-ticks] a resize recomputes the one-bar segments (the same value/scale ratio at the new track width)', async ({ page }) => {
    logPageIssues(page, 'breakdown-bar-resize')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="breakdown"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const read = () =>
      page.evaluate(() => {
        // TASK-162: the one-bar's 食費 segment (the first series segment,
        // titled with its share form) against the track
        const seg = Array.from(document.querySelectorAll('[data-test="breakdown-seg"]')).find((s) =>
          (s.getAttribute('title') ?? '').startsWith('食費'),
        ) as HTMLElement | undefined
        const track = document.querySelector('[data-test="breakdown-track"]') as HTMLElement | null
        const bar = document.querySelector('[data-test="breakdown-bar"]') as HTMLElement | null
        return {
          segW: seg ? seg.getBoundingClientRect().width : 0,
          trackW: track ? track.getBoundingClientRect().width : 0,
          barW: bar ? bar.getBoundingClientRect().width : 0,
        }
      })
    const narrow = await read()
    expect(narrow.segW / narrow.trackW).toBeCloseTo(550 / 1000, 2)
    expect(narrow.barW / narrow.trackW).toBeCloseTo(948 / 1000, 2)
    // widen the viewport (still the single-column band): the track grows and
    // the ResizeObserver path recomputes the bar — the ratio stays put
    await page.setViewportSize({ width: 740, height: 780 })
    await page.waitForTimeout(200)
    const wide = await read()
    expect(wide.trackW).toBeGreaterThan(narrow.trackW + 100)
    expect(wide.segW / wide.trackW).toBeCloseTo(550 / 1000, 2)
    expect(wide.segW).toBeGreaterThan(narrow.segW)
  })

  test('[covers:web-receipts.payment-filter][covers:web-common.row-bar-component] the payments zone keeps the 44px pressable button rows and carries the shared DOM bar (the null-key row a span with a bar)', async ({ page }) => {
    logPageIssues(page, 'payments-row-bar')
    await installApiStub(page)
    // the payments ranking comes off a richer fixture: two keyed rows plus a
    // null-key aggregate (a non-pressable span row — its bar comes from its
    // own value like every other row)
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis' && url.searchParams.get('axis') === 'payment_method',
      async (route) => {
        const body = {
          axis: 'payment_method',
          metric: 'amount',
          period: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
          totals: { amount: 948, count: 3, unit: 316, days: 31 },
          rows: [
            { key: 'cash', label: '現金', amount: 500, count: 2, unit: 250, share: 0.528 },
            { key: 'credit_card', label: 'クレジットカード', amount: 300, count: 1, unit: 300, share: 0.316 },
            { key: null, label: 'その他', amount: 148, count: 1, unit: 148, share: 0.156 },
          ],
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('[data-test="payments"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-test="payments"] .ranked-row')) as HTMLElement[]
      return rows.map((row) => {
        const seg = row.querySelector('.row-seg') as HTMLElement | null
        const track = row.querySelector('.ranked-bar-track') as HTMLElement | null
        return {
          tag: row.tagName,
          rowH: row.getBoundingClientRect().height,
          segPresent: seg !== null,
          segW: seg ? seg.getBoundingClientRect().width : 0,
          trackW: track ? track.getBoundingClientRect().width : 0,
          amount: row.querySelector('.amount')?.textContent ?? '',
        }
      })
    })
    expect(m.length).toBe(3)
    const amounts = m.map((r) => Number(r.amount.replace(/[円,]/g, '')))
    // TASK-167 D-1: the two-line .data-row grammar is the row's floor — the
    // two text lines (~53px) plus the 16px bar over its 20px bottom band
    // measure the row at ~73px (the old one-line 44px is gone)
    for (const r of m) {
      expect(r.rowH).toBeGreaterThanOrEqual(68)
      expect(r.rowH).toBeLessThanOrEqual(78)
      expect(r.segPresent).toBe(true)
    }
    // the two keyed rows are pressable buttons; the null-key aggregate row
    // stays a plain span (TASK-65) — with its bar present either way
    expect(m.map((r) => r.tag)).toEqual(['BUTTON', 'BUTTON', 'SPAN'])
    // the payments rows share one screen scale — barScale(max outer amount)
    // over the row values (the daily zone stays on the old basis until
    // TASK-126): every row's length ratio equals its value over that scale.
    // The ladder below is the same 1/2/5 ceiling barScale implements.
    const scale = Math.max(...amounts)
    const nice = (v: number) => {
      const exp = Math.pow(10, Math.floor(Math.log10(v)))
      for (const s of [1, 2, 5, 10]) if (s * exp >= v) return s * exp
      return 10 * exp
    }
    for (const [i, r] of m.entries()) {
      expect(r.segW / r.trackW).toBeCloseTo(amounts[i]! / nice(scale), 2)
    }
    // the press still filters in place (the TASK-65 regression): pressing
    // 現金 moves the URL, pressing it again clears it
    const cash = page.locator('[data-test="payments"] [data-test="row-現金"]')
    await cash.click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).toContain('payment_method=cash')
    await page.locator('[data-test="payments"] [data-test="row-現金"]').click()
    await page.waitForLoadState('networkidle')
    expect(page.url()).not.toContain('payment_method=')
  })
})

// --- TASK-100 trend axes: the 6-month window fits the 360px viewport, each
// thinned tick label centers under its own bar on the shared grid, the
// y-axis sits in the left gutter with two gridlines, and the year mode is
// dense (12 bars, the value labels thin to the 5 tick positions while the
// hidden values stay reachable via title). Real-browser geometry jsdom
// cannot measure (design: tmp/tasks/tm-100/design_trend-chart-axes.md
// §1-3 / §4). ---

test.describe('trend axis (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-browse.trend-axis-minimal-real][covers:web-browse.trend-month-window][covers:web-browse.trend-y-axis] 6か月窓は360pxに収まり間引きラベルは棒の下中央・y軸は左gutter・yearはdense12本', async ({ page }) => {
    logPageIssues(page, 'trend-axis')
    await installApiStub(page)
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rect = (el: Element | null | undefined) => el?.getBoundingClientRect() ?? null
      const card = document.querySelector('[data-test="trend-card"]')
      const hscroll = card?.querySelector('.hscroll') ?? null
      const axis = document.querySelector('[data-test="trend-axis"]')
      const spans = axis ? Array.from(axis.querySelectorAll('span')) : []
      const cols = card ? Array.from(card.querySelectorAll('.bar-col')) : []
      // each non-empty label span centers on its own bar column (the spans
      // and the columns share the index on the common grid). The LAST span
      // is the narrow band's exception: the ≤420px end-flush rule pins it to
      // its cell's right edge (the phantom-scroll guard), so it is checked
      // for staying INSIDE its own cell instead of centering
      const labelDx = spans
        .map((s, i): number | null => {
          if (!(s.textContent ?? '').trim()) return null
          const sr = rect(s)
          const cr = rect(cols[i])
          return sr && cr ? Math.abs(sr.left + sr.width / 2 - (cr.left + cr.width / 2)) : -1
        })
        .filter((d): d is number => d !== null)
      const endSpan = spans.at(-1)
      const endCell = cols.at(-1) ? rect(cols.at(-1)) : null
      const endRect = endSpan ? rect(endSpan) : null
      const lastInsideCell =
        endCell && endRect ? endRect.left >= endCell.left - 0.5 && endRect.right <= endCell.right + 0.5 : false
      const yAxis = rect(card?.querySelector('.y-axis'))
      const plot = rect(card?.querySelector('.plot'))
      const gridTops = Array.from(card?.querySelectorAll('.gridline') ?? []).map((g) => rect(g)?.top ?? -1)
      const valTops = Array.from(card?.querySelectorAll('.bar-col .bar-val') ?? []).map((v) => rect(v)?.top ?? -1)
      // TASK-161 §6-2: the thinning is width-based now — the hard-coded
      // label COUNT gave way to the contract itself: both window ends stay
      // labelled and no two shown labels overlap horizontally
      const shown = spans
        .map((s) => ((s.textContent ?? '').trim() ? rect(s) : null))
        .filter((r): r is DOMRect => r !== null)
      const firstSpan = shown.at(0)
      const lastSpan = shown.at(-1)
      let overlap = false
      for (let i = 1; i < shown.length; i++) if (shown[i - 1]!.right > shown[i]!.left) overlap = true
      return {
        missing: !card || !axis || !hscroll || !yAxis || !plot,
        barCount: cols.length,
        overflow: hscroll ? hscroll.scrollWidth - hscroll.clientWidth : -1,
        labelDx,
        lastInsideCell,
        endsShown: !!firstSpan && !!lastSpan && firstSpan.left < lastSpan.left,
        labelOverlap: overlap,
        yAxisRight: yAxis ? yAxis.right : -1,
        plotLeft: plot ? plot.left : -1,
        plotTop: plot ? plot.top : -1,
        plotBottom: plot ? plot.bottom : -1,
        plotHeight: plot ? plot.height : -1,
        gridTops,
        labelCount: document.querySelectorAll('.bar-label').length,
        topValTop: valTops.length ? Math.min(...valTops) : -1,
        colBottoms: Array.from(card?.querySelectorAll('.bar-col') ?? []).map((c) => rect(c)?.bottom ?? -1),
        stackTops: Array.from(card?.querySelectorAll('.bar-col .bar-stack') ?? []).map((s) => rect(s)?.top ?? -1),
      }
    })
    const dump = JSON.stringify(m)
    expect(m.missing, 'the trend card, the axis, the y-axis, the plot and the hscroll render').toBe(false)
    expect(m.barCount, 'the 6-month window renders 6 bars (no bar-2025-11)').toBe(6)
    // (1) the 6-month window fits the 360px viewport without scrolling
    expect(m.overflow, dump).toBeLessThanOrEqual(2)
    // (2) every non-empty tick label centers under its own bar (±2px);
    // TASK-161 §6-2: the thinning is width-based (a 390px viewport thins, a
    // wide one shows all) — the pinned facts are the BOTH-ENDS guarantee and
    // the no-overlap spacing, not a fixed count. The window's LAST label is
    // the narrow band's end-flush exception (inside its cell, not centered)
    expect(m.labelDx.length, dump).toBeGreaterThanOrEqual(2)
    expect(Math.max(...m.labelDx.slice(0, -1)), dump).toBeLessThanOrEqual(2)
    expect(m.lastInsideCell, `${dump} the flush end label stays inside its own cell`).toBe(true)
    expect(m.endsShown, `${dump} both window ends stay labelled`).toBe(true)
    expect(m.labelOverlap, `${dump} no two shown labels overlap`).toBe(false)
    // (3) the y-axis stays inside the left gutter
    expect(m.yAxisRight, dump).toBeLessThanOrEqual(m.plotLeft + 2)
    // (4) the two gridlines: the max line at plot top + 1rem, the mid line
    // at 50% of the plot height + 0.5rem (±2px)
    expect(m.gridTops.length, dump).toBe(2)
    const tops = [...m.gridTops].sort((a, b) => a - b)
    expect(Math.abs(tops[0]! - (m.plotTop + 16)), dump).toBeLessThanOrEqual(2)
    expect(Math.abs(tops[1]! - (m.plotTop + m.plotHeight / 2 + 8)), dump).toBeLessThanOrEqual(2)
    // (5) no per-bar month labels anywhere on the page
    expect(m.labelCount, dump).toBe(0)
    // (7) headroom: even the tallest bar's value label stays inside the plot
    expect(m.topValTop, dump).toBeGreaterThanOrEqual(m.plotTop)
    // (8) TASK-131: every column's bottom edge sits on the zero baseline
    // (the plot's bottom) — the content-grown grid row used to sink every
    // bar (the 0-yen placeholder columns included) below the baseline
    expect(m.colBottoms.length, dump).toBe(6)
    for (const b of m.colBottoms) expect(Math.abs(b - m.plotBottom), dump).toBeLessThanOrEqual(2)
    // (9) TASK-131: the tallest stack never overshoots the max gridline
    // (its top edge; catches the grown-row-but-dead-padding states — the
    // baseline sinking itself is caught by (8))
    expect(m.stackTops.length, dump).toBeGreaterThan(0)
    expect(Math.min(...m.stackTops), dump).toBeGreaterThanOrEqual(tops[0]! - 2)

    // (6) the year mode is dense: 12 bars still fit the viewport and the
    // value labels thin to the width-based tick positions (TASK-161 §6-2/
    // §11-4 — both window ends stay labelled, a hidden value stays reachable
    // via title; the old hard-coded [01,04,07,10,12] list was the jsdom
    // count fallback's positions, not the measured rule's). The default
    // stub's records live in October alone, so the year window would carry
    // eleven 0-yen bars (valLabel hides a zero) and the thinning would read
    // vacuous — seed a year of values first (both ends non-zero, a few zero
    // months for the title check)
    await page.route(
      (url) =>
        url.pathname === '/api/ledgers/1/analysis/trend' &&
        url.searchParams.get('granularity') === 'month' &&
        url.searchParams.get('from') === '2026-01-01' &&
        url.searchParams.get('to') === '2026-12-31',
      async (route) => {
        const values = [1200, 300, 900, 0, 1500, 400, 0, 800, 200, 948, 0, 1750]
        const body = {
          axis: 'category',
          metric: 'amount',
          granularity: 'month',
          period: { from: '2026-01-01', to: '2026-12-31', label: '2026年' },
          buckets: values.map((_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
          series: [{ key: 1, label: '食費', values, total: values.reduce((a, v) => a + v, 0) }],
          bucket_totals: values,
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/categories?year=2026')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const y = await page.evaluate(() => {
      const card = document.querySelector('[data-test="trend-card"]')
      const hscroll = card?.querySelector('.hscroll') ?? null
      const shown = Array.from(card?.querySelectorAll('.bar-col .bar-val') ?? [])
        .filter((v) => (v.textContent ?? '').trim() !== '')
        .map((v) => v.closest('button')?.getAttribute('data-test') ?? '')
      // no two shown value labels overlap horizontally
      const rects = Array.from(card?.querySelectorAll('.bar-col .bar-val') ?? [])
        .filter((v) => (v.textContent ?? '').trim() !== '')
        .map((v) => v.getBoundingClientRect())
      let overlap = false
      for (let i = 1; i < rects.length; i++) if (rects[i - 1]!.right > rects[i]!.left) overlap = true
      return {
        barCount: card ? card.querySelectorAll('.bar-col').length : 0,
        overflow: hscroll ? hscroll.scrollWidth - hscroll.clientWidth : -1,
        shown,
        labelOverlap: overlap,
        hiddenTitle: card?.querySelector('[data-test="bar-2026-02"]')?.getAttribute('title') ?? '',
      }
    })
    const ydump = JSON.stringify(y)
    expect(y.barCount, ydump).toBe(12)
    expect(y.overflow, ydump).toBeLessThanOrEqual(2)
    // both window ends stay labelled (the TASK-42 contract), no overlap, at
    // most 5 shown (the count cap the width rule inherits), and a thinned
    // bar's value stays reachable via its title
    expect(y.shown[0], ydump).toBe('bar-2026-01')
    expect(y.shown.at(-1), ydump).toBe('bar-2026-12')
    expect(y.shown.length, ydump).toBeLessThanOrEqual(5)
    expect(y.labelOverlap, ydump).toBe(false)
    expect(y.hiddenTitle, ydump).toMatch(/^2026年2月 \d+円$/)
  })

  // TASK-131 (design: tmp/tasks/tm-131/design_bar-col-padding-conflict.md
  // §2/§6): the bar-column geometry the axis test above could not see —
  // .bar-btn's padding reset beat .bar-col's headroom padding (same
  // specificity, later source order) while the TASK-123 explicit px
  // segments grew the auto grid row off the content-based min-size, so
  // every bar sank +30px below the zero baseline and the 100/95/90% bars
  // collapsed onto one flex-shrink ceiling. The default stub's lone 94.8%
  // bar cannot expose the ceiling — the direct regression needs the
  // high-ratio bars side by side, so a month-trend route override seeds
  // the ladder window 1000/950/900/840/500/0円 (niceMax 1000 →
  // 100/95/90/84/50/0%).
  test('[covers:web-browse.trend-bar-geometry] 高比率同居窓は全棒下端=zero baseline・100%棒上端=max gridline・棒高は設計式どおり（天井崩壊なし）', async ({ page }) => {
    logPageIssues(page, 'trend-bar-geometry')
    await installApiStub(page)
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis/trend' && url.searchParams.get('granularity') === 'month',
      async (route) => {
        const body = {
          axis: 'category',
          metric: 'amount',
          granularity: 'month',
          period: { from: '2026-05-01', to: '2026-10-31', label: '' },
          buckets: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'],
          series: [{ key: 1, label: '食費', values: [1000, 950, 900, 840, 500, 0], total: 4190 }],
          bucket_totals: [1000, 950, 900, 840, 500, 0],
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const rect = (el: Element | null | undefined) => el?.getBoundingClientRect() ?? null
      const card = document.querySelector('[data-test="trend-card"]')
      const plot = rect(card?.querySelector('.plot'))
      const cols = Array.from(card?.querySelectorAll('.bar-col') ?? [])
      return {
        missing: !card || !plot,
        plotBottom: plot ? plot.bottom : -1,
        trackH: plot ? plot.height : -1,
        gridTops: Array.from(card?.querySelectorAll('.gridline') ?? []).map((g) => rect(g)?.top ?? -1),
        colBottoms: cols.map((c) => rect(c)?.bottom ?? -1),
        bars: cols.map((c) => {
          const stack = rect(c.querySelector('.bar-stack'))
          return {
            key: c.getAttribute('data-test') ?? '',
            top: stack ? stack.top : -1,
            height: stack ? stack.height : -1,
          }
        }),
      }
    })
    const dump = JSON.stringify(m)
    expect(m.missing, dump).toBe(false)
    // the ladder in bucket order: 100/95/90/84/50% + the 0-yen placeholder
    // month (its column carries the fallback .bar, so no .bar-stack)
    const ladder: Record<string, number> = {
      'bar-2026-05': 1,
      'bar-2026-06': 0.95,
      'bar-2026-07': 0.9,
      'bar-2026-08': 0.84,
      'bar-2026-09': 0.5,
    }
    const stacked = m.bars.filter((b) => ladder[b.key] !== undefined)
    // (1) TASK-131: every column's bottom edge (the 0-yen placeholder
    // included) sits on the zero baseline — the plot's bottom. The grown
    // grid row used to sink all of them +30px below it, onto the month
    // tick row
    expect(m.colBottoms.length, dump).toBe(6)
    for (const b of m.colBottoms) expect(Math.abs(b - m.plotBottom), dump).toBeLessThanOrEqual(2)
    // (2) TASK-131: the 100% bar's stack top meets the max gridline (the
    // headroom puts the full bar 16px under the plot top; catches the
    // pinned-row-but-dead-padding state — the sinking is caught by (1))
    expect(stacked.length, dump).toBe(5)
    expect(m.gridTops.length, dump).toBe(2)
    const full = m.bars.find((b) => b.key === 'bar-2026-05')!
    expect(Math.abs(full.top - Math.min(...m.gridTops)), dump).toBeLessThanOrEqual(2)
    // (3) TASK-131: every stack's height follows ratio × barArea (±2px),
    // barArea = the track height minus the 16px headroom — the monotone
    // ladder survives: no flex-shrink ceiling flattening 100/95/90 onto
    // one height, no under-84% inflation
    const barArea = m.trackH - 16
    for (const b of stacked) {
      expect(Math.abs(b.height - ladder[b.key]! * barArea), `${dump} [${b.key}]`).toBeLessThanOrEqual(2)
    }
  })
})

// --- TASK-104 trend window + TASK-108 page-turn slide: the prev/next
// chevron pair around the trend chart pages the window by its own width
// (month 6 / year 12 — a page never overlaps the one before it) without
// moving the focus — only the trend endpoint re-fetches (the breakdown /
// recent and the TASK-103 week fetch stay put), and the focus changes (the
// period chip's month step, a bar press) reset the window to the initial
// one. TASK-108 adds the direction slide: the swap runs a
// trend-slide-back/forward transition keyed on the committed window, the
// first insertion and a same-window refetch never slide, and
// prefers-reduced-motion turns the swap instant. Measured on the real
// chromium layout: the pair renders as PeriodPicker-style 44px squares
// (design: tmp/tasks/tm-104/design_trend-window.md §5 / §8 +
// tmp/tasks/tm-108/design_trend-window-page.md §5). ---

test.describe('trend window (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  const INIT = ['bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09', 'bar-2026-10']
  // TASK-108 page 2 (one whole window back): 2025-11..2026-04, zero overlap
  // with INIT
  const SLID = ['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04']

  /** the previous calendar month of 'YYYY-MM' */
  const prevMonth = (m: string): string => {
    const [y, mo] = m.split('-').map(Number) as [number, number]
    const t = y * 12 + mo - 2
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
  }

  /** the trend chart's bar keys ('bar-YYYY-MM' …) in DOM order */
  const barKeys = (page: Page) =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="trend"] [data-test^="bar-"]')).map((el) =>
        el.getAttribute('data-test')!,
      ),
    )

  test('[covers:web-home.trend-window] prevで棒key群が窓幅（6か月）ページ送り（前窓と重複なし・focus不変・analysis/recent/weekは再fetchなし・cacheヒットで表示fetchなし・次の隣接窓prefetchのみ）・nextで復帰・時期チップと棒押下で初期窓へ', async ({ page }) => {
    logPageIssues(page, 'trend-window')
    await installApiStub(page)
    // every ledger API call the page turn must (analysis/trend, month) and
    // must not (analysis, receipts, the week trend) make
    const calls: { path: string; from: string | null; granularity: string | null }[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      const m = /^\/api\/ledgers\/\d+\/(.+)$/.exec(u.pathname)
      if (!m) return
      calls.push({ path: m[1]!, from: u.searchParams.get('from'), granularity: u.searchParams.get('granularity') })
    })
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(await barKeys(page)).toEqual(INIT)
    // the pair renders as PeriodPicker-style 44px squares; TASK-161 §1-3: the
    // symmetric all-zero floor keeps BOTH directions open on the initial
    // window (the old canNext = offset > 0 pinned next shut forever)
    for (const name of ['trend-prev', 'trend-next']) {
      const box = await page.locator(`[data-test="${name}"]`).boundingBox()
      expect(box, name).toBeTruthy()
      expect(box!.width, name).toBeCloseTo(44, 1)
      expect(box!.height, name).toBeCloseTo(44, 1)
    }
    await expect(page.locator('[data-test="trend-next"]')).toBeEnabled()
    // TASK-108 no-overlap proof (design §5-1): the paged-to keys share no
    // month with the initial page, and the slid page's right edge (2026-04)
    // is the calendar month immediately before INIT's left edge (2026-05) —
    // consecutive prev pages neither overlap nor leave a gap
    expect(SLID.filter((k) => INIT.includes(k)), 'pages never overlap').toEqual([])
    expect(SLID.at(-1), 'the slid page hugs the initial page').toBe(`bar-${prevMonth(INIT[0]!.slice(4))}`)
    const analysisGets = () => calls.filter((c) => c.path === 'analysis')
    const receiptGets = () => calls.filter((c) => c.path === 'receipts')
    const trendMonth = () => calls.filter((c) => c.path === 'analysis/trend' && c.granularity === 'month')
    const trendWeek = () => calls.filter((c) => c.path === 'analysis/trend' && c.granularity === 'week')
    // TASK-115: the initial commit prefetched the adjacent page (2025-11),
    // so the press below is a cache hit — no display fetch for the paged-to
    // window, its one request stays the prefetch itself
    expect(trendMonth().filter((c) => c.from === '2025-11-01')).toHaveLength(1)
    await page.locator('[data-test="trend-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    expect(analysisGets(), 'the breakdown never re-runs').toHaveLength(1)
    expect(receiptGets(), 'recent neither').toHaveLength(1)
    expect(trendWeek(), 'the TASK-103 week fetch stays in load()').toHaveLength(1)
    expect(trendMonth().filter((c) => c.from === '2025-11-01'), 'the prefetched page is not re-fetched').toHaveLength(1)
    expect(trendMonth().filter((c) => c.from === '2025-05-01'), 'the next adjacent prefetch').toHaveLength(1)
    // the paged-to window is all-zero (the mock records live in 2026-10) and
    // the move ran prev — the symmetric floor disables THAT direction alone
    await expect(page.locator('[data-test="trend-prev"]')).toBeDisabled()
    await expect(page.locator('[data-test="trend-next"]')).toBeEnabled()
    // next returns to the initial window in one press; the INIT window holds
    // records, so both directions stay open (the floor is direction-local)
    await page.locator('[data-test="trend-next"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await expect(page.locator('[data-test="trend-next"]')).toBeEnabled()
    await expect(page.locator('[data-test="trend-prev"]')).toBeEnabled()
    // the period chip's month step (2026-10 -> 2026-09) is an E2a move
    // (TASK-161 §1: September sits INSIDE the committed window) — the window
    // never moves and nothing re-fetches; only the highlight walks, and
    // picking 2026-10 again walks it back
    const trendCallsAtStep = trendMonth().length
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect(page.locator('[data-test="bar-2026-09"]')).toHaveClass(/current/)
    expect(await barKeys(page)).toEqual(INIT)
    await page.locator('[data-test="period-next"]').click()
    await expect(page.locator('[data-test="bar-2026-10"]')).toHaveClass(/current/)
    expect(await barKeys(page)).toEqual(INIT)
    expect(trendMonth().length, 'an E2a focus move issues no trend fetch').toBe(trendCallsAtStep)
    await page.keyboard.press('Escape') // close the dialog for the bar press
    // a bar press inside the paged window is an E2a move too — bar-2025-12
    // sits inside the paged window (2025-11..2026-04), so the window keeps
    // its bars (the neighbours never vanish — the old reset-around-the-press
    // re-anchored instead, TASK-161 §0-2's bug)
    await page.locator('[data-test="trend-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    await page.locator('[data-test="bar-2025-12"]').click()
    await expect(page.locator('[data-test="bar-2025-12"]')).toHaveClass(/current/)
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
  })

  // TASK-115 continuous slide (design §5-2 / §6): the window move keeps ONE
  // graph on screen — the concatenated old+new pair slides via transform and
  // trims on transitionend. The measured facts: the is-sliding pair on .bars
  // and .axis-labels, intermediate transform values (a real move, not an
  // instant swap), the old and new bars coexisting with the old bars still
  // on screen (the user's "the graph never vanishes"), the trimmed end
  // state, the non-firing cases and the reduced-motion instant swap. The
  // 220ms/easing numbers stay unconditioned (excluded).
  test('[covers:web-home.trend-window-slide] 窓移動は旧窓+新窓の連続スライド（旧bar非消滅・transform中間値・is-sliding同時付与）・トリムで新窓のみ・同窓再fetchと初回挿入は不発火・reducedMotionでは即時差し替え', async ({ page }) => {
    logPageIssues(page, 'trend-slide')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('.trend-window')).toBeVisible()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await page.waitForLoadState('networkidle') // the adjacent prefetch is cached: the press slides at once
    // an rAF sampler under .trend-window: while .bars carries is-sliding it
    // records every computed transform, the old/new bar coexistence and the
    // old bars' on-screen visibility — the continuity proof (§10: sampled
    // from the frame loop, before and during the 220ms move)
    await page.evaluate(() => {
      const w = window as unknown as {
        __slideRun: boolean
        __slide: { sliding: boolean; labels: boolean; transforms: string[]; coexist: boolean; oldVisible: boolean }
      }
      w.__slideRun = true
      w.__slide = { sliding: false, labels: false, transforms: [], coexist: false, oldVisible: false }
      const tick = () => {
        if (!w.__slideRun) return
        const s = w.__slide
        const bars = document.querySelector('.trend-window .bars')
        if (bars instanceof HTMLElement && bars.classList.contains('is-sliding')) {
          s.sliding = true
          s.transforms.push(getComputedStyle(bars).transform)
          const labels = document.querySelector('.trend-window .axis-labels')
          if (labels?.classList.contains('is-sliding')) s.labels = true
          const oldBar = document.querySelector('[data-test="bar-2026-05"]')
          const newBar = document.querySelector('[data-test="bar-2025-11"]')
          if (oldBar && newBar) {
            s.coexist = true
            const r = oldBar.getBoundingClientRect()
            if (r.right > 0 && r.left < window.innerWidth) s.oldVisible = true
          }
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    type SlideSample = { sliding: boolean; labels: boolean; transforms: string[]; coexist: boolean; oldVisible: boolean }
    const slideSample = () => page.evaluate(() => (window as unknown as { __slide: SlideSample }).__slide)
    const resetSample = () =>
      page.evaluate(() => {
        const w = window as unknown as { __slide: SlideSample }
        w.__slide = { sliding: false, labels: false, transforms: [], coexist: false, oldVisible: false }
      })
    const noSliding = () =>
      page.evaluate(() => !document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))

    // the initial load (the very first v-if insertion) painted instantly —
    // the sampler never saw a slide before the first press
    expect((await slideSample()).sliding, 'the first insertion never slides').toBe(false)

    // prev (into the past): the prefetched page slides the moment the button
    // fires — one graph, both windows flowing, nothing vanishing
    await page.locator('[data-test="trend-prev"]').click()
    await page.waitForFunction(() => document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID) // the 220ms move + trim
    await expect.poll(noSliding, { timeout: 3_000 }).toBe(true)
    const prevSample = await slideSample()
    expect(prevSample.sliding, '.bars carries is-sliding through the move').toBe(true)
    expect(prevSample.labels, '.axis-labels slides in lockstep with .bars').toBe(true)
    // a real translation: the sampled matrices hold the initial, at least one
    // intermediate and the target value
    expect(new Set(prevSample.transforms).size, 'transform passes through intermediate values').toBeGreaterThanOrEqual(3)
    expect(prevSample.coexist, 'the old and new bars coexist in the DOM').toBe(true)
    expect(prevSample.oldVisible, 'the old window stays on screen mid-move (no blank stage)').toBe(true)
    // the trimmed end state: the new page alone, transform reset, no class
    const afterPrev = await page.evaluate(() => {
      const bars = document.querySelector('.trend-window .bars') as HTMLElement
      return {
        transform: getComputedStyle(bars).transform,
        count: document.querySelectorAll('[data-test="trend"] [data-test^="bar-"]').length,
      }
    })
    expect(afterPrev.transform).toBe('none')
    expect(afterPrev.count).toBe(6)

    // next (back to now): the mirrored direction — the pair slides again
    resetSample()
    await page.locator('[data-test="trend-next"]').click()
    await page.waitForFunction(() => document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await expect.poll(noSliding, { timeout: 3_000 }).toBe(true)
    const nextSample = await slideSample()
    expect(nextSample.sliding).toBe(true)
    expect(nextSample.transforms.length, 'the mirrored move samples real frames').toBeGreaterThanOrEqual(3)
    expect(nextSample.coexist).toBe(true)

    // a same-window refetch (a label filter added) keeps the committed
    // windowKey: no slide may appear — observed from the initial window
    // (offset=0); at offset>0 a label switch is a focus change that
    // legitimately re-inits the window (§5-2 premise)
    resetSample()
    const labelled = page.waitForResponse((r) => {
      const u = new URL(r.url())
      return /\/analysis\/trend$/.test(u.pathname) && u.searchParams.has('label_colors')
    })
    await page.locator('[data-test="filter-search"]').click()
    await page.locator('[data-test="label-filter-red"]').click()
    await labelled
    await page.waitForTimeout(500) // past a whole slide, had one fired
    const refetchSample = await slideSample()
    expect(refetchSample.sliding, 'a recolour of the same window never slides').toBe(false)
    expect(refetchSample.transforms).toEqual([])
    expect(await barKeys(page)).toEqual(INIT)
    await page.keyboard.press('Escape') // close the dialog

    // reduced motion: the very same press skips the slide entirely — no
    // is-sliding frame ever, no transform, the new page at once (the JS skip
    // is the contract; the CSS no-op is its belt-and-braces)
    resetSample()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('[data-test="trend-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    await page.waitForTimeout(300)
    const reducedSample = await slideSample()
    expect(reducedSample.sliding, 'reduced motion never starts a slide').toBe(false)
    const reducedStyle = await page.evaluate(() => {
      const bars = document.querySelector('.trend-window .bars') as HTMLElement
      return { transform: getComputedStyle(bars).transform, duration: getComputedStyle(bars).transitionDuration }
    })
    expect(reducedStyle.transform).toBe('none')
    expect(['0s', ''].includes(reducedStyle.duration)).toBe(true)
  })

  // TASK-115 measurements at the 360px floor (design §5-2 新規測定): the
  // track stays the width it had before the slide (no bar shrinking when
  // the concatenated pair arrives), no phantom scrollbar appears for the
  // 2-window overflow, the old bars keep their DOM identity (keyed v-for
  // reuse), and the dense flag / value-label count / axis labels are
  // computed per window so the trim changes nothing about them.
  test('[covers:web-home.trend-window-slide] 360pxスライド実測: bar幅はスライド前後と等しい（track固定）・phantom scrollなし・旧bar要素は再利用（keyed v-for）・dense化せず.bar-valと軸ラベルはトリム前後で不変', async ({ page }) => {
    // test.use() is describe-scope only in playwright — this one test drops
    // the describe's 390px to the 360px floor at runtime, before any load
    await page.setViewportSize({ width: 360, height: 780 })
    logPageIssues(page, 'trend-slide-measure')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await page.waitForLoadState('networkidle')
    const SLID_KEYS = SLID.map((k) => k.slice(4))
    // the marker is written on the FIRST read only (before the press): the
    // later reads just look it up, so during.oldBarMarked being true proves
    // the very element marked earlier is still there (keyed prepend reuse) —
    // not that some bar-2026-05 exists at read time
    const read = (keys: string[], mark: boolean) =>
      page.evaluate(
        (arg) => {
          const hscroll = document.querySelector('[data-test="trend-card"] .hscroll') as HTMLElement | null
          const wrap = document.querySelector('.trend-window .trend-wrap') as HTMLElement
          const oldBar = document.querySelector('[data-test="bar-2026-05"]') as (HTMLElement & { __marker?: boolean }) | null
          if (oldBar && arg.mark) oldBar.__marker = true
          const valCount = Array.from(document.querySelectorAll('.trend-window .bar-col'))
            .filter(
              (b) =>
                arg.keys.includes(b.getAttribute('data-test')!.slice(4)) &&
                (b.querySelector('.bar-val') as HTMLElement | null)?.textContent !== '',
            )
            .length
          return {
            barWidth: oldBar ? oldBar.getBoundingClientRect().width : null,
            scrollWidth: hscroll ? hscroll.scrollWidth : null,
            clientWidth: hscroll ? hscroll.clientWidth : null,
            dense: wrap.classList.contains('dense'),
            oldBarMarked: oldBar?.__marker === true,
            newBarExists: document.querySelector('[data-test="bar-2025-11"]') !== null,
            valCount,
            labels: Array.from(document.querySelectorAll('.trend-window .axis-labels span')).map((el) => el.textContent),
          }
        },
        { keys, mark },
      )
    const before = await read(SLID_KEYS, true)
    expect(before.dense, 'a 6-bar month window is never dense').toBe(false)
    expect(before.barWidth).not.toBeNull()
    // prev: read the concatenated graph mid-slide
    await page.locator('[data-test="trend-prev"]').click()
    const during = await page
      .waitForFunction(() => document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))
      .then(() => read(SLID_KEYS, false))
    expect(during.newBarExists, 'the new window arrived while the old one stays').toBe(true)
    expect(during.oldBarMarked, 'the old bar keeps its DOM element (keyed prepend reuse)').toBe(true)
    expect(during.barWidth!, 'the track is pinned — bar width unchanged mid-slide').toBeCloseTo(before.barWidth!, 1)
    expect(during.scrollWidth!, 'no phantom scroll for the 2-window overflow').toBeLessThanOrEqual(during.clientWidth!)
    expect(during.dense, 'a 6+6 month concatenation never turns dense (REVIEW-2 R1)').toBe(false)
    const duringNewLabels = during.labels.slice(0, 6)
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    await expect
      .poll(() => page.evaluate(() => !document.querySelector('.trend-window .bars')?.classList.contains('is-sliding')))
      .toBe(true)
    const after = await read(SLID_KEYS, false)
    expect(after.labels, 'the trimmed labels are exactly the new window ones seen mid-slide (per-window axis)').toEqual(
      duringNewLabels,
    )
    expect(after.valCount, 'the trimmed value-label count matches the new window ones mid-slide').toBe(during.valCount)
    expect(after.dense).toBe(false)
    expect(after.scrollWidth!, 'still no phantom scroll after the trim').toBeLessThanOrEqual(after.clientWidth!)

    // rapid re-press (PR#2 review): the second press lands while the first
    // slide still runs — the replacement slide measures with the previous
    // pin still on the DOM, and the cell must stay the committed one (a
    // fresh offsetWidth read there would measure the pinned 2-window grid
    // and double the cell width). The mock records live in the initial
    // window only, so the paged-to window is all-zero and prev floors its
    // own direction (TASK-161 §1-3: canPrev false, the button disabled):
    // return to the initial window, page back with prev, then re-press NEXT
    // while that slide still runs — the floor never touches the opposite
    // direction, so the rapid press is reachable and the cached initial
    // window replaces the slide in the same tick
    await page.locator('[data-test="trend-next"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await page.waitForLoadState('networkidle') // the 2025-11 window is cached again: the prev press slides at once
    await page.locator('[data-test="trend-prev"]').click()
    await page.waitForFunction(() => document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))
    await page.locator('[data-test="trend-next"]').click()
    const readRapid = () =>
      page.evaluate(() => {
        const bars = document.querySelector('.trend-window .bars') as HTMLElement
        const bar = document.querySelector('[data-test="bar-2026-05"]') as HTMLElement | null
        return { pinned: bars.style.gridTemplateColumns !== '', width: bar ? bar.getBoundingClientRect().width : 0 }
      })
    await expect
      .poll(
        async () => {
          const s = await readRapid()
          return s.pinned && s.width > 0
        },
        { timeout: 3_000 },
      )
      .toBe(true)
    const rapid = await readRapid()
    expect(rapid.width, 'the re-slide keeps the committed cell width').toBeCloseTo(before.barWidth!, 1)
    // the interrupted slide settles back into the initial window
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await expect
      .poll(() =>
        page.evaluate(() => !document.querySelector('.trend-window .bars')?.classList.contains('is-sliding')),
      )
      .toBe(true)
  })

  // TASK-115 gridline measurement (design §5-2 新規測定 / REVIEW-2 R3): in
  // the dense year chart the horizontal gridlines must span the whole plot
  // while the concatenated pair slides — the lines are a fixed layer under
  // the moving bars, so the far side never runs out of guides.
  test('[covers:web-home.trend-window-slide] dense（year）スライド中もgridlineは表示域全幅（終端側1窓分の欠けなし）', async ({ page }) => {
    // same as above: the 360px floor at runtime (test.use is describe-scope)
    await page.setViewportSize({ width: 360, height: 780 })
    logPageIssues(page, 'trend-gridline')
    await installApiStub(page)
    await page.goto('/?year=2026')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await expect
      .poll(() => barKeys(page), { timeout: 3_000 })
      .toEqual(Array.from({ length: 12 }, (_, i) => `bar-2026-${String(i + 1).padStart(2, '0')}`))
    await page.waitForLoadState('networkidle')
    await page.locator('[data-test="trend-prev"]').click()
    await page.waitForFunction(() => document.querySelector('.trend-window .bars')?.classList.contains('is-sliding'))
    const during = await page.evaluate(() => {
      const plot = document.querySelector('.trend-window .plot') as HTMLElement
      const lines = Array.from(document.querySelectorAll('.trend-window .gridline')) as HTMLElement[]
      const pr = plot.getBoundingClientRect()
      return {
        count: lines.length,
        full: lines.every((l) => {
          const r = l.getBoundingClientRect()
          return r.left <= pr.left + 1 && r.right >= pr.right - 1
        }),
      }
    })
    expect(during.count).toBeGreaterThanOrEqual(2)
    expect(during.full, 'every gridline spans the plot width mid-slide').toBe(true)
    await expect
      .poll(() => barKeys(page), { timeout: 3_000 })
      .toEqual(Array.from({ length: 12 }, (_, i) => `bar-2025-${String(i + 1).padStart(2, '0')}`))
  })
})

// --- topbar logo: the 520px media-query boundary ---

for (const [width, below] of [
  [520, true],
  [521, false],
] as const) {
  test.describe(`topbar logo ${width}px`, () => {
    test.use({ viewport: { width, height: 780 } })

    test('[covers:web-shell.topbar-logo-breakpoints] ロゴは 520px 境界で出し分け', async ({ page }) => {
      logPageIssues(page, `logo${width}`)
      await installApiStub(page)
      await page.goto('/')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const fact = (selector: string) => {
          const el = document.querySelector(selector) as HTMLElement | null
          if (!el) return { display: 'missing', width: 0 }
          return { display: getComputedStyle(el).display, width: el.getBoundingClientRect().width }
        }
        return { full: fact('.topbar-logo-full'), compact: fact('.topbar-logo-compact') }
      })
      // NB: the logos are flex items of .topbar-brand (inline-flex), so
      // chromium blockifies the authored `inline-flex` to computed `flex` —
      // the visible side is asserted as display != none + non-zero box
      if (below) {
        expect(m.full.display, `full@${width} ${JSON.stringify(m)}`).toBe('none')
        expect(m.compact.display, `compact@${width} ${JSON.stringify(m)}`).not.toBe('none')
        expect(m.compact.width).toBeGreaterThan(0)
      } else {
        expect(m.full.display, `full@${width} ${JSON.stringify(m)}`).not.toBe('none')
        expect(m.full.width).toBeGreaterThan(0)
        expect(m.compact.display, `compact@${width} ${JSON.stringify(m)}`).toBe('none')
      }
    })
  })
}

// --- topbar metrics: the 899px media-query boundary ---

for (const spec of [
  { width: 899, height: 780, varValue: '56px', bar: 56, font: 16 },
  { width: 900, height: 800, varValue: '60px', bar: 60, font: 18.4 },
] as const) {
  test.describe(`topbar metrics ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: spec.height } })

    test('[covers:web-shell.topbar-compact-metrics] topbar 高と表題 font-size は 899px 境界で切替', async ({ page }) => {
      logPageIssues(page, `topbar${spec.width}`)
      await installApiStub(page)
      await page.goto('/receipts')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const topbar = document.querySelector('.topbar')!
        const title = document.querySelector('.topbar-title')
        return {
          topbarVar: getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim(),
          topbarH: topbar.getBoundingClientRect().height,
          fontPx: title ? parseFloat(getComputedStyle(title).fontSize) : null,
        }
      })
      expect(m.topbarVar).toBe(spec.varValue)
      expect(Math.abs(m.topbarH - spec.bar)).toBeLessThanOrEqual(0.5)
      expect(m.fontPx, '.topbar-title is rendered on /receipts').not.toBeNull()
      expect(Math.abs(m.fontPx! - spec.font)).toBeLessThanOrEqual(0.5)
    })
  })
}

// --- TASK-44 topbar: the title's 360/390px band switch (§11-4 U10) ---
// 360px and below: no title at all (like home) / 361-390px: icon only /
// 391px+: icon + text. The TASK-101 period + search two chips must ride
// along at every band without either the title or the chips going missing.

const TITLE_BANDS = [
  { width: 360, title: 'none', text: 'none' },
  { width: 361, title: 'visible', text: 'none' },
  { width: 390, title: 'visible', text: 'none' },
  { width: 391, title: 'visible', text: 'visible' },
] as const

for (const spec of TITLE_BANDS) {
  test.describe(`topbar title ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: 780 } })

    test('[covers:web-shell.topbar-title-breakpoints-real] 表題は 360/390px 境界で出し分け（時期・検索チップとともに欠けない）', async ({ page }) => {
      logPageIssues(page, `title${spec.width}`)
      await installApiStub(page)
      await page.goto('/receipts')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const fact = (selector: string) => {
          const el = document.querySelector(selector) as HTMLElement | null
          if (!el) return { present: false, display: 'missing', width: 0 }
          return { present: true, display: getComputedStyle(el).display, width: el.getBoundingClientRect().width }
        }
        return {
          title: fact('.topbar-title'),
          text: fact('.topbar-title-text'),
          icon: fact('.topbar-title .icon'),
          chips: {
            period: !!document.querySelector('[data-test="filter-period"]'),
            search: !!document.querySelector('[data-test="filter-search"]'),
          },
        }
      })
      const dump = `${spec.width}px ${JSON.stringify(m)}`
      if (spec.title === 'none') {
        expect(m.title.display, dump).toBe('none')
      } else {
        expect(m.title.display, dump).not.toBe('none')
        expect(m.icon.width, dump).toBeGreaterThan(0)
      }
      if (spec.text === 'none') expect(m.text.display, dump).toBe('none')
      else expect(m.text.display, dump).not.toBe('none')
      // TASK-101: both two-chip bar entries are on the bar at every band
      expect(m.chips.period, dump).toBe(true)
      expect(m.chips.search, dump).toBe(true)
    })
  })
}

// --- TASK-44 topbar: the period chip's short/full label (899px boundary) ---
// 899px and below: the short label (labelShort, chip within the 56px budget)
// / 900px+: the full label (the §11-4 estimate put it around 90-100px).

for (const spec of [
  { width: 899, visible: 'short' },
  { width: 900, visible: 'full' },
] as const) {
  test.describe(`filter period label ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: 780 } })

    test('[covers:web-browse.filter-period-label-widths-real] 時期チップは 899px 境界で短縮/フルを切替（899px 以下は幅 56px 以内）', async ({ page }) => {
      logPageIssues(page, `period${spec.width}`)
      await installApiStub(page)
      await page.goto('/receipts?month=2026-10')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const chip = document.querySelector('[data-test="filter-period"]')
        if (!chip) return { missing: true as const, short: null, full: null, chipW: 0 }
        // the two width labels are separate leaf elements (a CSS media query
        // picks the visible one); identify them by their exact text
        const leaf = (t: string) =>
          Array.from(chip.querySelectorAll('*')).find(
            (e) => e.children.length === 0 && (e.textContent ?? '').trim() === t,
          ) as HTMLElement | undefined
        const fact = (el: HTMLElement | undefined) =>
          el ? { display: getComputedStyle(el).display, width: el.getBoundingClientRect().width } : null
        return {
          missing: false as const,
          short: fact(leaf('10月')),
          full: fact(leaf('2026年10月')),
          chipW: chip.getBoundingClientRect().width,
        }
      })
      const dump = `${spec.width}px ${JSON.stringify(m)}`
      expect(m.missing, 'the period chip renders').toBe(false)
      if (spec.visible === 'short') {
        expect(m.short, dump).toBeTruthy()
        expect(m.short!.display, dump).not.toBe('none')
        expect(m.full, dump).toBeTruthy()
        expect(m.full!.display, dump).toBe('none')
        // the 56px budget with 1px of tolerance
        expect(m.chipW, dump).toBeLessThanOrEqual(57)
      } else {
        expect(m.full, dump).toBeTruthy()
        expect(m.full!.display, dump).not.toBe('none')
        expect(m.short, dump).toBeTruthy()
        expect(m.short!.display, dump).toBe('none')
        // the §11-4 estimate is 90-100px; keep a generous band for font
        // rendering differences (§11-11)
        expect(m.full!.width, dump).toBeGreaterThanOrEqual(70)
        expect(m.full!.width, dump).toBeLessThanOrEqual(130)
      }
    })
  })
}

// Range mode rides the same 899px budget with its own short label
// ("10/3〜", the from date only — §11-4).

test.describe('filter period label 899px (range mode)', () => {
  test.use({ viewport: { width: 899, height: 780 } })

  test('[covers:web-browse.filter-period-label-widths-real] 範囲モードの短縮ラベル（10/3〜）も 899px では 56px 以内', async ({ page }) => {
    logPageIssues(page, 'period899range')
    await installApiStub(page)
    await page.goto('/receipts?from=2026-10-03&to=2026-10-15')
    await expect(page.locator('.topbar')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const chip = document.querySelector('[data-test="filter-period"]')
      if (!chip) return { missing: true as const, short: null, full: null, chipW: 0 }
      const leaf = (t: string) =>
        Array.from(chip.querySelectorAll('*')).find(
          (e) => e.children.length === 0 && (e.textContent ?? '').trim() === t,
        ) as HTMLElement | undefined
      const fact = (el: HTMLElement | undefined) =>
        el ? { display: getComputedStyle(el).display, width: el.getBoundingClientRect().width } : null
      return {
        missing: false as const,
        short: fact(leaf('10/3〜')),
        full: fact(leaf('2026/10/03 〜 2026/10/15')),
        chipW: chip.getBoundingClientRect().width,
      }
    })
    const dump = `899px range ${JSON.stringify(m)}`
    expect(m.missing, 'the period chip renders').toBe(false)
    expect(m.short, dump).toBeTruthy()
    expect(m.short!.display, dump).not.toBe('none')
    expect(m.full, dump).toBeTruthy()
    expect(m.full!.display, dump).toBe('none')
    // the 56px budget with 1px of tolerance
    expect(m.chipW, dump).toBeLessThanOrEqual(57)
  })
})

// --- TASK-41 /search: the two-row head at 360px and the live search flow ---
// The unit tests (search-page.test.ts) pin the URL / commit rules against the
// mock api; here chromium measures what jsdom cannot — the 360px two-row
// layout without horizontal overflow — and walks the real flow: chip ->
// dialog -> run -> /search -> result row -> feed -> back with the q context
// intact (design tmp/tasks/tm-41/design_search-tab.md §2-2 / §4-2).

test.describe('search page (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-search.layout-real] /search は 360px で検索欄行+タブ行の2行・横溢れなし。dialog 実行→遷移・行→Feed→戻るで q が保たれる', async ({ page }) => {
    logPageIssues(page, 'search360')
    await installApiStub(page)

    // run the first search from the topbar chip on another page
    await page.goto('/receipts')
    await expect(page.locator('[data-test="filter-search"]')).toBeVisible()
    await page.locator('[data-test="filter-search"]').click()
    const input = page.locator('[data-test="search-dialog-input"]')
    await expect(input).toBeVisible()
    await input.fill('牛乳')
    await page.locator('[data-test="search-dialog-submit"]').click()
    await expect(page).toHaveURL(/\/search\?q=/)
    // the route transition is still swapping the view here — wait for the
    // search page's own head before measuring (same pattern as .topbar above)
    await expect(page.locator('[data-test="search-input"]')).toBeVisible()

    // the head row (input + scope chip) and the tab row both render, and the
    // 360px page has no horizontal overflow
    const m = await page.evaluate(() => ({
      head: !!document.querySelector('.search-head'),
      tabs: !!document.querySelector('.search-tabs'),
      // TASK-77: /search carries the ledger chip since TASK-74, so at 360px
      // the search chip's q word folds away (icon-only entry)
      qFold:
        document.querySelector('.chip-label-q') === null
          ? 'missing'
          : getComputedStyle(document.querySelector('.chip-label-q')!).display,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    expect(m.head, '.search-head renders').toBe(true)
    expect(m.tabs, '.search-tabs renders').toBe(true)
    expect(m.qFold, 'the search chip q word folds away at 360px').toBe('none')
    expect(m.overflow, 'no horizontal overflow').toBeLessThanOrEqual(1)

    // the committed term renders result rows
    await expect(page.locator('[data-test="search-row"]').first()).toBeVisible()

    // a row leads to the feed with the q context; back restores the search
    await page.locator('[data-test="search-row"]').first().click()
    await expect(page).toHaveURL(/\/receipts\/\d+/)
    await expect(page.locator('[data-test^="receipt-panel-"]').first()).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/search\?q=/)
    await expect(page.locator('[data-test="search-input"]')).toHaveValue('牛乳')
    await expect(page.locator('[data-test="search-row"]').first()).toBeVisible()
  })
})

// --- TASK-105 dashboard visual: the zone headings become visible
// zone-title text, the breakdown colors become the deterministic seriesColor
// mapping shared by the trend segments and the ranked rows, and the reading
// screens gain the .dash-cols two-column layout with the .zone--list width
// tier. Written test-first: these specs are red until the implementation
// lands (design: tmp/tasks/tm-105/design_dashboard-visual.md §1 / §2 / §5 /
// §6-3). ---

test.describe('zone headings (1280x720)', () => {
  test('[covers:web-common.zone-headings-visible] 5画面のzone見出しは可視 zone-title（sr-onlyなし・文言は従来どおり）で zone-more は見出し行の右端', async ({ page }) => {
    logPageIssues(page, 'zone-titles')
    await installApiStub(page)
    // the exact heading words stay the TASK-95 sr-only wording (no new copy);
    // AxisDetail's cross/own titles are dynamic, so that screen is checked
    // structurally only. TASK-161 §5 dropped the breakdown's own heading on
    // Home (the one bar under the period header carries the zone — no
    // 「支出の内訳」 title remains)
    const screens: { path: string; titles: string[] | null }[] = [
      { path: '/', titles: ['支出の推移', '週ごとの支出', '最近のレシート'] },
      { path: '/categories?month=2026-10', titles: ['支出の推移', 'カテゴリ別'] },
      { path: '/stores?month=2026-10', titles: ['支出の推移', '店別'] },
      { path: '/axes/item/牛乳?month=2026-10', titles: null },
      { path: '/receipts?month=2026-10', titles: ['日別の支出', '支払方法', 'レシート'] },
    ]
    for (const s of screens) {
      await page.goto(s.path)
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const heads = Array.from(document.querySelectorAll('.zone h2, .zone h3'))
        return {
          titles: heads.map((h) => (h.textContent ?? '').trim()),
          empty: heads.filter((h) => !(h.textContent ?? '').trim()).length,
          srOnly: heads.filter((h) => h.classList.contains('sr-only')).length,
          noTitleClass: heads.filter((h) => !h.classList.contains('zone-title')).length,
          // a visible heading has real layout width (sr-only clips to 1px)
          clipped: heads.filter((h) => h.getBoundingClientRect().width < 10).length,
          // each heading is the left element of a .zone-head row
          noHeadRow: heads.filter((h) => !h.parentElement?.classList.contains('zone-head')).length,
          // the standalone .zone-more row is gone with its class
          zoneMoreRows: document.querySelectorAll('.zone-more').length,
        }
      })
      const dump = `${s.path} ${JSON.stringify(m)}`
      if (s.titles !== null) expect(m.titles, dump).toEqual(s.titles)
      expect(m.empty, `${dump}: every zone heading carries text`).toBe(0)
      expect(m.srOnly, `${dump}: no sr-only zone heading`).toBe(0)
      expect(m.noTitleClass, `${dump}: every zone heading is a .zone-title`).toBe(0)
      expect(m.clipped, `${dump}: every zone heading is visibly laid out`).toBe(0)
      expect(m.noHeadRow, `${dump}: every zone heading sits in a .zone-head`).toBe(0)
      expect(m.zoneMoreRows, `${dump}: the standalone .zone-more row is gone`).toBe(0)
    }
    // the guide icon links ride at the heading row's right end on Home
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const more = await page.evaluate(() => {
      const place = (sel: string) => {
        const el = document.querySelector(sel)!
        const head = el.closest('.zone-head')!
        return { inHead: !!head, isLast: head.lastElementChild === el }
      }
      // TASK-165: the breakdown zone-head (breakdown-more) is gone — the
      // heading-row grammar check now covers the surviving guides only
      return { recent: place('[data-test="recent-more"]') }
    })
    expect(more.recent.inHead).toBe(true)
    expect(more.recent.isLast).toBe(true)
  })
})

test.describe('series colors (1280x720)', () => {
  test('[covers:web-common.series-color-assignment] trend セグメント・BreakdownBar segment・/categories ranking行 swatch は同key同色（決定的写像・系列間で色が分かれる）', async ({ page }) => {
    logPageIssues(page, 'series-colors')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const colorOf = (el: Element) => getComputedStyle(el as HTMLElement).backgroundColor
      const bar = document.querySelector('[data-test="bar-2026-10"]')
      const segs = bar ? Array.from(bar.querySelectorAll('.bar-seg')) : []
      // TASK-162 §1: the Home breakdown is the ONE bar now — the series
      // segments (titled with their share form) take the rows' place
      const bdSegs = Array.from(document.querySelectorAll('[data-test="breakdown-seg"]'))
      const bdColor = (label: string) => {
        const el = bdSegs.find((s) => (s.getAttribute('title') ?? '').startsWith(label)) ?? null
        return el ? colorOf(el) : null
      }
      const segColor = (label: string) =>
        segs.find((s) => (s.getAttribute('title') ?? '').startsWith(label)) ?? null
      return {
        barPresent: !!bar,
        segCount: segs.length,
        pairs: ['食費', '日用品'].map((label) => ({
          label,
          seg: segColor(label) ? colorOf(segColor(label)!) : null,
          breakdown: bdColor(label),
        })),
      }
    })
    // …then the /categories ranking rows (the list form's swatches) keep the
    // same colors for the same keys
    await page.goto('/categories?month=2026-10')
    await page.waitForLoadState('networkidle')
    const cat = await page.evaluate(() => {
      const colorOf = (el: Element) => getComputedStyle(el as HTMLElement).backgroundColor
      const rows = Array.from(document.querySelectorAll('main .ranked-row'))
      const rowColor = (label: string) => {
        const row = rows.find((r) => (r.querySelector('.ranked-label')?.textContent ?? '').trim() === label)
        const swatch = row?.querySelector('.ranked-swatch') ?? null
        return row && swatch ? colorOf(swatch) : null
      }
      return Object.fromEntries(['食費', '日用品'].map((label) => [label, rowColor(label)]))
    })
    const dump = JSON.stringify(m)
    expect(m.barPresent, dump).toBe(true)
    // the mock month holds the two series (食費 id1 / 日用品 id4)
    expect(m.segCount, dump).toBe(2)
    for (const p of m.pairs) {
      expect(p.seg, `${p.label}: the segment renders`).not.toBeNull()
      expect(p.breakdown, `${p.label}: the breakdown-bar segment renders`).not.toBeNull()
      // 同key同色: the trend segment and the breakdown-bar segment read one
      // seriesColor
      expect(p.seg, `${p.label}: the segment and the bar segment share one color`).toBe(p.breakdown)
      // …and the /categories ranking swatch keeps the same color for the key
      expect(cat[p.label], `${p.label}: the /categories swatch renders`).not.toBeNull()
      expect(p.seg, `${p.label}: the /categories swatch shares one color`).toBe(cat[p.label])
    }
    // the two series take distinct colors (not one flat tone)
    expect(m.pairs[0]!.seg).not.toBe(m.pairs[1]!.seg)
  })
})

test.describe('zone layout columns (1280 / 375)', () => {
  test('[covers:web-common.zone-layout] 1280px は2列（trend 左・list系 右・Receipts の kpi/一覧は .dash-cols の外の全幅）・375px は1列', async ({ page }) => {
    logPageIssues(page, 'zone-cols')
    await installApiStub(page)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const place = () =>
      page.evaluate(() => {
        const fact = (sel: string) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: r.x,
            w: r.width,
            col: el.closest('.col-main') ? ('main' as const) : el.closest('.col-side') ? ('side' as const) : ('none' as const),
            inCols: !!el.closest('.dash-cols'),
          }
        }
        return {
          trend: fact('[data-test="trend-card"]'),
          week: fact('[data-test="week-card"]'),
          breakdown: fact('[data-test="breakdown"]'),
          recent: fact('[data-test="recent"]'),
        }
      })
    const home = await place()
    const homeDump = JSON.stringify(home)
    expect(home.trend, homeDump).toMatchObject({ col: 'main', inCols: true })
    expect(home.week, homeDump).toMatchObject({ col: 'side' })
    // TASK-161 §5: the breakdown zone sits DIRECTLY under the period header
    // as a full-width zone OUTSIDE .dash-cols (the one bar spans the page —
    // no column placement)
    expect(home.breakdown, homeDump).toMatchObject({ col: 'none', inCols: false })
    expect(home.recent, homeDump).toMatchObject({ col: 'side' })
    // the chart column sits left and stays wider than the list column (the
    // week zone is the side column's own)
    expect(home.trend!.x, homeDump).toBeLessThan(home.week!.x)
    expect(home.trend!.w, homeDump).toBeGreaterThan(home.week!.w)
    // …and the full-width breakdown spans wider than either column
    expect(home.breakdown!.w, homeDump).toBeGreaterThan(home.trend!.w)

    // Receipts: only daily / payments ride the two columns; the kpi summary
    // and the receipts list stay full width outside .dash-cols
    await page.goto('/receipts?month=2026-10')
    await page.waitForLoadState('networkidle')
    const rec = await page.evaluate(() => {
      const fact = (sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        return {
          col: el.closest('.col-main') ? ('main' as const) : el.closest('.col-side') ? ('side' as const) : ('none' as const),
          inCols: !!el.closest('.dash-cols'),
        }
      }
      return { kpi: fact('[data-test="summary"]'), daily: fact('[data-test="daily"]'), payments: fact('[data-test="payments"]'), list: fact('[data-test="receipts"]') }
    })
    const recDump = JSON.stringify(rec)
    expect(rec.kpi, recDump).toMatchObject({ inCols: false })
    expect(rec.list, recDump).toMatchObject({ inCols: false })
    expect(rec.daily, recDump).toMatchObject({ col: 'main' })
    expect(rec.payments, recDump).toMatchObject({ col: 'side' })

    // the phone width keeps the single column (wrapper or not, the stack
    // reads the same): one resolved track, both columns equally wide
    await page.setViewportSize({ width: 375, height: 780 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const one = await page.evaluate(() => {
      const cols = document.querySelector('.dash-cols')!
      return {
        tracks: getComputedStyle(cols).gridTemplateColumns.split(' ').length,
        mainW: (document.querySelector('.col-main') as HTMLElement).getBoundingClientRect().width,
        sideW: (document.querySelector('.col-side') as HTMLElement).getBoundingClientRect().width,
      }
    })
    expect(one.tracks, 'a single 1fr track below 48rem').toBe(1)
    expect(Math.abs(one.mainW - one.sideW)).toBeLessThanOrEqual(2)
  })
})

test.describe('zone--list width tier (700x780)', () => {
  test.use({ viewport: { width: 700, height: 780 } })

  test('[covers:web-common.zone-layout] 1列帯（608〜768px）の list zone は max-width 38rem=608px で頭打ち（chart 系 zone は全幅のまま）', async ({ page }) => {
    logPageIssues(page, 'zone-list')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="week-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const fact = (sel: string) => {
        const el = document.querySelector(sel)! as HTMLElement
        return { w: el.getBoundingClientRect().width, max: getComputedStyle(el).maxWidth }
      }
      // TASK-161 §5 + TASK-162 §1: the breakdown is the full-width one-bar
      // zone now — the list tier reads on the week zone (the surviving
      // .zone--list on this screen)
      return { week: fact('[data-test="week-card"]'), breakdown: fact('[data-test="breakdown"]'), trend: fact('[data-test="trend-card"]') }
    })
    const dump = JSON.stringify(m)
    // 38rem = 608px: the list tier caps the zone well below the 700px column
    expect(m.week.max, dump).toBe('608px')
    expect(Math.abs(m.week.w - 608), dump).toBeLessThanOrEqual(1)
    // the chart zone and the one-bar breakdown zone keep the full width (no
    // tier on either)
    expect(m.trend.max, dump).toBe('none')
    expect(m.trend.w, dump).toBeGreaterThan(m.week.w + 20)
    expect(m.breakdown.max, dump).toBe('none')
  })
})

test.describe('trend fit at the 2-column boundary (768x780)', () => {
  test.use({ viewport: { width: 768, height: 780 } })

  test('[covers:web-common.zone-layout] 2列化境界の768pxでも dense 窓（年12本）は col-main 内の hscroll に収まる（横溢れ・軸溢れなし）', async ({ page }) => {
    logPageIssues(page, 'trend-768')
    await installApiStub(page)
    // the year window is the densest: 12 bars in the narrowest col-main the
    // layout ever produces (~340px = 768 - 2x1rem .app-main padding [the
    // max-width: 899px band's] - 24rem col-side - 0.75rem gap — the shell
    // padding is a pre-TASK-105 constant the implementation keeps, so the
    // width expectation is computed from the effective content width)
    await page.goto('/?year=2026')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const card = document.querySelector('[data-test="trend-card"]')!
      const main = card.closest('.col-main')
      const hscroll = card.querySelector('.hscroll')
      const wrap = card.querySelector('.trend-wrap')
      const axis = card.querySelector('[data-test="trend-axis"]')
      return {
        barCount: card.querySelectorAll('.bar-col').length,
        mainW: main?.getBoundingClientRect().width ?? 0,
        cardW: card.getBoundingClientRect().width,
        hscroll: !!hscroll,
        // the scroll port owns the overflow: the inner track may exceed the
        // port, never the document
        wrapOverflow: wrap ? wrap.scrollWidth - wrap.clientWidth : -1,
        axisOverflow: axis ? axis.scrollWidth - axis.clientWidth : -1,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }
    })
    const dump = JSON.stringify(m)
    expect(m.barCount, dump).toBe(12)
    expect(m.mainW, dump).toBeGreaterThanOrEqual(328)
    expect(m.mainW, dump).toBeLessThanOrEqual(352)
    // the zone never widens past its column
    expect(m.cardW, dump).toBeLessThanOrEqual(m.mainW + 2)
    expect(m.hscroll, dump).toBe(true)
    // the document keeps no horizontal overflow and the axis labels stay
    // inside the scroll port
    expect(m.docOverflow, dump).toBeLessThanOrEqual(1)
    expect(m.axisOverflow, dump).toBeLessThanOrEqual(0)
  })
})

// --- TASK-124 (design tmp/tasks/tm-124/design_spa-url-routing.md v2): the
// browsing URL sync and the tabbar-外 topbar ‹, as real-browser facts. (a/c/h
// revised by TASK-164 §2-2-1: the period chip's step is a USER period change,
// so it PUSHES its own history entry — the browser back walks the stacked
// period entries one by one and restores each entry's period on import (e);
// (c) a deep link restores the label filter together with the period on Home;
// (h) the ‹ climbs to the parent section on the non-browsing side. ---

test.describe('browsing url sync + topbar back (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-browse.url-period-sync][covers:web-browse.url-pop-restore] 時期チップの送りはURLのperiod keyをpushで積み・browser戻るは期間entryを順に遡って戻り先の期間へ復元する', async ({ page }) => {
    logPageIssues(page, 'url-period')
    await installApiStub(page)
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    // two month steps through the period chip: 2026-10 -> 09 -> 08 — each a
    // USER period change, so each stacks its own entry (TASK-164 §2-2-1)
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-09/)
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-08/)
    await page.keyboard.press('Escape') // close the dialog for the tab switch
    // leave to Home through the tabbar (a keys-less push), then come back
    await page.locator('[data-test="tabbar"] a').first().click()
    // mid-swap the crossfade keeps both surfaces in the DOM, so the total
    // resolves to two nodes — wait for the swap to settle on the one Home
    // node before the visible check (a strict-mode violation otherwise)
    await expect(page.locator('[data-test="period-total"]')).toHaveCount(1)
    await expect(page.locator('[data-test="period-total"]')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
    // back #1: the stacked period entry — the categories screen at 2026-08,
    // imported: the chip shows August
    await page.goBack()
    await expect(page).toHaveURL(/\/categories\?month=2026-08/)
    await expect(page.locator('[data-test="filter-period"]')).toHaveAttribute(
      'aria-label',
      '期間で絞り込み: 2026年8月',
    )
    // back #2: the first step's entry — 2026-09
    await page.goBack()
    await expect(page).toHaveURL(/\/categories\?month=2026-09/)
    // back #3: the deep-linked entry — 2026-10
    await page.goBack()
    await expect(page).toHaveURL(/\/categories\?month=2026-10/)
    // the next back leaves the app (the initial goto entry is the boundary)
    await page.goBack()
    await expect(page).not.toHaveURL(/\/categories/)
  })

  test('[covers:web-browse.url-restore] 直リンクの labels= と期間は Home でも復元される（analysis へ label_colors 付きで流れる・URL の keys は保たれる）', async ({ page }) => {
    logPageIssues(page, 'url-restore')
    await installApiStub(page)
    const apiUrls: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/api/ledgers/1/analysis')) apiUrls.push(r.url())
    })
    await page.goto('/?labels=red&month=2026-09')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    // the analysis query carries both the deep-linked month and the label filter
    expect(
      apiUrls.some((u) => u.includes('month=2026-09') && u.includes('label_colors=red')),
      JSON.stringify(apiUrls),
    ).toBe(true)
    // the URL keeps both keys (no rewrite drops them)
    expect(new URL(page.url()).searchParams.get('labels')).toBe('red')
    expect(new URL(page.url()).searchParams.get('month')).toBe('2026-09')
  })

  test('[covers:web-shell.topbar-back] tabbar外画面のtopbar ‹ は44px・brand直後・表題直前で親sectionへ戻る（manage→データtab・search→ホーム）', async ({ page }) => {
    logPageIssues(page, 'topbar-back')
    await installApiStub(page)
    await page.goto('/settings/labels')
    const back = page.locator('[data-test="topbar-back"]')
    await expect(back).toBeVisible()
    await expect(back).toHaveAttribute('aria-label', 'データへ戻る')
    const box = await back.boundingBox()
    expect(box).toBeTruthy()
    expect(box!.width).toBeCloseTo(44, 1)
    expect(box!.height).toBeCloseTo(44, 1)
    // the ‹ sits right after the brand and right before the topbar title
    const order = await page.evaluate(() =>
      Array.from(document.querySelector('header.topbar')!.children).map((el) => ({
        test: el.getAttribute('data-test'),
        brand: el.classList.contains('topbar-brand'),
        title: el.tagName === 'H1',
      })),
    )
    const dump = JSON.stringify(order)
    const idx = order.findIndex((o) => o.test === 'topbar-back')
    expect(idx, dump).toBeGreaterThan(order.findIndex((o) => o.brand))
    expect(idx, dump).toBeLessThan(order.findIndex((o) => o.title))
    await back.click()
    await expect(page).toHaveURL(/\/settings\/data$/)

    // TASK-164 §2-4: /search moved to the browsing side — a direct link sits
    // at the boundary, and its ‹ (label 戻る, not the parentTo wording)
    // climbs to the fallback parent '/' instead of leaving the app
    await page.goto('/search')
    await expect(page.locator('[data-test="topbar-back"]')).toHaveAttribute('aria-label', '戻る')
    await page.locator('[data-test="topbar-back"]').click()
    expect(new URL(page.url()).pathname).toBe('/')
    // the root browsing screens at a direct link (the boundary) hide the ‹;
    // the feed keeps none at all
    for (const path of ['/', '/categories?month=2026-10', '/receipts', '/receipts/101']) {
      await page.goto(path)
      expect(await page.locator('[data-test="topbar-back"]').count(), path).toBe(0)
    }
    // the axis detail carries the browsing ‹ instead — the PageHead ‹ is
    // gone (TASK-164 §2-6: the ‹ restores the history entry, carries none)
    await page.goto('/axes/category/1?month=2026-10')
    await expect(page.locator('[data-test="topbar-back"]')).toBeVisible()
    await expect(page.locator('.page-head [data-test="page-back"]')).toHaveCount(0)
  })
})

// TASK-164 (design: tmp/tasks/tm-164/design_back_home.md v4): the browsing
// back and the home re-press in the real browser, where the history stack,
// the saved scroll positions and the navigation positions are all real.
// §2-2-1: the user's period changes push onto the browser history and the ‹
// (router.back()) walks them back — a step, a jump and a mode switch each
// undo with one press; §2-6 landing: Home(5月) → Axis(5月) → Axis 6月 → ‹1
// Axis(5月) → ‹2 Home(5月); §1: the home re-press (the tabbar home tab on
// the home route) returns to the default period without a navigation; §2-4:
// a direct link is the boundary — the root screens hide the ‹, the axes
// climb the static fallback; §2-2-2: a period pop keeps the scroll (the
// same-path rule) while a cross-screen pop restores the saved position.
// Written test-first — red until the implementation lands.
test.describe('back + home re-press (TASK-164, 390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-browse.url-user-period-push][covers:web-shell.browsing-back] 期間step・jump・mode切替は履歴に積み ‹ でそれぞれ1回で戻る', async ({ page }) => {
    logPageIssues(page, 'task164-back')
    await installApiStub(page)
    // step: 2026-10 → 09, and one ‹ returns to 10
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-09/)
    await page.keyboard.press('Escape')
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/categories\?month=2026-10/)
    await expect(page.locator('[data-test="filter-period"]')).toHaveAttribute(
      'aria-label',
      '期間で絞り込み: 2026年10月',
    )
    // jump: a trend bar press (2026-05) → ‹ returns to October
    await page.locator('[data-test="bar-2026-05"]').click()
    await expect(page).toHaveURL(/month=2026-05/)
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/categories\?month=2026-10/)
    // mode switch: year → ‹ returns to the month
    await page.locator('[data-test="filter-period"]').click()
    await page.locator('[data-test="mode-year"]').click()
    await expect(page).toHaveURL(/year=2026/)
    await page.keyboard.press('Escape')
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/categories\?month=2026-10/)
  })

  test('[covers:web-shell.home-repress-reset] homeで期間移動 → home再押下（tabbar）でデフォルト期間（当月）へ復帰・labelsは維持', async ({ page }) => {
    logPageIssues(page, 'task164-home')
    await installApiStub(page)
    await page.goto('/?labels=red')
    await expect(page.locator('[data-test="period-total"]')).toBeVisible()
    // move the period away (May) through a bar press
    await page.locator('[data-test="bar-2026-05"]').click()
    await expect(page).toHaveURL(/month=2026-05/)
    // the home re-press: no navigation — the URL (and the store) return to
    // the default period, the label filter rides along (B1)
    await page.locator('[data-test="tabbar"] a').first().click()
    await expect(page).toHaveURL(/month=2026-10/)
    expect(new URL(page.url()).pathname).toBe('/')
    expect(new URL(page.url()).searchParams.get('labels')).toBe('red')
    await expect(page.locator('.period-label')).toHaveText('2026年10月')
  })

  test('[covers:web-browse.nav-boundary] 直リンク（境界）: ルート画面は ‹ 非表示・axes は fallback で親へ（境界更新で往復なし）・Axis期間変更→‹2回で Home', async ({ page }) => {
    logPageIssues(page, 'task164-boundary')
    await installApiStub(page)
    // a direct link IS the boundary: the root screens hide the ‹
    for (const path of ['/categories?month=2026-10', '/receipts', '/']) {
      await page.goto(path)
      expect(await page.locator('[data-test="topbar-back"]').count(), path).toBe(0)
    }
    // the axes keep theirs (a static fallback parent) and climb instead of
    // leaving the app — and the fallback moved the boundary: no ‹ on the
    // list (no axis → list → axis ping-pong)
    await page.goto('/axes/category/1?month=2026-10')
    await expect(page.locator('[data-test="topbar-back"]')).toBeVisible()
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/categories/)
    await expect(page.locator('[data-test="topbar-back"]')).toHaveCount(0)

    // the §2-6 landing with real in-app pushes, drilled from a month the
    // stub has receipts for (the axis-side DATA is irrelevant to the URL /
    // history assertions — only the period keys need to ride): Home(10月) →
    // Axis(10月) → Axis 11月 → ‹1 Axis(10月) → ‹2 Home(10月)
    await page.goto('/')
    await expect(page.locator('[data-test="period-total"]')).toBeVisible()
    // drill into the axis through the breakdown segment (a push carrying
    // the period)
    await page.locator('[data-test="breakdown-seg"]').first().click()
    await expect(page).toHaveURL(/\/axes\//)
    await expect(page).toHaveURL(/month=2026-10/)
    // the axis moves its own period (11月) — another push
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-next"]')).toBeVisible()
    await page.locator('[data-test="period-next"]').click()
    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(/month=2026-11/)
    // ‹1: back to the axis at October (the entry's state restores)
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/axes\/.*month=2026-10/)
    // ‹2: back to Home at October
    await page.locator('[data-test="topbar-back"]').click()
    await expect(new URL(page.url()).pathname).toBe('/')
    await expect(page).toHaveURL(/month=2026-10/)
  })

  test('[covers:web-browse.period-pop-scroll] 期間pop（同一path）はscrollに介入しない（scrollTo呼出なし）・画面をまたぐpopは保存位置へ復元', async ({ page }) => {
    logPageIssues(page, 'task164-scroll')
    await installApiStub(page)
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    // scroll partway down (the stub page scrolls only ~56px — a hardcoded
    // target both clamps and races the content swap, and the month's own
    // layout change shifts scrollY through the browser's scroll anchoring),
    // so the same-path half asserts the DESIGN fact directly: nothing calls
    // window.scrollTo around the period pop — no {top:0}, no savedPosition
    // restore, the viewport is simply left alone
    await page.evaluate(() => window.scrollTo(0, 150))
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const scrolls: unknown[][] = []
      const orig = window.scrollTo
      // both overloads of window.scrollTo, so the wrapper is assignable
      // without a cast
      function wrapped(x: number, y: number): void
      function wrapped(options?: ScrollToOptions): void
      function wrapped(a: number | ScrollToOptions | undefined, b?: number): void {
        scrolls.push([a, b])
        if (typeof a === 'number') orig(a, b ?? 0)
        else orig(a)
      }
      window.scrollTo = wrapped
      window.__periodPopScrolls = scrolls
    })
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-09/)
    await page.keyboard.press('Escape')
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/month=2026-10/)
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => window.__periodPopScrolls?.length ?? -1)).toBe(0)

    // a cross-screen pop RESTORES the saved position — with fixtures tall
    // enough for a real non-zero position and a position CHANGE across the
    // navigation (a zero-position or unchanged-position fixture would pass
    // even with no restore at all — REVIEW-12 #5). The axis detail scrolls
    // ~284px at this viewport. Different pageKey first: the axis → Home
    await page.goto('/axes/category/1?month=2026-10')
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)
    await page.evaluate(() => window.scrollTo(0, 200))
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(200)
    await page.locator('[data-test="tabbar"] a').first().click()
    await expect(page).toHaveURL(/\/\?month=/)
    // the away screen sits at a DIFFERENT position (a cross-pageKey push
    // goes to the top)
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBeLessThan(200)
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/axes\/category\/1/)
    await expect
      .poll(async () => page.evaluate(() => Math.round(window.scrollY)), { timeout: 3_000 })
      .toBe(200)

    // same pageKey, different path: the category axis → the store axis
    // through the cross ranking row (the pageKey collides on 'axes'; the
    // PATH decides). The same-pageKey push does not scroll, so move the
    // away screen to the top first — only the pop's savedPosition restore
    // can bring the 240 back
    await page.waitForTimeout(300)
    await page.evaluate(() => window.scrollTo(0, 240))
    await page.waitForTimeout(150)
    await page.locator('[data-test="cross"] a').first().click()
    await expect(page).toHaveURL(/\/axes\/store\/1/)
    await page.waitForTimeout(200)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.waitForTimeout(150)
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0)
    await page.locator('[data-test="topbar-back"]').click()
    await expect(page).toHaveURL(/\/axes\/category\/1/)
    await expect
      .poll(async () => page.evaluate(() => Math.round(window.scrollY)), { timeout: 3_000 })
      .toBe(240)
  })
})

// TASK-161 (design: tmp/tasks/tm-161/design_period_ui.md v2): the period-UI
// rework's browser facts — the §0-2 regression (focusing September keeps
// October's bar and its lead, 指摘1/2), the period step pair's 44px tap
// targets (指摘4), the breakdown's absolute ticks at the five step positions
// (指摘7) and the in-bar series labels on the week rows (指摘8). Written
// test-first: red until the implementation lands (mise run frontend:browser).
test.describe('period UI rework (TASK-161, 390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-home.trend-window-absolute] 9月focus後も10月barが存在し押せる（指摘1回帰: 窓は再anchorされない）・step pairは44px tap target', async ({ page }) => {
    logPageIssues(page, 'task161-focus')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    // focus September (a bar INSIDE the committed window): the window must
    // not re-anchor — October's bar stays in the DOM, visible and pressable
    await page.locator('[data-test="bar-2026-09"]').click()
    await page.waitForLoadState('networkidle')
    const oct = page.locator('[data-test="bar-2026-10"]')
    await expect(oct).toBeVisible()
    // the lead survives: pressing October moves the focus back
    await oct.click()
    await expect(page.locator('.period-label')).toHaveText('2026年10月')
    // the period step pair: 44px tap targets bracketing the label (指摘4)
    for (const t of ['period-step-prev', 'period-step-next']) {
      const box = await page.locator(`[data-test="${t}"]`).boundingBox()
      expect(box, t).not.toBeNull()
      expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44)
    }
  })

  test('[covers:web-home.breakdown-absolute-ticks][covers:web-common.axis-ticks] 内訳1本barの絶対目盛りは5段階をtrack幅の0/25/50/75/100%に置く（.breakdown-ticks・tick-0は値labelなし）・週行のbar内labelは幅が足りるsegmentに表示', async ({ page }) => {
    logPageIssues(page, 'task162-breakdown')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="period-total"]')).toBeVisible()
    const m = await page.evaluate(() => {
      const ticks = Array.from(document.querySelectorAll('[data-test^="breakdown-tick-"]'))
      // TASK-162 §1-5: the graduation rides the ONE bar's track (the
      // .ranked-bar-track of the old row list is gone with the rows)
      const carrier = document.querySelector('.breakdown-ticks')
      const track = document.querySelector('[data-test="breakdown-track"]')
      const trackRect = (track ?? carrier)?.getBoundingClientRect() ?? null
      // the in-bar label hook rides inside the segment (the exact element
      // kind is the implementation's; any text child of the leading week
      // segment counts)
      const seg = document.querySelector('[data-test="week-card"] .row-seg')
      return {
        carrier: carrier !== null,
        ticks: ticks.map((el) => ({
          id: el.getAttribute('data-test'),
          left: trackRect ? (el.getBoundingClientRect().left - trackRect.left) / trackRect.width : -1,
          text: el.textContent?.trim() ?? '',
        })),
        segLabel: seg?.textContent?.trim() ?? null,
      }
    })
    // the graduation lives in the renamed .breakdown-ticks carrier (the
    // .ranked-ticks vocabulary is gone — §1-5)
    expect(m.carrier).toBe(true)
    // the five steps at 0 / .25 / .5 / .75 / 1 of the track (axisTicksOf
    // steps=4), the base keeping its gridline without a value label
    expect(m.ticks.map((t) => t.id)).toEqual([
      'breakdown-tick-0',
      'breakdown-tick-1',
      'breakdown-tick-2',
      'breakdown-tick-3',
      'breakdown-tick-4',
    ])
    for (const [i, t] of m.ticks.entries()) expect(t.left, t.id!).toBeCloseTo(i / 4, 2)
    expect(m.ticks[0]!.text).toBe('')
    expect(m.ticks[4]!.text).not.toBe('')
    // the week row's in-bar label: the measured track fits the leading
    // segment, so the series name renders inside the bar (11px/600 / contrast)
    expect(m.segLabel).not.toBeNull()
    expect(m.segLabel!.length).toBeGreaterThan(0)
  })
})

// TASK-162 (design: tmp/tasks/tm-162/design_breakdown_stack.md v2): the
// vertical bars' in-segment labels (upright vertical-rl, the labelMin fold
// guaranteeing every drawn segment houses a label), the year tick row (the
// month labels go always-short, the year rides its own row and follows the
// slide machinery), and the bar-width/margin rework (48px cap, the nav pair
// outside the middle column). Test-first: red until the implementation
// lands.
test.describe('TASK-162 vertical segment labels / year ticks / bar width (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-browse.trend-bar-segment-label] 縦棒の全segmentに直立縦書きlabel（6字名も・labelMin foldで存在するseries segmentはすべて26px以上・例外Aのbarはlabelなし）・label文字矩形はsegment内に収まる・Receipts day/week/monthも同一class', async ({ page }) => {
    logPageIssues(page, 'task162-vlabel')
    await installApiStub(page)
    // a month window whose buckets exercise the whole §2 rule set (the
    // bars' px heights ride the 80px bar area at this viewport, niceMax
    // 1000): 2026-10 a 6-char name series + a tiny one that folds (交通
    // 48 = 5.1% > the 5% share fold, but ~3.8px < the 26px labelMin ->
    // folds via labelMin); 2026-09 the 6-char name alone; 2026-08 a
    // sub-26px TOTAL (例外A: the bar itself is too small to read — no
    // label at all)
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis/trend' && url.searchParams.get('granularity') === 'month',
      async (route) => {
        const body = {
          axis: 'category',
          metric: 'amount',
          granularity: 'month',
          period: { from: '2026-05-01', to: '2026-10-31', label: '2026-05〜10' },
          buckets: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'],
          series: [
            { key: 8, label: '医療・健康', values: [0, 0, 0, 0, 900, 900], total: 1800 },
            { key: 2, label: '交通', values: [0, 0, 0, 0, 0, 48], total: 48 },
          ],
          bucket_totals: [0, 0, 0, 30, 900, 948],
          truncated_rows: 0,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const readBar = (key: string) => {
        const col = document.querySelector(`[data-test="bar-${key}"]`)
        const stack = col?.querySelector('.bar-stack') ?? null
        const segs = stack ? Array.from(stack.querySelectorAll('.bar-seg')) : []
        return {
          present: stack !== null,
          stackH: stack ? stack.getBoundingClientRect().height : 0,
          segs: segs.map((s) => {
            const label = s.querySelector('.bar-seg-label')
            const sr = s.getBoundingClientRect()
            const lr = label ? label.getBoundingClientRect() : null
            const cs = label ? getComputedStyle(label) : null
            return {
              title: s.getAttribute('title') ?? '',
              label: label ? (label.textContent ?? '').trim() : null,
              writingMode: cs ? cs.writingMode : '',
              orientation: cs ? cs.textOrientation : '',
              // the label's glyph box must stay INSIDE the segment
              inside: lr ? lr.top >= sr.top - 0.5 && lr.bottom <= sr.bottom + 0.5 && lr.left >= sr.left - 0.5 && lr.right <= sr.right + 0.5 : false,
              h: sr.height,
            }
          }),
        }
      }
      return { oct: readBar('2026-10'), sep: readBar('2026-09'), aug: readBar('2026-08') }
    })
    const dump = JSON.stringify(m)
    // 2026-10: the tiny 交通 folded into「ほか」via the labelMin rule — the
    // drawn series segments are the 6-char name + the rest, EVERY series
    // segment labelled, all series segments >= 26px tall, and the upright
    // vertical writing on every LABELLED segment (the folded rest lands at
    // 3.8px — 例外B keeps it colour-only with its title)
    expect(m.oct.present, dump).toBe(true)
    for (const s of m.oct.segs) {
      if (!s.title.startsWith('ほか')) {
        expect(s.label, `${s.title}: every series segment carries a label`).not.toBeNull()
        expect(s.writingMode, `${s.title}: the upright vertical writing`).toBe('vertical-rl')
        expect(s.orientation, `${s.title}: the glyphs stand upright`).toBe('upright')
        expect(s.h, `${s.title}: the labelMin fold leaves no sub-26px series segment`).toBeGreaterThanOrEqual(26)
        expect(s.inside, `${s.title}: the label stays inside the segment`).toBe(true)
      }
    }
    // the 6-char name renders in FULL (the vertical direction absorbs it)
    expect(m.oct.segs[0]!.label).toBe('医療・健康')
    // 2026-09: the single series bar carries its own label
    expect(m.sep.segs[0]!.label).toBe('医療・健康')
    // 2026-08: a sub-26px TOTAL — 例外A, no label on anything (the bar
    // itself is beneath readability)
    expect(m.aug.stackH, dump).toBeLessThan(26)
    for (const s of m.aug.segs) expect(s.label, dump).toBeNull()
    // …and the Receipts bars (the OTHER vertical-bar DOM) read the same
    // shared class at every granularity: day (a month), week (a 3-month
    // range), month (a year)
    for (const [path, gran] of [
      ['/receipts?month=2026-10', 'day'],
      ['/receipts?from=2026-09-01&to=2026-11-30', 'week'],
      ['/receipts?year=2026', 'month'],
    ] as const) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const rec = await page.evaluate(() => {
        const segs = Array.from(document.querySelectorAll('.daily-seg'))
        // review 高1: the label's glyph box must stay INSIDE its segment on
        // the Receipts bars too — the whole-period day grid (31 columns) at
        // 360px once solved cells to ~7px and hung the labels outside (the
        // track floor + the .hscroll vessel keep every cell at label width)
        const outside = segs.filter((s) => {
          const label = s.querySelector('.bar-seg-label')
          if (!label) return false
          const sr = s.getBoundingClientRect()
          const lr = label.getBoundingClientRect()
          return !(lr.top >= sr.top - 0.5 && lr.bottom <= sr.bottom + 0.5 && lr.left >= sr.left - 0.5 && lr.right <= sr.right + 0.5)
        }).length
        return {
          segCount: segs.length,
          labelled: segs.filter((s) => s.querySelector('.bar-seg-label') !== null).length,
          writing: segs.length > 0 ? getComputedStyle(segs[0]!.querySelector('.bar-seg-label') ?? segs[0]!).writingMode : '',
          outside,
        }
      })
      // a labelled record day exists in the mock for each granularity; every
      // drawn segment that clears the labelMin bar carries the shared
      // vertical label class
      expect(rec.segCount, `${gran}: segments render`).toBeGreaterThan(0)
      expect(rec.labelled, `${gran}: the vertical labels render`).toBeGreaterThan(0)
      expect(rec.writing, `${gran}: the shared class paints vertical-rl`).toBe('vertical-rl')
      expect(rec.outside, `${gran}: every label box stays inside its segment`).toBe(0)
    }
  })

  test('[covers:web-browse.trend-year-ticks] 年tick行: 月labelは常に短形式・年は上位行（先頭の年+年境界・間引きに独立）・年月の文字矩形は非交差・slide（prev）後も新窓基準で一致', async ({ page }) => {
    logPageIssues(page, 'task162-years')
    await installApiStub(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // a cross-year 6-month window (2025-10..2026-03): the month labels stay
    // SHORT everywhere (the full "YYYY年M月" form is gone), the year row
    // reads 2025 at the head + 2026 at the January cell
    await page.goto('/categories?month=2026-03')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const axis = document.querySelector('[data-test="trend-axis"]')
      const years = document.querySelector('[data-test="axis-years"]')
      const monthSpans = axis ? Array.from(axis.querySelectorAll('span')) : []
      const yearSpans = years ? Array.from(years.querySelectorAll('span')) : []
      return {
        months: monthSpans.map((s) => (s.textContent ?? '').trim()).filter((t) => t !== ''),
        anyFullForm: monthSpans.some((s) => /^\d{4}年/.test((s.textContent ?? '').trim())),
        years: yearSpans.map((s) => ({ text: (s.textContent ?? '').trim(), test: s.getAttribute('data-test') ?? '' })),
        // the year and month glyph boxes must not intersect (§5-3)
        overlap: (() => {
          for (const y of yearSpans) {
            const yr = y.getBoundingClientRect()
            for (const s of monthSpans) {
              const sr = s.getBoundingClientRect()
              if (sr.width === 0) continue
              const inter = !(yr.right <= sr.left || sr.right <= yr.left || yr.bottom <= sr.top || sr.bottom <= yr.top)
              if (inter) return true
            }
          }
          return false
        })(),
        // the January cell's month label may be thinned out — the year tick
        // still sits on it (independence from the month thinning)
        axisGrid: axis ? getComputedStyle(axis).gridTemplateColumns : '',
        yearsGrid: years ? getComputedStyle(years).gridTemplateColumns : '',
      }
    })
    const dump = JSON.stringify(m)
    // the month row: short form only, both ends kept. 2月 drops out at this
    // width: it sits ADJACENT to the window-end 3月 and the pair breaks the
    // width rule's spacing (est. 28px + the 32px margin > the ~43px pitch),
    // and the TASK-42 both-ends contract outranks the spacing — the end
    // label stays, its neighbor goes
    expect(m.anyFullForm, `${dump}: no full-form month label`).toBe(false)
    expect(m.months).toEqual(['10月', '12月', '3月'])
    // the year row: the window's start year + the January boundary
    expect(m.years.map((y) => y.text)).toEqual(['2025', '2026'])
    expect(m.years.map((y) => y.test)).toEqual(['axis-year-2025', 'axis-year-2026'])
    // no glyph intersection between the two rows
    expect(m.overlap, 'the year and month glyph boxes do not intersect').toBe(false)
    // the year row shares the month row's grid (the same columns)
    expect(m.yearsGrid).toBe(m.axisGrid)
    // slide one window back (reduced motion: instant trim): the window pages
    // 6 months, so 2025-10..2026-03 lands on 2025-04..2025-09 — one year
    // alone. The ticks recompute on the NEW window's own reading: the old
    // window's 2026 January boundary left with it (a stale reading would
    // still carry 2026), and the head reads the new window's year alone
    await page.locator('[data-test="trend-prev"]').click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(400)
    const after = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="axis-years"] span')).map((s) => (s.textContent ?? '').trim()),
    )
    expect(after).toEqual(['2025'])
    // the month labels stay short after the slide too
    const monthsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="trend-axis"] span'))
        .map((s) => (s.textContent ?? '').trim())
        .filter((t) => t !== ''),
    )
    expect(monthsAfter.some((t) => /^\d{4}年/.test(t))).toBe(false)
  })

  // TASK-162 §5-4/§5-7 (review 中7): the year row rides the slide machinery
  // and its ticks are computed PER WINDOW — a MID-SLIDE frame (a year
  // boundary crossing the viewport) must already sit exactly where the trim
  // leaves it. The coordinate read: the tick's offset to ITS OWN January
  // cell's center (cell-relative, so the shared translateX of the row never
  // contaminates the comparison), sampled during the 220ms move and again
  // after the trim.
  test('[covers:web-browse.trend-year-ticks] slide中（年境界をまたぐframe）とtrim後の年tick位置一致（新窓基準の窓ごと計算・trim不変）・.axis-yearsはslide全工程で.bars/.axis-labelsと同一処理', async ({ page }) => {
    logPageIssues(page, 'task162-years-slide')
    await installApiStub(page)
    // NO reduced-motion emulation: the slide must actually run its 220ms.
    // The committed window 2026-04..2026-09 slides PREV onto 2025-10..2026-03
    // — the new window CROSSES the 2026-01 boundary, so mid-slide the row
    // reads the NEW window's own ticks (2025 at its head + 2026 at the
    // January cell) while the old window's months still hang at the left
    await page.goto('/categories?month=2026-09')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const readTicks = () =>
      page.evaluate(() => {
        const years = document.querySelector<HTMLElement>('[data-test="axis-years"]')
        const bars = document.querySelector<HTMLElement>('.bars')
        const tick = document.querySelector<HTMLElement>('[data-test="axis-year-2026"]')
        const janBar = document.querySelector<HTMLElement>('[data-test="bar-2026-01"]')
        const cs = years ? getComputedStyle(years) : null
        const barsCs = bars ? getComputedStyle(bars) : null
        return {
          sliding: years ? years.classList.contains('is-sliding') : false,
          transform: cs ? cs.transform : '',
          barsTransform: barsCs ? barsCs.transform : '',
          cols: years ? years.style.gridTemplateColumns : '',
          ticks: Array.from(document.querySelectorAll('[data-test="axis-years"] span')).map((s) => (s.textContent ?? '').trim()),
          // the 2026 tick's center against ITS January cell's center (px)
          offset:
            tick && janBar
              ? tick.getBoundingClientRect().left + tick.offsetWidth / 2 - (janBar.getBoundingClientRect().left + janBar.offsetWidth / 2)
              : null,
        }
      })
    await page.locator('[data-test="trend-prev"]').click()
    // sample INSIDE the 220ms move (the row wears .is-sliding and a real
    // transform — the same treatment .bars/.axis-labels take)
    await page.waitForTimeout(90)
    const mid = await readTicks()
    // the trim lands after the 220ms transition + the report/patch frames
    await page.waitForTimeout(700)
    const post = await readTicks()
    const dump = JSON.stringify({ mid, post })
    // mid-slide: the year row rides the machinery — is-sliding, a pinned
    // grid, a live transform (the same matrix family .bars wears)
    expect(mid.sliding, dump).toBe(true)
    expect(mid.transform, dump).not.toBe('none')
    expect(mid.transform, dump).toBe(mid.barsTransform)
    expect(mid.cols, dump).not.toBe('')
    // the NEW window's own reading both sides of the trim (2026-01's tick
    // survives the trim — a whole-window reading would drop it)
    expect(mid.ticks, dump).toEqual(['2025', '2026'])
    expect(post.ticks, dump).toEqual(['2025', '2026'])
    expect(post.sliding, dump).toBe(false)
    // the coordinate equality: the tick sits centered on its January cell
    // mid-slide AND after the trim, at the SAME offset (trim invariance)
    expect(mid.offset, dump).not.toBeNull()
    expect(Math.abs(mid.offset!), dump).toBeLessThanOrEqual(1)
    expect(Math.abs(post.offset!), dump).toBeLessThanOrEqual(1)
    expect(Math.abs((mid.offset ?? 0) - (post.offset ?? 0)), dump).toBeLessThanOrEqual(1)
  })

  // TASK-162 §5-3 (review 中5): the year row's END-cell flush, selected by
  // CELL POSITION (the component's is-edge-start/end classes — never the DOM
  // order, which the per-window slide reading reorders). Above the ≤420px
  // band the DENSE windows (cells ~17-30px < the ~28px year label) flush
  // their end ticks so the label grows INTO the plot instead of hanging past
  // its edge; a mid-window January keeps its centered cell.
  test('[covers:web-browse.trend-year-ticks] 年tick端部flush: 端cellの年tick（dense両端・右端1月cell）は端寄せでplot外へはみ出さずphantom scrollも生じない', async ({ page }) => {
    logPageIssues(page, 'task162-years-edge')
    await installApiStub(page)
    // 430px: above the ≤420px narrow band, inside the dense cell squeeze
    // (12 cells ≈ 25px < the ≈28px year label)
    await page.setViewportSize({ width: 430, height: 780 })
    await page.goto('/categories?year=2026')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const head = await page.evaluate(() => {
      const plot = document.querySelector<HTMLElement>('.plot')
      const tick = document.querySelector<HTMLElement>('[data-test="axis-year-2026"]')
      return {
        plotLeft: plot ? plot.getBoundingClientRect().left : 0,
        tickLeft: tick ? tick.getBoundingClientRect().left : 0,
        edgeClass: tick ? tick.className : '',
      }
    })
    // the head tick sits ON cell 1: start-flushed, its box never crosses the
    // plot's left edge (centered, the ≈28px label on the ≈25px cell hung
    // past it) — and the class (not the DOM order) carries the edge
    expect(head.edgeClass, JSON.stringify(head)).toContain('is-edge-start')
    expect(head.tickLeft, 'the head year tick flushes inside the plot').toBeGreaterThanOrEqual(head.plotLeft - 0.5)
    // a January-ENDING dense window (a 14-month range): the boundary tick on
    // the LAST cell end-flushes — centered it would hang past the plot's
    // right edge and feed the scroll port a phantom scroll
    await page.goto('/categories?from=2025-01-01&to=2026-01-31')
    await page.waitForLoadState('networkidle')
    const tail = await page.evaluate(() => {
      const plot = document.querySelector<HTMLElement>('.plot')
      const scroll = document.querySelector<HTMLElement>('[data-test="trend-card"] .hscroll')
      const tick2026 = document.querySelector<HTMLElement>('[data-test="axis-year-2026"]')
      const tick2025 = document.querySelector<HTMLElement>('[data-test="axis-year-2025"]')
      return {
        plotLeft: plot ? plot.getBoundingClientRect().left : 0,
        plotRight: plot ? plot.getBoundingClientRect().right : 0,
        tick2026Right: tick2026 ? tick2026.getBoundingClientRect().right : 0,
        tick2025Left: tick2025 ? tick2025.getBoundingClientRect().left : 0,
        edge2026: tick2026 ? tick2026.className : '',
        edge2025: tick2025 ? tick2025.className : '',
        phantom: scroll ? scroll.scrollWidth - scroll.clientWidth : -1,
      }
    })
    const tdump = JSON.stringify(tail)
    expect(tail.edge2025, tdump).toContain('is-edge-start')
    expect(tail.edge2026, tdump).toContain('is-edge-end')
    expect(tail.tick2025Left, `${tdump}: the head flushes inside the left edge`).toBeGreaterThanOrEqual(tail.plotLeft - 0.5)
    expect(tail.tick2026Right, `${tdump}: the January-end tick flushes inside the right edge`).toBeLessThanOrEqual(tail.plotRight + 0.5)
    expect(tail.phantom, `${tdump}: no phantom scroll feeds the port`).toBeLessThanOrEqual(1)
  })

  test('[covers:web-browse.trend-bar-width-margin] bar幅48px（--trend-bar-w一元・day粒度の最小cellでも縦書きlabel余白）・nav対は中列外（plot上端帯・中列は≈300px帯）・余白は外側/cell内の分類で測定', async ({ page }) => {
    logPageIssues(page, 'task162-margin')
    await installApiStub(page)
    // the desktop middle column reads the full 48px cap
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const wide = await page.evaluate(() => {
      const stack = document.querySelector<HTMLElement>('.bar-stack')
      const nav = document.querySelector<HTMLElement>('[data-test="trend-prev"]')
      const navNext = document.querySelector<HTMLElement>('[data-test="trend-next"]')
      const plot = document.querySelector<HTMLElement>('.plot')
      const zone = nav ? nav.closest<HTMLElement>('.zone') : null
      // the zone's CONTENT edge (inside the border + padding — §6-5 measures
      // zone content -> plot; clientLeft is the border only, the padding
      // rides the computed style)
      const zs = zone ? getComputedStyle(zone) : null
      const padL = zs ? Number.parseFloat(zs.paddingLeft) : 0
      const padR = zs ? Number.parseFloat(zs.paddingRight) : 0
      const contentLeft = zone ? zone.getBoundingClientRect().left + zone.clientLeft + padL : 0
      const contentRight = zone ? contentLeft + zone.clientWidth - padL - padR : 0
      return {
        barW: stack ? stack.getBoundingClientRect().width : 0,
        navH: nav ? nav.getBoundingClientRect().height : 0,
        // review 中7: the nav pair's placement must discriminate the OLD
        // side-column layout (the pair flanked the middle column OUTSIDE the
        // plot's x-span) from the absolute top band (the pair sits OVER the
        // plot's x-span) — "not a child of .plot" alone was vacuous
        navOverPlot:
          nav && navNext && plot
            ? nav.getBoundingClientRect().right > plot.getBoundingClientRect().left && navNext.getBoundingClientRect().left < plot.getBoundingClientRect().right
            : false,
        navTopInsideZone: nav && zone ? nav.getBoundingClientRect().top >= zone.getBoundingClientRect().top : false,
        // the margin split: the OUTER margin (zone content edge -> plot
        // edge, both sides) — §6-5's assertion basis: the old side columns
        // added their 44px+gap to the LEFT; the composed layout reads just
        // the y gutter (2.25rem) + the column gap (0.25rem) = 40px, and the
        // right margin collapses to ~0
        outerLeft: plot && zone ? plot.getBoundingClientRect().left - contentLeft : 0,
        outerRight: plot && zone ? contentRight - plot.getBoundingClientRect().right : 0,
        plotW: plot ? plot.getBoundingClientRect().width : 0,
      }
    })
    expect(wide.barW).toBeCloseTo(48, 0)
    expect(wide.navH).toBeGreaterThanOrEqual(44)
    expect(wide.navOverPlot, 'the pair rides over the plot band (the old side columns would flank it)').toBe(true)
    expect(wide.navTopInsideZone).toBe(true)
    // §6-5: the outer margins — left = the y gutter + the column gap alone
    // (40px ± 1), right ≈ 0 (the old layout read ~100px left: the pair's
    // 44px column + gap + gutter)
    expect(wide.outerLeft).toBeGreaterThanOrEqual(39)
    expect(wide.outerLeft).toBeLessThanOrEqual(41)
    expect(wide.outerRight).toBeLessThanOrEqual(1)
    // …and the narrow band: the middle column reclaims the nav pair's width
    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto('/categories?month=2026-10')
    await page.waitForLoadState('networkidle')
    const narrow = await page.evaluate(() => {
      const win = document.querySelector<HTMLElement>('.trend-window')
      const plot = document.querySelector<HTMLElement>('.plot')
      const col = document.querySelector<HTMLElement>('.bar-col')
      const stack = document.querySelector<HTMLElement>('.bar-stack')
      const nav = document.querySelector('[data-test="trend-prev"]')
      return {
        windowW: win ? win.clientWidth : 0,
        plotW: plot ? plot.getBoundingClientRect().width : 0,
        cellW: col ? col.getBoundingClientRect().width : 0,
        barW: stack ? stack.getBoundingClientRect().width : 0,
        // the per-cell bar gap (cell - bar), the §6-5 (b) measurement
        cellGap: col && stack ? col.getBoundingClientRect().width - stack.getBoundingClientRect().width : -1,
        navPresent: nav !== null,
      }
    })
    // the middle column is no longer squeezed by the nav pair's side
    // columns: the chart column (the trend window) takes the ~300px band at
    // the 360px floor — the zone content minus the app paddings — and the
    // plot spans that column minus the y gutter (2.25rem) and the gap
    // (0.25rem) alone
    expect(narrow.windowW).toBeGreaterThanOrEqual(290)
    expect(narrow.plotW).toBeCloseTo(narrow.windowW - 40, 0)
    // the bar reads min(cell, 48): the month cell at this width exceeds the
    // 15px label need with room to spare
    expect(narrow.barW).toBeGreaterThan(15)
    expect(narrow.cellGap).toBeGreaterThanOrEqual(0)
    expect(narrow.navPresent).toBe(true)
    // the day granularity (week mode) rides the narrowest cells — the bar
    // still houses the 15px vertical label
    await page.locator('[data-test="bar-2026-10"]').click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(300)
    const day = await page.evaluate(() => {
      const stack = document.querySelector<HTMLElement>('.bar-stack')
      const label = document.querySelector('.bar-seg-label')
      return {
        barW: stack ? stack.getBoundingClientRect().width : 0,
        labelled: label !== null,
      }
    })
    expect(day.barW).toBeGreaterThanOrEqual(15)
    expect(day.labelled).toBe(true)
    // review 中6: the Receipts bars read the SAME width rule — a sparse grid
    // (a 5-day range on a wide column: ~100px cells) caps the bar at the
    // --trend-bar-w token (48px) and centers it in its cell like the trend
    // .bar-stack, instead of stretching to the full cell; the cap radius's
    // JS base reads min(cell, token) off the computed var (never a literal)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/receipts?from=2026-10-01&to=2026-10-05')
    await page.waitForLoadState('networkidle')
    const rec = await page.evaluate(() => {
      const col = document.querySelector<HTMLElement>('[data-test="daily"] .daily-col')
      const bar = document.querySelector<HTMLElement>('[data-test="daily"] .daily-bar')
      return {
        cellW: col ? col.getBoundingClientRect().width : 0,
        barW: bar ? bar.getBoundingClientRect().width : 0,
        cap: bar ? getComputedStyle(bar).maxWidth : '',
        // the centered-in-cell grammar: equal side gaps
        gapL: col && bar ? bar.getBoundingClientRect().left - col.getBoundingClientRect().left : -1,
        gapR: col && bar ? col.getBoundingClientRect().right - bar.getBoundingClientRect().right : -1,
      }
    })
    expect(rec.cellW, 'the sparse grid holds cells wider than the cap').toBeGreaterThan(48)
    expect(rec.barW).toBeCloseTo(48, 0)
    expect(rec.cap, 'the cap reads the --trend-bar-w token').toBe('48px')
    expect(Math.abs(rec.gapL - rec.gapR), 'the bar centers in its cell').toBeLessThanOrEqual(1)
  })

  test('[covers:web-home.breakdown-absolute-ticks][covers:web-common.stacked-of-rows][covers:web-common.row-bar-component] segment button: 押下で当該分類のAxisDetailへ遷移（period引継ぎ）・Tab順に載りfocus-visibleは2px accent・「ほか」segmentは非button・残余件数はtruncated/fold込み・buttonの塗り帯は16pxでspanと揃う', async ({ page }) => {
    logPageIssues(page, 'task162-segbutton')
    await installApiStub(page)
    // the default stub's two categories close exactly on the total (no
    // residual) — seed the one-bar test's richer fixture so a「ほか」segment
    // actually rides the bar (the rest-span contract needs it present).
    // truncated_rows: 2 — review 中3: the rest COUNT merges the fetch's
    // truncated categories (7 sub-5% folds + 2 truncated = 9件 over the
    // 948-800=148円 residual)
    await page.route(
      (url) => url.pathname === '/api/ledgers/1/analysis' && url.searchParams.get('axis') === 'category',
      async (route) => {
        const body = {
          axis: 'category',
          metric: 'amount',
          period: { from: '2026-10-01', to: '2026-10-31', label: '2026年10月' },
          totals: { amount: 948, count: 3, unit: 316, days: 31 },
          rows: [
            { key: 1, label: '食費', amount: 500, count: 2, unit: 250, share: 0.528 },
            { key: 4, label: '日用品', amount: 300, count: 1, unit: 300, share: 0.316 },
            { key: 3, label: '文具', amount: 20, count: 1, unit: 20, share: 0.021 },
            { key: 6, label: '趣味', amount: 12, count: 1, unit: 12, share: 0.013 },
            { key: 5, label: '雑貨', amount: 5, count: 1, unit: 5, share: 0.005 },
            { key: 7, label: 'その他', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 8, label: '飲料', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 9, label: '菓子', amount: 4, count: 1, unit: 4, share: 0.004 },
            { key: 10, label: '雑誌', amount: 4, count: 1, unit: 4, share: 0.004 },
          ],
          truncated_rows: 2,
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
      },
    )
    await page.goto('/')
    await expect(page.locator('[data-test="breakdown-bar"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    // the rest segment never becomes a button (a null-key rest has no
    // destination); the series segments are focusable buttons in tab order
    const focus = await page.evaluate(() => {
      const segs = Array.from(document.querySelectorAll<HTMLElement>('[data-test="breakdown-seg"]'))
      const focusable = segs.filter((s) => s.tagName === 'BUTTON')
      // review 中2: the button's PAINTED band must be the 16px bar — the
      // inline fill rides backgroundColor (the background shorthand would
      // reset background-clip to border-box and paint the full 24px box),
      // and the 24px button centers on the 16px bar so its content-box band
      // lands exactly on the rest span's own band
      const firstBtn = focusable[0] ?? null
      const restSpan = segs.find((s) => s.tagName !== 'BUTTON') ?? null
      const btnCs = firstBtn ? getComputedStyle(firstBtn) : null
      return {
        titles: segs.map((s) => s.getAttribute('title') ?? ''),
        count: segs.length,
        buttonCount: focusable.length,
        tabbables: focusable.filter((s) => s.tabIndex >= 0).length,
        height: firstBtn ? firstBtn.getBoundingClientRect().height : 0,
        inlineFillProp: firstBtn?.style.background ? 'background' : firstBtn?.style.backgroundColor ? 'background-color' : '',
        clip: btnCs ? btnCs.backgroundClip : '',
        padTop: btnCs ? Number.parseFloat(btnCs.paddingTop) : -1,
        bandAlign:
          firstBtn && restSpan
            ? Math.abs(firstBtn.getBoundingClientRect().top + 4 - restSpan.getBoundingClientRect().top) +
              Math.abs(firstBtn.getBoundingClientRect().bottom - 4 - restSpan.getBoundingClientRect().bottom)
            : -1,
      }
    })
    const fdump = JSON.stringify(focus)
    expect(focus.titles[0], `${fdump}: the first segment is the top series`).toMatch(/^食費 /)
    // review 中3: the rest title's count = the tail + 5%-folds (7) + the
    // fetch's truncated categories (2) over the total-closed value 148円
    expect(focus.titles.at(-1), `${fdump}: the rest merges every fold stage's categories`).toBe('ほか 9件・計148円（16%）')
    expect(focus.count, `${fdump}: the rest is a span among the buttons`).toBeGreaterThan(focus.buttonCount)
    expect(focus.tabbables).toBe(focus.buttonCount)
    // the tap target clears WCAG 2.5.8 (24px) even on the 16px bar band
    expect(focus.height).toBeGreaterThanOrEqual(24)
    // review 中2: the fill rides the background-color longhand (the shorthand
    // would reset the clip), the content-box clip holds, and the button's
    // painted 16px band aligns with the rest span's band (the one-bar band
    // stays level end to end)
    expect(focus.inlineFillProp, `${fdump}: the inline fill is the longhand`).toBe('background-color')
    expect(focus.clip, `${fdump}: the stylesheet's content-box clip survives`).toBe('content-box')
    expect(focus.padTop, `${fdump}: the 4px top padding shrinks the painted band`).toBeCloseTo(4, 1)
    expect(focus.bandAlign, `${fdump}: the button's painted band matches the span's band`).toBeLessThanOrEqual(1)
    // keyboard focus reaches a series segment (they sit in the page's tab
    // order with everything before them — walk the Tab presses until one
    // lands) and the focus-visible ring paints the 2px accent
    let segFocused = false
    for (let i = 0; i < 30 && !segFocused; i++) {
      await page.keyboard.press('Tab')
      segFocused = await page.evaluate(
        () =>
          document.activeElement?.getAttribute('data-test') === 'breakdown-seg' &&
          document.activeElement.tagName === 'BUTTON',
      )
    }
    expect(segFocused, 'a Tab walk reaches the segment buttons').toBe(true)
    const focused = await page.evaluate(() => {
      const el = document.activeElement
      const cs = el ? getComputedStyle(el) : null
      return {
        isSeg: el ? el.getAttribute('data-test') === 'breakdown-seg' : false,
        outline: cs ? `${cs.outlineWidth} ${cs.outlineStyle}` : '',
      }
    })
    expect(focused.isSeg, JSON.stringify(focused)).toBe(true)
    expect(focused.outline).toContain('2px')
    // the press routes to the category's AxisDetail carrying the period
    await page.locator('[data-test="breakdown-seg"]').first().click()
    await page.waitForURL(/\/axes\/category\//)
    expect(page.url()).toMatch(/month=2026-10/)
  })
})


// TASK-167 (design: tmp/tasks/tm-167/design_row_hierarchy.md v2 §2
// D-1..D-10): the list rows' two-line hierarchy as real-browser measurements
// (the store name 16px/600 against the amount 16px/700, the sub line at
// 0.8rem with the derived top items, the row past the old 44px) and the
// receipt detail's three-tier item typography plus the removed leftover
// chrome (the 明細/画像 headings, the operating-meta footer, the note box,
// the chip tags row, the 画像あり chip and the wordy 修正 button). Written
// test-first — red until the implementation lands.
test.describe('row hierarchy + receipt detail (TASK-167, 390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-common.data-row-grammar][covers:web-common.row-top-items-display] 一覧行は2行構成: 店名16px/600・金額16px/700・副行0.8remの代表品目・行高52px以上', async ({ page }) => {
    logPageIssues(page, 'task167-rows')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="recent"] .data-row .row-main')).toHaveCount(3)
    const m = await page.evaluate(() => {
      const row = document.querySelector('[data-test="recent"] .data-row')!
      const main = row.querySelector('.row-main')!
      const name = main.querySelector(':scope > *:not(.amount)')!
      const amount = row.querySelector('.row-main .amount')!
      const sub = row.querySelector('.row-sub')!
      const cs = (el: Element) => {
        const s = getComputedStyle(el)
        return { w: s.fontWeight, s: s.fontSize }
      }
      return { h: row.getBoundingClientRect().height, name: cs(name), amount: cs(amount), sub: cs(sub), subText: sub.textContent?.trim() ?? '' }
    })
    expect(m.h).toBeGreaterThanOrEqual(52)
    expect(m.name.s).toBe('16px')
    expect(m.name.w).toBe('600')
    expect(m.amount.s).toBe('16px')
    expect(m.amount.w).toBe('700')
    expect(m.sub.s).toBe('12.8px')
    // the derived representative items (amount desc, k = 2) ride the sub line
    expect(m.subText).toContain('牛乳')
  })

  test('[covers:web-common.data-row-grammar] /categories ランキング行も同一文法（2行・副行に代表品目+share・下端bar維持）', async ({ page }) => {
    logPageIssues(page, 'task167-ranked')
    await installApiStub(page)
    await page.goto('/categories?month=2026-10')
    // the default stub's category axis carries two rows (食費 550・日用品 398);
    // the five-row + rest-row ranking shape is the TASK-129 spec's own fixture
    await expect(page.locator('.ranked-row .row-main')).toHaveCount(2)
    const row = page.locator('.ranked-row').first()
    await expect(row.locator('.row-main .amount')).toBeVisible()
    await expect(row.locator('.row-sub')).toBeVisible()
    await expect(row.locator('.row-sub')).toContainText('牛乳')
    await expect(row.locator('.row-sub')).toContainText('%')
    // the TASK-129 bottom bar track survives the two-line rework
    await expect(row.locator('.row-bar')).toBeVisible()
  })

  test('[covers:web-receipts.items-typography][covers:web-receipts.meta-footer-removed][covers:web-receipts.head-tags-inline][covers:web-receipts.edit-pencil-icon][covers:web-receipts.note-display][covers:web-receipts.head-row-grammar] レシート詳細: 明細3層の実測と除去要素の不在・pencil icon-only 修正・note 表示・頭部主行の実座標', async ({ page }) => {
    logPageIssues(page, 'task167-detail')
    await installApiStub(page)
    await page.goto('/receipts/101')
    // the feed renders the whole window's panels (102・103 follow 101), so the
    // items table reads scoped to panel 101's own card — the bare selector
    // would count the neighbour panels' rows too
    await expect(page.locator('[data-test="receipt-panel-101"] [data-test="items"] tbody tr')).toHaveCount(2)
    // the three tiers as measured weights: 品目 400 < 明細合計 700 < 合計
    const m = await page.evaluate(() => {
      const item = document.querySelector('[data-test="receipt-panel-101"] [data-test="items"] tbody tr td')!
      const itemNum = document.querySelector(
        '[data-test="receipt-panel-101"] [data-test="items"] tbody tr td.num',
      )!
      const footVal = document.querySelector('[data-test="receipt-panel-101"] [data-test="items-total"]')!
      const total = document.querySelector('[data-test="receipt-panel-101"] [data-test="total"]')!
      const w = (el: Element) => getComputedStyle(el).fontWeight
      return { item: w(item), itemNum: w(itemNum), foot: w(footVal), totalSize: getComputedStyle(total).fontSize }
    })
    expect(m.item).toBe('400')
    expect(m.itemNum).toBe('600')
    expect(m.foot).toBe('700')
    expect(parseFloat(m.totalSize)).toBeGreaterThanOrEqual(30)
    // the leftover chrome is gone: the zone headings, the operating-meta
    // footer, the chip tags row, the 画像あり chip and the wordy 修正
    // button. TASK-170: the note box is BACK — .receipt-note right under the
    // items table (the mock's 101 carries the note 近所の特売)
    await expect(page.locator('[data-test="items-card"] h2')).toHaveCount(0)
    await expect(page.locator('.receipt-foot')).toHaveCount(0)
    await expect(page.locator('[data-test="receipt-panel-101"] .receipt-note')).toBeVisible()
    await expect(page.locator('[data-test="receipt-panel-101"] .receipt-note')).toHaveText('近所の特売')
    await expect(page.locator('.receipt-header .tags')).toHaveCount(0)
    expect((await page.locator('[data-test="receipt-panel-101"] .receipt-header').innerText()).includes('画像あり')).toBe(false)
    // 修正 is the pencil icon-only ibtn at the head (its name lives in the
    // aria-label alone)
    const edit = page.locator('[data-test="receipt-panel-101"] [data-test="edit"]')
    await expect(edit).toBeVisible()
    await expect(edit).toHaveAttribute('aria-label', '修正')
    await expect(edit.locator('svg')).toBeVisible()
    expect((await edit.innerText()).trim()).toBe('')
    expect(await edit.evaluate((el) => el.closest('.receipt-mainrow') !== null)).toBe(true)
    // TASK-175: the head's MAIN row in real coordinates — the total and the
    // edit share ONE row (their boxes overlap vertically; baseline align +
    // align-self:center deliberately differ in TOPS, so top equality is NOT
    // the expectation), the total sits LEFT of the edit, and both the edit
    // and the sub row's picker host hug the head card's content right edge
    const headGeom = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="receipt-panel-101"]')!
      const card = panel.querySelector('.receipt-header')!.closest('.card')!
      const pad = parseFloat(getComputedStyle(card).paddingRight) || 0
      const contentRight = card.getBoundingClientRect().right - pad
      const r = (sel: string) => panel.querySelector(sel)!.getBoundingClientRect()
      return { total: r('[data-test="total"]'), edit: r('[data-test="edit"]'), subEnd: r('.receipt-sub-end'), contentRight }
    })
    expect(headGeom.edit.bottom).toBeGreaterThan(headGeom.total.top)
    expect(headGeom.edit.top).toBeLessThan(headGeom.total.bottom)
    expect(headGeom.total.right).toBeLessThanOrEqual(headGeom.edit.left + 1)
    expect(Math.abs(headGeom.edit.right - headGeom.contentRight)).toBeLessThanOrEqual(2)
    expect(Math.abs(headGeom.subEnd.right - headGeom.contentRight)).toBeLessThanOrEqual(2)
  })

  // TASK-175 review #1: the chips' own host (.label-dots) wraps when the
  // five titled chips outgrow the row — at this width the wrap is guaranteed
  // (chips ≈229px vs ≈188px of content width), so every wrapped line's
  // right edge is measured, not just the outer .receipt-sub-end box
  test.describe('head sub wrap (260x780)', () => {
    test.use({ viewport: { width: 260, height: 780 } })

    test('[covers:web-receipts.head-row-grammar] 頭部副行: 複数ラベルで折返しても .receipt-sub-end は右端・各行チップの右端も右端・label-add 44px は主行要素と重複しない', async ({ page }) => {
      logPageIssues(page, 'task175-head-sub')
      // richLabels titles all five labels and puts them on receipt 102
      await installApiStub(page, { richLabels: true })
      await page.goto('/receipts/102')
      await expect(page.locator('[data-test="receipt-panel-102"] .receipt-title')).toBeVisible()
      const g = await page.evaluate(() => {
        const panel = document.querySelector('[data-test="receipt-panel-102"]')!
        const card = panel.querySelector('.receipt-header')!.closest('.card')!
        const pad = parseFloat(getComputedStyle(card).paddingRight) || 0
        const contentRight = card.getBoundingClientRect().right - pad
        const r = (sel: string) => panel.querySelector(sel)!.getBoundingClientRect()
        // group the sub row's chips into their wrapped lines (same top = one
        // line) and keep each line's rightmost edge
        const lines: Array<{ top: number; right: number }> = []
        for (const chip of Array.from(panel.querySelectorAll('.receipt-sub-end .label-chip'))) {
          const b = chip.getBoundingClientRect()
          const line = lines.find((x) => Math.abs(x.top - b.top) <= 4)
          if (line) line.right = Math.max(line.right, b.right)
          else lines.push({ top: b.top, right: b.right })
        }
        return {
          contentRight,
          subEnd: r('.receipt-sub-end'),
          add: r('[data-test="label-add"]'),
          total: r('[data-test="total"]'),
          edit: r('[data-test="edit"]'),
          lines,
        }
      })
      const dump = JSON.stringify(g)
      // five chips + the 44px button may wrap the picker's line(s) — the host
      // stays glued to the head card's content right edge either way (H-5)
      expect(Math.abs(g.subEnd.right - g.contentRight)).toBeLessThanOrEqual(2)
      // non-vacuous: the chips really wrapped inside their own host
      expect(g.lines.length, dump).toBeGreaterThanOrEqual(2)
      // review #1: EVERY wrapped chip line hugs the right edge (a left-
      // aligned fallback line misses it by the line's leftover width)
      for (const line of g.lines) {
        expect(Math.abs(line.right - g.contentRight), dump).toBeLessThanOrEqual(2)
      }
      // the 44px label button never overlaps the MAIN row's total / edit
      // (separate rows: the vertical spans are disjoint)
      const mainBottom = Math.max(g.total.bottom, g.edit.bottom)
      expect(g.add.top).toBeGreaterThanOrEqual(mainBottom - 1)
      expect(g.add.width).toBeCloseTo(44, 1)
      expect(g.add.height).toBeCloseTo(44, 1)
    })
  })

  // TASK-175 review #2: the main row's worst case as real geometry — the
  // seeded receipt 113 (longDeletedHead) carries a deleted 削除済み badge,
  // a delimiter-free long store name and an 8-digit total on ONE row
  test('[covers:web-receipts.head-row-grammar] 削除済み+長店名+大きい金額の主行: 店名のみellipsis・badgeと合計は非重複・主行はカード内に収まる', async ({ page }) => {
    logPageIssues(page, 'task175-head-deleted-long')
    await installApiStub(page, { longDeletedHead: true })
    await page.goto('/receipts/113')
    await expect(page.locator('[data-test="receipt-panel-113"] .receipt-title')).toBeVisible()
    // deleted: no pencil; the badge rides the title (out of the ellipsis
    // span)
    await expect(page.locator('[data-test="receipt-panel-113"] [data-test="edit"]')).toHaveCount(0)
    await expect(page.locator('[data-test="receipt-panel-113"] [data-test="deleted"]')).toBeVisible()
    const g = await page.evaluate(() => {
      const panel = document.querySelector('[data-test="receipt-panel-113"]')!
      const card = panel.querySelector('.receipt-header')!.closest('.card')!
      const cs = getComputedStyle(card)
      const box = card.getBoundingClientRect()
      const contentLeft = box.left + (parseFloat(cs.paddingLeft) || 0)
      const contentRight = box.right - (parseFloat(cs.paddingRight) || 0)
      const name = panel.querySelector('.receipt-title-name')!
      const nb = name.getBoundingClientRect()
      const badge = panel.querySelector('[data-test="deleted"]')!.getBoundingClientRect()
      const total = panel.querySelector('[data-test="total"]')!.getBoundingClientRect()
      const main = panel.querySelector('.receipt-mainrow')!.getBoundingClientRect()
      return {
        contentLeft,
        contentRight,
        nameClient: name.clientWidth,
        nameScroll: name.scrollWidth,
        nameRight: nb.right,
        badgeLeft: badge.left,
        badgeRight: badge.right,
        totalLeft: total.left,
        totalRight: total.right,
        mainLeft: main.left,
        mainRight: main.right,
        cardScroll: card.scrollWidth,
        cardClient: card.clientWidth,
      }
    })
    const dump = JSON.stringify(g)
    // the name alone ellipsizes: its text overflows the clip box (the full
    // name stays on the title attribute)
    expect(g.nameScroll, dump).toBeGreaterThan(g.nameClient)
    expect(g.nameRight, dump).toBeLessThanOrEqual(g.badgeLeft + 1)
    // the badge (width protected) and the big total never overlap: the
    // badge ends before the total starts, both on the same main row
    expect(g.badgeRight, dump).toBeLessThanOrEqual(g.totalLeft + 1)
    // the whole main row fits inside the head card: no horizontal overflow,
    // the row spans exactly the card's content width (no pencil — the
    // total itself is the right edge)
    expect(g.cardScroll, dump).toBeLessThanOrEqual(g.cardClient + 1)
    expect(g.mainLeft, dump).toBeGreaterThanOrEqual(g.contentLeft - 1)
    expect(g.mainRight, dump).toBeLessThanOrEqual(g.contentRight + 1)
    expect(Math.abs(g.totalRight - g.contentRight), dump).toBeLessThanOrEqual(2)
  })
})
