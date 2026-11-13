// README figure capture (TASK-184): the two screenshots the repo README
// shows — the home dashboard and one rich receipt detail — on the showcase
// seed (stub.ts `showcase` → mock.ts SHOWCASE_RECEIPTS: six months of
// lifestyle data, so the trend bars / week rows / recent list carry real
// weight instead of the thin 3-receipt default). Phone width only (390),
// light scheme, 2x device pixels — the capture.usage.spec.ts newShotContext
// recipe. The pngs land in test-results/browser/capture/readme/ and are
// copied to assets/img/shot_{home,receipt}.png for the README.
// Run: pnpm exec playwright test tests/browser/capture.readme.spec.ts

import { mkdirSync } from 'node:fs'
import { expect, test, type Browser } from '@playwright/test'
import { installApiStub } from './stub'

const OUT = 'test-results/browser/capture/readme'

// The showcase representative (mock.ts SHOWCASE_RECEIPTS): 2026-10-13 19:44
// サンライフ, 7 items / 5,336円, has_image + red label + note.
const SHOWCASE_RECEIPT = 271

// The showcase clock runs at month end (2026-10-31) so October's whole
// calendar — every week row included — is settled data, not a mid-month
// snapshot with empty trailing weeks.
const SHOWCASE_NOW = '2026-10-31T12:00:00+09:00'

/** A 390px light-scheme context at 2x device pixels (the existing login capture recipe). */
function newShotContext(browser: Browser) {
  return browser.newContext({
    // 1200 (not the 780 recipe) keeps the sticky bottom tabbar below the
    // week rows on the fullPage home shot
    viewport: { width: 390, height: 1200 },
    deviceScaleFactor: 2,
    locale: 'ja-JP',
    colorScheme: 'light',
  })
}

test.describe('README figures (width 390)', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  // The home dashboard full page: month total, stacked trend bars over the
  // six-month window, the week rows of the current week, the recent feed.
  test('readme-home.png — the home dashboard on the showcase seed', async ({ browser }) => {
    const ctx = await newShotContext(browser)
    const page = await ctx.newPage()
    await installApiStub(page, { showcase: true, now: SHOWCASE_NOW })
    await page.goto('/')
    await expect(page.locator('.topbar')).toBeVisible()
    // the four data zones of the dashboard have drawn their real content
    // (skeleton done, bars and rows rendered) before the shot is taken
    await expect(page.locator('[data-test="breakdown"]')).toBeVisible()
    await expect(page.locator('[data-test="trend"] [data-test^="bar-"]').first()).toBeVisible()
    await expect(page.locator('[data-test="week-card"] [data-test^="row-"]').first()).toBeVisible()
    await expect(page.locator('[data-test^="recent-"]').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    await page.screenshot({ path: `${OUT}/readme-home.png`, fullPage: true, animations: 'disabled' })
    await ctx.close()
  })

  // One rich receipt on the feed: store head, datetime, the 7-line item
  // table, total, label dots, note and the image placeholder. The feed page
  // stacks the whole month's panels (a fullPage shot would be ~5,700px tall
  // of neighbors), so the PANEL element itself is captured at its full
  // height — the one-receipt figure the README wants.
  test('readme-receipt.png — the showcase representative receipt', async ({ browser }) => {
    const ctx = await newShotContext(browser)
    const page = await ctx.newPage()
    await installApiStub(page, { showcase: true, now: SHOWCASE_NOW })
    await page.goto(`/receipts/${SHOWCASE_RECEIPT}`)
    const panel = page.locator(`[data-test="receipt-panel-${SHOWCASE_RECEIPT}"]`)
    await expect(panel).toBeVisible()
    await page.waitForLoadState('networkidle')
    await panel.screenshot({ path: `${OUT}/readme-receipt.png`, animations: 'disabled' })
    await ctx.close()
  })
})
