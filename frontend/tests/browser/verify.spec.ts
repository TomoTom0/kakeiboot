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
    await expect(page.locator('[data-test="receipt-panel-112"] .detail-title')).toBeVisible()

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
  })

  test('[covers:web-receipts.feed-scroll-compensation-real] 上方向展開でも表示中パネルの top を維持', async ({ page }) => {
    logPageIssues(page, 'compensation')
    await installApiStub(page, { feed: 9 })
    await page.goto('/receipts/112')
    await expect(page.locator('[data-test="receipt-panel-112"] .detail-title')).toBeVisible()
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
    await expect(page.locator('[data-test="receipt-panel-107"] .detail-title')).toBeVisible({ timeout: 5_000 })
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
    await expect(page.locator('[data-test="receipt-panel-104"] .detail-title')).toBeVisible()
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
    await expect(page.locator('[data-test="receipt-panel-106"] .detail-title')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-test="receipt-panel-112"] .receipt-panel-placeholder')).toBeVisible()
    expect(page.locator('[data-test="feed-position"]')).toContainText('9 / 12')
  })

  test('[covers:web-receipts.feed-direct-link-initial-scroll-real] 浅い位置（先頭）の直リンクも URL そのままで着地', async ({ page }) => {
    logPageIssues(page, 'direct-link-shallow')
    await installApiStub(page, { feed: 9 })
    await page.goto('/receipts/112') // idx 0
    await expect(page.locator('[data-test="receipt-panel-112"] .detail-title')).toBeVisible()
    await expect
      .poll(() => panelTop(page, 112).then((r) => Math.abs(r.top - r.expected)), { timeout: 3_000 })
      .toBeLessThanOrEqual(2)
    expect(new URL(page.url()).pathname).toBe('/receipts/112')
    expect(new URL(page.url()).search).toBe('')
    expect(page.locator('[data-test="feed-position"]')).toContainText('1 / 12')
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

  test('[covers:web-receipts.daily-bars-min-track] daily-bars の各本は最小 4px を下回らない', async ({ page }) => {
    logPageIssues(page, 'daily')
    await installApiStub(page)
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('[data-test="daily"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const daily = document.querySelector('[data-test="daily"]')!
      const cols = Array.from(daily.querySelectorAll('.daily-col'))
      const bars = daily.querySelector('.daily-bars') as HTMLElement
      return {
        count: cols.length,
        minWidth: Math.min(...cols.map((c) => c.getBoundingClientRect().width)),
        scrollWidth: bars.scrollWidth,
        clientWidth: bars.clientWidth,
      }
    })
    expect(m.count, '2026-10 has 31 day columns').toBe(31)
    expect(m.minWidth, 'every column keeps the 4px minimum (0.05px tolerance)').toBeGreaterThanOrEqual(3.95)
    expect(m.scrollWidth, 'the track fits inside the card').toBeLessThanOrEqual(m.clientWidth + 1)
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
    // the bar element exists at the fixed readable height (TASK-129: 6px —
    // the shared component's grammar value, well above the old 2px gradient)
    expect(m.barPresent).toBe(true)
    expect(m.barH).toBeCloseTo(6, 0)
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
    // the row keeps its 44px full-width shape and the bar fits inside it
    expect(m.rowH).toBeCloseTo(44, 0)
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

  test('[covers:web-common.row-bar-component][covers:web-common.bar-scale][covers:web-home.breakdown-rest-row] ranked row bars: 6px DOM bar, 4-side 1px outline, right cap, bar/track = value/scale — the share-less rest row included, one scale with the week bar', async ({ page }) => {
    logPageIssues(page, 'row-bar')
    await installApiStub(page)
    // the breakdown answer comes off a richer analysis fixture. The rows
    // sort amount-desc and the top-5 stay visible, so the tail (the four
    // 4円 rows) folds into the「ほか 4件・計16円」rest row (share-less, its
    // bar must still follow its own value: 16/1000 of the track, outlined),
    // while 雑貨 5円 rides the 5th visible slot at 5/1000×track ≈ 1.5px —
    // the sub-3px bar proving rule F. The week data stays the stub's (948円
    // week), so the screen scale is barScale(max(500, 300, 948)) = 1000.
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
      const rows = Array.from(document.querySelectorAll('[data-test="breakdown"] .ranked-row')) as HTMLElement[]
      const read = (label: string) => {
        const row = rows.find((r) => (r.querySelector('.ranked-label')?.textContent ?? '').startsWith(label)) ?? null
        const bar = row?.querySelector('.row-bar') as HTMLElement | null
        const seg = bar?.querySelector('.row-seg') as HTMLElement | null
        const track = row?.querySelector('.ranked-bar-track') as HTMLElement | null
        const cs = seg ? getComputedStyle(seg) : null
        return {
          found: row !== null,
          rowH: row ? row.getBoundingClientRect().height : 0,
          barPresent: bar !== null,
          barH: bar ? bar.getBoundingClientRect().height : 0,
          segW: seg ? seg.getBoundingClientRect().width : 0,
          segH: seg ? seg.getBoundingClientRect().height : 0,
          trackW: track ? track.getBoundingClientRect().width : 0,
          borderWidths: cs ? [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth] : [],
          radius: cs
            ? [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius]
            : [],
          fillColor: cs ? cs.backgroundColor : '',
          fillStyle: row ? row.getAttribute('style') ?? '' : '',
        }
      }
      const weekRow = document.querySelector('[data-test="week-card"] [data-test="row-2026-10-05"]') as HTMLElement | null
      const weekBar = weekRow?.querySelector('.row-bar') as HTMLElement | null
      const weekTrack = weekRow?.querySelector('.week-bar-track') as HTMLElement | null
      return {
        top: read('食費'),
        daily: read('日用品'),
        rest: read('ほか'),
        tiny: read('雑貨'),
        week: {
          barW: weekBar ? weekBar.getBoundingClientRect().width : 0,
          trackW: weekTrack ? weekTrack.getBoundingClientRect().width : 0,
        },
      }
    })
    // every row renders its 44px shape and the 6px shared bar inside the
    // absolutely-positioned track that spans the row (padding included)
    for (const r of [m.top, m.daily, m.rest]) {
      expect(r.found).toBe(true)
      expect(r.rowH).toBeCloseTo(44, 0)
      expect(r.barPresent).toBe(true)
      expect(r.barH).toBeCloseTo(6, 0)
      expect(r.trackW).toBeGreaterThan(0)
      // the outline: all four sides at 1px; the cap: the data end (right)
      // alone rounds — BOTH right corners at 1.5px (min(2, 6/4), the SVG
      // grammar's twin) — the base end (left) stays square
      for (const w of r.borderWidths) expect(w).toBe('1px')
      expect(Number.parseFloat(r.radius[1]!)).toBeCloseTo(1.5, 1)
      expect(r.radius[0]).toBe('0px')
      expect(r.radius[2]).toBe('0px')
      expect(r.radius[3]).toBe('1.5px')
    }
    // the top row paints its series color (食費 key 1 → --series-1 #803A0D)
    const top = colorChannels(m.top.fillColor).map((v) => Math.round(v))
    expect(top.slice(0, 3)).toEqual([128, 58, 13])
    // the lengths are the values over the ONE screen scale 1000: the ratio
    // bar/track equals value/1000 for the top row, the second row…
    expect(m.top.segW / m.top.trackW).toBeCloseTo(500 / 1000, 2)
    expect(m.daily.segW / m.daily.trackW).toBeCloseTo(300 / 1000, 2)
    // …and the share-less「ほか」row — its bar comes from its own value (the
    // folded tail's 16円), not from any share denominator
    expect(m.rest.segW / m.rest.trackW).toBeCloseTo(16 / 1000, 3)
    // one scale across surfaces: the week bar (948円) rides the same 1000
    expect(m.week.barW / m.week.trackW).toBeCloseTo(948 / 1000, 2)
    // rule F on the row bar: the 5円 row's bar is under 3px — the data ratio
    // wins and the outline drops (fill only), the bar itself stays visible
    expect(m.tiny.barPresent).toBe(true)
    expect(m.tiny.segW).toBeGreaterThan(0)
    expect(m.tiny.segW).toBeLessThan(3)
    for (const w of m.tiny.borderWidths) expect(w, 'rule F: no outline under 3px').toBe('0px')
  })

  test('[covers:web-common.row-bar-component] a resize recomputes the bar lengths (the same value/scale ratio at the new track width)', async ({ page }) => {
    logPageIssues(page, 'row-bar-resize')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="breakdown"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const read = () =>
      page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('[data-test="breakdown"] .ranked-row')).find((r) =>
          (r.querySelector('.ranked-label')?.textContent ?? '').startsWith('食費'),
        ) as HTMLElement
        const seg = row.querySelector('.row-seg') as HTMLElement
        const track = row.querySelector('.ranked-bar-track') as HTMLElement
        return { segW: seg.getBoundingClientRect().width, trackW: track.getBoundingClientRect().width }
      })
    const narrow = await read()
    expect(narrow.segW / narrow.trackW).toBeCloseTo(550 / 1000, 2)
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
    for (const r of m) {
      expect(r.rowH).toBeCloseTo(44, 0)
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
      // and the columns share the index on the common grid)
      const labelDx = spans
        .map((s, i): number | null => {
          if (!(s.textContent ?? '').trim()) return null
          const sr = rect(s)
          const cr = rect(cols[i])
          return sr && cr ? Math.abs(sr.left + sr.width / 2 - (cr.left + cr.width / 2)) : -1
        })
        .filter((d): d is number => d !== null)
      const yAxis = rect(card?.querySelector('.y-axis'))
      const plot = rect(card?.querySelector('.plot'))
      const gridTops = Array.from(card?.querySelectorAll('.gridline') ?? []).map((g) => rect(g)?.top ?? -1)
      const valTops = Array.from(card?.querySelectorAll('.bar-col .bar-val') ?? []).map((v) => rect(v)?.top ?? -1)
      return {
        missing: !card || !axis || !hscroll || !yAxis || !plot,
        barCount: cols.length,
        overflow: hscroll ? hscroll.scrollWidth - hscroll.clientWidth : -1,
        labelDx,
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
    // (2) every non-empty tick label centers under its own bar (±2px)
    expect(m.labelDx.length, dump).toBe(4)
    expect(Math.max(...m.labelDx), dump).toBeLessThanOrEqual(2)
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
    // value labels thin to the 5 tick positions (the hidden values stay
    // reachable via title)
    await page.goto('/categories?year=2026')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const y = await page.evaluate(() => {
      const card = document.querySelector('[data-test="trend-card"]')
      const hscroll = card?.querySelector('.hscroll') ?? null
      return {
        barCount: card ? card.querySelectorAll('.bar-col').length : 0,
        overflow: hscroll ? hscroll.scrollWidth - hscroll.clientWidth : -1,
        valBars: Array.from(card?.querySelectorAll('.bar-col .bar-val') ?? []).map(
          (v) => v.closest('button')?.getAttribute('data-test') ?? '',
        ),
        hiddenTitle: card?.querySelector('[data-test="bar-2026-02"]')?.getAttribute('title') ?? '',
      }
    })
    const ydump = JSON.stringify(y)
    expect(y.barCount, ydump).toBe(12)
    expect(y.overflow, ydump).toBeLessThanOrEqual(2)
    expect(y.valBars, ydump).toEqual(['bar-2026-01', 'bar-2026-04', 'bar-2026-07', 'bar-2026-10', 'bar-2026-12'])
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
  // TASK-108 page 2 (offset=6): 2025-11..2026-04, zero overlap with INIT
  const SLID = ['bar-2025-11', 'bar-2025-12', 'bar-2026-01', 'bar-2026-02', 'bar-2026-03', 'bar-2026-04']
  // September's initial window — a focus change resets the offset to 0, so
  // the month-step expectation is span-independent (§5-1)
  const SEP_INIT = ['bar-2026-04', 'bar-2026-05', 'bar-2026-06', 'bar-2026-07', 'bar-2026-08', 'bar-2026-09']

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
    // the pair renders as PeriodPicker-style 44px squares; next is disabled
    // on the initial window (no future slide)
    for (const name of ['trend-prev', 'trend-next']) {
      const box = await page.locator(`[data-test="${name}"]`).boundingBox()
      expect(box, name).toBeTruthy()
      expect(box!.width, name).toBeCloseTo(44, 1)
      expect(box!.height, name).toBeCloseTo(44, 1)
    }
    await expect(page.locator('[data-test="trend-next"]')).toBeDisabled()
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
    // next returns to the initial window in one press and disables again
    await expect(page.locator('[data-test="trend-next"]')).toBeEnabled()
    await page.locator('[data-test="trend-next"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await expect(page.locator('[data-test="trend-next"]')).toBeDisabled()
    // the period chip's month step (2026-10 -> 2026-09) resets the window to
    // September's initial one, and picking 2026-10 again restores it
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SEP_INIT)
    await page.locator('[data-test="period-next"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await page.keyboard.press('Escape') // close the dialog for the bar press
    // a bar press is a focus move: the window resets around the pressed
    // month — bar-2025-12 sits inside the paged window (2025-11..2026-04),
    // clearly outside the initial page (TASK-108 §5-1)
    await page.locator('[data-test="trend-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    await page.locator('[data-test="bar-2025-12"]').click()
    await expect
      .poll(() => barKeys(page), { timeout: 3_000 })
      .toEqual(['bar-2025-07', 'bar-2025-08', 'bar-2025-09', 'bar-2025-10', 'bar-2025-11', 'bar-2025-12'])
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
    // window only, so every prev destination is all-zero (canPrev false,
    // the button disabled): start from the initial window, page back with
    // prev, then re-press NEXT while that slide still runs — canNext is
    // offset>0, so the rapid press is reachable and the cached initial
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
    // structurally only
    const screens: { path: string; titles: string[] | null }[] = [
      { path: '/', titles: ['支出の推移', '週ごとの支出', '支出の内訳', '最近のレシート'] },
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
      return { breakdown: place('[data-test="breakdown-more"]'), recent: place('[data-test="recent-more"]') }
    })
    expect(more.breakdown.inHead).toBe(true)
    expect(more.breakdown.isLast).toBe(true)
    expect(more.recent.inHead).toBe(true)
    expect(more.recent.isLast).toBe(true)
  })
})

test.describe('series colors (1280x720)', () => {
  test('[covers:web-common.series-color-assignment] trend セグメントと内訳行 swatch は同key同色（決定的写像・系列間で色が分かれる）', async ({ page }) => {
    logPageIssues(page, 'series-colors')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const colorOf = (el: Element) => getComputedStyle(el as HTMLElement).backgroundColor
      const bar = document.querySelector('[data-test="bar-2026-10"]')
      const segs = bar ? Array.from(bar.querySelectorAll('.bar-seg')) : []
      const rows = Array.from(document.querySelectorAll('[data-test="breakdown"] .ranked-row'))
      const rowColor = (label: string) => {
        const row = rows.find((r) => (r.querySelector('.ranked-label')?.textContent ?? '').trim() === label)
        const swatch = row?.querySelector('.ranked-swatch') ?? null
        return row && swatch ? colorOf(swatch) : null
      }
      // the segment title is「名称 〜円（n%）」(TASK-105): the label is the
      // first space-delimited token
      const segColor = (label: string) =>
        segs.find((s) => (s.getAttribute('title') ?? '').startsWith(label)) ?? null
      return {
        barPresent: !!bar,
        segCount: segs.length,
        pairs: ['食費', '日用品'].map((label) => ({
          label,
          seg: segColor(label) ? colorOf(segColor(label)!) : null,
          swatch: rowColor(label),
        })),
      }
    })
    const dump = JSON.stringify(m)
    expect(m.barPresent, dump).toBe(true)
    // the mock month holds the two series (食費 id1 / 日用品 id4)
    expect(m.segCount, dump).toBe(2)
    for (const p of m.pairs) {
      expect(p.seg, `${p.label}: the segment renders`).not.toBeNull()
      expect(p.swatch, `${p.label}: the row swatch renders`).not.toBeNull()
      // 同key同色: the trend segment and the ranked row read one seriesColor
      expect(p.seg, `${p.label}: the segment and the row swatch share one color`).toBe(p.swatch)
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
    expect(home.breakdown, homeDump).toMatchObject({ col: 'side' })
    expect(home.recent, homeDump).toMatchObject({ col: 'side' })
    // the chart column sits left and stays wider than the list column
    expect(home.trend!.x, homeDump).toBeLessThan(home.breakdown!.x)
    expect(home.trend!.w, homeDump).toBeGreaterThan(home.breakdown!.w)

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
    await expect(page.locator('[data-test="breakdown"]')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const fact = (sel: string) => {
        const el = document.querySelector(sel)! as HTMLElement
        return { w: el.getBoundingClientRect().width, max: getComputedStyle(el).maxWidth }
      }
      return { breakdown: fact('[data-test="breakdown"]'), trend: fact('[data-test="trend-card"]') }
    })
    const dump = JSON.stringify(m)
    // 38rem = 608px: the list tier caps the zone well below the 700px column
    expect(m.breakdown.max, dump).toBe('608px')
    expect(Math.abs(m.breakdown.w - 608), dump).toBeLessThanOrEqual(1)
    // the chart zone keeps the full width (no tier on the trend)
    expect(m.trend.max, dump).toBe('none')
    expect(m.trend.w, dump).toBeGreaterThan(m.breakdown.w + 20)
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
// browsing URL sync and the tabbar-外 topbar ‹, as real-browser facts. (a) the
// period chip's step replaces the URL's period key without stacking history,
// and the browser back restores the entry's final period (e); (c) a deep link
// restores the label filter together with the period on Home; (h) the ‹ is a
// 44px icon-only target right after the brand that climbs to the parent
// section. Written test-first — these stay red until the implementation
// lands. ---

test.describe('browsing url sync + topbar back (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-browse.url-period-sync][covers:web-browse.url-pop-restore] 時期チップの送りはURLのperiod keyをreplaceで置換し（履歴に積まない）・browser戻るは戻り先entryの期間ごと復元する', async ({ page }) => {
    logPageIssues(page, 'url-period')
    await installApiStub(page)
    await page.goto('/categories?month=2026-10')
    await expect(page.locator('[data-test="trend-card"]')).toBeVisible()
    // two month steps through the period chip: 2026-10 -> 09 -> 08
    await page.locator('[data-test="filter-period"]').click()
    await expect(page.locator('[data-test="period-prev"]')).toBeVisible()
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-09/)
    await page.locator('[data-test="period-prev"]').click()
    await expect(page).toHaveURL(/month=2026-08/)
    await page.keyboard.press('Escape') // close the dialog for the tab switch
    // leave to Home through the tabbar (a keys-less push), then come back
    await page.locator('[data-test="tabbar"] a').first().click()
    await expect(page.locator('[data-test="period-total"]')).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
    await page.goBack()
    // the back lands on the categories entry's final URL (2026-08) and the
    // pop imports it: the chip shows August
    await expect(page).toHaveURL(/\/categories\?month=2026-08/)
    await expect(page.locator('[data-test="filter-period"]')).toHaveAttribute(
      'aria-label',
      '期間で絞り込み: 2026年8月',
    )
    // the two steps never stacked history: the next back leaves the app
    // (a push-per-step implementation would land on ?month=2026-09 instead)
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

    // /search climbs to Home; the browsing screens keep the tabbar instead
    await page.goto('/search')
    await expect(page.locator('[data-test="topbar-back"]')).toHaveAttribute('aria-label', 'ホームへ戻る')
    await page.locator('[data-test="topbar-back"]').click()
    expect(new URL(page.url()).pathname).toBe('/')
    for (const path of ['/', '/categories?month=2026-10', '/axes/category/1?month=2026-10', '/receipts/101']) {
      await page.goto(path)
      expect(await page.locator('[data-test="topbar-back"]').count(), path).toBe(0)
    }
    // the axis detail keeps its PageHead ‹ (inside .page-head, not the topbar)
    await page.goto('/axes/category/1?month=2026-10')
    await expect(page.locator('.page-head [data-test="page-back"]')).toBeVisible()
  })
})
