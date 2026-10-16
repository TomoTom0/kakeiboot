import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as webauthn from '@/web/api/webauthn'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ASSERTION, ATTESTATION, CCR, ME, RCR, cleanup, mockFetch, mountApp, settle, type Handler } from './helpers'

vi.mock('@/web/api/webauthn', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/web/api/webauthn')>()
  return { ...orig, createPasskey: vi.fn(), getPasskey: vi.fn() }
})

beforeEach(() => {
  vi.mocked(webauthn.getPasskey).mockReset().mockResolvedValue(ASSERTION)
  vi.mocked(webauthn.createPasskey).mockReset().mockResolvedValue(ATTESTATION)
})
afterEach(cleanup)

const PASSKEYS = [
  { id: 1, label: 'iPhone', created_at: 1_760_000_000_000, last_used_at: null, backup_state: true },
  { id: 2, label: 'YubiKey', created_at: 1_760_000_000_000, last_used_at: 1_760_400_000_000, backup_state: false },
]

function home(extra: Record<string, Handler | Handler[]> = {}) {
  return mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: PASSKEYS }, ...extra })
}

async function clickDelete(wrapper: Awaited<ReturnType<typeof mountApp>>['wrapper'], id: number) {
  await wrapper.find(`[data-test="passkey-${id}"] [data-test="delete"]`).trigger('click')
  await wrapper.find(`[data-test="passkey-${id}"] [data-test="delete-confirm"]`).trigger('click')
  await settle()
}

describe('SettingsPage', () => {
  it('[covers:web-settings.shows-account] アカウント番号・表示名・家計簿・パスキー一覧', async () => {
    home()
    const { wrapper } = await mountApp('/settings')
    expect(wrapper.find('[data-test="account-number"]').text()).toBe('BB-ABCD-EFGH')
    expect(wrapper.find('[data-test="display-name"]').text()).toBe('太郎')
    expect(wrapper.find('[data-test="ledgers"]').text()).toContain('家計')
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('iPhone')
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('同期済み')
    expect(wrapper.find('[data-test="passkey-2"]').text()).toContain('端末内')
  })

  it('[covers:web-settings.delete-last-passkey-409] 409 last_passkey を文言で示す', async () => {
    home({ 'DELETE /api/passkeys/1': { status: 409, body: { error: 'last_passkey' } } })
    const { wrapper } = await mountApp('/settings')
    await clickDelete(wrapper, 1)
    expect(wrapper.find('[data-test="error"]').text()).toContain('最後のパスキーは削除できません')
    expect(wrapper.find('[data-test="passkey-1"]').exists()).toBe(true)
  })

  it('[covers:web-settings.step-up-dialog-on-reauth] reauth_required で本人確認後に再送', async () => {
    const f = home({
      'DELETE /api/passkeys/2': [{ status: 401, body: { error: 'reauth_required' } }, { status: 204 }],
      'POST /api/webauthn/reauth/start': { body: RCR },
      'POST /api/webauthn/reauth/finish': { body: {} },
    })
    const { wrapper } = await mountApp('/settings')
    await clickDelete(wrapper, 2)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(true)
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(1)
    await wrapper.find('[data-test="stepup-confirm"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/webauthn/reauth/start')).toHaveLength(1)
    expect(f.to('POST', '/api/webauthn/reauth/finish')[0]!.body).toEqual({ credential: ASSERTION })
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(2)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="info"]').text()).toContain('削除しました')
  })

  it('[covers:web-stepup.cancel-rejects] 本人確認キャンセルで再送しない', async () => {
    const f = home({ 'DELETE /api/passkeys/2': { status: 401, body: { error: 'reauth_required' } } })
    const { wrapper } = await mountApp('/settings')
    await clickDelete(wrapper, 2)
    await wrapper.find('[data-test="stepup-cancel"]').trigger('click')
    await settle()
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(1)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="error"]').text()).toContain('本人確認がキャンセル')
  })

  it('[covers:web-settings.add-passkey] start → create → finish（label 付き）→ 一覧再取得', async () => {
    const f = home({
      'POST /api/passkeys/start': { body: CCR },
      'POST /api/passkeys/finish': { body: {} },
    })
    const { wrapper } = await mountApp('/settings')
    await wrapper.find('[data-test="new-label"]').setValue('iPhone')
    await wrapper.find('[data-test="add-passkey"]').trigger('click')
    await settle()
    expect(webauthn.createPasskey).toHaveBeenCalledWith(CCR)
    expect(f.to('POST', '/api/passkeys/finish')[0]!.body).toEqual({ credential: ATTESTATION, label: 'iPhone' })
    expect(f.to('GET', '/api/passkeys')).toHaveLength(2)
  })

  it('[covers:web-settings.rename-passkey] PATCH で改名、100文字超は送らない', async () => {
    const f = home({ 'PATCH /api/passkeys/1': { body: {} } })
    const { wrapper } = await mountApp('/settings')
    await wrapper.find('[data-test="passkey-1"] [data-test="rename"]').trigger('click')
    await wrapper.find('[data-test="rename-input"]').setValue('x'.repeat(101))
    await wrapper.find('[data-test="rename-save"]').trigger('click')
    await settle()
    expect(f.to('PATCH', '/api/passkeys/1')).toHaveLength(0)
    expect(wrapper.find('[data-test="error"]').text()).toContain('1〜100文字')
    await wrapper.find('[data-test="rename-input"]').setValue('Mac')
    await wrapper.find('[data-test="rename-save"]').trigger('click')
    await settle()
    expect(f.to('PATCH', '/api/passkeys/1')[0]!.body).toEqual({ label: 'Mac' })
  })

  it('[covers:web-settings.logout] ログアウト・全端末ログアウトでログイン画面へ', async () => {
    for (const [btn, path] of [['logout', '/api/auth/logout'], ['logout-all', '/api/auth/logout-all']] as const) {
      const f = home({ [`POST ${path}`]: { status: 204 } })
      const { wrapper, router } = await mountApp('/settings')
      await wrapper.find(`[data-test="${btn}"]`).trigger('click')
      await settle()
      expect(f.to('POST', path)).toHaveLength(1)
      expect(router.currentRoute.value.path).toBe('/login')
      cleanup()
    }
  })

  it('[covers:web-settings.invite-issue] owner は招待 URL を発行でき、owner でなければフォームなし', async () => {
    const f = home({
      'POST /api/invitations': { status: 201, body: { url: 'https://h/register?token=X', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings')
    await wrapper.find('[data-test="invite-role"]').setValue('viewer')
    await wrapper.find('[data-test="invite-note"]').setValue('妹')
    await wrapper.find('[data-test="invite-issue"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/invitations')[0]!.body).toEqual({ role: 'viewer', inviter_note: '妹' })
    expect(wrapper.find('[data-test="invite-url"]').text()).toBe('https://h/register?token=X')
    cleanup()

    mockFetch({
      'GET /api/auth/me': { body: { ...ME, ledgers: [{ id: 2, name: '実家', role: 'editor' }] } },
      'GET /api/passkeys': { body: PASSKEYS },
    })
    const b = await mountApp('/settings')
    expect(b.wrapper.find('[data-test="invite"]').exists()).toBe(false)
  })
})

describe('AppsPage', () => {
  const GRANTS = [
    {
      id: 1,
      client_display: 'ChatGPT',
      client_id: 'https://chatgpt.com/a',
      scope: 'ledger.read ledger.write',
      active_ledger_id: 1,
      active_ledger_name: '家計',
      created_at: Date.UTC(2026, 9, 1, 0, 0),
      last_used_at: null,
    },
    {
      id: 2,
      client_display: 'ChatGPT',
      client_id: 'https://chatgpt.com/b',
      scope: 'ledger.read',
      active_ledger_id: null,
      active_ledger_name: null,
      created_at: Date.UTC(2026, 9, 2, 0, 0),
      last_used_at: null,
    },
  ]
  const apps = (extra: Record<string, Handler | Handler[]> = {}) =>
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/oauth/grants': { body: GRANTS }, ...extra })

  it('[covers:web-apps.list-grants] client・scope・選択中 ledger（未選択）・JST 日時', async () => {
    apps()
    const { wrapper } = await mountApp('/apps')
    const g1 = wrapper.find('[data-test="grant-1"]').text()
    expect(g1).toContain('ChatGPT')
    expect(g1).toContain('家計簿の記録・編集')
    expect(wrapper.find('[data-test="grant-1"] [data-test="active-ledger"]').text()).toBe('家計')
    expect(wrapper.find('[data-test="grant-2"] [data-test="active-ledger"]').text()).toBe('未選択')
    expect(g1).toContain('2026/10/01 09:00')
  })

  it('[covers:web-apps.revoke-grant] 画面内の確認後に DELETE', async () => {
    const f = apps({ 'DELETE /api/oauth/grants/1': { status: 204 } })
    const { wrapper } = await mountApp('/apps')
    await wrapper.find('[data-test="grant-1"] [data-test="revoke"]').trigger('click')
    expect(f.to('DELETE', '/api/oauth/grants/1')).toHaveLength(0)
    await wrapper.find('[data-test="grant-1"] [data-test="revoke-confirm"]').trigger('click')
    await settle()
    expect(f.to('DELETE', '/api/oauth/grants/1')).toHaveLength(1)
    expect(wrapper.find('[data-test="grant-1"]').exists()).toBe(false)
  })

  it('[covers:web-apps.switch-ledger] 切替成功で表示更新、409 は選択不可の文言', async () => {
    const f = apps({
      'PUT /api/oauth/grants/1/active-ledger': [
        { body: { ledger: { id: 2, name: '実家', role: 'editor' }, previous: { id: 1, name: '家計' } } },
        { status: 409, body: { error: 'ledger_not_selectable' } },
      ],
    })
    const { wrapper } = await mountApp('/apps')
    await wrapper.find('[data-test="grant-1"] [data-test="switch-select"]').setValue(2)
    await wrapper.find('[data-test="grant-1"] [data-test="switch"]').trigger('click')
    await settle()
    expect(f.to('PUT', '/api/oauth/grants/1/active-ledger')[0]!.body).toEqual({ ledger_id: 2 })
    expect(wrapper.find('[data-test="grant-1"] [data-test="active-ledger"]').text()).toBe('実家')
    await wrapper.find('[data-test="grant-1"] [data-test="switch"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('選択できません')
  })
})

describe('ManageLabelsPage (TASK-17)', () => {
  const LABELS = [
    { color: 'red', title: '旅行' },
    { color: 'yellow', title: null },
    { color: 'green', title: null },
    { color: 'blue', title: null },
    { color: 'purple', title: null },
  ]

  function injectLabelApi() {
    const api = createMockDataApi()
    Object.assign(api, {
      listLabels: vi.fn(async () => ({ labels: LABELS })),
      updateLabelTitle: vi.fn(async (_l: number, color: string, input: { title: string | null }) => ({
        label: { color, title: input.title },
        changed: true,
      })),
    })
    setDataApi(api)
    return api as DataApi & {
      listLabels: ReturnType<typeof vi.fn>
      updateLabelTitle: ReturnType<typeof vi.fn>
    }
  }

  it('[covers:web-settings.manage-labels] 5 行表示・保存で updateLabelTitle・上限超過はエラー表示・viewer は閲覧のみ', async () => {
    const api = injectLabelApi()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/settings/labels')
    // 5 rows: swatch + color name + title input + save
    const rows = wrapper.findAll('[data-test^="label-row-"]')
    expect(rows).toHaveLength(5)
    expect(wrapper.find('[data-test="label-row-red"]').text()).toContain('赤')
    expect(wrapper.find('[data-test="label-row-red"]').text()).toContain('旅行')
    expect(wrapper.text()).toContain('黄')
    expect(wrapper.text()).toContain('緑')
    expect(wrapper.text()).toContain('青')
    expect(wrapper.text()).toContain('紫')

    // a direct visit (no cached definitions yet) seeds the inputs with the
    // fetched titles, so saving another row cannot clear them unnoticed
    expect((wrapper.find('[data-test="label-title-red"]').element as HTMLInputElement).value).toBe('旅行')
    expect((wrapper.find('[data-test="label-title-yellow"]').element as HTMLInputElement).value).toBe('')

    // saving a title calls updateLabelTitle
    await wrapper.find('[data-test="label-title-yellow"]').setValue('誕生日')
    await wrapper.find('[data-test="label-save-yellow"]').trigger('click')
    await settle()
    expect(api.updateLabelTitle).toHaveBeenCalledWith(1, 'yellow', { title: '誕生日' })

    // clearing saves null
    await wrapper.find('[data-test="label-title-red"]').setValue('')
    await wrapper.find('[data-test="label-save-red"]').trigger('click')
    await settle()
    expect(api.updateLabelTitle).toHaveBeenLastCalledWith(1, 'red', { title: null })

    // over the length limit shows an error
    await wrapper.find('[data-test="label-title-green"]').setValue('あ'.repeat(21))
    await wrapper.find('[data-test="label-save-green"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="label-error-green"]').exists()).toBe(true)
    wrapper.unmount()
    cleanup()
    setDataApi(null)

    // viewer: read-only (no inputs, no save buttons)
    const viewerApi = injectLabelApi()
    void viewerApi
    mockFetch({ 'GET /api/auth/me': { body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] } } })
    const viewer = await mountApp('/settings/labels')
    expect(viewer.wrapper.text()).toContain('赤')
    expect(viewer.wrapper.find('[data-test="label-title-red"]').exists()).toBe(false)
    expect(viewer.wrapper.find('[data-test="label-save-red"]').exists()).toBe(false)
  })
})
