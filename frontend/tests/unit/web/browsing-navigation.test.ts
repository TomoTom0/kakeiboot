import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { mount } from '@vue/test-utils'
import type { Router } from 'vue-router'
import App from '@/web/App.vue'
import { setDataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { browsingNavigation } from '@/web/composables/browsingNavigation'
import { usePeriodStore } from '@/web/stores/period'
import { useSessionStore } from '@/web/stores/session'
import { cleanup, createManualHistory, ME, mockFetch, mountApp, settle } from './helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  setDataApi(createMockDataApi())
  mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
})
afterEach(() => {
  cleanup()
  setDataApi(null)
  window.history.replaceState(null, '')
  vi.useRealTimers()
})
function hold(router: Router): () => void {
  let release: () => void = () => {}
  let first = true
  router.beforeEach(() => {
    if (!first) return true
    first = false
    return new Promise<void>((resolve) => { release = resolve })
  })
  return () => release()
}

it('[covers:web-browse.url-ordered-system-write] pending B→C→reset keeps B and replaces only C', async () => {
  const { router } = await mountApp('/?month=2026-08&keep=yes#anchor')
  const release = hold(router)
  const period = usePeriodStore()
  period.setMonth('2026-09')
  await settle()
  period.setMonth('2026-05')
  period.resetToDefault()
  release()
  await settle()
  expect(router.currentRoute.value.query).toEqual({ month: '2026-10', keep: 'yes' })
  expect(router.currentRoute.value.hash).toBe('#anchor')
  router.back()
  await settle()
  expect(period.month).toBe('2026-09')
  router.back()
  await settle()
  expect(period.month).toBe('2026-08')
})

it('[covers:web-browse.url-queue-boundary] ledger reset waits for a stale-owned success then corrects the new baseline', async () => {
  const { router } = await mountApp('/?month=2026-10&labels=red&keep=yes')
  const release = hold(router)
  const period = usePeriodStore()
  period.setMonth('2026-05')
  await settle()
  period.setMonth('2026-04')
  useSessionStore().selectedLedgerId = 2
  expect(period.labelColors).toEqual([])
  release()
  await settle()
  expect(router.currentRoute.value.query).toEqual({ month: '2026-04', keep: 'yes' })
  expect(period.labelColors).toEqual([])
  router.back()
  await settle()
  expect(router.currentRoute.value.query.month).toBe('2026-10')
})

it('[covers:web-browse.url-queue-boundary] dispose does not import or write; remount imports the late committed URL', async () => {
  const { router, wrapper, pinia } = await mountApp('/?month=2026-10')
  const release = hold(router)
  const period = usePeriodStore()
  period.setMonth('2026-05')
  await settle()
  period.setMonth('2026-04')
  // The design's dispose runs at router lifetime: the adapter outlives the
  // shell (D3-2). Unmounting the LAST installed app instead tears vue-router
  // itself down — it resets currentRoute and cancels the held push, a
  // router-death boundary no public API prevents — so an empty mounted app
  // keeps the router installed across the shell's unmount.
  const keeper = createApp({ render: () => null })
  keeper.use(router)
  keeper.mount(document.createElement('div'))
  wrapper.unmount()
  release()
  await settle()
  expect(period.month).toBe('2026-04')
  expect(router.currentRoute.value.query.month).toBe('2026-05')
  const remounted = mount(App, { global: { plugins: [pinia, router] } })
  try {
    await settle()
    expect(period.month).toBe('2026-05')
    router.back()
    await settle()
    expect(period.month).toBe('2026-10')
  } finally {
    remounted.unmount()
    keeper.unmount()
  }
})

it('[covers:web-browse.url-queue-failure] redirect discards queued operations and imports the destination', async () => {
  const { router } = await mountApp('/?month=2026-10')
  router.beforeEach((to) => to.query.month === '2026-05' ? '/stores?month=2026-03' : true)
  const period = usePeriodStore()
  period.setMonth('2026-05')
  period.setMonth('2026-04')
  await settle()
  expect(router.currentRoute.value.path).toBe('/stores')
  expect(period.month).toBe('2026-03')
  router.back()
  await settle()
  expect(period.month).toBe('2026-10')
})

it('[covers:web-browse.url-queue-failure] rejected guard reports the error, discards the queue and permits fresh work after reconciliation', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const { router } = await mountApp('/?month=2026-10')
  const error = new Error('guard failed')
  const off = router.beforeEach(() => { throw error })
  const period = usePeriodStore()
  period.setMonth('2026-05')
  period.setMonth('2026-04')
  await settle()
  expect(report).toHaveBeenCalledWith(error)
  expect(period.month).toBe('2026-10')
  expect(router.currentRoute.value.query.month).toBe('2026-10')
  off()
  period.setMonth('2026-03')
  await settle()
  expect(router.currentRoute.value.query.month).toBe('2026-03')
})

it('[covers:web-shell.browsing-back] a duplicate external replace and shell remount never clear an unnotified back', async () => {
  const history = createManualHistory()
  const { router, wrapper, pinia } = await mountApp('/?month=2026-10', { history })
  const period = usePeriodStore()
  period.setMonth('2026-05')
  await settle()
  history.holdPops()
  browsingNavigation(router).topbarBack()
  await router.replace(router.currentRoute.value.fullPath)
  await settle()
  // Mount the next shell BEFORE unmounting the current one: with the app
  // count dropping to zero vue-router tears itself down (currentRoute reset,
  // history listener removed, the location re-pushed on the next install) —
  // a router-death boundary. The condition keeps the unnotified back across
  // a SHELL dispose/remount at router lifetime (D3-3), which the overlapping
  // mount expresses through the public API.
  const remounted = mount(App, { global: { plugins: [pinia, router] } })
  wrapper.unmount()
  try {
    browsingNavigation(router).topbarBack()
    expect(history.goCalls).toHaveLength(1)
    period.setMonth('2026-04')
    await settle()
    expect(router.currentRoute.value.query.month).toBe('2026-05')
    history.releasePops()
    await settle()
    expect(browsingNavigation(router).historyLocked.value).toBe(true)
  } finally { remounted.unmount() }
})

it('[covers:web-browse.url-queue-boundary] same-URL external navigation invalidates a queued operation even before the first hook', async () => {
  const { router } = await mountApp('/?month=2026-10')
  const period = usePeriodStore()
  period.setMonth('2026-05')
  period.setMonth('2026-04')
  await router.replace(router.currentRoute.value.fullPath)
  await settle()
  expect(period.month).toBe('2026-10')
  expect(router.currentRoute.value.query.month).toBe('2026-10')
})

it('[covers:web-browse.url-queue-boundary] external boundary cancels a search debounce before it can overwrite the destination', async () => {
  const { router, wrapper } = await mountApp('/search?q=old')
  await wrapper.find('[data-test="search-input"]').setValue('stale')
  await router.replace('/search?q=new')
  await new Promise((resolve) => setTimeout(resolve, 320))
  await settle()
  expect(router.currentRoute.value.query.q).toBe('new')
})

it.each([
  { raw: '/?keep=yes', completed: '/?keep=yes&month=2026-10' },
  { raw: '/?week=2026-10-14', completed: '/?week=2026-10-12' },
  { raw: '/search?q=old&month=2026-10', completed: '/search?q=old' },
])('[covers:web-browse.url-queue-failure] refused completion never retries: $raw', async ({ raw, completed }) => {
  const { router, wrapper } = await mountApp('/?month=2026-10')
  const refused = vi.fn(() => false)
  router.beforeEach((to) => to.fullPath === completed ? refused() : true)
  const replace = vi.spyOn(router, 'replace')
  await router.push(raw)
  await settle()
  expect(refused).toHaveBeenCalledTimes(1)
  expect(replace).toHaveBeenCalledTimes(1)
  expect(router.currentRoute.value.fullPath).toBe(raw)
  await settle()
  expect(replace).toHaveBeenCalledTimes(1)
  usePeriodStore().setLabelColors(['red'])
  await settle()
  expect(router.currentRoute.value.query.labels).toBe('red')
  expect(replace).toHaveBeenCalledTimes(2)
  if (router.currentRoute.value.name === 'search') {
    await wrapper.find('[data-test="search-input"]').setValue('fresh')
    await wrapper.find('[data-test="search-input"]').trigger('keydown.enter')
    await settle()
    expect(router.currentRoute.value.query.q).toBe('fresh')
  } else {
    usePeriodStore().setMonth('2026-03')
    await settle()
    expect(router.currentRoute.value.query.month).toBe('2026-03')
  }
  expect(refused).toHaveBeenCalledTimes(1)
})

it.each([
  { direction: 'forward', delta: 1, from: '/?month=2026-05' },
  { direction: 'back', delta: -2, from: '/?month=2026-05' },
  { direction: 'back', delta: -1, from: '/?month=2026-04' },
])('[covers:web-shell.browsing-back] unrelated pop keeps the original wait: $direction $delta $from', async ({ direction, delta, from }) => {
  const history = createManualHistory()
  const { router } = await mountApp('/?month=2026-10', { history })
  usePeriodStore().setMonth('2026-05')
  await settle()
  history.holdPops()
  const navigation = browsingNavigation(router)
  navigation.topbarBack()
  history.notifyPop({ to: '/?month=2026-03', from, delta, direction: direction === 'back' ? 'back' : 'forward' })
  await settle()
  expect(router.currentRoute.value.query.month).toBe('2026-03')
  expect(navigation.historyLocked.value).toBe(true)
  navigation.topbarBack()
  expect(history.goCalls).toHaveLength(1)
  history.releasePops()
  await settle()
  expect(navigation.historyLocked.value).toBe(true)
  const push = vi.spyOn(router, 'push')
  usePeriodStore().setMonth('2026-02')
  await settle()
  expect(push).not.toHaveBeenCalled()
})

it.each([
  { to: '/?month=2026-03', position: 1 },
  { to: '/?month=2026-10', position: 0 },
])('[covers:web-shell.browsing-back] matching direction/from/delta cannot override a different destination or entry position: $to $position', async ({ to, position }) => {
  const history = createManualHistory()
  const { router } = await mountApp('/?month=2026-10', { history })
  usePeriodStore().setMonth('2026-05')
  await settle()
  const state = vi.spyOn(history, 'state', 'get').mockReturnValue({ back: '/?month=2026-10', position: 2 })
  history.holdPops()
  const navigation = browsingNavigation(router)
  navigation.topbarBack()
  state.mockReturnValue({ position })
  history.notifyPop({ to, from: '/?month=2026-05', delta: -1, direction: 'back' })
  await settle()
  expect(navigation.historyLocked.value).toBe(true)
  navigation.topbarBack()
  expect(history.goCalls).toHaveLength(1)
})
