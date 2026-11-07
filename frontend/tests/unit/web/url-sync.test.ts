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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocationQuery } from 'vue-router'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { direction, navKind } from '@/web/composables/navDirection'
import { usePeriodStore } from '@/web/stores/period'
import { ME, cleanup, mockFetch, mountApp, scrollMocks, settle } from './helpers'

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
  it('[covers:web-browse.url-restore] 直リンクの labels= と期間 keys は Home/Categories でも store へ復元される（analysis に label_colors が流れる）', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/?labels=red&month=2026-09')
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ month: '2026-09', label_colors: ['red'] }))
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
  it('[covers:web-browse.url-user-period-push] 利用者の期間変更（mode切替・range指定・jump）は push で書り戻る（同tickの連続変更は1回のpush・labels同時差分は同一pushに載る）', async () => {
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

    // a jump (setMonth — a trend bar press) pushes once; two steps in one
    // tick batch into ONE push carrying the final value
    const store = usePeriodStore()
    push.mockClear()
    store.setMonth('2026-05')
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(push).toHaveBeenCalledTimes(1)
    push.mockClear()
    store.step(-1)
    store.step(-1)
    await settle()
    expect(q(m).month).toBe('2026-03')
    expect(push).toHaveBeenCalledTimes(1)

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

  it('[covers:web-browse.url-label-pop-asymmetry] labels単独の変更は履歴に載せないが pop で戻り先 entry の labels ごと復元される（5月・赤 → 6月push → 青replace → ‹ で 5月・赤）', async () => {
    const m = await mountApp('/?month=2026-05')
    // the search dialog opens ONCE and stays open across the toggles (the
    // filter-bar recipe) — reopening it per toggle would close it instead
    await m.wrapper.find('[data-test="filter-search"]').trigger('click')
    await settle()
    await m.wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await settle()
    // a labels-only replace → entry1 = 5月・赤
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
    expect(q(m).month).toBe('2026-05')
    expect(q(m).labels).toBe('red')
    expect(store.month).toBe('2026-05')
    expect(store.labelColors).toEqual(['red'])
  })

  it('[covers:web-browse.url-next-write-discard-off-target] 対象外画面での期間変更は nextWrite を即座に破棄し・対象画面への直接遷移でも keys-less 補完は replace（残留 user 指定の誤 push なし）', async () => {
    const m = await mountApp('/settings/general')
    const store = usePeriodStore()
    // a user period change OFF a sync target: the store watch fires, the
    // write-back returns early — and the early return itself discards the
    // one-shot flag (REVIEW-12 #4: the change will never be written, so it
    // must not stand for the NEXT arrival's keys-less completion to misread
    // as a user change)
    store.setMonth('2026-05')
    await settle()
    expect(store.nextWrite).toBe('system')
    // the direct hop to a keys-less target lands a replace completion: the
    // store's period rides the URL without stacking an entry
    const push = vi.spyOn(m.router, 'push')
    await m.router.push('/')
    await settle()
    expect(q(m).month).toBe('2026-05')
    expect(push).toHaveBeenCalledTimes(1) // only the test's own navigation
  })

  it('[covers:web-browse.url-next-write-discard-off-target] 同tick往復（step(-1);step(1)・watch不発火）で立ったフラグは掃き捨てられ keys-less 遷移の補完は replace（REVIEW-12 #3）', async () => {
    const m = await mountApp('/?month=2026-10')
    const store = usePeriodStore()
    // the same-tick round trip ends where it started: the value watch never
    // fires (nothing changed), while the first step DID legitimately raise
    // 'user' — the composable's sweep watch drops the orphaned marking at
    // the end of the tick (a real user change has been consumed through
    // writeBack by then; only a marking with no write behind it resets)
    store.step(-1)
    store.step(1)
    await settle()
    expect(store.month).toBe('2026-10')
    expect(store.nextWrite).toBe('system')
    // ... so a keys-less arrival's completion stays a replace
    const push = vi.spyOn(m.router, 'push')
    await m.router.push('/receipts')
    await settle()
    expect(q(m).month).toBe('2026-10')
    expect(push).toHaveBeenCalledTimes(1) // only the test's own navigation
  })
})
