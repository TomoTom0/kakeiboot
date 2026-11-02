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

    // the write-back is a replace: no history entry, no slide, no scroll
    const one = await remount('/?month=2026-10')
    // seed navDirection's previous position: remount()'s cleanup() wipes
    // window.history.state, so the mount's own push observed position=null
    // (the memory history never writes window.history — the transition.test
    // recipe). A same-location replace moves nothing and leaves lastPosition
    // at 3 for the write-back's own replace to compare 3 against 3
    window.history.replaceState({ position: 3 }, '')
    await one.router.replace({ query: { month: '2026-10' } })
    await settle()
    const scrolls = scrollMocks().scrollTo.mock.calls.length
    await stepPeriod(one)
    expect(q(one).month).toBe('2026-09')
    expect(navKind.value).toBe('replace')
    expect(direction.value).toBe('none')
    expect(scrollMocks().scrollTo.mock.calls.length).toBe(scrolls)
  })

  it('[covers:web-browse.url-label-sync] ラベル絞り込みの変更は5画面+/search の URL labels= へ反映される', async () => {
    for (const path of ['/', '/categories', '/stores', '/receipts', '/axes/category/1', '/search?q=牛乳']) {
      const m = await remount(path)
      await toggleLabel(m, 'red')
      expect(q(m).labels, path).toBe('red')
    }
  })

  // TASK-146 §1: stepping into a FUTURE month rides the same replace
  // write-back (the cap is gone; the URL keeps accepting future values)
  it('[covers:web-shell.period-uncapped-step] 未来月への送り（›）も URL の month= へ replace で書り戻る（from/to は付かない）', async () => {
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

  it('[covers:web-browse.url-pop-restore] browser 戻るは戻り先 entry の最終 URL の期間へ復元する（同一画面内の変更は履歴に積まない）', async () => {
    const stats = vi.spyOn(api, 'getAnalysis')
    const m = await mountApp('/categories?month=2026-10')
    await stepPeriod(m) // entry 1 becomes /categories?month=2026-09 (replace)
    await m.router.push('/stores')
    await settle()
    expect(q(m).month).toBe('2026-09') // the keys-less entry writes it back
    await stepPeriod(m) // /stores -> 2026-08 (replace)
    expect(q(m).month).toBe('2026-08')
    await m.router.back()
    await settle()
    // the pop lands on the categories entry's final URL and imports it
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

  it('[covers:web-browse.axis-parent-to-reactive] 軸詳細の ‹ の遷移先指定は現在の期間・labels を運ぶ（parentTo そのものを検証・古値を運ばない）', async () => {
    // the period move ALONE (a label move mixed in would hand the narrowed
    // watch another init that refreshes the snapshot): the ‹ press passes its
    // parentTo to router.push as-is, and the PUSH ARGUMENT — not the landing
    // URL, which the parent screen's own write-back would patch up from the
    // store — is what shows a stale query (review LOW)
    const a = await mountApp('/axes/category/1?month=2026-10')
    await stepPeriod(a) // the store and the URL: month 2026-09
    const pushA = vi.spyOn(a.router, 'push')
    await a.wrapper.find('.page-head [data-test="page-back"]').trigger('click')
    await settle()
    expect(pushA).toHaveBeenCalledWith({ path: '/categories', query: { month: '2026-09' } })

    // the label move alone, through the same direct check: the link rides the
    // live query on both dimensions
    const b = await remount('/axes/category/1?month=2026-10')
    await toggleLabel(b, 'red')
    const pushB = vi.spyOn(b.router, 'push')
    await b.wrapper.find('.page-head [data-test="page-back"]').trigger('click')
    await settle()
    expect(pushB).toHaveBeenCalledWith({ path: '/categories', query: { month: '2026-10', labels: 'red' } })
  })
})

describe('topbar back ‹ on the tabbar-外 screens (TASK-124 D3)', () => {
  const CASES = [
    { path: '/search', parent: '/', label: 'ホームへ戻る' },
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

  it('[covers:web-shell.topbar-back] ‹ は PageHead と同じ up 语义（parentTo push + back intent・history back でない）で閲覧系/Axis/feed には置かない', async () => {
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

    // the browsing screens, the axis detail and the feed keep their existing
    // navigation (the axis PageHead ‹ stays; no topbar ‹ anywhere here)
    for (const path of ['/', '/receipts', '/categories', '/stores', '/axes/category/1?month=2026-10', '/receipts/101']) {
      const n = await remount(path)
      expect(n.wrapper.find('[data-test="topbar-back"]').exists(), path).toBe(false)
      if (path.startsWith('/axes/')) {
        expect(n.wrapper.find('.page-head [data-test="page-back"]').exists(), path).toBe(true)
      }
    }
  })
})
