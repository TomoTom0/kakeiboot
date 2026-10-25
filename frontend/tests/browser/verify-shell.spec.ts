// TASK-60 real-browser verification (chromium), shell half: the layout
// facts jsdom cannot compute — the topbar two-chip 360px fold and the
// account menu's ledger radio section (both TASK-101), the anchored
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

// --- topbar two-chip breakpoints (TASK-101): the label chip and the ledger
// trigger are gone from the topbar, leaving the period + search two chips.
// The 360px band keeps folding the kb word, the q word and the search chip's
// dot column down to the bare 44px icon entry — the current-recipe
// expectation (暫定; re-measured and finalized after the implementation
// lands, web-shell.topbar-breakpoints-real) ---

for (const spec of [
  { width: 360, folded: true },
  { width: 361, folded: false },
] as const) {
  test.describe(`topbar 2-chip fold ${spec.width}px`, () => {
    test.use({ viewport: { width: spec.width, height: 780 } })

    test('[covers:web-shell.topbar-breakpoints-real] 360px 帯の kb 語・q 語・検索チップ dot 列の折り畳みは現行維持（暫定）', async ({ page }) => {
      logPageIssues(page, `topbar-fold${spec.width}`)
      await installApiStub(page)
      // pick red through the search dialog's lower half, then run a search
      // from the same dialog so the q word rides the chip together with the
      // dots
      await page.goto('/receipts?month=2026-10')
      await expect(page.locator('.topbar')).toBeVisible()
      await page.locator('[data-test="filter-search"]').click()
      await expect(page.locator('[data-test="label-filter-red"]')).toBeVisible()
      await page.locator('[data-test="label-filter-red"]').click()
      await page.locator('[data-test="search-dialog-input"]').fill('牛乳')
      await page.locator('[data-test="search-dialog-submit"]').click()
      await page.waitForURL(/\/search\?/)
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => {
        const fact = (selector: string) => {
          const el = document.querySelector(selector)
          if (!el) return { present: false, display: 'missing', width: 0 }
          return { present: true, display: getComputedStyle(el).display, width: el.getBoundingClientRect().width }
        }
        const chip = document.querySelector('[data-test="filter-search"]') as HTMLElement | null
        return {
          kb: fact('.topbar-logo-compact .logo-word'),
          q: fact('[data-test="filter-search"] .chip-label-q'),
          dots: fact('[data-test="filter-search"] .label-filter-dots'),
          chipW: chip ? chip.getBoundingClientRect().width : 0,
          aria: chip?.getAttribute('aria-label') ?? '',
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }
      })
      const dump = `${spec.width}px ${JSON.stringify(m)}`
      // the spoken name keeps the term and the label at every band (the fold
      // only drops the painted surfaces)
      expect(m.aria, dump).toContain('検索: 牛乳')
      expect(m.aria, dump).toContain('ラベル:')
      if (spec.folded) {
        expect(m.kb.display, dump).toBe('none')
        expect(m.q.display, dump).toBe('none')
        expect(m.dots.display, dump).toBe('none')
        expect(Math.abs(m.chipW - 44), dump).toBeLessThanOrEqual(0.5)
      } else {
        expect(m.kb.display, dump).not.toBe('none')
        expect(m.q.display, dump).not.toBe('none')
        expect(m.q.width, dump).toBeGreaterThan(0)
        expect(m.dots.display, dump).not.toBe('none')
        expect(m.dots.width, dump).toBeGreaterThan(0)
        expect(m.scrollWidth, dump).toBeLessThanOrEqual(m.clientWidth)
      }
    })
  })
}

// --- ledger switcher inside the account menu (TASK-101): the topbar carries
// no standalone trigger anymore; the menu-head is followed by the 家計簿
// radio section (color chip / name / role / check), a separator and the four
// plain items. Selecting switches the session, the band follows and the
// focus returns to the account trigger ---

test.describe('ledger switch via account menu (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-shell.ledger-switcher][covers:web-shell.ledger-color-band] 家計簿切替は account menu 内 radio section（topbar トリガ無し）・切替後に band と選択行が追従', async ({ page }) => {
    logPageIssues(page, 'ledger-section')
    await installApiStub(page)
    await page.goto('/receipts?month=2026-10')
    await expect(page.locator('.topbar')).toBeVisible()
    await page.waitForLoadState('networkidle')
    // the topbar center is the two-chip bar: period + search, no label chip
    // and no ledger trigger
    const bar = await page.evaluate(() => ({
      period: !!document.querySelector('.topbar-filters [data-test="filter-period"]'),
      search: !!document.querySelector('.topbar-filters [data-test="filter-search"]'),
      labelChip: !!document.querySelector('.topbar-filters [data-test="filter-labels"]'),
      ledgerTrigger: !!document.querySelector('.topbar [data-test="ledger-switch"]'),
    }))
    const bdump = JSON.stringify(bar)
    expect(bar.period, bdump).toBe(true)
    expect(bar.search, bdump).toBe(true)
    expect(bar.labelChip, bdump).toBe(false)
    expect(bar.ledgerTrigger, bdump).toBe(false)

    // open the account menu: the radio section rides right under the head
    await page.locator('[data-test="account-button"]').click()
    await expect(page.locator('[data-test="account-menu"]')).toBeVisible()
    const m = await page.evaluate(() => {
      const menu = document.querySelector('[data-test="account-menu"]')!
      const section = menu.querySelector('[role="group"][aria-label="家計簿"]')
      const rows = Array.from(menu.querySelectorAll('[role="menuitemradio"]')) as HTMLElement[]
      const chipStyle = (row: HTMLElement) => row.querySelector('.ledger-chip')?.getAttribute('style') ?? ''
      return {
        sectionPresent: !!section,
        headFirst: section ? !!section.previousElementSibling?.classList.contains('menu-head') : false,
        separator: !!menu.querySelector('hr[aria-hidden="true"]'),
        rowCount: rows.length,
        checked: rows.map((r) => r.getAttribute('aria-checked')),
        names: rows.map((r) => (r.querySelector('.ledger-option-name')?.textContent ?? '').trim()),
        chipStyles: rows.map(chipStyle),
        plainItems: menu.querySelectorAll('[role="menuitem"]').length,
      }
    })
    const dump = JSON.stringify(m)
    expect(m.sectionPresent, dump).toBe(true)
    expect(m.headFirst, 'the section sits right under the menu-head').toBe(true)
    expect(m.separator, 'a separator divides the section from the plain items').toBe(true)
    expect(m.rowCount, dump).toBe(2)
    expect(m.checked, dump).toEqual(['true', 'false'])
    expect(m.names, dump).toEqual(['default book', '家族の家計簿'])
    expect(m.chipStyles[0], dump).toContain('var(--ledger-teal)')
    expect(m.chipStyles[1], dump).toContain('var(--ledger-orange)')
    expect(m.plainItems, 'the four plain menu items stay complete').toBe(4)

    // selecting the second row switches the session, closes the menu and
    // the band / checked row follow
    await page.locator('[data-test="ledger-option-2"]').click()
    await expect(page.locator('[data-test="account-menu"]')).toBeHidden()
    const after = await page.evaluate(() => ({
      focusedOnAccount: document.activeElement?.closest('[data-test="account-button"]') !== null,
      band: document.querySelector('.shell')?.getAttribute('style') ?? '',
      scoped: document.querySelector('.topbar')?.classList.contains('ledger-scoped') ?? false,
    }))
    const adump = JSON.stringify(after)
    expect(after.focusedOnAccount, 'the focus returns to the account trigger').toBe(true)
    expect(after.scoped, adump).toBe(true)
    expect(after.band, adump).toContain('var(--ledger-orange)')
    // reopening shows the check moved to the second row
    await page.locator('[data-test="account-button"]').click()
    await expect(page.locator('[data-test="ledger-option-2"]')).toBeVisible()
    const checked = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-test="account-menu"] [role="menuitemradio"]')).map((r) =>
        r.getAttribute('aria-checked'),
      ),
    )
    expect(checked).toEqual(['false', 'true'])
  })
})

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

// --- drawer overlay, desktop side (900px, TASK-89): the drawer starts
// closed at every width; opened by the menu button it is a plain overlay —
// the scrim shows and an outside tap closes it, but there are no modal side
// effects (no inert, no lock) and the main column never moves ---

test.describe('drawer overlay (900x800, reduced motion)', () => {
  test.use({ viewport: { width: 900, height: 800 }, reducedMotion: 'reduce' })

  test('[covers:web-shell.drawer-overlay-real] desktop overlay: 初期closed・開ければscrim表示で外タップで閉じる・inert/lockなし・main不変', async ({ page }) => {
    logPageIssues(page, 'drawer-desktop')
    await installApiStub(page)
    await page.goto('/receipts/101')
    await expect(page.locator('[data-test="receipt-panel-101"] .detail-title')).toBeVisible()

    const sidebarRect = () => page.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect())
    const mainX = () => page.evaluate(() => document.querySelector('.app-main')!.getBoundingClientRect().x)

    // TASK-89: the drawer starts closed even at 900px+
    await expect.poll(async () => (await sidebarRect()).right <= 0, { timeout: 3_000 }).toBe(true)
    const m0 = await page.evaluate(() => ({
      scrim: getComputedStyle(document.querySelector('.scrim')!).display,
      mainInert: document.querySelector('.main-col')!.hasAttribute('inert'),
      lock: document.documentElement.classList.contains('drawer-lock'),
    }))
    const d0 = JSON.stringify(m0)
    expect(m0.scrim, d0).toBe('none')
    expect(m0.mainInert, d0).toBe(false)
    expect(m0.lock, d0).toBe(false)

    // open: the plain slide overlay — the scrim shows at desktop too, still
    // no modal side effects, and the main column never moves
    await page.locator('[data-test="menu-button"]').click()
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
    expect(m.scrim, dump).toBe('block')
    expect(m.mainInert, dump).toBe(false)
    expect(m.lock, dump).toBe(false)
    const x0 = await mainX()

    // an outside tap on the scrim closes the desktop overlay too (TASK-89)
    // the outside tap is the scrim itself (it covers the desktop now and
    // sits above the main column)
    await page.locator('.scrim').click({ position: { x: 500, y: 300 } })
    await expect.poll(async () => (await sidebarRect()).right <= 0, { timeout: 3_000 }).toBe(true)
    expect(Math.abs((await mainX()) - x0), 'the main column never moves').toBeLessThanOrEqual(1)
  })
})

// --- topbar title position (TASK-69): the title centers inside the box that
// spans brand → right-side cluster (filters or actions). On a chip-less
// screen the title text sits at the midpoint between the brand's right edge
// and the actions' left edge; on a chip screen it pulls well clear of the
// brand (before the change it hugged it at the topbar gap, 12px at 1280px) ---

test.describe('topbar title position (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('[covers:web-shell.topbar-title-position-real] 表題は brand と右側要素の間の中央寄せ（/settings 中点一致・/receipts は brand から離れる）', async ({ page }) => {
    logPageIssues(page, 'title-pos')
    await installApiStub(page)
    await page.goto('/settings')
    await expect(page.locator('.topbar-title')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const m = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      const brand = r('.topbar-brand')
      const icon = r('.topbar-title .icon')
      const text = r('.topbar-title-text')
      const actions = r('.topbar-actions')
      // the whole title content (icon + gap + text) is the centered unit
      const contentCenter = (icon.left + text.right) / 2
      return { brandRight: brand.right, textLeft: text.left, contentCenter, actionsLeft: actions.left }
    })
    const mid = (m.brandRight + m.actionsLeft) / 2
    expect(Math.abs(m.contentCenter - mid), `/settings title center ${JSON.stringify(m)} mid ${mid}`).toBeLessThanOrEqual(4)

    await page.goto('/receipts')
    await expect(page.locator('.topbar-title')).toBeVisible()
    await page.waitForLoadState('networkidle')
    const f = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      const brand = r('.topbar-brand')
      const text = r('.topbar-title-text')
      return { brandRight: brand.right, textLeft: text.left }
    })
    expect(f.textLeft - f.brandRight, `/receipts ${JSON.stringify(f)}`).toBeGreaterThanOrEqual(40)
  })
})

// --- apps grant rows (TASK-20 §10-3): the 選択中の家計簿 dd carries the
// grant's own --ledger-<key> chip as a real painted color. The grants stub
// option feeds one grant whose active_ledger_color (pink) differs from the
// web side's selected membership (teal), so the check is non-vacuous — the
// chip follows the grant's color, not the session's. The switch select's
// option dots are deliberately not measured here: a closed select's dropdown
// is not DOM-painted even in chromium (jsdom DOM presence covers them) ---

test.describe('apps grant ledger chip (390x780)', () => {
  test.use({ viewport: { width: 390, height: 780 } })

  test('[covers:web-apps.list-grants] 選択中の家計簿の色 chip は --ledger-<key> の実色', async ({ page }) => {
    logPageIssues(page, 'apps-chip')
    await installApiStub(page, {
      grants: [
        {
          id: 1,
          client_display: 'ChatGPT',
          client_id: 'https://chatgpt.com/a',
          scope: 'ledger.read ledger.write',
          active_ledger_id: 1,
          active_ledger_name: 'default book',
          active_ledger_color: 'pink',
          created_at: Date.UTC(2026, 9, 1, 0, 0),
          last_used_at: null,
        },
      ],
    })
    await page.goto('/apps')
    await expect(page.locator('[data-test="grant-1"]')).toBeVisible()
    // the measure.ts recipe (kept inline per this file's convention): resolve
    // the palette var through a probe element's computed background — the
    // same engine normalization as the chip's own computed color — and
    // compare the two paint values
    const m = await page.evaluate(() => {
      const chip = document.querySelector('[data-test="grant-1"] [data-test="active-ledger"] .ledger-chip') as HTMLElement | null
      const probe = document.createElement('span')
      probe.style.background = 'var(--ledger-pink)'
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).backgroundColor
      probe.remove()
      if (!chip) return { present: false, bg: '', resolved, w: 0, h: 0 }
      const r = chip.getBoundingClientRect()
      return { present: true, bg: getComputedStyle(chip).backgroundColor, resolved, w: r.width, h: r.height }
    })
    const dump = JSON.stringify(m)
    expect(m.present, dump).toBe(true)
    // non-vacuous: the var resolves to a real paint, not transparent
    expect(m.resolved, dump).toMatch(/^rgb/)
    expect(m.bg, dump).toBe(m.resolved)
    expect(m.w, dump).toBeGreaterThan(0)
    expect(m.h, dump).toBeGreaterThan(0)
  })
})
