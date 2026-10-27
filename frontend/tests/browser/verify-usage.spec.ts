// TASK-48 real-browser verification (chromium), usage half: the copy
// feedback facts jsdom cannot compute — the icon swap carries a real
// animation-name and the URL box keeps its height through the success state
// (the old in-box "コピーしました" text row used to reflow it). Each test
// title carries its [covers:<id>] tag for scripts/design/verify-conditions.py;
// the conditions live in tests/design/conditions.toml (design:
// tmp/tasks/tm-48/design_copy-feedback.md §4).
// Run: mise run frontend:browser (or
//   pnpm exec playwright test tests/browser/verify-usage.spec.ts).

import { expect, test, type Page } from '@playwright/test'
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

// --- copy feedback (TASK-48): clicking the icon-only copy button swaps the
// svg to the check glyph with the pop animation applied, while the URL box
// keeps its exact height (the success state must not reflow the box) ---
//
// A reduced-motion variant asserts the second guard: the swap stays (check
// glyph + accent) but the animation property reads none.

for (const spec of [
  { motion: 'no-preference' as const, animated: true },
  { motion: 'reduce' as const, animated: false },
] as const) {
  test.describe(`copy feedback (390x780, ${spec.motion})`, () => {
    test.use({ viewport: { width: 390, height: 780 }, reducedMotion: spec.motion })

    test('[covers:web-usage.copy-feedback-real] コピー押下で svg が check へ切替し box の高さは不変（animation は reduced-motion で無効）', async ({ page }) => {
      logPageIssues(page, `copy-${spec.motion}`)
      // jsdom-free clipboard: resolve writeText in the page whatever the
      // environment grants
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'clipboard', {
          value: { writeText: async () => {} },
          configurable: true,
        })
      })
      await installApiStub(page)
      await page.goto('/usage/connect')
      await expect(page.locator('[data-test="connect-url-box"]')).toBeVisible()
      const h0 = await page.evaluate(
        () => document.querySelector('[data-test="connect-url-box"]')!.getBoundingClientRect().height,
      )
      await page.locator('[data-test="copy-url"]').click()
      const m = await page.evaluate(() => {
        const btn = document.querySelector('[data-test="copy-url"]')!
        const icon = btn.querySelector('.icon')!
        return {
          check: btn.querySelector('svg')!.innerHTML.includes('M20 6 9 17l-5-5'),
          anim: getComputedStyle(icon).animationName,
          boxH: document.querySelector('[data-test="connect-url-box"]')!.getBoundingClientRect().height,
          visibleDoneLine: Array.from(
            document.querySelectorAll('[data-test="connect-url-box"] > *:not(.sr-only)'),
          ).some((el) => (el.textContent ?? '').includes('コピーしました')),
          srStatus: !!document.querySelector('[data-test="copy-done"].sr-only[role="status"]'),
        }
      })
      const dump = JSON.stringify(m)
      expect(m.check, dump).toBe(true)
      if (spec.animated) expect(m.anim, dump).toBe('bb-copy-pop')
      else expect(m.anim, dump).toBe('none')
      expect(Math.abs(m.boxH - h0), dump).toBeLessThanOrEqual(1)
      expect(m.visibleDoneLine, 'no visible done text row joins the box').toBe(false)
      expect(m.srStatus, dump).toBe(true)
    })
  })
}
