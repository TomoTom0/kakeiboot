// TASK-124 (SPA URL routing + the in-screen back affordance), written
// test-first against the design (tmp/tasks/tm-124/design_spa-url-routing.md
// v2, D2/D3): the shell-level URL sync composable keeps the browsing screens'
// period mode keys (month= / week= / year= / from&to — the mode key is the
// truth, from/to a derived value) and labels= in the URL in both directions
// (import only when the URL carries keys — a keys-less entry keeps the store
// and writes it back at once; every write is a router.replace with a diff
// guard), the feed (/receipts/:id) stays outside both directions, /search
// carries period keys only while scope=period, and the tabbar-外 screens get
// the topbar ‹ (a parentTo push with the up semantics). These stay red until
// the implementation lands.
//
// TASK-145 (the review LOW pair, test-first against
// tmp/tasks/tm-145/design_search-carry.md v1): the /search period-keys rule
// holds on BOTH write sides — the dialog run() carries q only (D1-1), a
// /search?month= inflow is stripped by the first write-back even with no
// labels diff (D1-2), and the scope toggle seats the keys only when narrowing
// (D1-3); the axis detail page does not re-query on the write-back echo
// (D2) and its parent link rides the live route query (D2-2). The new cases
// stay red until the implementation lands.
//
// TASK-164 (test-first against tmp/tasks/tm-164/design_back_home.md v4):
// §2-2-1 turns the user's period changes into history PUSHES (the
// TASK-124 D2-2 "a period change never stacks history" rule is inverted by
// the user's "戻るは期間変更全般を1件戻す") — only the user routes push
// (step / setMonth / setWeek / the new setMode / setRange), every system
// write (a keys-less completion, an import normalization, the reset, a
// labels-only change, the /search strip) stays a replace, guarded by the
// one-shot nextWrite flag with its three residue rules; §2-5 keeps the
// labels asymmetric (never stacked alone, restored with the entry on pop);
// §2-4/§2-6 move the ‹ semantics: the axis PageHead ‹ is gone (topbar ‹
// everywhere on the browsing side, TASK-145 D2-2's carry with it) and
// /search joins the browsing history-back side (the parentTo map keeps the
// other ten screens). The TASK-164 cases stay red until it lands.
//
// TASK-174 (test-first against tmp/tasks/tm-174/design_url-history-entries.md
// v4): the value-watch write-back is replaced by the store's typed operation
// notifications feeding a single FIFO that owns the browsing URL writes —
// ONE history entry per identifiable operation (the same-tick compression
// "two steps in one tick batch into one push" is WITHDRAWN: A→B→C and A→B→A
// stack two entries each), the queue's head is the only navigation in
// flight, an ACKed write never echoes back into the store (the pending-echo
// guard), every system write (labels / the reset / the patch writers of
// Receipts filter, Search tab/q, TopbarFilterBar, Stores category, Axis
// chips, the scope boundary) rides the same queue behind a pending push
// without cancelling it, and boundaries (an external entry, an unnotified
// back, a late pop) and failures (a refused / redirected / duplicated
// navigation, a rejected pop) stop the drain instead of being counted as
// entries. The TASK-174 cases stay red until it lands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocationQuery, Router } from 'vue-router'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { browsingNavigation } from '@/web/composables/browsingNavigation'
import { direction, navKind } from '@/web/composables/navDirection'
import { usePeriodStore } from '@/web/stores/period'
import { ME, cleanup, createManualHistory, mockFetch, mountApp, scrollMocks, settle } from './helpers'

let api: DataApi

const MOCK = { 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] }, 'GET /api/oauth/grants': { body: [] } }

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
  mockFetch(MOCK)
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  window.history.replaceState(null, '')
  cleanup()
})

type M = Awaited<ReturnType<typeof mountApp>>

/** Current route query of a mount. */
const q = (m: M): LocationQuery => m.router.currentRoute.value.query

/** One month back through the topbar period chip (the dialog stays open). */
async function stepPeriod(m: M): Promise<void> {
  await m.wrapper.find('[data-test="filter-period"]').trigger('click')
  await settle()
  await m.wrapper.find('[data-test="period-prev"]').trigger('click')
  await settle()
}

/** Select a label color through the search dialog's lower half. */
async function toggleLabel(m: M, color: string): Promise<void> {
  await m.wrapper.find('[data-test="filter-search"]').trigger('click')
  await settle()
  await m.wrapper.find(`[data-test="label-filter-${color}"]`).trigger('click')
  await settle()
}

/** Unmount + remount at `path` inside one test (the view-pages pattern). */
async function remount(path: string): Promise<M> {
  cleanup()
  window.history.replaceState(null, '')
  setDataApi(api)
  mockFetch(MOCK)
  return mountApp(path)
}

/** A beforeEach guard holding every MATCHING navigation until release()
 * (TASK-174's manual-release window: finalize never runs while held, so a
 * test can hand the coordinator a next operation while the first write's
 * navigation is still in flight). `held()` counts the parked navigations. */
function holdGuard(
  router: Router,
  shouldHold: (to: { query: LocationQuery }) => boolean = () => true,
): { release: () => void; held: () => number } {
  const waiting: Array<() => void> = []
  let active = true
  router.beforeEach(async (to) => {
    if (!active || !shouldHold(to)) return true
    await new Promise<void>((resolve) => waiting.push(resolve))
    return true
  })
  return {
    release() {
      active = false
      for (const r of waiting.splice(0)) r()
    },
    held: () => waiting.length,
  }
}

describe('browsing URL sync: period keys (TASK-124 D2)', () => {
  it('[covers:web-browse.url-period-sync] 期間変更（時期チップ送り・mode切替・trend棒押下）は閲覧系5画面の URL period keys を replace で更新（from/to は range モードの key のみ）', async () => {
    for (const path of ['/', '/categories', '/stores', '/receipts', '/axes/category/1']) {
      const m = await remount(`${path}?month=2026-10`)
      // the spy is (re)attached AFTER the remount — remount()'s cleanup()
      // calls vi.restoreAllMocks() and detaches an earlier spy — so the
      // observed call is the re-fetch the step triggers
      const stats = vi.spyOn(api, 'getAnalysis')
      await stepPeriod(m)
      expect(q(m).month, path).toBe('2026-09')
      expect(q(m).from, path).toBeUndefined()
      expect(q(m).to, path).toBeUndefined()
      expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ month: '2026-09' }))
    }

    // Home: the mode switch swaps the mode key, a trend bar press moves the month
    const home = await remount('/?month=2026-10')
    await home.wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await home.wrapper.find('[data-test="mode-year"]').trigger('click')
    await settle()
    expect(q(home).year).toBe('2026')
    expect(q(home).month).toBeUndefined()
    await home.wrapper.find('[data-test="mode-month"]').trigger('click')
    await settle()
    await home.wrapper.find('[data-test="bar-2026-05"]').trigger('click')
    await settle()
    expect(q(home).month).toBe('2026-05')

    // TASK-164 §2-2-1: a USER period change is a push — the write-back
    // rides ONE router.push (a history entry), so the browser back returns
    // to the previous period (the entry's URL re-imports into the store)
    const one = await remount('/?month=2026-10')
    // seed navDirection's previous position: remount()'s cleanup() wipes
    // window.history.state, so the mount's own push observed position=null
    // (the memory history never writes window.history — the transition.test
    // recipe). A same-location replace moves nothing and leaves lastPosition
    // at 3 for the write-back's own navigation to compare 3 against 3
    window.history.replaceState({ position: 3 }, '')
    await one.router.replace({ query: { month: '2026-10' } })
    await settle()
    const push = vi.spyOn(one.router, 'push')
    const scrolls = scrollMocks().scrollTo.mock.calls.length
    await stepPeriod(one)
    expect(q(one).month).toBe('2026-09')
    // one push per user operation (no replace on the user route), no slide,
    // and the same-path rule keeps the scroll untouched
    expect(push).toHaveBeenCalledTimes(1)
    expect(navKind.value).toBe('replace')
    expect(direction.value).toBe('none')
    expect(scrollMocks().scrollTo.mock.calls.length).toBe(scrolls)
    // the stacked entry is real: the browser back lands on the previous
    // period and the import restores it into the store
    await one.router.back()
    await settle()
    expect(q(one).month).toBe('2026-10')
    expect(usePeriodStore().month).toBe('2026-10')
  })

  it('[covers:web-browse.url-label-sync] ラベル絞り込みの変更は5画面+/search の URL labels= へ反映される', async () => {
    for (const path of ['/', '/categories', '/stores', '/receipts', '/axes/category/1', '/search?q=牛乳']) {
      const m = await remount(path)
      await toggleLabel(m, 'red')
      expect(q(m).labels, path).toBe('red')
    }
  })

  // TASK-146 §1: stepping into a FUTURE month rides the same user write
  // (the cap is gone; the URL keeps accepting future values — a push since
  // TASK-164 §2-2-1, like every user period change)
  it('[covers:web-shell.period-uncapped-step] 未来月への送り（›）も URL の month= へ書り戻る（from/to は付かない）', async () => {
    const m = await remount('/?month=2026-10')
    await m.wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="period-next"]').trigger('click')
    await settle()
    expect(q(m).month).toBe('2026-11')
    expect(q(m).from).toBeUndefined()
    expect(q(m).to).toBeUndefined()
  })
})

describe('browsing URL sync: import rules (TASK-124 D2-1/D2-2/D2-3)', () => {
  it('[covers:web-browse.url-restore] 直リンクの labels= は Home でも store へ復元されるが期間 keys はホームのコールドスタートでは取り込まない（Issue #9）・Categories では期間 keys も復元される', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/?labels=red&month=2026-09')
    // Issue #9: the cold start on home drops the URL's period keys — the
    // analysis runs on the CURRENT month; the labels (not period keys)
    // still restore, and the write-back replaces the stale month key
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ month: '2026-10', label_colors: ['red'] }))
    expect(usePeriodStore().month).toBe('2026-10')
    expect(q(m).month).toBe('2026-10')
    // the topbar search chip shows the restored selection (dots on the chip)
    expect(m.wrapper.find('[data-test="filter-search"]').findAll('.label-filter-dot')).toHaveLength(1)

    // categories: the same remount steps, but with the spy attached BEFORE
    // the mount (remount()'s cleanup() would detach it) so the initial
    // load's analysis call is observed
    cleanup()
    window.history.replaceState(null, '')
    setDataApi(api)
    mockFetch(MOCK)
    const catStats = vi.spyOn(api, 'getAnalysis')
    const c = await mountApp('/categories?labels=blue&year=2026')
    expect(catStats).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ axis: 'category', year: 2026, label_colors: ['blue'] }),
    )
    // the topbar chip shows the restored selection on Categories too
    expect(c.wrapper.find('[data-test="filter-search"]').findAll('.label-filter-dot')).toHaveLength(1)
  })

  it('[covers:web-browse.url-keys-absent-store-continues] keys 無し流入は store の継続値が正（reset しない）で直ちに URL へ書き戻す', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/receipts?month=2026-09')
    expect(q(m).month).toBe('2026-09')
    await m.router.push('/')
    await settle()
    // the shared period survives the keys-less entry — no default reset ...
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ month: '2026-09' }))
    // ... and the store's current value rides the URL at once (D2-1)
    expect(q(m).month).toBe('2026-09')
  })

  it('[covers:web-browse.url-pop-restore] browser 戻るはentry単位で戻り先 entry の最終 URL の期間へ復元する（TASK-164: 期間変更もpushで積まれるため画面内の期間entryも順に遡る）', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/categories?month=2026-10')
    await stepPeriod(m) // a USER change: /categories?month=2026-09 stacks (a push)
    await m.router.push('/stores')
    await settle()
    expect(q(m).month).toBe('2026-09') // the keys-less entry's completion (a replace)
    await stepPeriod(m) // another USER change: /stores?month=2026-08 (a push)
    expect(q(m).month).toBe('2026-08')
    // back #1: the period entry first — /stores at 2026-09, imported
    await m.router.back()
    await settle()
    expect(m.router.currentRoute.value.path).toBe('/stores')
    expect(q(m).month).toBe('2026-09')
    // back #2: the screen entry — the categories entry's final URL imports
    await m.router.back()
    await settle()
    expect(m.router.currentRoute.value.path).toBe('/categories')
    expect(q(m).month).toBe('2026-09')
    expect(stats).toHaveBeenLastCalledWith(1, expect.objectContaining({ axis: 'category', month: '2026-09' }))
  })

  it('[covers:web-browse.url-feed-excluded] feed（/receipts/:id）は取り込み・書戻し双方の対象外（文脈 query が正・store の期間/labels で上書きしない）', async () => {
    const list = vi.spyOn(api, 'listReceipts')
    const m = await mountApp('/')
    await stepPeriod(m) // the store: month 2026-09
    await toggleLabel(m, 'red') // the store: labels red
    await m.router.push('/receipts/101?from=2026-08-01&to=2026-08-31')
    await settle()
    // no import: the store keeps its month mode (the feed from/to never re-modes it)
    const store = usePeriodStore()
    expect(store.mode).toBe('month')
    expect(store.month).toBe('2026-09')
    expect(store.labelColors).toEqual(['red'])
    // no write-back: the URL stays the context query exactly — no period/labels keys added
    expect(q(m)).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    // the feed lists with the URL context, not the store period
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ from: '2026-08-01', to: '2026-08-31' }))
  })

  it('[covers:web-search.url-scope-all-period-keys] /search の期間 keys は scope=period 時のみ（scope=all では載せない・labels は常時）', async () => {
    const m = await mountApp('/receipts?month=2026-09&labels=red')
    await m.router.push('/search?q=牛乳')
    await settle()
    // the keys-less entry writes the labels back ...
    expect(q(m).labels).toBe('red')
    // ... but the period keys never land while scope=all (the default)
    expect(q(m).month).toBeUndefined()
    expect(q(m).from).toBeUndefined()
    // a period change while scope=all leaves the URL untouched too
    await m.wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="period-prev"]').trigger('click')
    await settle()
    expect(q(m).month).toBeUndefined()
  })

  it('[covers:web-browse.url-diff-guard] 取り込み一致・同一 URL 再 replace の echo では無駄な replace を発行しない', async () => {
    const m = await mountApp('/')
    // the keys-less entry writes the store's period once (D2-1)
    expect(q(m).month).toBe('2026-10')
    const replace = vi.spyOn(m.router, 'replace')
    // a re-navigation to the identical URL: the import agrees with the store
    // and the watcher must not echo another replace — the spy's ONLY call is
    // this re-navigation itself (it records the test's own call too), so
    // exactly one call means the implementation issued no second replace
    await m.router.replace({ path: '/', query: { month: '2026-10' } })
    await settle()
    expect(replace).toHaveBeenCalledTimes(1)
  })
})

describe('search URL keys on both write sides (TASK-145 D1)', () => {
  it('[covers:web-search.url-scope-all-period-keys] 検索 dialog 実行（run）の流入は q と labels のみ（carry する期間 keys は載らない）', async () => {
    const m = await mountApp('/receipts?month=2026-09&labels=red')
    await m.wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="search-dialog-input"]').setValue('牛乳')
    // the run rides the form submit (the button is type="submit"; jsdom does
    // not synthesize submit from a click — the filter-bar recipe)
    await m.wrapper.find('form.search-dialog').trigger('submit')
    await settle()
    expect(q(m).q).toBe('牛乳')
    // the landing is a keys-less entry: the shell sync writes the labels ...
    expect(q(m).labels).toBe('red')
    // ... and the period keys never ride while scope=all (the run carries q
    // only, D1-1 — the store's period reaches /search through the store
    // continuation, not the URL)
    expect(q(m).month).toBeUndefined()
    expect(q(m).from).toBeUndefined()
    expect(q(m).to).toBeUndefined()
  })

  it('[covers:web-search.url-scope-all-period-keys] 期間 keys 付き流入（/search?month= 直リンク）は取り込み後に writeBack が keys を落とす（labels 差分なしでも）', async () => {
    const m = await mountApp('/search?month=2026-09&q=牛乳')
    // the URL's period was imported — the deep link drives the store ...
    const store = usePeriodStore()
    expect(store.month).toBe('2026-09')
    // ... and the first write-back strips the stray period keys even with NO
    // labels diff (labels unselected): the replace must fire on the stray
    // PERIOD_KEY alone, or the deleted keys would read as "no diff" and the
    // stale bookmark shape would survive (D1-2, review MED1)
    expect(q(m).month).toBeUndefined()
    expect(q(m).from).toBeUndefined()
    expect(q(m).to).toBeUndefined()
    expect(q(m).q).toBe('牛乳')
  })

  it('[covers:web-search.scope-toggle-period-keys] scope 切替: period→all で期間 keys が消え・all→period でのみ載る', async () => {
    // period -> all: the toggle adds nothing (dropPeriodQuery's result stands)
    const scoped = await remount('/search?q=牛乳&scope=period&month=2026-10')
    await scoped.wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(q(scoped).q).toBe('牛乳')
    expect(q(scoped).scope).toBeUndefined()
    expect(q(scoped).month).toBeUndefined()
    expect(q(scoped).week).toBeUndefined()
    expect(q(scoped).year).toBeUndefined()
    expect(q(scoped).from).toBeUndefined()
    expect(q(scoped).to).toBeUndefined()

    // all -> period: the only direction that seats the store's current keys
    const plain = await remount('/search?q=牛乳')
    await plain.wrapper.find('[data-test="search-scope"]').trigger('click')
    await settle()
    expect(q(plain).scope).toBe('period')
    expect(q(plain).month).toBe('2026-10')
  })
})

describe('axis detail: the write-back echo and the parent link (TASK-145 D2/D2-2)', () => {
  it('[covers:web-browse.url-echo-no-double-init] keys 無し流入の writeBack echo では初回取得は request 種別ごと1回（二重 init なし）', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const recent = vi.spyOn(api, 'listReceipts')
    const catalog = vi.spyOn(api, 'getCatalog')
    const m = await mountApp('/axes/category/1')
    // the echo landed: the keys-less entry wrote the store's month back
    expect(q(m).month).toBe('2026-10')
    // one load only — counted PER REQUEST KIND (a normal single load of the
    // category top still issues two analyses: the cross (store axis) and the
    // own (category axis), so "one getAnalysis" would under-count; review LOW4)
    expect(stats.mock.calls.filter(([, p]) => p.axis === 'store')).toHaveLength(1)
    expect(stats.mock.calls.filter(([, p]) => p.axis === 'category')).toHaveLength(1)
    expect(recent).toHaveBeenCalledTimes(1)
    // catalog.load's in-flight dedupe holds across the whole landing
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-axis.page-back-removed] 軸詳細の PageHead ‹ は除去（topbar ‹ へ集約・現在値 carry は廃止・見出し行は残る）', async () => {
    const a = await mountApp('/axes/category/1?month=2026-10')
    // the heading row itself stays (the kind label / the name / the total)
    expect(a.wrapper.find('.page-head').exists()).toBe(true)
    expect(a.wrapper.find('[data-test="total"]').exists()).toBe(true)
    // ... but its ‹ is gone — TASK-145 D2-2's live-query carry dies with it
    // (§2-6: the ‹ restores the history entry's state, it carries nothing)
    expect(a.wrapper.find('.page-head [data-test="page-back"]').exists()).toBe(false)
    expect(a.wrapper.find('[data-test="page-back"]').exists()).toBe(false)
    // the topbar ‹ takes over (TASK-164 §2-4: the browsing side's ‹)
    expect(a.wrapper.find('[data-test="topbar-back"]').exists()).toBe(true)
  })
})

describe('topbar back ‹ on the tabbar-外 screens (TASK-124 D3 + TASK-164 §2-4)', () => {
  const CASES = [
    // TASK-164: /search moved to the browsing side (a history-back ‹) — the
    // parentTo map keeps the ten non-browsing screens
    { path: '/settings/general', parent: '/', label: 'ホームへ戻る' },
    { path: '/settings/auth', parent: '/', label: 'ホームへ戻る' },
    { path: '/settings/data', parent: '/', label: 'ホームへ戻る' },
    { path: '/settings/others', parent: '/', label: 'ホームへ戻る' },
    { path: '/settings/categories', parent: '/settings/data', label: 'データへ戻る' },
    { path: '/settings/stores', parent: '/settings/data', label: 'データへ戻る' },
    { path: '/settings/labels', parent: '/settings/data', label: 'データへ戻る' },
    // /apps pushes the parent '/settings'; the route tree redirects /settings
    // to its general tab (required by account-pages), so the landing path is
    // the redirected one while the parent map itself keeps '/settings'
    { path: '/apps', parent: '/settings/general', label: '設定へ戻る' },
    { path: '/usage', parent: '/settings/others', label: 'その他へ戻る' },
    { path: '/usage/connect', parent: '/settings/others', label: 'その他へ戻る' },
  ]

  it('[covers:web-shell.topbar-back] tabbar 外画面の topbar ‹ は brand 直後・表題直前の icon-only で親マップの親へ戻る', async () => {
    for (const c of CASES) {
      const m = await remount(c.path)
      const back = m.wrapper.find('[data-test="topbar-back"]')
      expect(back.exists(), c.path).toBe(true)
      expect(back.attributes('aria-label'), c.path).toBe(c.label)
      // icon-only: no text, just the chevron
      expect(back.text(), c.path).toBe('')
      expect(back.find('svg').exists(), c.path).toBe(true)
      // placement: right after the brand, right before the topbar title
      const children = Array.from(m.wrapper.find('header.topbar').element.children)
      const idx = children.findIndex((el) => el.getAttribute('data-test') === 'topbar-back')
      const brandIdx = children.findIndex((el) => el.classList.contains('topbar-brand'))
      const titleIdx = children.findIndex((el) => el.tagName === 'H1')
      expect(idx, c.path).toBeGreaterThan(brandIdx)
      expect(idx, c.path).toBeLessThan(titleIdx)
      // the press climbs to the parent section
      await back.trigger('click')
      await settle()
      expect(m.router.currentRoute.value.path, c.path).toBe(c.parent)
    }
  })

  it('[covers:web-shell.topbar-back] ‹ は PageHead と同じ up 语义（parentTo push + back intent・history back でない）・/search と axes の ‹ は browsing side へ移管で feed には置かない', async () => {
    // establish a position so navDirection can see the push (the memory
    // history never writes window.history — the transition.test.ts recipe)
    const m = await remount('/settings/general')
    window.history.replaceState({ position: 1 }, '')
    await m.router.push('/settings/labels')
    await settle()
    const push = vi.spyOn(m.router, 'push')
    const back = vi.spyOn(m.router, 'back')
    const btn = m.wrapper.find('[data-test="topbar-back"]')
    window.history.replaceState({ position: 2 }, '')
    await btn.trigger('click')
    await settle()
    expect(push).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
    expect(m.router.currentRoute.value.path).toBe('/settings/data')
    expect(navKind.value).toBe('push')
    expect(direction.value).toBe('back')

    // TASK-164 §2-4: /search and the axes joined the browsing side — their
    // topbar ‹ exists (a history back with the boundary fallback) and the
    // axis PageHead ‹ is gone. The root browsing screens at the boundary
    // (a fresh mount with no app history behind it) hide the ‹ — that
    // per-screen matrix lives in dashboard-shell (nav-boundary).
    for (const path of ['/search?q=牛乳', '/axes/category/1?month=2026-10', '/axes/item/牛乳?month=2026-10']) {
      const n = await remount(path)
      expect(n.wrapper.find('[data-test="topbar-back"]').exists(), path).toBe(true)
      if (path.startsWith('/axes/')) {
        expect(n.wrapper.find('.page-head [data-test="page-back"]').exists(), path).toBe(false)
      }
    }
    // the feed keeps no topbar ‹ even with app history behind it (its 一覧
    // link remains its way back)
    window.history.replaceState({ position: 1 }, '')
    const home = await remount('/')
    window.history.replaceState({ position: 2 }, '')
    await home.router.push('/receipts/101')
    await settle()
    expect(home.wrapper.find('[data-test="topbar-back"]').exists()).toBe(false)
  })
})

describe('writeBack push/replace + labels asymmetry (TASK-164 §2-2-1/§2-5)', () => {
  it('[covers:web-browse.url-user-period-push] 利用者の期間変更（mode切替・range指定・jump）は push で書り戻る（D1-5識別区間では別々の有効API呼出は別entry・labels同時差分は同一pushに載る）', async () => {
    // the mode switch: the picker's tab rides the new setMode API
    const m = await mountApp('/?month=2026-10')
    await m.wrapper.find('[data-test="filter-period"]').trigger('click')
    await settle()
    const push = vi.spyOn(m.router, 'push')
    await m.wrapper.find('[data-test="mode-year"]').trigger('click')
    await settle()
    expect(q(m).year).toBe('2026')
    expect(push).toHaveBeenCalledTimes(1)

    // the Custom form commits through the new setRange API
    await m.wrapper.find('[data-test="mode-range"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="range-from"]').setValue('2026-01-01')
    await m.wrapper.find('[data-test="range-to"]').setValue('2026-03-31')
    push.mockClear()
    await m.wrapper.find('[data-test="range-apply"]').trigger('click')
    await settle()
    expect(q(m).from).toBe('2026-01-01')
    expect(q(m).to).toBe('2026-03-31')
    expect(push).toHaveBeenCalledTimes(1)

    // a jump (setMonth — a trend bar press) pushes once
    const store = usePeriodStore()
    push.mockClear()
    store.setMonth('2026-05')
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(push).toHaveBeenCalledTimes(1)
    // TASK-174 D1-5: two VALID calls in one tick are TWO pushes — the
    // same-tick batching of the old value watch is withdrawn, and the
    // entries are real: back walks the intermediate, then the prior value
    push.mockClear()
    store.step(-1)
    store.step(-1)
    await settle()
    expect(q(m).month).toBe('2026-03')
    expect(push).toHaveBeenCalledTimes(2)
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-04')
    expect(store.month).toBe('2026-04')
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-05')

    // a period change with a simultaneous labels diff rides ONE push
    push.mockClear()
    store.setMonth('2026-06')
    store.setLabelColors(['red'])
    await settle()
    expect(q(m).month).toBe('2026-06')
    expect(q(m).labels).toBe('red')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('[covers:web-browse.url-system-write-replace] 利用者以外の書き戻しは replace のまま（keys-less補完・labels単独・reset・/search strip は履歴を積まない）', async () => {
    const m = await mountApp('/receipts?month=2026-09')
    const push = vi.spyOn(m.router, 'push')
    const replace = vi.spyOn(m.router, 'replace')

    // the keys-less arrival's completion write-back is a replace
    await m.router.push('/')
    await settle()
    expect(q(m).month).toBe('2026-09')
    expect(replace).toHaveBeenCalled()
    expect(push).toHaveBeenCalledTimes(1) // only the test's own navigation

    // a labels-only change never stacks an entry
    replace.mockClear()
    push.mockClear()
    await toggleLabel(m, 'red')
    expect(q(m).labels).toBe('red')
    expect(replace).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    // the home re-press reset writes the default keys as a replace (§1-3:
    // resetToDefault never marks its write as a user one)
    replace.mockClear()
    push.mockClear()
    await m.wrapper.find('[data-test="tabbar"] a').trigger('click')
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(replace).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    // the /search scope=all stray-key strip stays a replace too
    replace.mockClear()
    push.mockClear()
    await m.router.push('/search?q=牛乳&month=2026-08')
    await settle()
    expect(q(m).month).toBeUndefined()
    expect(replace).toHaveBeenCalled()
    expect(push).toHaveBeenCalledTimes(1) // only the test's own navigation
  })

  it('[covers:web-browse.url-system-write-replace] reset は順序付きのsystem要素: user B→user C→reset は両user entryを残して現在entryをデフォルト期間へ置換する（backでCへ戻る）', async () => {
    const m = await mountApp('/?month=2026-08')
    const store = usePeriodStore()
    const push = vi.spyOn(m.router, 'push')
    store.setMonth('2026-09')
    store.setMonth('2026-05')
    await settle()
    // TASK-174 D2: the reset never cancels the pending user pushes — both
    // land as entries first, then the reset replaces the CURRENT (2026-05)
    // entry with the default period
    store.resetToDefault()
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(push).toHaveBeenCalledTimes(2) // the two user pushes only
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-09')
    await m.router.forward()
    await settle()
    expect(q(m).month).toBe('2026-10') // the reset replaced the current entry
  })

  it('[covers:web-browse.url-label-pop-asymmetry] labels単独の変更は履歴に載せないが pop で戻り先 entry の labels ごと復元される（10月・赤 → 6月push → 青replace → ‹ で 10月・赤）', async () => {
    // Issue #9: the cold start on home drops the mount URL's month=2026-05
    // — entry1 is the CURRENT month (2026-10), which is what makes this
    // test's first entry differ from the pre-#9 expectation
    const m = await mountApp('/?month=2026-05')
    expect(q(m).month).toBe('2026-10')
    // the search dialog opens ONCE and stays open across the toggles (the
    // filter-bar recipe) — reopening it per toggle would close it instead
    await m.wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    // a labels-only replace → entry1 = 10月・赤
    const store = usePeriodStore()
    store.setMonth('2026-06') // a user push → entry2 stacked on entry1
    await settle()
    // the labels-only change swaps red for blue (a replace on entry2)
    await m.wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    expect(q(m).labels).toBe('blue')
    expect(q(m).month).toBe('2026-06')
    // the back lands on entry1 — its period AND its labels restore together
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(q(m).labels).toBe('red')
    expect(store.month).toBe('2026-10')
    expect(store.labelColors).toEqual(['red'])
  })

  it('[covers:web-browse.url-next-write-discard-off-target] 対象外画面での期間変更は履歴要求として受理されず・対象画面への再流入でも再生しない（補完はreplace）', async () => {
    const m = await mountApp('/settings/general')
    const store = usePeriodStore()
    // a user period change OFF a sync target is NOT accepted as a history
    // demand (TASK-174 D1-4): no entry stands behind it — and the demand
    // does not replay when a browsing target arrives later
    store.setMonth('2026-05')
    await settle()
    const push = vi.spyOn(m.router, 'push')
    const replace = vi.spyOn(m.router, 'replace')
    // the direct hop to a keys-less target lands a replace completion: the
    // store's period rides the URL without stacking an entry
    await m.router.push('/')
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(push).toHaveBeenCalledTimes(1) // only the test's own navigation
    expect(replace).toHaveBeenCalled()
    // a back cannot walk to the unaccepted month: the only entries are the
    // settings screen and this completion
    await m.router.back()
    await settle()
    expect(m.router.currentRoute.value.path).toBe('/settings/general')
    expect(q(m).month).toBeUndefined()
    // nothing replays the unaccepted demand on a later target arrival either
    replace.mockClear()
    await m.router.push('/categories')
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(push).toHaveBeenCalledTimes(2) // the two test navigations only
  })

  it('[covers:web-browse.url-operation-capture] 同tick往復（step(-1);step(1)）は破棄でなく2操作として保存され back/forward が往復を再現する（旧フラグ掃き捨て前提の撤回）', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    // the same-tick round trip ends where it started, but it is TWO
    // operations (D1-5: A→B→A stacks two entries — the old sweep that
    // dropped the round trip when the value watch never fired is withdrawn)
    store.step(-1)
    store.step(1)
    expect(store.month).toBe('2026-10')
    await settle()
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-09') // back lands on the B leg ...
    expect(store.month).toBe('2026-09')
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10') // ... then the original A
    await m.router.forward()
    await settle()
    expect(q(m).month).toBe('2026-09')
    expect(store.month).toBe('2026-09')
  })
})

// TASK-174 (test-first against tmp/tasks/tm-174/design_url-history-entries.md
// v4): the operation-notification FIFO owns the browsing URL writes — one
// entry per identifiable operation (same-tick A→B→C / A→B→A stack two
// entries each; the old watch-batching compression is withdrawn), max one
// navigation in flight, an ACKed write never echoes into the store, every
// system write rides the same queue behind a pending push, and boundaries
// (an external entry, an unnotified back, a late pop) and failures (a
// refused / redirected / duplicated navigation, a rejected pop) stop the
// drain instead of being counted as entries. The new cases stay red until
// the implementation lands.
describe('browsing URL sync: one operation, one entry (TASK-174)', () => {
  it('[covers:web-browse.url-operation-capture] 同tickのA→B→Cは2つの期間entryとして保存され store/画面は最新操作を即座に反映する（watchバッチング圧縮なし）', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    const push = vi.spyOn(m.router, 'push')
    // two valid operations in ONE tick: two pushes — the intermediate
    // 2026-05 must not vanish into watch batching
    store.setMonth('2026-05')
    store.setMonth('2026-04')
    expect(store.month).toBe('2026-04') // the store shows the LATEST at once
    await settle()
    expect(push).toHaveBeenCalledTimes(2)
    // the entries are real and ordered: back walks B, then the original A
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(usePeriodStore().month).toBe('2026-05')
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
  })

  it('[covers:web-browse.url-serialized-history] 最初のnavigationをguard保留中に次の操作を与えても失われず in-flight は1のまま・解除後に back/forward がA/B/Cを順に再現する', async () => {
    const m = await mountApp('/?month=2026-10')
    const hold = holdGuard(m.router)
    const store = usePeriodStore()
    store.setMonth('2026-05') // the first write's navigation sits in the guard
    await settle()
    // while the first navigation is held, the NEXT operation is accepted
    // and saved — but no second navigation is issued (max in-flight = 1)
    store.setMonth('2026-04')
    await settle()
    expect(hold.held()).toBe(1)
    hold.release()
    await settle()
    expect(q(m).month).toBe('2026-04')
    expect(store.month).toBe('2026-04')
    // the entries stand in operation order: A(2026-10) B(2026-05) C(2026-04)
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-05')
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    await m.router.forward()
    await settle()
    expect(q(m).month).toBe('2026-05')
    await m.router.forward()
    await settle()
    expect(q(m).month).toBe('2026-04')
  })

  it('[covers:web-browse.url-pending-echo] store=C のとき保留中のBが確定しても storeを巻き戻さずB由来の再取得・追加writeがない（外部popはimportする）', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/?month=2026-10')
    const hold = holdGuard(m.router)
    const store = usePeriodStore()
    store.setMonth('2026-05') // B — held in the guard
    await settle()
    store.setMonth('2026-04') // the store is now C
    await settle()
    hold.release()
    await settle()
    // the queue drained: the URL ends at C ...
    expect(q(m).month).toBe('2026-04')
    // ... but B's landing never rolled the store back: 2026-05 drove
    // exactly ONE analysis (the setMonth) — the B echo issued no re-query
    expect(stats.mock.calls.filter(([, p]) => p.month === '2026-05')).toHaveLength(1)
    expect(store.month).toBe('2026-04')
    // an EXTERNAL pop is the opposite: the landing entry imports
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(store.month).toBe('2026-05')
  })

  it('[covers:web-browse.url-ordered-system-write] pending期間push中のlabels選択はpushをcancelせずlabelsは最終状態に載る（entry数は期間操作ぶんのみ）', async () => {
    const m = await mountApp('/?month=2026-10')
    const hold = holdGuard(m.router)
    const push = vi.spyOn(m.router, 'push')
    usePeriodStore().setMonth('2026-05') // the user push — held in the guard
    await settle()
    await toggleLabel(m, 'red') // a labels change while the push is pending
    hold.release()
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(q(m).labels).toBe('red')
    expect(push).toHaveBeenCalledTimes(1) // labels adds no entry
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(q(m).labels).toBe('red') // absent labels retains the selection (D2-1)
  })

  it('[covers:web-browse.url-ordered-system-write] pending期間push中のReceipts filter適用はpushをcancelせずfilter keysは後続replaceで載る（導出from/toは適用時の期間から算出）', async () => {
    const m = await remount('/receipts?month=2026-10&labels=red&keep=yes')
    const push = vi.spyOn(m.router, 'push')
    const hold = holdGuard(m.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    await m.wrapper.find('[data-test="filters-toggle"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="payment"]').setValue('credit_card')
    await m.wrapper.find('[data-test="filters"]').trigger('submit')
    hold.release()
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(q(m).labels).toBe('red')
    expect(q(m).keep).toBe('yes')
    expect(q(m).payment_method).toBe('credit_card')
    // the derived from/to ride the patch computed from the APPLIED period —
    // 2026-05's own bounds, not the stale 2026-10 pair
    expect(q(m).from).toBe('2026-05-01')
    expect(q(m).to).toBe('2026-05-31')
    expect(push).toHaveBeenCalledTimes(1)
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(q(m).payment_method).toBeUndefined()
  })

  it('[covers:web-browse.url-ordered-system-write] pending期間push中のStores店カテゴリ設定とAxis chip削除はpushをcancelせずpatchだけが後続replaceされる', async () => {
    // /stores: the store-category toggle
    const st = await remount('/stores?month=2026-10&labels=red&keep=yes')
    const stPush = vi.spyOn(st.router, 'push')
    const stHold = holdGuard(st.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    await st.wrapper.findAll('[data-test="store-category"]')[0]!.trigger('click')
    stHold.release()
    await settle()
    expect(q(st).month).toBe('2026-05')
    expect(q(st).labels).toBe('red')
    expect(q(st).keep).toBe('yes')
    expect(q(st).store_category).toBe('スーパー')
    expect(stPush).toHaveBeenCalledTimes(1)
    await st.router.back()
    await settle()
    expect(q(st).month).toBe('2026-10')
    expect(q(st).store_category).toBeUndefined()

    // /axes: the cross-filter chip removal (a store_id delete patch)
    const ax = await remount('/axes/category/1?month=2026-10&store_id=1&labels=red&keep=yes')
    const axPush = vi.spyOn(ax.router, 'push')
    const axHold = holdGuard(ax.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    await ax.wrapper.find('[data-test="chip-store"]').find('.chip-x').trigger('click')
    axHold.release()
    await settle()
    expect(q(ax).month).toBe('2026-05')
    expect(q(ax).labels).toBe('red')
    expect(q(ax).keep).toBe('yes')
    expect(q(ax).store_id).toBeUndefined()
    expect(axPush).toHaveBeenCalledTimes(1)
    await ax.router.back()
    await settle()
    expect(q(ax).month).toBe('2026-10')
    expect(q(ax).store_id).toBe('1')
  })

  it('[covers:web-browse.url-ordered-system-write] pending期間push中の検索語確定（topbar dialog・Search Enter・Search debounce）はpushをcancelせず連続確定は受付順になる', async () => {
    // on /search with scope=period the period push is accepted; the q
    // writers (the topbar dialog's submit and the page input's Enter /
    // debounce) send their patch through the same queue behind the push
    const m = await remount('/search?q=牛乳&scope=period&month=2026-10&labels=red&keep=yes')
    const push = vi.spyOn(m.router, 'push')
    const landed: unknown[] = []
    m.router.afterEach((to, _from, failure) => { if (!failure) landed.push(to.query.q) })
    const hold = holdGuard(m.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    // writer 1: the topbar dialog's submit (on /search it replaces q)
    await m.wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="search-dialog-input"]').setValue('パン')
    await m.wrapper.find('form.search-dialog').trigger('submit')
    await settle()

    // writers 2 (Enter) and 3 (debounce) land in acceptance order: the
    // Enter commits at once, the debounce commit fires 300ms later and the
    // final q is the debounce's (the later acceptance wins, never reordered)
    await m.wrapper.find('[data-test="search-input"]').setValue('卵')
    await m.wrapper.find('[data-test="search-input"]').trigger('keydown.enter')
    await settle()
    expect(q(m).q).toBe('牛乳')
    await m.wrapper.find('[data-test="search-input"]').setValue('酒')
    await new Promise((r) => setTimeout(r, 320))
    await settle()
    expect(hold.held()).toBe(1)
    expect(q(m).month).toBe('2026-10')
    hold.release()
    await settle()
    expect(q(m).q).toBe('酒')
    expect(q(m).labels).toBe('red')
    expect(q(m).keep).toBe('yes')
    expect(q(m).month).toBe('2026-05')
    expect(q(m).labels).toBe('red')
    expect(q(m).keep).toBe('yes')
    expect(push).toHaveBeenCalledTimes(1) // still one period entry only
    expect(landed).toEqual(['牛乳', 'パン', '卵', '酒'])
    m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(q(m).q).toBe('牛乳')
  })

  it('[covers:web-browse.url-ordered-system-write] pending期間push中のSearch tab切替は後続replace・scope切替は先行期間操作を完了してから置換し all後の期間操作は誤受理しない', async () => {
    // the tab toggle rides behind the pending push
    const m = await remount('/search?q=牛乳&scope=period&month=2026-10&labels=red&keep=yes')
    const push = vi.spyOn(m.router, 'push')
    const hold = holdGuard(m.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    await m.wrapper.find('[data-test="search-tab-items"]').trigger('click')
    hold.release()
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(q(m).labels).toBe('red')
    expect(q(m).keep).toBe('yes')
    expect(q(m).tab).toBe('items')
    expect(push).toHaveBeenCalledTimes(1)
    await m.router.back()
    await settle()
    expect(q(m).tab).toBeUndefined()

    // the scope toggle is an ORDERED boundary element: the pending period
    // operation completes first, then the scope replace lands — and once
    // the scope is all, a period operation is not accepted as a history
    // demand
    const se = await remount('/search?q=牛乳&scope=period&month=2026-10&labels=red&keep=yes')
    const sePush = vi.spyOn(se.router, 'push')
    const seHold = holdGuard(se.router)
    usePeriodStore().setMonth('2026-05')
    await settle()
    await se.wrapper.find('[data-test="search-scope"]').trigger('click') // period -> all
    usePeriodStore().setMonth('2026-07') // all accepted, replace still uncommitted
    await settle()
    expect(q(se).scope).toBe('period')
    expect(seHold.held()).toBe(1)
    seHold.release()
    await settle()
    expect(q(se).month).toBeUndefined() // the all-switch dropped the keys
    expect(q(se).labels).toBe('red')
    expect(q(se).keep).toBe('yes')
    expect(q(se).q).toBe('牛乳')
    expect(sePush).toHaveBeenCalledTimes(1) // the period push stood first
    await se.router.back()
    await settle()
    expect(q(se).month).toBe('2026-10') // the entry before the scope replace
    expect(q(se).scope).toBe('period')
    await se.router.forward() // return to the all entry before testing its acceptance rule
    await settle()
    expect(q(se).scope).toBeUndefined()
    sePush.mockClear()
    usePeriodStore().setMonth('2026-07')
    await settle()
    expect(sePush).not.toHaveBeenCalled() // not accepted while scope=all
    expect(q(se).month).toBeUndefined()
  })

  it('[covers:web-browse.url-queue-boundary] 外部pushは境界: 保留中の期間pushと未送信操作は破棄され旧queueは再生しない', async () => {
    const m = await mountApp('/?month=2026-10')
    // hold ONLY the FIFO write (its target is the month push); the external
    // entry below passes the guard and interrupts
    const hold = holdGuard(m.router, (to) => to.query.month === '2026-05')
    const store = usePeriodStore()
    store.setMonth('2026-05') // held
    await settle()
    store.setMonth('2026-04') // accepted, saved — NOT yet sent
    await settle()
    // an EXTERNAL entry: the queue is dropped, not resumed
    await m.router.push('/stores')
    await settle()
    hold.release()
    await settle()
    expect(m.router.currentRoute.value.path).toBe('/stores')
    // the dropped demands never replay: the entries behind /stores are the
    // initial period and this external push only
    await m.router.back()
    await settle()
    expect(m.router.currentRoute.value.path).toBe('/')
    expect(q(m).month).toBe('2026-10')
  })

  it('[covers:web-browse.url-queue-boundary][covers:web-shell.browsing-back] 未通知back（awaiting-pop）は外部replaceのPromise終端では解消せず再押下は追加backなし・後着popは新しい境界として扱う', async () => {
    const history = createManualHistory()
    window.history.replaceState({ position: 1 }, '')
    const m = await mountApp('/?month=2026-10', { history })
    window.history.replaceState({ position: 2 }, '')
    const store = usePeriodStore()
    store.setMonth('2026-05')
    await settle()
    // hold the pop notifications, then press ‹: the back moves the position
    // but its pop never arrives (the awaiting-pop window)
    history.holdPops()
    await m.wrapper.find('[data-test="topbar-back"]').trigger('click')
    await settle()
    expect(history.goCalls.filter((c) => c.delta < 0)).toHaveLength(1)
    // an external replace lands while the back's pop is un-notified: its
    // Promise settling does NOT cancel or resolve the awaited pop
    await m.router.replace({ query: { month: '2026-06' } })
    await settle()
    // the press stays locked — a re-press issues no additional back
    await m.wrapper.find('[data-test="topbar-back"]').trigger('click')
    await settle()
    expect(history.goCalls.filter((c) => c.delta < 0)).toHaveLength(1)
    // the late pop finally arrives: a NEW boundary — the old queue never
    // replays (a fresh period operation writes nothing)
    history.releasePops()
    await settle()
    store.setMonth('2026-07')
    await settle()
    expect(q(m).month).not.toBe('2026-07')
  })

  it('[covers:web-browse.url-queue-failure] 拒否（aborted）になった期間pushは成功entryに数えず未送信分は破棄される（後続操作のwriteなし）', async () => {
    const m = await mountApp('/?month=2026-10')
    const hold = holdGuard(m.router)
    // Register before navigation starts: the router snapshots its guard
    // list at entry. Release the first guard, then actually abort the push.
    let refused = false
    m.router.beforeEach(() => {
      if (refused) return true
      refused = true
      return false
    })
    const store = usePeriodStore()
    store.setMonth('2026-05') // held
    await settle()
    store.setMonth('2026-04') // saved, unsent
    await settle()
    hold.release()
    await settle()
    // the aborted push stacked no entry and the unsent demand is dropped:
    // the URL stands where it was and nothing writes 2026-04
    expect(q(m).month).toBe('2026-10')
    expect(store.month).toBe('2026-10') // D4 restores the last committed snapshot
    await settle()
    expect(q(m).month).toBe('2026-10')
  })

  it('[covers:web-browse.url-queue-failure] 同一URLへの外部replace競合は境界・duplicatedはbeforeEachなしで識別しentryに数えない', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    store.setMonth('2026-09')
    await settle() // E1 = 2026-09 stands
    const hold = holdGuard(m.router, (to) => to.query.month === '2026-05')
    store.setMonth('2026-05') // held
    await settle()
    // an EXTERNAL replace seats the very URL the queue is about to push
    // (it matches the guard's hold condition too — fire it un-awaited and
    // let the release settle both)
    void m.router.replace({ query: { month: '2026-05' } })
    await settle()
    hold.release()
    await settle()
    // The held push is cancelled by the external entrance (not duplicated).
    // Neither failure adds a period entry: back returns to 2026-10
    // directly — no 2026-05 entry was stacked between
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')
    // A successful, unambiguous pop establishes a new baseline (D4).
    // Only newly accepted operations may resume; the old queue never replays.
    store.setMonth('2026-07')
    await settle()
    expect(q(m).month).toBe('2026-07')
    // Exercise a REAL duplicated result: no beforeEach runs for an already
    // committed target. The adapter observes its own returned Promise.
    const guard = vi.fn(() => true)
    m.router.beforeEach(guard)
    const result = await browsingNavigation(m.router).write('push', m.router.currentRoute.value.fullPath, {
      operationId: 999, generation: 0, context: 'duplicate-probe',
    })
    expect(result.kind).toBe('duplicate')
    expect(guard).not.toHaveBeenCalled()
    await m.router.back()
    await settle()
    expect(q(m).month).toBe('2026-10')

  })

  it('[covers:web-browse.url-queue-failure][covers:web-shell.browsing-back] pop拒否 → failure afterEach → 復元前の再押下/期間変更では backロック・drain停止を維持し追加のhistory要求・writeがない', async () => {
    const history = createManualHistory()
    window.history.replaceState({ position: 1 }, '')
    const m = await mountApp('/?month=2026-10', { history })
    window.history.replaceState({ position: 2 }, '')
    const store = usePeriodStore()
    store.setMonth('2026-05')
    await settle()
    history.holdRestorations()
    const push = vi.spyOn(m.router, 'push')
    const replace = vi.spyOn(m.router, 'replace')
    const failed = vi.fn()
    m.router.afterEach((_to, _from, failure) => { if (failure) failed() })
    // the next navigation (the ‹ press's pop) is held, then REFUSED — the
    // failure afterEach lands while the history restoration is unconfirmed
    let armed = true
    let settleGuard: ((v: boolean) => void) | null = null
    m.router.beforeEach(() => {
      if (!armed) return true
      armed = false
      return new Promise<boolean>((resolve) => {
        settleGuard = resolve
      })
    })
    await m.wrapper.find('[data-test="topbar-back"]').trigger('click')
    await settle()
    // pop-active: the re-press is ignored (no second back) ...
    await m.wrapper.find('[data-test="topbar-back"]').trigger('click')
    await settle()
    expect(history.goCalls.filter((c) => c.delta < 0)).toHaveLength(1)
    // ... and a period change is neither accepted nor written while the
    // pop's navigation waits
    store.setMonth('2026-07')
    await settle()
    expect(q(m).month).toBe('2026-05')
    // refuse the pop: the navigation aborts (the failure afterEach) and the
    // router restores the position with a SILENT go — the restoration is
    // unconfirmed from the public surface, so the lock STAYS
    settleGuard!(false)
    await settle()
    expect(failed).toHaveBeenCalledTimes(1)
    expect(history.pendingRestorations).toBe(1)
    expect(history.location).toContain('month=2026-10')
    expect(history.goCalls.filter((c) => c.trigger === false)).toHaveLength(1)
    expect(history.goCalls.filter((c) => c.delta < 0)).toHaveLength(1)
    await m.wrapper.find('[data-test="topbar-back"]').trigger('click')
    store.setMonth('2026-03')
    await settle()
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(history.goCalls.filter((c) => c.delta < 0)).toHaveLength(1)
    history.releaseRestorations()
    expect(history.location).toContain('month=2026-05')
    expect(history.pendingRestorations).toBe(0)
    browsingNavigation(m.router).topbarBack()
    store.setMonth('2026-02')
    await settle()
    expect(browsingNavigation(m.router).historyLocked.value).toBe(true)
    expect(push).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(history.goCalls).toHaveLength(2)
  })
})

it.each([
  { path: '/stores', query: 'store_category=スーパー', key: 'store_category', selector: '[data-test="store-category"]' },
  { path: '/axes/payment/credit_card', query: 'category=食費', key: 'category', selector: '[data-test="chip-category"] .chip-x' },
  { path: '/axes/category/1', query: 'store_category=スーパー', key: 'store_category', selector: '[data-test="chip-store_category"] .chip-x' },
])('[covers:web-browse.url-ordered-system-write] pending push preserves entry and unrelated keys during $path $key removal', async ({ path, query, key, selector }) => {
  const m = await mountApp(`${path}?month=2026-10&labels=red&keep=yes&${query}`)
  const original = q(m)[key]
  const hold = holdGuard(m.router)
  const push = vi.spyOn(m.router, 'push')
  const replace = vi.spyOn(m.router, 'replace')
  usePeriodStore().setMonth('2026-05')
  await settle()
  await m.wrapper.find(selector).trigger('click')
  await settle()
  expect(hold.held()).toBe(1)
  expect(replace).not.toHaveBeenCalled()
  expect(q(m).month).toBe('2026-10')
  hold.release()
  await settle()
  expect(push).toHaveBeenCalledTimes(1)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(q(m)).toEqual({ month: '2026-05', labels: 'red', keep: 'yes' })
  m.router.back()
  await settle()
  expect(q(m)).toEqual({ month: '2026-10', labels: 'red', keep: 'yes', [key]: original })
  m.router.forward()
  await settle()
  expect(q(m)).toEqual({ month: '2026-05', labels: 'red', keep: 'yes' })
})

it('[covers:web-browse.url-ordered-system-write] scope all→period受付で確定前から期間操作を受理しFIFO順と非所有queryを保持する', async () => {
  const m = await mountApp('/search?q=牛乳&scope=period&month=2026-10&labels=red&keep=yes')
  const hold = holdGuard(m.router)
  const push = vi.spyOn(m.router, 'push')
  const landed: Array<{ scope: unknown; month: unknown }> = []
  m.router.afterEach((to, _from, failure) => {
    if (!failure) landed.push({ scope: to.query.scope, month: to.query.month })
  })
  usePeriodStore().setMonth('2026-05')
  await settle()
  await m.wrapper.find('[data-test="search-scope"]').trigger('click') // all accepted
  usePeriodStore().setMonth('2026-07') // ignored for history while logically all
  await m.wrapper.find('[data-test="search-scope"]').trigger('click') // period accepted
  usePeriodStore().setMonth('2026-06') // accepted before either scope replace lands
  await settle()
  expect(hold.held()).toBe(1)
  expect(q(m).month).toBe('2026-10')
  hold.release()
  await settle()
  expect(landed).toEqual([
    { scope: 'period', month: '2026-05' },
    { scope: undefined, month: undefined },
    { scope: 'period', month: '2026-07' },
    { scope: 'period', month: '2026-06' },
  ])
  expect(push).toHaveBeenCalledTimes(2)
  expect(q(m)).toEqual({ q: '牛乳', scope: 'period', month: '2026-06', labels: 'red', keep: 'yes' })
  m.router.back()
  await settle()
  expect(q(m).month).toBe('2026-07')
  m.router.back()
  await settle()
  expect(q(m).month).toBe('2026-10')
})

// Issue #9 (home period freshness): a home entry starts from the current
// month unless the standing period is fresh — the cold start never
// imports the URL's period keys on home (a restored tab's ?month= is
// stale state), an in-session keys-less home entry older than
// HOME_FRESH_WINDOW_MS (10 min since the last period activity) resets to
// the default, a keys-less entry inside the window keeps the period, and
// an entry carrying explicit period keys always imports them. Other
// screens' cold-start import is unchanged. Time is the faked Date: the
// period operations land at 2026-10-15T03:00Z and setSystemTime ages them.
describe('home period freshness (Issue #9)', () => {
  it('[covers:web-shell.home-fresh-window] コールドスタートで /?month=2026-09 に着地してもホームは当月表示（他画面のコールドスタートは従来どおり取り込む）', async () => {
    const m = await mountApp('/?month=2026-09')
    const store = usePeriodStore()
    expect(store.month).toBe('2026-10')
    // the stale key is replaced by the store's current keys at once
    expect(q(m).month).toBe('2026-10')

    // another screen's cold start still imports its period keys
    const c = await remount('/categories?month=2026-09')
    expect(usePeriodStore().month).toBe('2026-09')
    expect(q(c).month).toBe('2026-09')
  })

  it('[covers:web-shell.home-fresh-window] セッション内のホーム進入: 最終の期間操作から窓（10分）超過なら当月へリセット・窓以内なら期間維持', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    store.setMonth('2026-09') // the last period activity, at T0
    await settle()
    expect(q(m).month).toBe('2026-09')

    // inside the window (T0 + 5 min): the keys-less home entry keeps it
    vi.setSystemTime(new Date('2026-10-15T03:05:00Z'))
    await m.router.push('/receipts')
    await settle()
    await m.router.push('/')
    await settle()
    expect(store.month).toBe('2026-09')
    expect(q(m).month).toBe('2026-09')

    // beyond the window (T0 + 11 min): the keys-less home entry resets
    // to the current month and the URL follows as a replace
    vi.setSystemTime(new Date('2026-10-15T03:11:00Z'))
    await m.router.push('/receipts')
    await settle()
    await m.router.push('/')
    await settle()
    expect(store.month).toBe('2026-10')
    expect(q(m).month).toBe('2026-10')
  })

  it('[covers:web-shell.home-fresh-window] 期間キー付きのホーム進入は窓超過でもキーが優先される（リセットしない）', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    store.setMonth('2026-09')
    await settle()
    vi.setSystemTime(new Date('2026-10-15T03:11:00Z'))
    await m.router.push('/receipts')
    await settle()
    await m.router.push('/?month=2026-05')
    await settle()
    expect(store.month).toBe('2026-05')
    expect(q(m).month).toBe('2026-05')
  })
})
