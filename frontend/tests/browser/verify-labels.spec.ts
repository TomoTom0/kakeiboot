// TASK-60 real-browser verification (chromium), labels half: the layout
// facts jsdom cannot compute — the one-line receipt rows staying put with
// LabelDots inserted, the label UI layout (picker popover containment, the
// search chip tap target and its dialog's label half — TASK-101 reshaped the
// topbar entry — the manage screen) and the titled chips' WCAG contrast in
// both color schemes. Each test title carries its [covers:<id>] tag for
// scripts/design/verify-conditions.py; the conditions live in
// tests/design/conditions.toml (design:
// tmp/tasks/tm-60/design_browser-extension.md §4-2).
// Run: mise run frontend:browser (or
//   pnpm exec playwright test tests/browser/verify-labels.spec.ts).

import { expect, test, type Page } from '@playwright/test'
import { contrastRatio, parseColor, rectInViewport } from './measure'
import { installApiStub } from './stub'

// Browser-side issue logging (verify.spec.ts recipe; vite HMR websocket
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

// --- one-line receipt rows: the reserved labels cell (row-labels) carries
// the compact LabelDots (8px, up to five) without widening the row — the
// width difference against a label-less row is the font-independent metric
// (richLabels puts all five labels on receipt 102; the feed seed's 104 is
// the label-less contrast row) ---

test.describe('row labels (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-receipts.row-labels-no-widen-real] LabelDots 挿入で一覧行の幅・高さ・横溢れが不変', async ({ page }) => {
    logPageIssues(page, 'row-labels')
    await installApiStub(page, { feed: 9, richLabels: true })
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('.recent-row').first()).toBeVisible()
    // NB: the row is addressed via its li[data-test] — the link's href
    // expands the list context query, so an attribute selector on the href
    // would not match
    const m = await page.evaluate(() => {
      const five = document.querySelector('[data-test="receipt-102"] a.recent-row')
      const none = document.querySelector('[data-test="receipt-104"] a.recent-row')
      const rows = Array.from(document.querySelectorAll('.recent-row'))
      const dot = five?.querySelector('.label-dot') ?? null
      const fr = five?.getBoundingClientRect() ?? null
      const nr = none?.getBoundingClientRect() ?? null
      const dr = dot?.getBoundingClientRect() ?? null
      return {
        fiveW: fr?.width ?? null,
        noneW: nr?.width ?? null,
        dots: five ? five.querySelectorAll('.label-dot').length : 0,
        rowCount: rows.length,
        maxRowH: rows.length ? Math.max(...rows.map((r) => r.getBoundingClientRect().height)) : 0,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        dotW: dr?.width ?? null,
        dotH: dr?.height ?? null,
      }
    })
    const dump = JSON.stringify(m)
    expect(m.fiveW, dump).not.toBeNull()
    expect(m.noneW, dump).not.toBeNull()
    // non-vacuous: the five-dot row really carries five dots
    expect(m.dots, dump).toBe(5)
    expect(Math.abs(m.fiveW! - m.noneW!), dump).toBeLessThanOrEqual(1)
    expect(m.maxRowH, dump).toBeLessThanOrEqual(44.5)
    expect(m.scrollWidth, dump).toBeLessThanOrEqual(m.clientWidth)
    expect(Math.abs(m.dotW! - 8), dump).toBeLessThanOrEqual(0.5)
    expect(Math.abs(m.dotH! - 8), dump).toBeLessThanOrEqual(0.5)
  })
})

// --- label UI layout (TASK-101 shape): the picker popover stays inside the
// viewport, the search chip is a 44x44 tap target, its dialog's label half
// stays inside the dialog, and a selection paints the 5px dots + accent on
// the chip itself ---

test.describe('label UI (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-labels.ui-layout-real] picker popover は viewport 内・検索チップ 44px・dialog 下段は dialog 内・選択ドット 5px', async ({ page }) => {
    logPageIssues(page, 'label-ui')
    await installApiStub(page, { richLabels: true })

    // (1) the picker popover (anchored) stays inside the viewport
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()
    // the feed renders the whole window's panels, each with its own picker
    // button — scope to panel 101's own trigger
    await page.locator('[data-test="receipt-panel-101"] [data-test="label-add"]').click()
    await expect(page.locator('.label-picker-pop .popover-dialog')).toBeVisible()
    // the richLabels gate (contrast-test recipe): until the /labels
    // definitions fetch lands the picker falls back to bare color-only
    // chips — a narrower popover than the titled chips this condition
    // measures, so wait for a titled chip before reading the rect
    await expect(page.locator('.label-picker-pop .label-chip.titled').first()).toBeVisible()
    const pop = await page.evaluate(() => {
      const r = document.querySelector('.label-picker-pop .popover-dialog')!.getBoundingClientRect()
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      }
    })
    expect(rectInViewport(pop, pop.innerWidth, pop.innerHeight), JSON.stringify(pop)).toBe(true)
    await page.keyboard.press('Escape')

    // (2) the search chip is the 44x44 square entry (the only icon chip on
    // the two-chip bar now)
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('.topbar')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const box = await page.locator('[data-test="filter-search"]').boundingBox()
    expect(box, 'filter-search').toBeTruthy()
    // the condition's tolerance is ±0.5 (dot measurements below use the
    // same explicit form)
    expect(Math.abs(box!.width - 44), 'filter-search').toBeLessThanOrEqual(0.5)
    expect(Math.abs(box!.height - 44), 'filter-search').toBeLessThanOrEqual(0.5)

    // (3)(4) open the search dialog and pick a color in its lower half: the
    // label half stays inside the dialog rect and the chip turns active
    // with a 5px dot
    await page.locator('[data-test="filter-search"]').click()
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await expect(page.locator('[role="dialog"] .label-toggle-group')).toBeVisible()
    const fit = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')!.getBoundingClientRect()
      const g = document.querySelector('[role="dialog"] .label-toggle-group')!.getBoundingClientRect()
      const foot = document.querySelector('[role="dialog"] [data-test="label-filter-clear"]')!.getBoundingClientRect()
      return {
        dLeft: d.left,
        dRight: d.right,
        dBottom: d.bottom,
        groupInside: g.left >= d.left - 0.5 && g.right <= d.right + 0.5 && g.bottom <= d.bottom + 0.5,
        footInside: foot.right <= d.right + 0.5 && foot.bottom <= d.bottom + 0.5,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dialogInside: d.left >= 0 && d.right <= window.innerWidth && d.bottom <= window.innerHeight,
      }
    })
    const fdump = JSON.stringify(fit)
    expect(fit.groupInside, 'the label half rides inside the dialog rect').toBe(true)
    expect(fit.footInside, 'the 解除 button rides inside the dialog rect').toBe(true)
    expect(fit.dialogInside, fdump).toBe(true)
    await page.locator('[data-test="label-filter-red"]').click()
    await expect(page.locator('[data-test="filter-search"]')).toHaveClass(/active/)
    const m = await page.evaluate(() => {
      const chip = document.querySelector('[data-test="filter-search"]')!
      const dr = chip.querySelector('.label-filter-dot')?.getBoundingClientRect() ?? null
      return { dotW: dr?.width ?? null, dotH: dr?.height ?? null }
    })
    const dump = JSON.stringify(m)
    expect(Math.abs(m.dotW! - 5), dump).toBeLessThanOrEqual(0.5)
    expect(Math.abs(m.dotH! - 5), dump).toBeLessThanOrEqual(0.5)
  })

  test('[covers:web-browse.filter-dialogs] 検索dialog下段の toggle は即時適用: 再取得と URL labels= 同期・dialog 維持・解除で全消し', async ({ page }) => {
    logPageIssues(page, 'label-immediate')
    await installApiStub(page, { richLabels: true })
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('.topbar')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.locator('[data-test="filter-search"]').click()
    await expect(page.locator('[role="dialog"]')).toBeVisible()

    // toggling red re-queries at once (a fresh receipts response lands) and
    // the URL picks up labels= while the dialog stays open
    const requery = page.waitForResponse((r) => /\/api\/ledgers\/1\/receipts/.test(r.url()))
    await page.locator('[data-test="label-filter-red"]').click()
    await requery
    await expect(page).toHaveURL(/labels=red/)
    expect(await page.locator('[role="dialog"]').isVisible()).toBe(true)

    // 解除 empties the selection: the URL drops labels= after another
    // re-query, and the dialog still stays up for more adjustments
    const requery2 = page.waitForResponse((r) => /\/api\/ledgers\/1\/receipts/.test(r.url()))
    await page.locator('[data-test="label-filter-clear"]').click()
    await requery2
    await expect(page).not.toHaveURL(/labels=/)
    expect(await page.locator('[role="dialog"]').isVisible()).toBe(true)
  })
})

// --- manage screen: five rows at 360px, each at least 48px tall, no
// horizontal overflow ---

test.describe('manage labels (360x780)', () => {
  test.use({ viewport: { width: 360, height: 780 } })

  test('[covers:web-labels.ui-layout-real] /settings/labels は 360px で5行・行高 ≥48px・横溢れなし', async ({ page }) => {
    logPageIssues(page, 'manage-labels')
    await installApiStub(page, { richLabels: true })
    await page.goto('/settings/labels')
    for (const c of ['red', 'yellow', 'green', 'blue', 'purple']) {
      await expect(page.locator(`[data-test="label-row-${c}"]`)).toBeVisible()
    }
    const m = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.label-row-btn'))
      return {
        count: btns.length,
        minH: btns.length ? Math.min(...btns.map((b) => b.getBoundingClientRect().height)) : 0,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }
    })
    const dump = JSON.stringify(m)
    expect(m.count, dump).toBe(5)
    expect(m.minH, dump).toBeGreaterThanOrEqual(48)
    expect(m.scrollWidth, dump).toBeLessThanOrEqual(m.clientWidth)
  })
})

// --- titled chip contrast: the five .label-chip.titled colorways meet
// WCAG 4.5:1 in both schemes (tokens swap via prefers-color-scheme) ---

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`label chip contrast (${scheme})`, () => {
    test.use({ viewport: { width: 390, height: 780 }, colorScheme: scheme })

    test('[covers:web-labels.chip-contrast-real] 全ラベルチップの fg/bg コントラスト ≥ 4.5:1', async ({ page }) => {
      logPageIssues(page, `contrast-${scheme}`)
      await installApiStub(page, { richLabels: true })
      await page.goto('/settings/labels')
      // .titled only appears once the real definitions arrive (the color-only
      // fallback renders bare chips), so this wait also gates the fetch
      await expect(page.locator('[data-test="label-row-red"] .label-chip.titled')).toBeVisible()
      const chips = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.label-chip.titled')).map((el) => ({
          color: getComputedStyle(el).color,
          bg: getComputedStyle(el).backgroundColor,
        })),
      )
      expect(chips.length, 'five titled chips render').toBe(5)
      for (const c of chips) {
        const fg = parseColor(c.color)
        const bg = parseColor(c.bg)
        expect(fg, `unparseable fg "${c.color}" fails`).not.toBeNull()
        expect(bg, `unparseable bg "${c.bg}" fails`).not.toBeNull()
        const ratio = contrastRatio(fg!, bg!)
        expect(ratio, `${c.color} on ${c.bg} (${scheme})`).toBeGreaterThanOrEqual(4.5)
      }
    })
  })
}

// --- label picker close-on-select (TASK-51): tapping a color in the picker
// popover closes the dialog, lands the chip in the tags row and returns the
// focus to the tag-plus trigger (the user read the always-open popover as a
// bug; the chip animating in is the confirmation now) ---

test.describe('label picker close on select (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-labels.picker-close-real] 色の tap で popover が閉じ・chip が行に現れ・focus が label-add へ戻る', async ({ page }) => {
    logPageIssues(page, 'picker-close')
    await installApiStub(page)
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()
    const picker = page.locator('[data-test="receipt-panel-101"] [data-test="label-picker"]')
    await expect(picker.locator('[data-test="label-add"]')).toBeVisible()
    await picker.locator('[data-test="label-add"]').click()
    await expect(picker.locator('.popover-dialog')).toBeVisible()
    await picker.locator('[data-test="label-toggle-red"]').click()
    const m = await page.evaluate(() => {
      const p = document.querySelector('[data-test="receipt-panel-101"] [data-test="label-picker"]')!
      return {
        dialog: p.querySelector('[role="dialog"]') !== null,
        chip: p.querySelectorAll('.label-chip').length,
        focusOnAdd: document.activeElement === p.querySelector('[data-test="label-add"]'),
      }
    })
    const dump = JSON.stringify(m)
    expect(m.dialog, dump).toBe(false)
    expect(m.chip, 'the selected chip rides the tags row').toBeGreaterThan(0)
    expect(m.focusOnAdd, 'the focus returns to the tag-plus trigger').toBe(true)
  })
})
