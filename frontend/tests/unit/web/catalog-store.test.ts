// TASK-74 (design: tmp/tasks/tm-74/design_hierarchy.md §4-4): the catalog
// store — a per-ledger getCatalog(l, false) cache with synchronous tree
// lookups (nodeById / pathOf / resolve / parentIdOf / childrenOf), dropped
// on a ledger switch, on leaving /settings (the manage screens may have
// edited the tree) and via invalidate(). MCP-side edits stay undetected
// (stale accepted: a stale path 400s on the stats call and a reload heals).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { createAppRouter } from '@/web/router'
import { useCatalogStore } from '@/web/stores/catalog'
import { useSessionStore } from '@/web/stores/session'
import { ME, cleanup, mockFetch, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  api = createMockDataApi()
  setDataApi(api)
})
afterEach(() => {
  setDataApi(null)
  cleanup()
})

/** Store of a fresh pinia with ledger 1 selected and the catalog loaded. */
async function loadedStore() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useSessionStore(pinia)
  session.setMe(ME) // default ledger 1
  const catalog = useCatalogStore(pinia)
  await catalog.load()
  return { pinia, session, catalog }
}

describe('catalog store (TASK-74 §4-4)', () => {
  it('[covers:web-browse.catalog-store] ツリー探索: nodeById・pathOf・parentIdOf・childrenOf・resolve（archived は出ない）', async () => {
    const { catalog } = await loadedStore()
    // mock seed: 食費(1) > 食料品(2) / 外食(3)・日用品(4)・交通費(5)・趣味(6, archived)
    expect(catalog.nodeById('item', 2)?.name).toBe('食料品')
    expect(catalog.nodeById('item', 999)).toBeNull()
    expect(catalog.pathOf('item', 2)).toBe('食費/食料品')
    expect(catalog.pathOf('item', 1)).toBe('食費')
    expect(catalog.pathOf('item', 999)).toBeNull()
    expect(catalog.parentIdOf('item', 2)).toBe(1)
    expect(catalog.parentIdOf('item', 1)).toBeNull()
    expect(catalog.childrenOf('item', 1).map((n) => n.name)).toEqual(['食料品', '外食'])
    expect(catalog.childrenOf('item', 2)).toEqual([])
    expect(catalog.resolve('item', '食費/外食')?.id).toBe(3)
    expect(catalog.resolve('item', '食費')?.id).toBe(1)
    expect(catalog.resolve('item', '存在しない/道')).toBeNull()
    expect(catalog.resolve('store', 'スーパー')?.name).toBe('スーパー')
    // archived nodes never come back (the cache reads includeArchived=false)
    expect(catalog.nodeById('item', 6)).toBeNull()
    expect(catalog.resolve('item', '趣味')).toBeNull()
  })

  it('[covers:web-browse.catalog-store] キャッシュ: 同一 ledger は1回だけ取得・invalidate() 後の次アクセスで再取得', async () => {
    const getCatalog = vi.spyOn(api, 'getCatalog')
    const { catalog } = await loadedStore()
    expect(getCatalog).toHaveBeenCalledTimes(1)
    expect(getCatalog).toHaveBeenCalledWith(1, false)
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(1)
    expect(catalog.pathOf('item', 2)).toBe('食費/食料品')
    catalog.invalidate()
    expect(catalog.pathOf('item', 2)).toBeNull()
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(2)
    expect(catalog.pathOf('item', 2)).toBe('食費/食料品')
  })

  it('[covers:web-browse.catalog-store] invalidate() は進行中の load promise も破棄（解決後にキャッシュへ復活させない）', async () => {
    // a load left /settings while its fetch is still in flight: the
    // invalidate must drop that promise too — the next load() starts a fresh
    // fetch instead of awaiting (and adopting) the pre-invalidate one
    const orig = api.getCatalog.bind(api)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const getCatalog = vi.spyOn(api, 'getCatalog').mockImplementationOnce(async (...args: Parameters<typeof orig>) => {
      await gate
      return orig(...args)
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    useSessionStore(pinia).setMe(ME) // default ledger 1
    const catalog = useCatalogStore(pinia)
    const stale = catalog.load() // the in-flight fetch (gated)
    catalog.invalidate() // leaving /settings mid-flight
    const fresh = catalog.load()
    // the post-invalidate load did not adopt the in-flight promise: it
    // started its own fetch right away
    expect(getCatalog).toHaveBeenCalledTimes(2)
    release()
    await Promise.all([stale, fresh])
    expect(catalog.pathOf('item', 2)).toBe('食費/食料品')
  })

  it('[covers:web-browse.catalog-store] ledger 切替でキャッシュ破棄し次アクセスで再取得（ledger 未選択は取得しない）', async () => {
    const getCatalog = vi.spyOn(api, 'getCatalog')
    const pinia = createPinia()
    setActivePinia(pinia)
    // no session yet: the selected ledger is null and load() stays idle
    const idle = useCatalogStore(pinia)
    await idle.load()
    expect(getCatalog).not.toHaveBeenCalled()
    expect(idle.pathOf('item', 1)).toBeNull()

    const session = useSessionStore(pinia)
    session.setMe(ME)
    const catalog = useCatalogStore(pinia)
    await catalog.load()
    expect(getCatalog).toHaveBeenLastCalledWith(1, false)
    session.selectedLedgerId = 2
    await settle()
    expect(catalog.pathOf('item', 2)).toBeNull() // the switch dropped the cache
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(2)
    expect(getCatalog).toHaveBeenLastCalledWith(2, false)
  })

  it('[covers:web-browse.catalog-store] /settings 配下からの退出でキャッシュ破棄（settings 内の移動・進入ではしない）', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const getCatalog = vi.spyOn(api, 'getCatalog')
    const pinia = createPinia()
    setActivePinia(pinia)
    const router = createAppRouter(createMemoryHistory(), pinia)
    await router.push('/settings/categories')
    const session = useSessionStore(pinia)
    expect(session.selectedLedgerId).toBe(1)
    const catalog = useCatalogStore(pinia)
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(1)

    // moving within /settings keeps the cache (no manage screen was left)
    await router.push('/settings/stores')
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(1)

    // leaving /settings drops it: the manage screens may have renamed /
    // moved / archived nodes, so the next access refetches
    await router.push('/categories')
    await catalog.load()
    expect(getCatalog).toHaveBeenCalledTimes(2)
  })
})
