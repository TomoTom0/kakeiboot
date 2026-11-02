// TASK-44 stage 1a specs (design: tmp/tasks/tm-28/design_browsing.md
// §11, rev 3) plus the TASK-41 stage 1b search chip, reshaped by TASK-101
// (the label chip is gone; the topbar's center filter bar carries the
// period / search two chips, §11-3) — their PopoverPanel dialogs (§11-6:
// PeriodPicker for the period, the two-tier search dialog — the one-line
// search form on top, the label toggle group + 解除 below, both entered
// through the search chip), and the one-row page toolbar (§11-5; TASK-75
// §6-3 merged the filter button and the condition chips into the single
// row). The /search destination itself is covered by search-page.test.ts.
// Conditions: web-browse.topbar-filter-bar / web-browse.filter-dialogs /
// web-search.topbar-entry / web-layout.toolbar-one-row in
// tests/design/conditions.toml.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/** Exact leaf texts of a chip's descendants (both width labels ride the chip; CSS media queries pick the visible one). */
function leafTexts(w: W, testId: string): Set<string> {
  return new Set(
    w
      .find(`[data-test="${testId}"]`)
      .findAll('*')
      .filter((e) => e.element.children.length === 0)
      .map((e) => e.text().trim()),
  )
}

/** Open a topbar chip's dialog (PopoverPanel) and wait a tick. */
async function openDialog(w: W, testId: 'filter-period' | 'filter-search'): Promise<void> {
  await w.find(`[data-test="${testId}"]`).trigger('click')
  await settle()
}

/** Body of the first balanced {} block whose head matches (an @media block). */
function mediaBlock(head: RegExp): string | undefined {
  const css = readFileSync(resolve(process.cwd(), 'src/web/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const m = head.exec(css)
  if (!m) return undefined
  const open = css.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i)
  }
  return undefined
}

describe('TopbarFilterBar: chips on the browsing routes (TASK-44 1a + TASK-41 1b)', () => {
  it('[covers:web-browse.topbar-filter-bar] 閲覧系topbar中央に時期・検索の2チップ常時（ラベル選択UIはtopbarに無い・表題とtopbar-actionsの間・aria-label・短縮/フル両要素・選択中accent）', async () => {
    // a titled label makes the search chip's spoken label names visible
    await api.updateLabelTitle(1, 'red', { title: '旅行' })
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] }, 'GET /api/oauth/grants': { body: [] } })
    const { wrapper, router } = await mountApp('/receipts')

    // §11-3: the bar sits between the page title and the topbar actions
    const bar = wrapper.find('header.topbar .topbar-filters')
    expect(bar.exists()).toBe(true)
    expect(bar.element.previousElementSibling?.classList.contains('topbar-title')).toBe(true)
    expect(bar.element.nextElementSibling?.classList.contains('topbar-actions')).toBe(true)

    // TASK-101: period + search — the two-chip bar; the label chip is gone
    // and no label selection UI rides the topbar anymore
    const chip = (id: string) => wrapper.find(`header.topbar .topbar-filters [data-test="${id}"]`)
    expect(chip('filter-period').exists()).toBe(true)
    expect(chip('filter-search').exists()).toBe(true)
    expect(chip('filter-labels').exists()).toBe(false)
    expect(chip('filter-period').classes()).toContain('filter-chip-btn')
    expect(chip('filter-search').classes()).toContain('filter-chip-btn')
    expect(chip('filter-search').classes()).toContain('filter-chip-search')
    // off /search the chip is the plain entry: icon only, no active state
    expect(chip('filter-search').attributes('aria-label')).toBe('検索')
    expect(chip('filter-search').find('svg').exists()).toBe(true)
    expect(chip('filter-search').find('.chip-label-q').exists()).toBe(false)
    expect(chip('filter-search').classes()).not.toContain('active')

    // the period chip reads the current period and renders BOTH width labels
    // (labelShort <=899px / full >=900px; the media query picks one)
    expect(chip('filter-period').attributes('aria-label')).toBe('期間で絞り込み: 2026年10月')
    const texts = leafTexts(wrapper, 'filter-period')
    expect(texts.has('10月')).toBe(true)
    expect(texts.has('2026年10月')).toBe(true)

    // the label selection rides the search chip (TASK-101): the dots, the
    // accent and the spoken names all surface on filter-search — with no q
    // running the aria carries the label section alone
    await openDialog(wrapper, 'filter-search')
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(chip('filter-search').classes()).toContain('active')
    const dots = chip('filter-search').findAll('.label-filter-dot')
    expect(dots).toHaveLength(1)
    expect(dots[0]!.classes()).toContain('label-red')
    expect(chip('filter-search').attributes('aria-label')).toBe('ラベル: 旅行')

    // every browsing route carries the bar (§11-3 route.meta.filters),
    // /search included once TASK-41 adds the route
    for (const path of ['/', '/categories', '/stores', '/receipts/101', '/search?q=牛乳']) {
      await router.push(path)
      await settle()
      const onBar = wrapper.find('header.topbar .topbar-filters')
      expect(onBar.exists(), path).toBe(true)
      // home has no page title: there the bar follows the brand directly
      // (on the titled routes the h1 sits in between — the /receipts
      // adjacency check above covers that side)
      if (path === '/') {
        expect(onBar.element.previousElementSibling?.classList.contains('topbar-brand'), path).toBe(true)
      }
    }
    // the settings / manage / apps / usage screens do not
    for (const path of ['/settings', '/settings/labels', '/apps', '/usage']) {
      await router.push(path)
      await settle()
      expect(wrapper.find('.topbar-filters').exists(), path).toBe(false)
    }
    // and a browsing route brings the chips back
    await router.push('/receipts')
    await settle()
    expect(wrapper.find('.topbar-filters').exists()).toBe(true)
  }, 10_000)

  it('[covers:web-browse.topbar-filter-bar] 家計簿に未参加の間はtopbar中央バーを出さない', async () => {
    const ME_NONE: typeof ME = { ...ME, ledgers: [], default_ledger_id: null }
    mockFetch({ 'GET /api/auth/me': { body: ME_NONE } })
    const { wrapper } = await mountApp('/')
    expect(wrapper.find('header.topbar').exists()).toBe(true)
    expect(wrapper.find('.topbar-filters').exists()).toBe(false)
  })
})

describe('topbar period dialog (PeriodPicker)', () => {
  it('[covers:web-browse.filter-dialogs][covers:web-shell.period-picker-week-tab][covers:web-shell.period-picker-order][covers:web-shell.period-uncapped-step] 時期dialog: タブ「週｜月｜年｜Custom」の自然昇順（TASK-90/91）・送りとタブ切替は即時（dialog開いたまま・watch(period.range)で再取得・› は未来へも有効〔TASK-146 §1〕）・範囲は「表示」でのみ確定', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/receipts')
    const chip = () => wrapper.find('[data-test="filter-period"]')

    await chip().trigger('click')
    await settle()
    // a PopoverPanel dialog opens and the chip is its expanded trigger
    const dialog = wrapper.get('[role="dialog"]')
    expect(chip().attributes('aria-expanded')).toBe('true')
    expect(chip().attributes('aria-controls')).toBe(dialog.attributes('id'))
    // TASK-90: the tabs run 週・月・年 in natural ascending order, and the
    // free-form fourth tab says Custom (TASK-91)
    const tabs = wrapper.findAll('[role="tablist"][aria-label="期間の単位"] .tab')
    expect(tabs.map((b) => b.text())).toEqual(['週', '月', '年', 'Custom'])
    expect(tabs[0]!.attributes('data-test')).toBe('mode-week')
    expect(tabs[1]!.attributes('data-test')).toBe('mode-month')
    expect(tabs[3]!.attributes('data-test')).toBe('mode-range')

    // TASK-53: the week tab applies at once like month/year — the current week
    // (2026-10-12..18) steps in whole weeks. TASK-146 §1: the current-week
    // cap is gone, so › steps into the future (2026-10-19..25) as well
    await wrapper.find('[data-test="mode-week"]').trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年10月12日の週')
    const weekTexts = leafTexts(wrapper, 'filter-period')
    expect(weekTexts.has('10/12週')).toBe(true)
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-12', to: '2026-10-18' }))
    expect(wrapper.find('[data-test="period-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年10月19日の週')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-19', to: '2026-10-25' }))
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年10月12日の週')
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年10月5日の週')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-05', to: '2026-10-11' }))

    // the year tab applies at once: the chip swaps to the year labels and the
    // page re-queries through watch(period.range); the dialog stays open
    await wrapper.find('[data-test="mode-year"]').trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年')
    const yearTexts = leafTexts(wrapper, 'filter-period')
    expect(yearTexts.has('26年')).toBe(true)
    expect(yearTexts.has('2026年')).toBe(true)
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-01-01', to: '2026-12-31' }))

    // back on months: TASK-146 §1 — the current month steps into the future
    // too (2026-11), then ‹ walks back and › returns through the same steps
    await wrapper.find('[data-test="mode-month"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="period-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年11月')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-11-01', to: '2026-11-30' }))
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年10月')
    await wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(chip().attributes('aria-label')).toBe('期間で絞り込み: 2026年9月')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-09-01', to: '2026-09-30' }))
    expect(wrapper.find('[data-test="period-next"]').attributes('disabled')).toBeUndefined()
    await wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-01' }))

    // the range tab commits only on 表示: typing alone never touches the store
    await wrapper.find('[data-test="mode-range"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="range-from"]').setValue('2026-10-03')
    await wrapper.find('[data-test="range-to"]').setValue('2026-10-15')
    await settle()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-01' }))
    await wrapper.find('[data-test="range-apply"]').trigger('click')
    await settle()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-10-03', to: '2026-10-15' }))
    // the dialog stays open for further adjustments
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
  })

  // TASK-146 §3 #15 (web-common.overlay-transition): the popover's open is an
  // appear fade now — the panel root carries the fade vocabulary's enter
  // classes in the insert patch (jsdom ships no stylesheet, so they are read
  // right after the click's nextTick, before the rAF clears them) and the
  // close parks the leave classes on the way out.
  it('[covers:web-common.overlay-transition] 時期dialogの開閉は appear fade（.popover-dialog に page-enter-*・閉じは page-leave-*）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/receipts', { attach: true, stubs: { transition: false } })
    const chip = () => wrapper.find('[data-test="filter-period"]')

    await chip().trigger('click')
    const panel = wrapper.find('.popover-dialog')
    expect(panel.exists()).toBe(true)
    expect(panel.classes()).toContain('page-enter-active')
    expect(panel.classes()).toContain('page-enter-from')
    await settle()
    // the open state itself is the existing contract (unchanged)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-expanded')).toBe('true')

    // the close (a re-press toggles) parks the leave classes before removal
    await chip().trigger('click')
    const leaving = wrapper.find('.popover-dialog')
    expect(leaving.exists()).toBe(true)
    expect(leaving.classes()).toContain('page-leave-active')
    await settle()
    expect(wrapper.find('.popover-dialog').exists()).toBe(false)
  })
})

describe('search dialog lower half (labels)', () => {
  it('[covers:web-browse.filter-dialogs] 検索dialog下段: LabelToggleGroup+解除は即時にperiod storeへ出て各ページの再取得へ伝播（dialogは開いたまま）', async () => {
    await api.updateLabelTitle(1, 'red', { title: '旅行' })
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const stats = vi.spyOn(api, 'getAnalysis')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper } = await mountApp('/')
    const chip = () => wrapper.find('[data-test="filter-search"]')

    await openDialog(wrapper, 'filter-search')
    // the two-tier search dialog: the form on top, the label half below
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(wrapper.find('form.search-dialog').exists()).toBe(true)
    expect(wrapper.find('.label-toggle-group').exists()).toBe(true)
    // nothing selected: the clear button starts disabled
    expect(wrapper.find('[data-test="label-filter-clear"]').attributes('disabled')).toBeDefined()

    // toggling red is period.setLabelColors(['red']) at once: Home's
    // analysis and the recent list re-query with the filter, the search chip
    // shows the selection, and the dialog stays open
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red'], limit: 50 }))
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red'] }))
    expect(chip().attributes('aria-label')).toBe('ラベル: 旅行')
    expect(chip().classes()).toContain('active')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)

    // OR with blue, then 解除 empties the selection and re-queries with []
    await wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'], limit: 50 }))
    await wrapper.find('[data-test="label-filter-clear"]').trigger('click')
    await settle()
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: [], limit: 50 }))
    expect(chip().attributes('aria-label')).toBe('検索')
    expect(chip().classes()).not.toContain('active')
  })

  it('[covers:web-browse.filter-dialogs] Receipts はラベル変更で labels= URL を更新し、直リンク labels= は period store へ書き戻す', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/receipts')

    await openDialog(wrapper, 'filter-search')
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    // the URL carries the labels query (L3) and the list re-queries with it
    expect(router.currentRoute.value.query['labels']).toBe('red,blue')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))

    // a deep link adopts the URL labels into the period store, so the chip
    // shows the selection the list is actually filtering with (§11-3)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const direct = await mountApp('/receipts?labels=red,blue')
    const chip = direct.wrapper.find('[data-test="filter-search"]')
    expect(chip.classes()).toContain('active')
    expect(chip.findAll('.label-filter-dot')).toHaveLength(2)
    // untitled labels read their neutral spoken names (red=1, blue=4)
    expect(chip.attributes('aria-label')).toBe('ラベル: ラベル1、ラベル4')
  })

  it('[covers:web-browse.filter-dialogs] Escape・外側押下でdialogを閉じトリガのチップへフォーカスが戻る', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/receipts', { attach: true })
    const period = () => wrapper.find('[data-test="filter-period"]')

    await period().trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(period().attributes('aria-expanded')).toBe('true')
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(period().attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(period().element)

    // an outside pointerdown closes the search dialog the same way
    await wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    const outside = wrapper.find('.app-main').element
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('[data-test="filter-search"]').element)
  })
})

describe('topbar search chip (TASK-41 1b)', () => {
  it('[covers:web-search.topbar-entry] チップの表示: /search かつ q ありは「検索: {q}」で語を付き・他ページは素の入口', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳')
    const chip = () => wrapper.find('[data-test="filter-search"]')
    expect(chip().exists()).toBe(true)
    expect(chip().attributes('aria-label')).toBe('検索: 牛乳')
    expect(chip().find('.chip-label-q').exists()).toBe(true)
    expect(chip().find('.chip-label-q').text()).toBe('牛乳')

    // every other page shows the plain entry
    await router.push('/receipts')
    await settle()
    expect(chip().attributes('aria-label')).toBe('検索')
    expect(chip().find('.chip-label-q').exists()).toBe(false)
    expect(chip().find('svg').exists()).toBe(true)

    // and /search without a q is the plain entry too
    await router.push('/search')
    await settle()
    expect(chip().attributes('aria-label')).toBe('検索')
    expect(chip().find('.chip-label-q').exists()).toBe(false)
  })

  it('[covers:web-search.topbar-entry] 他ページからの実行: q のみを渡して /search へ遷移（labels は着地後の shell 同期・期間 keys は載らない）し dialog は閉じる', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] }, 'GET /api/oauth/grants': { body: [] } })
    const { wrapper, router } = await mountApp('/receipts')
    // 2026-10 (the default) + label red selected through the search dialog's
    // lower half — the one open dialog carries both tiers
    await openDialog(wrapper, 'filter-search')
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()

    const push = vi.spyOn(router, 'push')
    const chip = () => wrapper.find('[data-test="filter-search"]')
    // the dialog stays open from the toggle above: the form rides its top tier
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-expanded')).toBe('true')
    const input = wrapper.find('[data-test="search-dialog-input"]')
    expect(input.attributes('type')).toBe('search')
    expect((input.element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-test="search-dialog-submit"]').exists()).toBe(true)

    await input.setValue('牛乳')
    // the run rides the form submit (the button is type="submit"; jsdom does
    // not synthesize submit from a click, and a @click on the button would
    // double-fire in real browsers — REVIEW-3 指摘2)
    const submitBtn = wrapper.find('[data-test="search-dialog-submit"]')
    expect(submitBtn.attributes('type')).toBe('submit')
    await wrapper.find('form.search-dialog').trigger('submit')
    await settle()
    // the dialog closed and the app moved to /search with q only — the run
    // carries nothing else (TASK-145 D1-1): the landing is a keys-less entry,
    // the shell URL sync writes the labels back, and the period keys never
    // ride while scope=all (the store's period reaches /search through the
    // store continuation instead)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(chip().attributes('aria-expanded')).toBe('false')
    expect(push).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/search')
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳', labels: 'red' })
  })

  it('[covers:web-search.topbar-entry] /search 内の実行は replace で q のみ差し替え・draft は開くたび現在 q で初期化・空実行で q を外す', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/search?q=牛乳')
    const chip = () => wrapper.find('[data-test="filter-search"]')
    expect(chip().attributes('aria-label')).toBe('検索: 牛乳')
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')

    // the draft initializes to the current q once per open
    await chip().trigger('click')
    await settle()
    const input = wrapper.find('[data-test="search-dialog-input"]')
    expect((input.element as HTMLInputElement).value).toBe('牛乳')
    await input.setValue('牛乳 1L')
    await wrapper.find('form.search-dialog').trigger('submit')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ q: '牛乳 1L' })

    // reopening re-initializes the draft; an empty run clears q (and the results)
    await chip().trigger('click')
    await settle()
    const again = wrapper.find('[data-test="search-dialog-input"]')
    expect((again.element as HTMLInputElement).value).toBe('牛乳 1L')
    await again.setValue('')
    await wrapper.find('form.search-dialog').trigger('submit')
    await settle()
    expect(router.currentRoute.value.path).toBe('/search')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('[covers:web-browse.filter-dialogs] 検索dialog: Escape・外側押下で閉じトリガのチップへフォーカスが戻る', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/receipts', { attach: true })
    const chip = () => wrapper.find('[data-test="filter-search"]')

    await chip().trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(chip().attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(chip().element)

    // an outside pointerdown closes it the same way
    await chip().trigger('click')
    await settle()
    const outside = wrapper.find('.app-main').element
    for (const type of ['pointerdown', 'mousedown', 'click']) {
      outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
    }
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(chip().element)
  })
})

describe('one-row page toolbar (TASK-75 §6-3)', () => {
  it('[covers:web-layout.toolbar-one-row] /receipts は絞り込みボタン+条件チップが同じ1行（件数バッジ・期間・ラベルUIは本文に無い）、一覧は「…」のみの1行、詳細はチップの1行、Home はツールバーなし、720px の column 化なし', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    // receipts: the filter button and the condition chips share the one
    // toolbar row (TASK-75 merges the old button row + chip row); the period
    // UI (mode tabs / step) and the label button stay in the topbar
    const { wrapper } = await mountApp('/receipts?item=牛乳')
    const toolbar = wrapper.find('.page-toolbar')
    expect(toolbar.exists()).toBe(true)
    const toggle = toolbar.find('[data-test="filters-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.classes()).toContain('toolbar-filter-btn')
    // through 390px the word folds away and the count badge carries the
    // active conditions (§6-3): one chip is on
    expect(toggle.find('.toolbar-filter-count').text()).toBe('1')
    // the chips live inside the same row — no separate chip row below
    expect(toolbar.find('[data-test="page-chips"]').exists()).toBe(true)
    expect(wrapper.find('.view-page > [data-test="page-chips"]').exists()).toBe(false)
    expect(wrapper.find('.filter-chips').exists()).toBe(false)
    // review L3: the receipts row passes no "..." menu slot, so the menu cell
    // renders nothing at all (no empty right-end div)
    expect(toolbar.find('.page-toolbar-menu').exists()).toBe(false)
    const main = wrapper.find('.app-main')
    for (const sel of [
      '[data-test="mode-month"]',
      '[data-test="mode-year"]',
      '[data-test="mode-range"]',
      '[data-test="period-prev"]',
      '[data-test="period-next"]',
      '[data-test="label-filter-button"]',
      '.period-bar',
    ]) {
      expect(main.find(sel).exists(), sel).toBe(false)
    }

    // the category / store lists are chip-less: the row carries the "..."
    // menu alone at its right end (§6-5 — the standalone .page-menu row is
    // gone) and no period / label UI joins it
    for (const path of ['/categories', '/stores']) {
      cleanup()
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      const page = await mountApp(path)
      const bar = page.wrapper.find('.page-toolbar')
      expect(bar.exists(), `${path} toolbar`).toBe(true)
      expect(bar.find('[data-test="page-chips"]').exists()).toBe(false)
      expect(bar.find('.page-toolbar-menu [data-test="page-menu"]').exists()).toBe(true)
      expect(page.wrapper.find('.page-menu').exists()).toBe(false)
      for (const sel of ['.period-bar', '[data-test="label-filter-button"]']) {
        expect(page.wrapper.find(sel).exists(), `${path} ${sel}`).toBe(false)
      }
    }

    // the detail pages: the chips row moved into the one-line toolbar right
    // under the heading (TASK-74's provisional row absorbed, interface as-is)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const detail = await mountApp('/axes/category/1?store_id=3')
    const dBar = detail.wrapper.find('.page-toolbar')
    expect(dBar.exists()).toBe(true)
    expect(dBar.find('[data-test="page-chips"]').exists()).toBe(true)
    expect(detail.wrapper.find('.view-page > [data-test="page-chips"]').exists()).toBe(false)
    // review L3: the chip-only toolbar leaves no empty menu cell either (the
    // "..." lives in the PageHead row on the detail pages)
    expect(dBar.find('.page-toolbar-menu').exists()).toBe(false)
    // a chip-less, menu-less toolbar renders nothing at all (a bare store
    // detail carries its "..." in the heading row instead)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const bare = await mountApp('/stores/1')
    expect(bare.wrapper.find('.page-toolbar').exists()).toBe(false)

    // Home carries no page toolbar: the month switch moved to the period chip
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const home = await mountApp('/')
    for (const sel of ['.page-toolbar', '[data-test="month-prev"]', '[data-test="month-next"]', '.period-bar', '[data-test="label-filter-button"]']) {
      expect(home.wrapper.find(sel).exists(), sel).toBe(false)
    }

    // the stylesheet drops the 720px two-row design for the page toolbar
    const narrow = mediaBlock(/@media\s*\(max-width:\s*720px\)/)
    if (narrow !== undefined) expect(narrow).not.toMatch(/\.page-toolbar/)
  })
})

describe('dialog closes on navigation (TASK-44 review)', () => {
  it('[covers:web-browse.filter-dialogs] dialog を開いたまま別ルートへ遷移すると閉じる（aria-expanded=false）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/receipts')
    await openDialog(wrapper, 'filter-period')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    const chip = () => wrapper.find('[data-test="filter-period"]')

    await router.push('/')
    await settle()
    // the bar survives the page swap; its dialog does not
    expect(wrapper.find('header.topbar .topbar-filters').exists()).toBe(true)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(chip().attributes('aria-expanded')).toBe('false')

    // the search dialog (TASK-41) follows the same rule
    const search = () => wrapper.find('[data-test="filter-search"]')
    await search().trigger('click')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    await router.push('/stores')
    await settle()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(search().attributes('aria-expanded')).toBe('false')
  })

  it('[covers:web-browse.filter-dialogs] Feed 内の URL replace（スクロール同期）では閉じない', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/receipts/101?from=2026-10-01&to=2026-10-31')
    await openDialog(wrapper, 'filter-period')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    const chip = () => wrapper.find('[data-test="filter-period"]')

    // the feed rewrites its URL to the visible receipt while scrolling
    // (router.replace within the receipt route): not a navigation, the
    // dialog stays open
    await router.replace({ name: 'receipt', params: { id: 102 }, query: { from: '2026-10-01', to: '2026-10-31' } })
    await settle()
    expect(router.currentRoute.value.path).toBe('/receipts/102')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
    expect(chip().attributes('aria-expanded')).toBe('true')
  })
})
