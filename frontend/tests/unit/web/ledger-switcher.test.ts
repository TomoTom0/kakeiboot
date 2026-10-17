// Ledger colors and the ledger switcher (TASK-16 item 3): initial selection
// from me.default_ledger_id, the LedgerSwitcher (color chip + popover list)
// and the top bar color band. The settings-screen color radiogroup is gone
// (TASK-34: display colors are assigned automatically, not user-chosen).
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '@/web/api/auth'
import { setDataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { useSessionStore } from '@/web/stores/session'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  setDataApi(createMockDataApi())
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
})

const TWO: Me = {
  ...ME,
  default_ledger_id: 1,
  ledgers: [
    { id: 1, name: 'default book', role: 'owner', color: 'teal' },
    { id: 2, name: '家族', role: 'editor', color: 'orange' },
  ],
}

describe('session.setMe initial ledger', () => {
  it('[covers:web-shell.ledger-initial-default] 初期選択と失効時は default_ledger_id（所属内）→ ledgers[0]', () => {
    const fresh = () => {
      setActivePinia(createPinia())
      return useSessionStore()
    }
    const ledgers12 = [
      { id: 1, name: 'a', role: 'owner' as const, color: 'teal' as const },
      { id: 2, name: 'b', role: 'editor' as const, color: 'orange' as const },
    ]
    let s = fresh()
    s.setMe({ ...ME, ledgers: ledgers12, default_ledger_id: 2 })
    expect(s.selectedLedgerId).toBe(2)

    s = fresh()
    s.setMe({ ...ME, ledgers: ledgers12, default_ledger_id: 9 })
    expect(s.selectedLedgerId).toBe(1)

    s = fresh()
    s.setMe({ ...ME, ledgers: ledgers12, default_ledger_id: null })
    expect(s.selectedLedgerId).toBe(1)

    // the selected ledger disappears from the memberships on a reload
    s = fresh()
    s.setMe({ ...ME, ledgers: ledgers12, default_ledger_id: 2 })
    expect(s.selectedLedgerId).toBe(2)
    s.setMe({
      ...ME,
      ledgers: [ledgers12[0]!, { id: 3, name: 'c', role: 'viewer', color: 'pink' }],
      default_ledger_id: 3,
    })
    expect(s.selectedLedgerId).toBe(3)
  })
})

describe('LedgerSwitcher', () => {
  it('[covers:web-shell.ledger-switcher] 色チップとアクセシブルネーム、一覧の色・名前・役割・選択中、選ぶと切替えて閉じる', async () => {
    mockFetch({ 'GET /api/auth/me': { body: TWO } })
    const { wrapper, pinia } = await mountApp('/')
    const trigger = wrapper.find('[data-test="ledger-switch"]')
    expect(trigger.attributes('aria-label')).toBe('家計簿: default book（切り替え）')
    expect(trigger.html()).toContain('var(--ledger-teal)')

    await trigger.trigger('click')
    await settle()
    const menu = wrapper.find('[data-test="ledger-menu"]')
    expect(menu.exists()).toBe(true)
    const o1 = wrapper.find('[data-test="ledger-option-1"]')
    const o2 = wrapper.find('[data-test="ledger-option-2"]')
    expect(o1.attributes('role')).toBe('menuitemradio')
    expect(o2.attributes('role')).toBe('menuitemradio')
    expect(o1.attributes('aria-checked')).toBe('true')
    expect(o2.attributes('aria-checked')).toBe('false')
    expect(o1.text()).toContain('default book')
    expect(o1.text()).not.toContain('オーナー')
    expect(o1.html()).toContain('var(--ledger-teal)')
    expect(o2.text()).toContain('家族')
    expect(o2.text()).toContain('編集')
    expect(o2.html()).toContain('var(--ledger-orange)')

    await o2.trigger('click')
    await settle()
    expect(useSessionStore(pinia).selectedLedgerId).toBe(2)
    expect(wrapper.find('[data-test="ledger-menu"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ledger-switch"]').attributes('aria-label')).toBe('家計簿: 家族（切り替え）')
    cleanup()

    // a single membership still shows the trigger
    mockFetch({ 'GET /api/auth/me': { body: { ...TWO, ledgers: [TWO.ledgers[0]] } } })
    const one = await mountApp('/')
    expect(one.wrapper.find('[data-test="ledger-switch"]').exists()).toBe(true)
    cleanup()

    // not on screens that are not ledger scoped
    mockFetch({ 'GET /api/auth/me': { body: TWO }, 'GET /api/passkeys': { body: [] } })
    const settings = await mountApp('/settings')
    expect(settings.wrapper.find('[data-test="ledger-switch"]').exists()).toBe(false)
  })

  it('[covers:web-shell.ledger-color-band] ledgerScoped の画面で topbar に ledger-scoped と --ledger-current', async () => {
    const orange: Me = { ...TWO, ledgers: [{ ...TWO.ledgers[0]!, color: 'orange' }] }
    mockFetch({ 'GET /api/auth/me': { body: orange }, 'GET /api/passkeys': { body: [] } })
    const { wrapper, router } = await mountApp('/')
    expect(wrapper.find('.topbar').classes()).toContain('ledger-scoped')
    expect(wrapper.find('.shell').attributes('style')).toMatch(/--ledger-current:\s*var\(--ledger-orange\)/)
    await router.push('/settings')
    await settle()
    expect(wrapper.find('.topbar').classes()).not.toContain('ledger-scoped')
  })
})
