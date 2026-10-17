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
  it('[covers:web-settings.shows-account] 一般tabに表示名・家計簿一覧（アカウント番号は web UI 全体で非表示）', async () => {
    home()
    const { wrapper } = await mountApp('/settings/general')
    expect(wrapper.find('[data-test="display-name"]').text()).toBe('太郎')
    // the second real-device review removed the number display itself (and
    // its copy button): the account number lives on the operator CLI only,
    // not anywhere in the web UI
    expect(wrapper.text()).not.toContain('BB-ABCD-EFGH')
    expect(wrapper.find('[data-test="account-number"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="account-number-copy"]').exists()).toBe(false)
    // ledger list: color chip + name + role, display only
    // (TASK-34: no display-color radiogroup anywhere on the panel)
    const ledgers = wrapper.find('[data-test="ledgers"]')
    expect(ledgers.text()).toContain('家計')
    expect(ledgers.text()).toContain('オーナー')
    expect(ledgers.html()).toContain('var(--ledger-teal)')
    expect(wrapper.find('[role="radiogroup"]').exists()).toBe(false)
  })

  it('[covers:web-settings.shows-passkeys] 認証tabにパスキー一覧（同期済み/端末内）と追加フォーム', async () => {
    home()
    const { wrapper } = await mountApp('/settings/auth')
    expect(wrapper.find('[data-test="passkeys"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('iPhone')
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('同期済み')
    expect(wrapper.find('[data-test="passkey-2"]').text()).toContain('端末内')
    expect(wrapper.find('[data-test="new-label"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="add-passkey"]').exists()).toBe(true)
  })

  it('[covers:web-settings.delete-last-passkey-409] 409 last_passkey を文言で示す', async () => {
    home({ 'DELETE /api/passkeys/1': { status: 409, body: { error: 'last_passkey' } } })
    const { wrapper } = await mountApp('/settings/auth')
    await clickDelete(wrapper, 1)
    expect(wrapper.find('[data-test="passkeys-panel"] [data-test="error"]').text()).toContain('最後のパスキーは削除できません')
    expect(wrapper.find('[data-test="passkey-1"]').exists()).toBe(true)
  })

  it('[covers:web-settings.step-up-dialog-on-reauth] reauth_required で本人確認後に再送', async () => {
    const f = home({
      'DELETE /api/passkeys/2': [{ status: 401, body: { error: 'reauth_required' } }, { status: 204 }],
      'POST /api/webauthn/reauth/start': { body: RCR },
      'POST /api/webauthn/reauth/finish': { body: {} },
    })
    const { wrapper } = await mountApp('/settings/auth')
    await clickDelete(wrapper, 2)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(true)
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(1)
    await wrapper.find('[data-test="stepup-confirm"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/webauthn/reauth/start')).toHaveLength(1)
    expect(f.to('POST', '/api/webauthn/reauth/finish')[0]!.body).toEqual({ credential: ASSERTION })
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(2)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="passkeys-panel"] [data-test="info"]').text()).toContain('削除しました')
  })

  it('[covers:web-stepup.cancel-rejects] 本人確認キャンセルで再送しない', async () => {
    const f = home({ 'DELETE /api/passkeys/2': { status: 401, body: { error: 'reauth_required' } } })
    const { wrapper } = await mountApp('/settings/auth')
    await clickDelete(wrapper, 2)
    await wrapper.find('[data-test="stepup-cancel"]').trigger('click')
    await settle()
    expect(f.to('DELETE', '/api/passkeys/2')).toHaveLength(1)
    expect(wrapper.find('[data-test="stepup-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="passkeys-panel"] [data-test="error"]').text()).toContain('本人確認がキャンセル')
  })

  it('[covers:web-settings.add-passkey] start → create → finish（label 付き）→ 一覧再取得', async () => {
    const f = home({
      'POST /api/passkeys/start': { body: CCR },
      'POST /api/passkeys/finish': { body: {} },
    })
    const { wrapper } = await mountApp('/settings/auth')
    await wrapper.find('[data-test="new-label"]').setValue('iPhone')
    await wrapper.find('[data-test="add-passkey"]').trigger('click')
    await settle()
    expect(webauthn.createPasskey).toHaveBeenCalledWith(CCR)
    expect(f.to('POST', '/api/passkeys/finish')[0]!.body).toEqual({ credential: ATTESTATION, label: 'iPhone' })
    expect(f.to('GET', '/api/passkeys')).toHaveLength(2)
  })

  it('[covers:web-settings.rename-passkey] PATCH で改名、100文字超は送らない', async () => {
    const f = home({ 'PATCH /api/passkeys/1': { body: {} } })
    const { wrapper } = await mountApp('/settings/auth')
    await wrapper.find('[data-test="passkey-1"] [data-test="rename"]').trigger('click')
    await wrapper.find('[data-test="rename-input"]').setValue('x'.repeat(101))
    await wrapper.find('[data-test="rename-save"]').trigger('click')
    await settle()
    expect(f.to('PATCH', '/api/passkeys/1')).toHaveLength(0)
    expect(wrapper.find('[data-test="passkeys-panel"] [data-test="error"]').text()).toContain('1〜100文字')
    await wrapper.find('[data-test="rename-input"]').setValue('Mac')
    await wrapper.find('[data-test="rename-save"]').trigger('click')
    await settle()
    expect(f.to('PATCH', '/api/passkeys/1')[0]!.body).toEqual({ label: 'Mac' })
  })

  it('[covers:web-settings.invite-issue] owner は共有 URL を発行でき、owner でなければフォームなし', async () => {
    const f = home({
      'POST /api/invitations': { status: 201, body: { url: 'https://h/register?token=X', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings/auth')
    // the sharing card names the default ledger and keeps the sharing words
    // (the wording "invitation" belongs to the registration-only card)
    const panel = wrapper.find('[data-test="invite-panel"]')
    expect(panel.text()).toContain('家計を共有')
    expect(panel.text()).not.toContain('招待')
    await wrapper.find('[data-test="invite-role"]').setValue('viewer')
    await wrapper.find('[data-test="invite-note"]').setValue('妹')
    await wrapper.find('[data-test="invite-issue"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/invitations')[0]!.body).toEqual({ role: 'viewer', inviter_note: '妹' })
    expect(wrapper.find('[data-test="invite-url"]').text()).toBe('https://h/register?token=X')
    cleanup()

    // a me whose default_ledger_id points at an editor membership: no form,
    // and the forbidden note in its place (same card on the auth tab)
    mockFetch({
      'GET /api/auth/me': { body: { ...ME, default_ledger_id: 2 } },
      'GET /api/passkeys': { body: PASSKEYS },
    })
    const b = await mountApp('/settings/auth')
    expect(b.wrapper.find('[data-test="invite"]').exists()).toBe(false)
    expect(b.wrapper.find('[data-test="invite-forbidden"]').exists()).toBe(true)
  })

  it('[covers:web-settings.register-invite-card] 全userに登録の招待カード・メモ必須・URLと期限を表示', async () => {
    // a non-owner me (editor-only memberships) still gets the card
    const f = mockFetch({
      'GET /api/auth/me': {
        body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'editor' as const }, { ...ME.ledgers[1]! }] },
      },
      'POST /api/register-invitations': {
        status: 201,
        body: { url: 'https://h/register?token=R', expires_at: Date.UTC(2026, 9, 16, 15, 0) },
      },
    })
    const { wrapper } = await mountApp('/settings/auth')
    const card = wrapper.find('[data-test="register-invite"]')
    expect(card.exists()).toBe(true)
    expect(card.text()).toContain('登録の招待')

    // empty note: stopped before the API
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')).toHaveLength(0)
    expect(wrapper.find('[data-test="register-invite"] [data-test="error"]').text()).toContain('メモを入力してください。')

    // 201 characters (charCount, not bytes): stopped as well
    await wrapper.find('[data-test="register-invite-note"]').setValue('あ'.repeat(201))
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')).toHaveLength(0)
    expect(wrapper.find('[data-test="register-invite"] [data-test="error"]').text()).toContain('メモは200文字以内で入力してください。')

    // a valid note: POST {inviter_note}, then the URL and the JST expiry
    await wrapper.find('[data-test="register-invite-note"]').setValue('妹')
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')[0]!.body).toEqual({ inviter_note: '妹' })
    expect(wrapper.find('[data-test="register-invite-url"]').text()).toBe('https://h/register?token=R')
    expect(wrapper.find('[data-test="register-invite-expires"]').text()).toContain('2026/10/17 00:00')
  })

  it('[covers:web-settings.settings-layout] /settings は /settings/general へ redirect し、4つの水平tabでパネルを切り替える', async () => {
    home()
    const { wrapper, router } = await mountApp('/settings')
    expect(router.currentRoute.value.path).toBe('/settings/general')
    // four horizontal tabs after the real-device review: general / auth /
    // data / others
    const TABS = [
      ['settings-tab-general', '/settings/general', '一般'],
      ['settings-tab-auth', '/settings/auth', '認証'],
      ['settings-tab-data', '/settings/data', 'データ'],
      ['settings-tab-others', '/settings/others', 'その他'],
    ] as const
    for (const [key, href, label] of TABS) {
      const tab = wrapper.find(`[data-test="${key}"]`)
      expect(tab.attributes('href'), key).toBe(href)
      expect(tab.text(), key).toBe(label)
    }
    // no /apps link inside the settings tabs (it stays in the account menu)
    for (const a of wrapper.findAll('[data-test="settings-nav"] a')) {
      expect(a.attributes('href')).not.toContain('/apps')
    }
    // the landed general tab is the current one
    expect(wrapper.find('[data-test="settings-tab-general"]').attributes('aria-current')).toBe('page')

    // clicking a tab swaps the panel below the strip; the auth tab stacks
    // the passkey list, the registration invitation and the sharing card
    await wrapper.find('[data-test="settings-tab-auth"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/settings/auth')
    expect(wrapper.find('[data-test="passkeys"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="register-invite"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="invite-panel"]').exists()).toBe(true)
    // logout left the settings screen for the top-right account menu
    expect(wrapper.find('[data-test="logout-card"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="logout"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="logout-all"]').exists()).toBe(false)

    // the data and others tabs carry their link rows
    await wrapper.find('[data-test="settings-tab-data"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="settings-data-categories"]').attributes('href')).toBe('/settings/categories')
    await wrapper.find('[data-test="settings-tab-others"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="settings-others-usage"]').attributes('href')).toBe('/usage')

    // aria-current follows the active tab; the manage screens light the
    // data tab as their way back
    await router.push('/settings/labels')
    await settle()
    expect(wrapper.find('[data-test="settings-tab-data"]').attributes('aria-current')).toBe('page')
    for (const [key] of TABS) {
      if (key === 'settings-tab-data') continue
      expect(wrapper.find(`[data-test="${key}"]`).attributes('aria-current'), key).toBeUndefined()
    }
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

  it('[covers:web-shell.loading-skeleton] 接続中のアプリも初回 loading は skeleton（aria-hidden + sr-only）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mockFetch({
      'GET /api/auth/me': { body: ME },
      'GET /api/oauth/grants': async () => {
        await gate
        return { body: GRANTS }
      },
    })
    const { wrapper } = await mountApp('/apps')
    const sk = wrapper.find('[data-test="loading"]')
    expect(sk.exists()).toBe(true)
    expect(sk.classes()).toContain('skeleton')
    expect(sk.attributes('aria-hidden')).toBe('true')
    expect(sk.find('.sr-only').text()).toBe('読み込んでいます...')
    expect(wrapper.find('[data-test="grant-1"]').exists()).toBe(false)
    release()
    await settle()
    expect(wrapper.find('[data-test="loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="grant-1"]').exists()).toBe(true)
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

  it('[covers:web-settings.manage-labels][covers:web-labels.no-color-names-on-screen] 5行はLabelChipのみ・行押下でその行だけ入力+保存で updateLabelTitle・Escape でやめる・viewer は押せない', async () => {
    const api = injectLabelApi()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/settings/labels')
    await settle()

    // 5 rows of LabelChips only: the titled one carries its name as chip
    // text, the untitled ones show no text (no color names anywhere)
    const rows = wrapper.findAll('[data-test^="label-row-"]')
    expect(rows).toHaveLength(5)
    const chips = wrapper.findAll('.label-rows .label-chip')
    expect(chips).toHaveLength(5)
    expect(chips[0]!.text()).toBe('旅行')
    expect(chips[0]!.classes()).toContain('label-red')
    expect(chips[1]!.text()).toBe('')
    expect(wrapper.text()).not.toMatch(/赤|黄|緑|青|紫|ラベル[1-5]|名前なし/)
    // no inputs before a row is pressed; every row is pressable (editor)
    expect(wrapper.find('[data-test="label-title-red"]').exists()).toBe(false)
    expect(wrapper.findAll('.label-rows button').length).toBeGreaterThanOrEqual(5)

    // the aria names use the spoken name (title / neutral ラベルN)
    expect(wrapper.find('[data-test="label-edit-yellow"]').attributes('aria-label')).toBe('ラベル2の名前を変更')
    expect(wrapper.find('[data-test="label-edit-red"]').attributes('aria-label')).toBe('旅行の名前を変更')

    // pressing a row turns that row alone into the editor, seeded with the
    // fetched title (a direct visit still sees the existing names)
    await wrapper.find('[data-test="label-edit-yellow"]').trigger('click')
    await settle()
    expect(wrapper.findAll('[data-test^="label-title-"]')).toHaveLength(1)
    expect((wrapper.find('[data-test="label-title-yellow"]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-test="label-title-yellow"]').attributes('aria-label')).toBe('ラベル2の名前')
    expect(wrapper.find('[data-test="label-save-yellow"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="label-cancel-yellow"]').exists()).toBe(true)

    // saving a name calls updateLabelTitle and returns the row to display
    await wrapper.find('[data-test="label-title-yellow"]').setValue('誕生日')
    await wrapper.find('[data-test="label-title-yellow"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(api.updateLabelTitle).toHaveBeenCalledWith(1, 'yellow', { title: '誕生日' })
    expect(wrapper.find('[data-test="label-title-yellow"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="label-row-yellow"]').find('.label-chip').text()).toBe('誕生日')
    // the result lands in the row's role="status"
    const status = wrapper.find('[data-test="label-row-yellow"]').find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain('保存しました')

    // pressing another row with an unsaved draft is blocked once, then the
    // second press switches (discarding the draft)
    await wrapper.find('[data-test="label-edit-red"]').trigger('click')
    await settle()
    expect((wrapper.find('[data-test="label-title-red"]').element as HTMLInputElement).value).toBe('旅行')
    await wrapper.find('[data-test="label-title-red"]').setValue('改正')
    await wrapper.find('[data-test="label-edit-green"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="label-unsaved"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="label-title-red"]').exists()).toBe(true) // still editing red
    await wrapper.find('[data-test="label-edit-green"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="label-title-green"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="label-title-red"]').exists()).toBe(false)

    // Escape cancels the editor without saving
    await wrapper.find('[data-test="label-title-green"]').trigger('keydown', { key: 'Escape' })
    await settle()
    expect(wrapper.find('[data-test="label-title-green"]').exists()).toBe(false)
    expect(api.updateLabelTitle).toHaveBeenCalledTimes(1)

    // clearing a name saves null (back to the bare color chip)
    await wrapper.find('[data-test="label-edit-red"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-title-red"]').setValue('')
    await wrapper.find('[data-test="label-save-red"]').trigger('click')
    await settle()
    expect(api.updateLabelTitle).toHaveBeenLastCalledWith(1, 'red', { title: null })
    expect(wrapper.find('[data-test="label-row-red"]').find('.label-chip').text()).toBe('')

    // over the length limit shows an error in the row
    await wrapper.find('[data-test="label-edit-green"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="label-title-green"]').setValue('あ'.repeat(21))
    await wrapper.find('[data-test="label-save-green"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="label-error-green"]').exists()).toBe(true)
    expect(wrapper.text()).not.toMatch(/赤|黄|緑|青|紫|ラベル[1-5]|名前なし/)
    wrapper.unmount()
    cleanup()
    setDataApi(null)

    // viewer: the rows are not pressable (chips only, no buttons at all)
    const viewerApi = injectLabelApi()
    void viewerApi
    mockFetch({ 'GET /api/auth/me': { body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] } } })
    const viewer = await mountApp('/settings/labels')
    expect(viewer.wrapper.findAll('.label-rows .label-chip')).toHaveLength(5)
    expect(viewer.wrapper.find('[data-test="label-edit-red"]').exists()).toBe(false)
    expect(viewer.wrapper.find('[data-test="label-title-red"]').exists()).toBe(false)
    expect(viewer.wrapper.find('[data-test="label-save-red"]').exists()).toBe(false)
  })
})
