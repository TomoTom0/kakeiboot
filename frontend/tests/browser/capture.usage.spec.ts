// Usage-figure asset capture (TASK-37): the two self-screen screenshots the
// /usage/connect page shows — F4 (passkey login) and F5 (consent). Phone
// width only (390), light scheme, logged out; the consent screen renders from
// the stubbed ConsentInfo (stub.ts CONSENT, whose scope descriptions are the
// backend scope_description strings). The pngs land in
// test-results/browser/capture/390/ and `mise run frontend:usage-shots` then
// copies them to src/web/assets/usage/{login,consent}.png.
// This spec only touches /login and /oauth/consent — both existing routes —
// so it runs (and was committed) before the /usage pages exist.
// Run: pnpm exec playwright test tests/browser/capture.usage.spec.ts

import { mkdirSync } from 'node:fs'
import { expect, test, type Browser } from '@playwright/test'
import { installApiStub } from './stub'

const OUT = 'test-results/browser/capture/390'

/** A 390px light-scheme context at 2x device pixels (the existing login capture recipe). */
function newShotContext(browser: Browser) {
  return browser.newContext({
    viewport: { width: 390, height: 780 },
    deviceScaleFactor: 2,
    locale: 'ja-JP',
    colorScheme: 'light',
  })
}

test.describe('usage figure assets (width 390)', () => {
  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  // F4: the login screen exactly as the connection flow opens it in a browser
  test('login.png — the passkey login screen', async ({ browser }) => {
    const ctx = await newShotContext(browser)
    const page = await ctx.newPage()
    await installApiStub(page, { loggedIn: false })
    await page.goto('/login')
    await expect(page.locator('[data-test="login"]')).toBeVisible()
    await page.screenshot({ path: `${OUT}/login.png`, fullPage: true })
    await ctx.close()
  })

  // F5: the consent screen (client / scope descriptions / first ledger /
  // allow-deny). The consent page does not call /api/auth/me, so it renders
  // in the logged-out context from the stubbed request info.
  test('consent.png — the consent screen', async ({ browser }) => {
    const ctx = await newShotContext(browser)
    const page = await ctx.newPage()
    await installApiStub(page, { loggedIn: false })
    await page.goto('/oauth/consent?req=dummy')
    await expect(page.locator('[data-test="consent"]')).toBeVisible()
    await page.screenshot({ path: `${OUT}/consent.png`, fullPage: true })
    await ctx.close()
  })
})
