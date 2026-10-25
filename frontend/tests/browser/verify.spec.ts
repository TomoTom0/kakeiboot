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
        plotHeight: plot ? plot.height : -1,
        gridTops,
        labelCount: document.querySelectorAll('.bar-label').length,
        topValTop: valTops.length ? Math.min(...valTops) : -1,
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
