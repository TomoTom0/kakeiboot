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

  test('[covers:web-home.trend-window] prevで棒key群が窓幅（6か月）ページ送り（前窓と重複なし・focus不変・analysis/recent/weekは再fetchなし）・nextで復帰・時期チップと棒押下で初期窓へ', async ({ page }) => {
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
    // prev: the page turns by the window's own width and only the trend
    // endpoint re-runs
    await page.locator('[data-test="trend-prev"]').click()
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    const analysisGets = () => calls.filter((c) => c.path === 'analysis')
    const receiptGets = () => calls.filter((c) => c.path === 'receipts')
    const trendMonth = () => calls.filter((c) => c.path === 'analysis/trend' && c.granularity === 'month')
    const trendWeek = () => calls.filter((c) => c.path === 'analysis/trend' && c.granularity === 'week')
    expect(analysisGets(), 'the breakdown never re-runs').toHaveLength(1)
    expect(receiptGets(), 'recent neither').toHaveLength(1)
    expect(trendWeek(), 'the TASK-103 week fetch stays in load()').toHaveLength(1)
    expect(trendMonth().at(-1)!.from).toBe('2025-11-01')
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

  // TASK-108 slide grammar (design §5-2 / §6-3): the direction classes, the
  // non-firing cases (first insertion, same-window refetch) and the
  // reduced-motion instant swap — the numbers of the motion itself stay in
  // the unit layer's contract.
  test('[covers:web-home.trend-window-slide] 窓交代はdirection別slide class（prev=back・next=forward）・初回挿入と同窓再fetchは不発火・reducedMotionでは即時差し替え', async ({ page }) => {
    logPageIssues(page, 'trend-slide')
    await installApiStub(page)
    await page.goto('/')
    await expect(page.locator('.trend-window')).toBeVisible()
    // an rAF sampler under .trend-window: records every trend-slide-* class
    // sighting, so even a single-frame class (the reduced-motion instant
    // swap) is provably absent when it must not fire
    await page.evaluate(() => {
      const w = window as unknown as { __slideSeen: string[]; __slideRun: boolean }
      w.__slideSeen = []
      w.__slideRun = true
      const tick = () => {
        if (!w.__slideRun) return
        for (const el of document.querySelectorAll('.trend-window [class*="trend-slide-"]'))
          for (const c of el.classList) if (c.startsWith('trend-slide')) w.__slideSeen.push(c)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const slideSeen = () => page.evaluate(() => (window as unknown as { __slideSeen: string[] }).__slideSeen)
    const noSlideClass = () =>
      page.evaluate(() => document.querySelectorAll('.trend-window [class*="trend-slide-"]').length === 0)
    // the initial load (the very first v-if insertion) paints instantly: no
    // trend-slide class may ever appear on it
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    expect(await slideSeen(), 'the first insertion never slides').toEqual([])

    // a one-shot gate over the stub's month-granularity trend responses, so
    // the swap starts only when this test releases it (§10: the class
    // observation begins before the response can land)
    const gateMonthTrend = async (): Promise<() => void> => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      await page.route(
        (url) => url.pathname.endsWith('/analysis/trend'),
        async (route) => {
          if (new URL(route.request().url()).searchParams.get('granularity') !== 'month') return route.fallback()
          await gate
          return route.fallback()
        },
      )
      return release
    }

    // prev (into the past): the new chart enters from the left — the leaving
    // or entering chart root carries the trend-slide-back pair (§3-1)
    const releasePrev = await gateMonthTrend()
    await page.locator('[data-test="trend-prev"]').click()
    const backClass = page.waitForFunction(
      () => document.querySelector('.trend-window [class*="trend-slide-back-"]') !== null,
      { timeout: 5_000 },
    )
    releasePrev()
    await backClass
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
    await expect.poll(noSlideClass, { timeout: 3_000 }).toBe(true) // let the 220ms out-in pair finish

    // next (back to now): the mirrored trend-slide-forward pair
    const releaseNext = await gateMonthTrend()
    await page.locator('[data-test="trend-next"]').click()
    const forwardClass = page.waitForFunction(
      () => document.querySelector('.trend-window [class*="trend-slide-forward-"]') !== null,
      { timeout: 5_000 },
    )
    releaseNext()
    await forwardClass
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(INIT)
    await expect.poll(noSlideClass, { timeout: 3_000 }).toBe(true)

    // a same-window refetch (a label filter added) keeps the committed
    // windowKey: no class may appear — observed from the initial window
    // (offset=0); at offset>0 a label switch is a focus change that
    // legitimately re-inits the window (§5-2 premise)
    await page.evaluate(() => {
      ;(window as unknown as { __slideSeen: string[] }).__slideSeen = []
    })
    const labelled = page.waitForResponse((r) => {
      const u = new URL(r.url())
      return /\/analysis\/trend$/.test(u.pathname) && u.searchParams.has('label_colors')
    })
    await page.locator('[data-test="filter-search"]').click()
    await page.locator('[data-test="label-filter-red"]').click()
    await labelled
    // an out-in pair, had one fired, runs 220+220ms — wait past that before
    // declaring the absence
    await page.waitForTimeout(500)
    expect(await slideSeen(), 'a recolour of the same window never slides').toEqual([])
    await page.keyboard.press('Escape') // close the dialog

    // reduced motion: the same press swaps instantly — the class still lands
    // (Vue adds it) but the CSS turns it into a no-op; the class AND the
    // computed style are read in ONE evaluation so the single-frame class
    // lifetime cannot race the poll (§10: transform none is the main fact)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const releaseReduced = await gateMonthTrend()
    await page.locator('[data-test="trend-prev"]').click()
    const instant = page.waitForFunction(
      () => {
        const el = document.querySelector('.trend-window [class*="trend-slide-back-"]')
        if (!el) return false
        const cs = getComputedStyle(el)
        return cs.transitionDuration === '0s' && cs.transform === 'none'
      },
      { timeout: 5_000 },
    )
    releaseReduced()
    await instant
    await expect.poll(() => barKeys(page), { timeout: 3_000 }).toEqual(SLID)
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
    // layout ever produces (~372px = 768 - 24rem col-side - 0.75rem gap)
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
    expect(m.mainW, dump).toBeGreaterThanOrEqual(360)
    expect(m.mainW, dump).toBeLessThanOrEqual(380)
    // the zone never widens past its column
    expect(m.cardW, dump).toBeLessThanOrEqual(m.mainW + 2)
    expect(m.hscroll, dump).toBe(true)
    // the document keeps no horizontal overflow and the axis labels stay
    // inside the scroll port
    expect(m.docOverflow, dump).toBeLessThanOrEqual(1)
    expect(m.axisOverflow, dump).toBeLessThanOrEqual(0)
  })
})
