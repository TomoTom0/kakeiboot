// TASK-60 real-browser verification (chromium), shell half: the layout
// facts jsdom cannot compute — the ledger-name 899px boundary, the anchored
// popover's --popover-shift correction, the sheet-narrow 480px switch with
// its scrim, and the drawer overlay end states. Each test title carries its
// [covers:<id>] tag for scripts/design/verify-conditions.py; the conditions
// live in tests/design/conditions.toml (design:
// tmp/tasks/tm-60/design_browser-extension.md §4-1). capture.spec.ts takes
// the pictures; this spec measures.
// Run: mise run frontend:browser (or
//   pnpm exec playwright test tests/browser/verify-shell.spec.ts).

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

// --- ledger switcher: the name rides along only at 900px+ (the 899px media
// query hides .ledger-name; the accessible name stays via aria-label, the
// static side web-shell.ledger-switcher) ---

for (const spec of [
  { width: 899, height: 780, visible: false },
  { width: 900, height: 800, visible: true },
] as const) {
  test.describe(`ledger name ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: spec.height } })

    test('[covers:web-shell.ledger-name-breakpoints-real] 家計簿切替の名前併記は 899px 境界で切替', async ({ page }) => {
      logPageIssues(page, `ledger-name${spec.width}`)
      await installApiStub(page)
      await page.goto('/receipts')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const el = document.querySelector('[data-test="ledger-switch"] .ledger-name') as HTMLElement | null
        if (!el) return { present: false, display: 'missing', width: 0 }
        return { present: true, display: getComputedStyle(el).display, width: el.getBoundingClientRect().width }
      })
      const dump = `${spec.width}px ${JSON.stringify(m)}`
      expect(m.present, '/receipts is ledgerScoped: the ledger switcher renders').toBe(true)
      if (spec.visible) {
        expect(m.display, dump).not.toBe('none')
        expect(m.width, dump).toBeGreaterThan(0)
      } else {
        expect(m.display, dump).toBe('none')
      }
    })
  })
}

// --- anchored popover shift: the panel rect is measured after opening and
// pushed back inside the 16px viewport margins via --popover-shift (bare
// chips of the default seed keep the picker width deterministic). Seeded
// with bareTags (design §9-1 alt-2): at both 390px and 360px the full tags
// row keeps the picker host near the row's end (measured panel left 223 of
// 390, shift 0px — the §9-1 first alternative's wrap never happens), so
// receipt 101 drops its tags and the host sits at the row head where the
// panel crosses the 16px margin and the correction demonstrably fires ---

test.describe('popover shift (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-shell.popover-shift-real] anchored popover は --popover-shift で 16px margin 内へ収まる', async ({ page }) => {
    logPageIssues(page, 'popover-shift')
    await installApiStub(page, { bareTags: true })
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()
    // the feed renders the whole window's panels, each with its own picker
    // button — scope to panel 101's own trigger
    await page.locator('[data-test="receipt-panel-101"] [data-test="label-add"]').click()
    await expect(page.locator('.label-picker-pop .popover-dialog')).toBeVisible()
    const m = await page.evaluate(() => {
      const el = document.querySelector('.label-picker-pop .popover-dialog')!
      const r = el.getBoundingClientRect()
      return {
        left: r.left,
        right: r.right,
        innerWidth: window.innerWidth,
        shift: getComputedStyle(el).getPropertyValue('--popover-shift'),
      }
    })
    const dump = JSON.stringify(m)
    expect(m.left, dump).toBeGreaterThanOrEqual(15)
    expect(m.right, dump).toBeLessThanOrEqual(m.innerWidth - 15)
    // non-vacuous: the correction actually fired (shift parsed as a number > 0)
    const shift = parseFloat(m.shift)
    expect(Number.isFinite(shift), dump).toBe(true)
    expect(shift, dump).toBeGreaterThan(0)
  })
})

// --- sheet-narrow popover: the 480px boundary turns the /receipts filter
// form into a bottom sheet (fixed, full width, 70dvh, radius 12px, z 45
// above the tabbar) with a scrim behind it; 481px stays anchored ---

for (const spec of [
  { width: 480, narrow: true },
  { width: 481, narrow: false },
] as const) {
  test.describe(`popover sheet ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: 780 } })

    test('[covers:web-shell.popover-sheet-breakpoints-real] sheet-narrow は 480px 境界でボトムシートへ切替', async ({ page }) => {
      logPageIssues(page, `popover-sheet${spec.width}`)
      await installApiStub(page)
      await page.goto('/receipts?month=2026-10')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.locator('[data-test="filters-toggle"]').click()
      // is-narrow lands via watch(open) -> nextTick -> onOpened, i.e. after
      // the dialog itself mounts: wait for the composed state, not the bare
      // dialog (a bare visibility wait could measure pre-narrow)
      if (spec.narrow) {
        await expect(page.locator('.filters-popover .popover-dialog.is-narrow')).toBeVisible()
      } else {
        await expect(page.locator('.filters-popover .popover-dialog:not(.is-narrow)')).toBeVisible()
      }
      const m = await page.evaluate(() => {
        const el = document.querySelector('.filters-popover .popover-dialog')!
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const mid = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        const hit = document.elementFromPoint(mid.x, mid.y)
        return {
          isNarrow: el.classList.contains('is-narrow'),
          position: cs.position,
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          maxHeight: cs.maxHeight,
          radius: cs.borderTopLeftRadius,
          scrim: !!document.querySelector('.filters-popover .popover-scrim'),
          hitInPanel: hit !== null && el.contains(hit),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        }
      })
      const dump = `${spec.width}px ${JSON.stringify(m)}`
      if (spec.narrow) {
        expect(m.isNarrow, dump).toBe(true)
        expect(m.position, dump).toBe('fixed')
        expect(Math.abs(m.left), dump).toBeLessThanOrEqual(1)
        expect(Math.abs(m.right - m.innerWidth), dump).toBeLessThanOrEqual(1)
        expect(Math.abs(m.bottom - m.innerHeight), dump).toBeLessThanOrEqual(1)
        expect(parseFloat(m.maxHeight), dump).toBeLessThanOrEqual(0.7 * m.innerHeight + 1)
        expect(m.radius, dump).toBe('12px')
        expect(m.scrim, dump).toBe(true)
        expect(m.hitInPanel, 'elementFromPoint at the sheet center hits the panel itself').toBe(true)
      } else {
        expect(m.isNarrow, dump).toBe(false)
        expect(m.position, dump).toBe('absolute')
        expect(m.scrim, dump).toBe(false)
      }
    })
  })
}

// --- drawer overlay, modal side (390px): closed = off-screen, open = pinned
// left with the scroll lock, the scrim under the topbar, the inert main
// column and the z-order (scrim over feed-nav, topbar over everything);
// reduced motion makes the slide instant so the end state is deterministic ---

test.describe('drawer overlay (390x780, reduced motion)', () => {
  test.use({ viewport: { width: 390, height: 780 }, reducedMotion: 'reduce' })

  test('[covers:web-shell.drawer-overlay-real] modal drawer: 閉=画面外・開=左端・lock・scrim・inert・重なり', async ({ page }) => {
    logPageIssues(page, 'drawer-modal')
    await installApiStub(page)
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()

    const sidebarRect = () => page.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect())
    const mainX = () => page.evaluate(() => document.querySelector('.app-main')!.getBoundingClientRect().x)

    // closed: the sidebar sits fully off-screen; the main column's x is the baseline
    expect((await sidebarRect()).right).toBeLessThanOrEqual(0)
    const x0 = await mainX()

    await page.locator('[data-test="menu-button"]').click()
    await expect
      .poll(async () => {
        const r = await sidebarRect()
        return Math.abs(r.left) <= 1 && Math.abs(r.top - 56) <= 1 && Math.abs(r.width - 240) <= 1
      }, { timeout: 3_000 })
      .toBe(true)
    const m = await page.evaluate(() => {
      const scrim = document.querySelector('.scrim')!
      const sr = scrim.getBoundingClientRect()
      const center = (sel: string) => {
        const b = document.querySelector(sel)!.getBoundingClientRect()
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      }
      const hitAt = (p: { x: number; y: number }) => document.elementFromPoint(p.x, p.y)
      const hitFeed = hitAt(center('[data-test="feed-prev"]'))
      const hitMenu = hitAt(center('[data-test="menu-button"]'))
      return {
        lock: document.documentElement.classList.contains('drawer-lock'),
        overflow: getComputedStyle(document.documentElement).overflow,
        scrimTop: sr.top,
        scrimLeft: sr.left,
        scrimRight: sr.right,
        scrimBottom: sr.bottom,
        mainInert: document.querySelector('.main-col')!.hasAttribute('inert'),
        hitFeedInScrim: hitFeed !== null && hitFeed.closest('.scrim') !== null,
        hitMenuInTopbar: hitMenu !== null && hitMenu.closest('.topbar') !== null,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      }
    })
    const dump = JSON.stringify(m)
    expect(m.lock, dump).toBe(true)
    expect(m.overflow, dump).toBe('hidden')
    expect(Math.abs(m.scrimTop - 56), dump).toBeLessThanOrEqual(1)
    expect(Math.abs(m.scrimLeft), dump).toBeLessThanOrEqual(1)
    expect(Math.abs(m.scrimRight - m.innerWidth), dump).toBeLessThanOrEqual(1)
    expect(Math.abs(m.scrimBottom - m.innerHeight), dump).toBeLessThanOrEqual(1)
    expect(m.mainInert, dump).toBe(true)
    expect(m.hitFeedInScrim, 'the scrim covers the feed nav (z 25 over z 10)').toBe(true)
    expect(m.hitMenuInTopbar, 'the topbar (z 40) stays above the drawer layers').toBe(true)
    expect(Math.abs((await mainX()) - x0), 'the main column never moves').toBeLessThanOrEqual(1)

    // close: everything modal is gone and the sidebar is off-screen again
    await page.locator('[data-test="menu-button"]').click()
    await expect.poll(async () => (await sidebarRect()).right <= 0, { timeout: 3_000 }).toBe(true)
    const closed = await page.evaluate(() => ({
      lock: document.documentElement.classList.contains('drawer-lock'),
      mainInert: document.querySelector('.main-col')!.hasAttribute('inert'),
      scrim: getComputedStyle(document.querySelector('.scrim')!).display,
    }))
    const cdump = JSON.stringify(closed)
    expect(closed.lock, cdump).toBe(false)
    expect(closed.mainInert, cdump).toBe(false)
    expect(closed.scrim, cdump).toBe('none')
    expect(Math.abs((await mainX()) - x0), cdump).toBeLessThanOrEqual(1)
  })
})

// --- drawer overlay, desktop side (900px): the overlay starts open with no
// modal side effects (no scrim, no inert, no lock); the plain slide toggle
// keeps the main column put through open -> close -> open ---

test.describe('drawer overlay (900x800, reduced motion)', () => {
  test.use({ viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' })

  test('[covers:web-shell.drawer-overlay-real] desktop overlay: 初期open・scrim/inert/lockなし・main不変', async ({ page }) => {
    logPageIssues(page, 'drawer-desktop')
    await installApiStub(page)
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()

    const sidebarRect = () => page.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect())
    const mainX = () => page.evaluate(() => document.querySelector('.app-main')!.getBoundingClientRect().x)

    // the 900px matchMedia opens the overlay from the start
    await expect
      .poll(async () => {
        const r = await sidebarRect()
        return Math.abs(r.left) <= 1 && Math.abs(r.top - 60) <= 1 && Math.abs(r.width - 240) <= 1
      }, { timeout: 3_000 })
      .toBe(true)
    const m = await page.evaluate(() => ({
      scrim: getComputedStyle(document.querySelector('.scrim')!).display,
      mainInert: document.querySelector('.main-col')!.hasAttribute('inert'),
      lock: document.documentElement.classList.contains('drawer-lock'),
    }))
    const dump = JSON.stringify(m)
    expect(m.scrim, dump).toBe('none')
    expect(m.mainInert, dump).toBe(false)
    expect(m.lock, dump).toBe(false)
    const x0 = await mainX()

    // close: plain slide, no modal side effects; the main column stays put
    await page.locator('[data-test="menu-button"]').click()
    await expect.poll(async () => (await sidebarRect()).right <= 0, { timeout: 3_000 }).toBe(true)
    expect(Math.abs((await mainX()) - x0), 'the main column never moves').toBeLessThanOrEqual(1)

    // and open again
    await page.locator('[data-test="menu-button"]').click()
    await expect
      .poll(async () => {
        const r = await sidebarRect()
        return Math.abs(r.left) <= 1 && Math.abs(r.top - 60) <= 1
      }, { timeout: 3_000 })
      .toBe(true)
  })
})
