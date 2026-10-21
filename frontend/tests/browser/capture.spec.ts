// Screen capture of the current web screens at phone / desktop widths
// (TASK-19). Outputs go to test-results/browser/capture/<width>/:
//   <screen>.png         viewport capture
//   <screen>-full.png    full page capture
//   logo-*.png           enlarged (deviceScaleFactor 3) logo crops
//   metrics.json         bounding boxes / overlap facts for analysis
// Run: pnpm exec playwright test (or mise run frontend:browser).

import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { installApiStub } from './stub'

const OUT = 'test-results/browser/capture'
const WIDTHS = [390, 360, 768, 1280] as const
const SCREENS = [
  { name: 'home', path: '/' },
  { name: 'categories', path: '/categories' },
  { name: 'receipt-feed', path: '/receipts/101' },
  // settings tabs (TASK-36 real-device rework: four horizontal tabs) and the
  // label manage screen that lights the data tab
  { name: 'settings-general', path: '/settings/general' },
  { name: 'settings-auth', path: '/settings/auth' },
  { name: 'settings-data', path: '/settings/data' },
  { name: 'settings-others', path: '/settings/others' },
  { name: 'settings-labels', path: '/settings/labels' },
  // usage pages (TASK-37); usage-connect shows the F2/F6 placeholders until
  // the ChatGPT-side screenshots land, so it captures fine without them
  { name: 'usage', path: '/usage' },
  { name: 'usage-connect', path: '/usage/connect' },
] as const

type Box = { x: number; y: number; width: number; height: number } | null

async function box(page: Page, selector: string): Promise<Box> {
  const loc = page.locator(selector).filter({ visible: true }).first()
  if ((await loc.count()) === 0) return null
  return loc.boundingBox()
}

/** Facts of the shell header: logo boxes, computed colors, menu button. */
async function shellMetrics(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: cs.display,
        visibility: cs.visibility,
        color: cs.color,
      }
    }
    const svgPaint = (svg: Element | null) => {
      if (!svg) return null
      const rectEl = svg.querySelector('rect')
      const paths = Array.from(svg.querySelectorAll('path'))
      return {
        rectFill: rectEl ? getComputedStyle(rectEl).fill : null,
        rectStroke: rectEl ? getComputedStyle(rectEl).stroke : null,
        pathStrokes: paths.map((p) => getComputedStyle(p).stroke),
        attrWidth: svg.getAttribute('width'),
        attrHeight: svg.getAttribute('height'),
        viewBox: svg.getAttribute('viewBox'),
      }
    }
    const q = (s: string) => document.querySelector(s)
    const menu = q('.menu-btn')
    let menuCenterTop: string | null = null
    if (menu) {
      const r = menu.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      menuCenterTop = hit
        ? `${hit.tagName.toLowerCase()}${hit.id ? '#' + hit.id : ''}.${Array.from(hit.classList).join('.')}` +
          ` (inside: ${(hit.closest('[class]') as HTMLElement | null)?.className ?? ''}; sidebar=${!!hit.closest('.sidebar')}; scrim=${!!hit.closest('.scrim')}; menu=${!!hit.closest('.menu-btn')})`
        : null
    }
    const topbar = q('.topbar')
    const topbarChildren = topbar
      ? Array.from(topbar.children).map((c) => ({ cls: (c as HTMLElement).className, ...rect(c) }))
      : []
    return {
      viewport: { w: innerWidth, h: innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      topbar: rect(topbar),
      topbarChildren,
      menuBtn: rect(menu),
      menuCenterTop,
      sidebar: rect(q('.sidebar')),
      sidebarLogo: rect(q('.sidebar .logo')),
      sidebarLogoPaint: svgPaint(q('.sidebar .logo')),
      topbarLogoFull: rect(q('.topbar-logo-full')),
      topbarLogoFullPaint: svgPaint(q('.topbar-logo-full')),
      topbarLogoCompact: rect(q('.topbar-logo-compact')),
      topbarLogoCompactPaint: svgPaint(q('.topbar-logo-compact')),
      authLogo: rect(q('.auth-logo')),
      authLogoPaint: svgPaint(q('.auth-logo')),
      drawerClose: rect(q('.drawer-close')),
      scrim: rect(q('.scrim')),
      accentVar: getComputedStyle(document.documentElement).getPropertyValue('--bb-accent'),
      accentSoftVar: getComputedStyle(document.documentElement).getPropertyValue('--bb-accent-soft'),
    }
  })
}

/** Rows of the main column: each direct block child of main with its box (toolbars, label buttons). */
async function mainRows(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const main = document.querySelector('.app-main')
    if (!main) return []
    const out: { tag: string; cls: string; text: string; x: number; y: number; w: number; h: number }[] = []
    const walk = (el: Element, depth: number) => {
      for (const c of Array.from(el.children)) {
        const r = c.getBoundingClientRect()
        if (r.height === 0) continue
        if (r.y > innerHeight) continue
        out.push({
          tag: '  '.repeat(depth) + c.tagName.toLowerCase(),
          cls: (c as HTMLElement).className?.toString?.() ?? '',
          text: (c.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        })
        if (depth < 3) walk(c, depth + 1)
      }
    }
    walk(main, 0)
    return out
  })
}

for (const width of WIDTHS) {
  test.describe(`width ${width}`, () => {
    test.use({ viewport: { width, height: width >= 900 ? 800 : 780 } })
    const dir = `${OUT}/${width}`

    test.beforeAll(() => {
      mkdirSync(dir, { recursive: true })
    })

    test('screens, sidebar, logos', async ({ page, browser }) => {
      // capture walks 10+ screens with viewport + fullPage shots per width, so
      // it sits close to the default 30s budget under concurrent repo load
      // (parallel verify runs in worktrees); give the capture room to finish
      test.setTimeout(120_000)
      const metrics: Record<string, unknown> = {}
      await installApiStub(page)
      // browser-side errors go to the run log; Vite HMR websocket noise is
      // expected (headless chromium blocks the HMR socket) and skipped
      const noise = /\[vite\]|WebSocket|Vite server|server-hmr/
      page.on('pageerror', (e) => console.log(`[pageerror ${width}] ${e.message}`))
      page.on('console', (m) => {
        if (m.type() === 'error' && !noise.test(m.text())) console.log(`[console ${width}] ${m.text()}`)
      })
      page.on('response', (r) => {
        if (r.status() >= 400) console.log(`[http ${r.status()} ${width}] ${r.url()}`)
      })

      for (const s of SCREENS) {
        await page.goto(s.path)
        await expect(page.locator('.topbar')).toBeVisible()
        await page.waitForLoadState('networkidle')
        await page.screenshot({ path: `${dir}/${s.name}.png` })
        await page.screenshot({ path: `${dir}/${s.name}-full.png`, fullPage: true })
        metrics[s.name] = { shell: await shellMetrics(page), main: await mainRows(page) }
      }

      // sidebar / drawer open. The shell class is the source of truth for
      // the open state (the overlay hides via transform, not display):
      // mobile starts closed, so the menu button opens it; desktop starts
      // open (TASK-33 overlay unification) — and a closed shot follows.
      await page.goto('/')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.waitForLoadState('networkidle')
      const menu = page.locator('[data-test="menu-button"]')
      const navOpen = async () => ((await page.locator('.shell').getAttribute('class')) ?? '').includes('drawer-open')
      if (!(await navOpen())) {
        await menu.click()
        await page.waitForTimeout(400) // slide transition
      }
      await page.screenshot({ path: `${dir}/sidebar-open.png` })
      metrics['sidebar-open'] = { shell: await shellMetrics(page) }
      // the same on the receipt feed (toolbar under the top bar)
      await page.goto('/receipts/101')
      await page.waitForLoadState('networkidle')
      if (!(await navOpen())) {
        await menu.click()
        await page.waitForTimeout(400)
      }
      await page.screenshot({ path: `${dir}/sidebar-open-feed.png` })
      metrics['sidebar-open-feed'] = { shell: await shellMetrics(page) }
      // desktop only: the menu button slides the overlay closed (and back)
      if (width >= 900) {
        await menu.click()
        await page.waitForTimeout(400)
        await page.screenshot({ path: `${dir}/sidebar-closed.png` })
        metrics['sidebar-closed'] = { shell: await shellMetrics(page) }
        await menu.click()
        await page.waitForTimeout(400)
      }

      // enlarged logo crops (3x device pixels)
      const ctx = await browser.newContext({
        viewport: { width, height: 400 },
        deviceScaleFactor: 3,
        locale: 'ja-JP',
        colorScheme: 'light',
      })
      const zoom = await ctx.newPage()
      await installApiStub(zoom)
      await zoom.goto('/')
      await expect(zoom.locator('.topbar')).toBeVisible()
      await zoom.waitForLoadState('networkidle')
      await zoom.locator('.topbar').screenshot({ path: `${dir}/logo-topbar-bar.png` })
      const topLogo = zoom.locator('.topbar-brand').filter({ visible: true })
      if ((await topLogo.count()) > 0) await topLogo.first().screenshot({ path: `${dir}/logo-topbar.png` })
      if (width >= 900) {
        await zoom.locator('.sidebar').screenshot({ path: `${dir}/sidebar-desktop.png` })
      } else {
        await zoom.locator('[data-test="menu-button"]').click()
        await zoom.waitForTimeout(400)
        await zoom.locator('.sidebar').screenshot({ path: `${dir}/sidebar-drawer.png` })
      }
      metrics['zoom-boxes'] = {
        topbarBrand: await box(zoom, '.topbar-brand'),
        sidebar: await box(zoom, '.sidebar'),
      }
      await ctx.close()

      // login screen (no session)
      const lctx = await browser.newContext({
        viewport: { width, height: 780 },
        deviceScaleFactor: 2,
        locale: 'ja-JP',
        colorScheme: 'light',
      })
      const login = await lctx.newPage()
      await installApiStub(login, { loggedIn: false })
      await login.goto('/login')
      await login.waitForLoadState('networkidle')
      await login.screenshot({ path: `${dir}/login.png` })
      const authLogo = login.locator('.auth-logo').first()
      if ((await authLogo.count()) > 0) await authLogo.screenshot({ path: `${dir}/logo-login.png` })
      metrics.login = { shell: await shellMetrics(login) }
      await lctx.close()

      writeFileSync(`${dir}/metrics.json`, JSON.stringify(metrics, null, 2))
    })
  })
}
