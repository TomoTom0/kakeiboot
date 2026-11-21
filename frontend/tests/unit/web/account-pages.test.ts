import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as webauthn from '@/web/api/webauthn'
import { ApiError } from '@/web/api/http'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import {
  ASSERTION,
  ATTESTATION,
  CCR,
  ME,
  RCR,
  cleanup,
  mockFetch,
  mountApp,
  settle,
  stubClipboard,
  type Handler,
} from './helpers'

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
  return mockFetch({
    'GET /api/auth/me': { body: ME },
    'GET /api/passkeys': { body: PASSKEYS },
    'GET /api/share-tickets': { body: [] },
    ...extra,
  })
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
    // TASK-13: the default ledger row carries the 既定 badge (row 1 in ME)
    const rows = ledgers.findAll('.ledger-color-row')
    expect(rows[0]!.find('[data-test="default-badge"]').exists()).toBe(true)
    expect(rows[0]!.find('[data-test="default-badge"]').text()).toBe('既定')
    expect(rows[1]!.find('[data-test="default-badge"]').exists()).toBe(false)
  })

  it('[covers:web-settings.ledger-rename] editor以上の行は⋯の行内editorで改名（Enter保存・Escapeやめる・maxlength=100）し Me.ledgers を更新、400は行内alert・viewer行は⋯なし（TASK-20）', async () => {
    // the injected DataApi answers renameLedger with the request echo (the
    // unit layer verifies the panel flow, not the HTTP contract)
    const api = createMockDataApi()
    const renameLedger = vi.fn(async (l: number, input: { name: string }) => ({ id: l, name: input.name }))
    Object.assign(api, { renameLedger })
    setDataApi(api)
    const me = {
      ...ME,
      ledgers: [...ME.ledgers, { id: 3, name: '見るだけ', role: 'viewer' as const, color: 'pink' as const }],
    }
    mockFetch({ 'GET /api/auth/me': { body: me }, 'GET /api/passkeys': { body: PASSKEYS } })
    const { wrapper, router } = await mountApp('/settings/general')
    const rows = () => wrapper.findAll('[data-test="ledgers"] .ledger-color-row')
    // rows follow me.ledgers order: 1 家計(owner) / 2 実家(editor) / 3 見るだけ(viewer)

    // owner and editor rows carry the trailing "..." — TASK-13 puts the
    // default-ledger switch in the same menu, so the non-default viewer row
    // keeps a menu too (既定の家計簿にする only, no rename)
    expect(wrapper.find('[data-test="ledgers"] [data-test="row-menu-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ledgers"] [data-test="row-menu-2"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ledgers"] [data-test="row-menu-3"]').exists()).toBe(true)

    // editor row: "..." -> 名前を変更 turns the row into the inline editor,
    // seeded with the current name and capped at 100 chars
    await wrapper.find('[data-test="row-menu-2"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-rename"]').trigger('click')
    await settle()
    const input = wrapper.find('[data-test="edit-name"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('実家')
    expect(input.attributes('maxlength')).toBe('100')

    // Escape gives up the edit without a call
    await input.setValue('実家の家計')
    await input.trigger('keydown', { key: 'Escape' })
    await settle()
    expect(wrapper.find('[data-test="edit-name"]').exists()).toBe(false)
    expect(rows()[1]!.text()).toContain('実家')
    expect(renameLedger).not.toHaveBeenCalled()

    // 保存 calls PATCH via renameLedger, rewrites the row and reports the
    // save in the row's role="status"
    await wrapper.find('[data-test="row-menu-2"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-rename"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="edit-name"]').setValue('実家の家計')
    await wrapper.find('[data-test="edit-save"]').trigger('click')
    await settle()
    expect(renameLedger).toHaveBeenCalledWith(2, { name: '実家の家計' })
    expect(wrapper.find('[data-test="edit-name"]').exists()).toBe(false)
    expect(rows()[1]!.text()).toContain('実家の家計')
    expect(rows()[1]!.find('[role="status"]').text()).toContain('保存しました')

    // a 400 lands as the row-local alert with the shared copy (the backend
    // does not separate empty / too long / duplicate); the editor stays up
    // and the row keeps the old name until a save succeeds
    renameLedger.mockRejectedValueOnce(new ApiError(400, 'invalid_request'))
    await wrapper.find('[data-test="row-menu-1"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-rename"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="edit-name"]').setValue('我が家')
    await wrapper.find('[data-test="edit-name"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(rows()[0]!.find('[role="alert"]').text()).toContain(
      '名前が空・100字を超える・または同じ名前の家計簿が既にあります',
    )
    expect(rows()[0]!.text()).toContain('家計')

    // the retried save goes through and the store update reaches the
    // ledger switcher rows on a ledgerScoped screen (/settings/general is
    // not one; TASK-101 moved the switcher into the account menu)
    await wrapper.find('[data-test="edit-save"]').trigger('click')
    await settle()
    expect(renameLedger).toHaveBeenLastCalledWith(1, { name: '我が家' })
    expect(rows()[0]!.text()).toContain('我が家')
    await router.push('/settings/labels')
    await settle()
    expect(wrapper.find('[data-test="ledger-switch"]').exists()).toBe(false)
    await wrapper.find('[data-test="account-button"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="ledger-option-1"]').text()).toContain('我が家')
    expect(wrapper.find('[data-test="ledger-option-2"]').text()).toContain('実家の家計')
    setDataApi(null)
  })

  it('[covers:web-settings.default-ledger] ⋯「既定の家計簿にする」で PUT /api/auth/me/default-ledger・badge 移動・失敗は行内 alert（TASK-13）', async () => {
    const me = {
      ...ME,
      ledgers: [...ME.ledgers, { id: 3, name: '見るだけ', role: 'viewer' as const, color: 'pink' as const }],
    }
    const f = mockFetch({
      'GET /api/auth/me': { body: me },
      'GET /api/passkeys': { body: PASSKEYS },
      'GET /api/share-tickets': { body: [] },
      'PUT /api/auth/me/default-ledger': [
        { body: { ledger: { id: 2, name: '実家', role: 'editor' } } },
        { status: 404, body: { error: 'not_found' } },
      ],
    })
    const { wrapper } = await mountApp('/settings/general')
    const rows = () => wrapper.findAll('[data-test="ledgers"] .ledger-color-row')

    // the default row (1) offers no 既定にする item (it already is the default)
    await wrapper.find('[data-test="row-menu-1"]').trigger('click')
    await settle()
    expect(wrapper.find('[role="menu"] [data-test="menu-default"]').exists()).toBe(false)
    expect(wrapper.find('[role="menu"] [data-test="menu-rename"]').exists()).toBe(true)
    await wrapper.find('[data-test="row-menu-1"]').trigger('click')
    await settle()

    // the non-default editor row switches the default: PUT {ledger_id},
    // me.default_ledger_id updates and the badge moves with a row status
    await wrapper.find('[data-test="row-menu-2"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-default"]').trigger('click')
    await settle()
    expect(f.to('PUT', '/api/auth/me/default-ledger')[0]!.body).toEqual({ ledger_id: 2 })
    expect(rows()[0]!.find('[data-test="default-badge"]').exists()).toBe(false)
    expect(rows()[1]!.find('[data-test="default-badge"]').text()).toBe('既定')
    expect(rows()[1]!.find('[role="status"]').text()).toContain('既定の家計簿にしました')

    // a rejected switch stays on the row as an alert and keeps the default
    await wrapper.find('[data-test="row-menu-3"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-default"]').trigger('click')
    await settle()
    expect(f.to('PUT', '/api/auth/me/default-ledger')).toHaveLength(2)
    expect(rows()[2]!.find('[role="alert"]').text()).toContain('対象が見つかりません')
    expect(rows()[1]!.find('[data-test="default-badge"]').exists()).toBe(true)
    await wrapper.unmount()
    cleanup()

    // a viewer row that IS the default has nothing to menu (display only)
    mockFetch({
      'GET /api/auth/me': { body: { ...me, default_ledger_id: 3 } },
      'GET /api/passkeys': { body: PASSKEYS },
      'GET /api/share-tickets': { body: [] },
    })
    const b = await mountApp('/settings/general')
    expect(b.wrapper.find('[data-test="row-menu-3"]').exists()).toBe(false)
    expect(b.wrapper.find('[data-test="row-menu-1"]').exists()).toBe(true)
  })

  it('[covers:web-settings.shows-passkeys] 認証tabにパスキー一覧（同期済み/端末内）と追加button（dialog 制・TASK-46）', async () => {
    home()
    const { wrapper } = await mountApp('/settings/auth')
    expect(wrapper.find('[data-test="passkeys"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('iPhone')
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('同期済み')
    expect(wrapper.find('[data-test="passkey-2"]').text()).toContain('端末内')
    expect(wrapper.find('[data-test="add-passkey"]').exists()).toBe(true)
    // TASK-46: the add form lives in a dialog — no standing inputs
    expect(wrapper.find('[data-test="new-label"]').exists()).toBe(false)
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

  it('[covers:web-settings.add-passkey] dialog で名前を入れ start → create → finish（label 付き）→ 一覧再取得（TASK-46）', async () => {
    const f = home({
      'POST /api/passkeys/start': { body: CCR },
      'POST /api/passkeys/finish': { body: {} },
    })
    const { wrapper } = await mountApp('/settings/auth')
    // the button opens the add dialog (no standing label input anymore)
    await wrapper.find('[data-test="add-passkey"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="add-passkey-dialog"]').exists()).toBe(true)

    // 101 characters is stopped inside the dialog (no start call)
    await wrapper.find('[data-test="add-passkey-dialog"] [data-test="new-label"]').setValue('x'.repeat(101))
    await wrapper.find('[data-test="add-passkey-dialog"] [data-test="add-passkey-submit"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/passkeys/start')).toHaveLength(0)
    expect(wrapper.find('[data-test="add-passkey-dialog"] [role="alert"]').text()).toContain('100文字以内')

    // a valid name runs the ceremony: start → create → finish with the label
    await wrapper.find('[data-test="add-passkey-dialog"] [data-test="new-label"]').setValue('iPhone')
    await wrapper.find('[data-test="add-passkey-dialog"] [data-test="add-passkey-submit"]').trigger('click')
    await settle()
    expect(webauthn.createPasskey).toHaveBeenCalledWith(CCR)
    expect(f.to('POST', '/api/passkeys/finish')[0]!.body).toEqual({ credential: ATTESTATION, label: 'iPhone' })
    expect(f.to('GET', '/api/passkeys')).toHaveLength(2)
    expect(wrapper.find('[data-test="add-passkey-dialog"]').exists()).toBe(false)
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

  it('[covers:web-settings.passkey-icon-actions] パスキー行操作・追加・editor確定は icon-only（aria-label+title）、削除確認の文字は不変', async () => {
    home({ 'PATCH /api/passkeys/1': { body: {} } })
    const { wrapper } = await mountApp('/settings/auth')
    // the row actions are icon-only 44px buttons carrying the row's own name
    const rename = wrapper.find('[data-test="passkey-1"] [data-test="rename"]')
    expect(rename.text()).toBe('')
    expect(rename.attributes('aria-label')).toBe('iPhoneの名前を変更')
    expect(rename.attributes('title')).toBe('iPhoneの名前を変更')
    expect(rename.find('svg').exists()).toBe(true)
    const del = wrapper.find('[data-test="passkey-1"] [data-test="delete"]')
    expect(del.text()).toBe('')
    expect(del.attributes('aria-label')).toBe('iPhoneを削除')
    expect(del.classes()).toContain('danger')
    expect(del.find('svg').html()).toContain('M3 6h18') // the "trash" glyph
    // the add form's button is icon-only too (key-plus: key circle + plus)
    const add = wrapper.find('[data-test="add-passkey"]')
    expect(add.text()).toBe('')
    expect(add.attributes('aria-label')).toBe('パスキーを追加')
    expect(add.find('svg').html()).toContain('M12 5v14') // the key-plus' plus

    // the rename editor's confirm pair is icon-only with plain labels
    await wrapper.find('[data-test="passkey-1"] [data-test="rename"]').trigger('click')
    await settle()
    const save = wrapper.find('[data-test="rename-save"]')
    expect(save.text()).toBe('')
    expect(save.attributes('aria-label')).toBe('保存')
    expect(save.classes()).toContain('primary')
    const cancel = wrapper.find('[data-test="passkey-1"] .actions button:not([data-test])')
    expect(cancel.attributes('aria-label')).toBe('やめる')
    expect(cancel.text()).toBe('')
    // the save still runs through PATCH (the icon swap changes no behavior;
    // this editor confirms with its buttons, no Enter binding here)
    await wrapper.find('[data-test="rename-input"]').setValue('Mac')
    await wrapper.find('[data-test="rename-save"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="rename-input"]').exists()).toBe(false)

    // the destructive confirm keeps its words: icon-only is the row actions
    // and the editor pair alone
    await wrapper.find('[data-test="passkey-1"] [data-test="delete"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="passkey-1"]').text()).toContain('削除しますか？')
    expect(wrapper.find('[data-test="delete-confirm"]').text()).toBe('削除する')
    const cancelDelete = wrapper.findAll('[data-test="passkey-1"] button').find((b) => b.text() === 'やめる')
    expect(cancelDelete).toBeTruthy()
  })

  it('[covers:web-settings.issue-url-icons] 共有URL・登録URLの発行 button は icon-only（aria-label+title・動作不変）', async () => {
    const f = home({
      'POST /api/share-tickets': { status: 201, body: { url: 'https://h/share?token=X', expires_at: 0 } },
      'POST /api/register-invitations': { status: 201, body: { url: 'https://h/register?token=R', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings/auth')
    const issue = wrapper.find('[data-test="invite-issue"]')
    expect(issue.text()).toBe('')
    expect(issue.attributes('aria-label')).toBe('共有 URL を発行')
    expect(issue.attributes('title')).toBe('共有 URL を発行')
    expect(issue.classes()).toContain('primary')
    expect(issue.find('svg').exists()).toBe(true)
    const register = wrapper.find('[data-test="register-invite-issue"]')
    expect(register.text()).toBe('')
    expect(register.attributes('aria-label')).toBe('登録 URL を発行')
    expect(register.attributes('title')).toBe('登録 URL を発行')
    // the actions still run through the same API paths — the forms now live
    // inside the dialogs (TASK-46), so open each dialog first
    await issue.trigger('click')
    await settle()
    await wrapper.find('[data-test="invite-note"]').setValue('妹')
    await wrapper.find('[data-test="invite-submit"]').trigger('click')
    await register.trigger('click')
    await settle()
    await wrapper.find('[data-test="register-invite-note"]').setValue('妹')
    await wrapper.find('[data-test="register-invite-submit"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/share-tickets')).toHaveLength(1)
    expect(f.to('POST', '/api/register-invitations')).toHaveLength(1)
  })

  it('[covers:web-manage.editor-icon-actions] 家計簿名・ラベル名の行内editor確定は icon-only（aria-label+title・Enter/Escape 不変）', async () => {
    const api = createMockDataApi()
    const renameLedger = vi.fn(async (l: number, input: { name: string }) => ({ id: l, name: input.name }))
    Object.assign(api, { renameLedger })
    setDataApi(api)
    mockFetch({
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
      'GET /api/share-tickets': { body: [] },
    })
    const { wrapper } = await mountApp('/settings/general')
    // open the ledger rename editor through the row menu
    await wrapper.find('[data-test="row-menu-1"]').trigger('click')
    await settle()
    await wrapper.find('[role="menu"] [data-test="menu-rename"]').trigger('click')
    await settle()
    const save = wrapper.find('[data-test="edit-save"]')
    expect(save.text()).toBe('')
    expect(save.attributes('aria-label')).toBe('保存')
    expect(save.attributes('title')).toBe('保存')
    expect(save.classes()).toContain('primary')
    expect(save.find('svg').exists()).toBe(true)
    const cancel = wrapper.find('[data-test="ledgers"] .ledger-row-editor button:not([data-test])')
    expect(cancel.text()).toBe('')
    expect(cancel.attributes('aria-label')).toBe('やめる')
    // Enter saves, Escape gives up — the keyboard paths are unchanged
    await wrapper.find('[data-test="edit-name"]').setValue('我が家')
    await wrapper.find('[data-test="edit-name"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(renameLedger).toHaveBeenCalledWith(1, { name: '我が家' })
    setDataApi(null)
    cleanup()

    // the label rows on /settings/labels use the same icon pair
    const api2 = createMockDataApi()
    setDataApi(api2)
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/passkeys': { body: [] } })
    const labels = await mountApp('/settings/labels')
    await labels.wrapper.find('[data-test="label-edit-yellow"]').trigger('click')
    await settle()
    const labelSave = labels.wrapper.find('[data-test="label-save-yellow"]')
    expect(labelSave.text()).toBe('')
    expect(labelSave.attributes('aria-label')).toBe('保存')
    const labelCancel = labels.wrapper.find('[data-test="label-cancel-yellow"]')
    expect(labelCancel.text()).toBe('')
    expect(labelCancel.attributes('aria-label')).toBe('やめる')
    setDataApi(null)
  })

  it('[covers:web-settings.invite-issue] 共有 dialog から発行（メモ既定は発行日時）・owner の家計簿が無ければ説明文（TASK-46/78）', async () => {
    const f = home({
      'POST /api/share-tickets': {
        status: 201,
        body: { url: 'https://h/share?token=X', expires_at: Date.UTC(2026, 9, 16, 15, 0) },
      },
    })
    const { wrapper } = await mountApp('/settings/auth')
    // the sharing card keeps the sharing words; "invitation" belongs to the
    // registration-only card. The dialog is closed: no fields in the DOM.
    const panel = wrapper.find('[data-test="invite-panel"]')
    expect(panel.text()).toContain('家計簿を共有')
    expect(panel.text()).not.toContain('招待')
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)

    await wrapper.find('[data-test="invite-issue"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(true)
    // the memo is prefilled with the issuance datetime (JST YYYY/MM/DD HH:MM)
    expect(
      (wrapper.find('[data-test="invite-dialog"] [data-test="invite-note"]').element as HTMLInputElement).value,
    ).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)

    await wrapper.find('[data-test="invite-dialog"] [data-test="invite-role"]').setValue('viewer')
    await wrapper.find('[data-test="invite-dialog"] [data-test="invite-note"]').setValue('妹')
    await wrapper.find('[data-test="invite-dialog"] [data-test="invite-submit"]').trigger('click')
    await settle()
    // TASK-78: the chosen ledger_id always rides along (ME: ledger 1, the
    // owner membership that is also the default)
    expect(f.to('POST', '/api/share-tickets')[0]!.body).toEqual({ role: 'viewer', ledger_id: 1, inviter_note: '妹' })
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)
    // the issued row shows the URL and the JST expiry (passkey-row style)
    const row = wrapper.find('[data-test="invite-issued"] [data-test="invite-issued-row"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('妹')
    expect(row.find('[data-test="invite-issued-url"]').text()).toBe('https://h/share?token=X')
    expect(row.text()).toContain('2026/10/17 00:00')
    cleanup()

    // a me with no owned ledger at all: no form, and the forbidden note in
    // its place (same card on the auth tab)
    mockFetch({
      'GET /api/auth/me': {
        body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'editor' as const }, { ...ME.ledgers[1]! }] },
      },
      'GET /api/passkeys': { body: PASSKEYS },
      'GET /api/share-tickets': { body: [] },
    })
    const b = await mountApp('/settings/auth')
    expect(b.wrapper.find('[data-test="invite"]').exists()).toBe(false)
    expect(b.wrapper.find('[data-test="invite-forbidden"]').exists()).toBe(true)
  })

  it('[covers:web-settings.share-tickets-list] open チケット一覧（平文 URL は再表示されない）と失効', async () => {
    const ticket = {
      ticket_ref: 'abcd1234',
      ledger_id: 1,
      ledger_name: '家計',
      role: 'viewer' as const,
      created_at: Date.UTC(2026, 9, 16, 15, 0),
      expires_at: Date.UTC(2026, 9, 23, 15, 0),
      inviter_note: '妹',
    }
    const f = home({
      'GET /api/share-tickets': { body: [ticket] },
      'DELETE /api/share-tickets/abcd1234': { status: 204 },
    })
    const { wrapper } = await mountApp('/settings/auth')
    const list = wrapper.find('[data-test="share-tickets"]')
    expect(list.exists()).toBe(true)
    expect(list.text()).toContain('再表示できません')
    const row = list.find('[data-test="share-ticket-row"]')
    expect(row.text()).toContain('妹')
    expect(row.text()).toContain('家計')
    expect(row.text()).toContain('閲覧のみ')
    expect(row.text()).toContain('2026/10/17 00:00')
    expect(row.text()).toContain('2026/10/24 00:00')
    expect(row.text()).not.toContain('token=')

    // revoke follows the passkey-row delete pattern: icon button, then an
    // inline confirm; the row leaves the list only after the DELETE lands
    const revoke = row.find('[data-test="share-ticket-revoke"]')
    expect(revoke.text()).toBe('')
    expect(revoke.attributes('aria-label')).toContain('失効')
    await revoke.trigger('click')
    await settle()
    expect(row.text()).toContain('失効しますか？')
    expect(f.to('DELETE', '/api/share-tickets/abcd1234')).toHaveLength(0)
    await row.find('[data-test="share-ticket-revoke-confirm"]').trigger('click')
    await settle()
    expect(f.to('DELETE', '/api/share-tickets/abcd1234')).toHaveLength(1)
    expect(wrapper.find('[data-test="share-ticket-row"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="share-tickets"]').exists()).toBe(false)
  })

  it('[covers:web-settings.register-invite-no-share] 登録の招待カードは家計簿を共有しない旨を示す', async () => {
    home()
    const { wrapper } = await mountApp('/settings/auth')
    expect(wrapper.find('[data-test="register-invite"]').text()).toContain('家計簿は共有されません')
  })

  it('[covers:web-settings.invite-select-ledger] 選択肢は owner の家計簿のみ・初期選択は既定（owner のとき）・既定が owner でなければ先頭（TASK-78）', async () => {
    const me = {
      ...ME,
      ledgers: [
        ME.ledgers[0]!,
        { ...ME.ledgers[1]!, role: 'owner' as const },
        { id: 3, name: '見るだけ', role: 'viewer' as const, color: 'pink' as const },
      ],
      default_ledger_id: 2,
    }
    const f = mockFetch({
      'GET /api/auth/me': { body: me },
      'GET /api/passkeys': { body: PASSKEYS },
      'POST /api/share-tickets': { status: 201, body: { url: 'https://h/register?token=Y', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings/auth')
    await wrapper.find('[data-test="invite-issue"]').trigger('click')
    await settle()
    const select = wrapper.find('[data-test="invite-dialog"] [data-test="invite-ledger"]')
    // only the owned ledgers are choices (the viewer membership is not)
    const options = select.findAll('option')
    expect(options).toHaveLength(2)
    expect(options.map((o) => o.text())).toEqual(['家計', '実家'])
    // the default ledger is owned: preselected
    expect((select.element as HTMLSelectElement).value).toBe('2')
    await select.setValue(1)
    await wrapper.find('[data-test="invite-dialog"] [data-test="invite-submit"]').trigger('click')
    await settle()
    expect((f.to('POST', '/api/share-tickets')[0]!.body as { ledger_id: number }).ledger_id).toBe(1)
    await wrapper.unmount()
    cleanup()

    // the default points at a non-owned (viewer) ledger: the first owned
    // ledger is the initial selection instead
    mockFetch({
      'GET /api/auth/me': { body: { ...me, default_ledger_id: 3 } },
      'GET /api/passkeys': { body: PASSKEYS },
      'GET /api/share-tickets': { body: [] },
    })
    const b = await mountApp('/settings/auth')
    await b.wrapper.find('[data-test="invite-issue"]').trigger('click')
    await settle()
    const select2 = b.wrapper.find('[data-test="invite-dialog"] [data-test="invite-ledger"]')
    expect((select2.element as HTMLSelectElement).value).toBe('1')
  })

  it('[covers:web-settings.invite-issued-row] 発行済み行のコピー（icon-only button・成功は icon 切替+sr-only status / 失敗 alert・TASK-46/47/48）', async () => {
    const writeText = stubClipboard()
    mockFetch({
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: PASSKEYS },
      'GET /api/share-tickets': { body: [] },
      'POST /api/register-invitations': { status: 201, body: { url: 'https://h/register?token=R', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings/auth')
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-submit"]').trigger('click')
    await settle()
    const row = wrapper.find('[data-test="register-invite-issued"] [data-test="register-invite-issued-row"]')
    expect(row.exists()).toBe(true)

    // TASK-47: the row copy is an icon-only button (no visible text, found
    // by aria-label); the resting glyph is the copy icon
    const btn = row.find('[data-test="copy"]')
    expect(btn.text()).toBe('')
    expect(btn.attributes('aria-label')).toBe('URL をコピー')
    expect(btn.find('svg').html()).toContain('M4 16c-1.1 0-2-.9-2-2') // the "copy" back sheet
    await btn.trigger('click')
    await settle()
    expect(writeText).toHaveBeenCalledWith('https://h/register?token=R')
    // TASK-48: the success is the icon swap to a check + the sr-only status
    // line; no visible text row joins the issued row
    expect(btn.find('svg').html()).toContain('M20 6 9 17l-5-5') // the "check" glyph
    expect(btn.classes()).toContain('is-done')
    expect(btn.attributes('aria-label')).toBe('コピーしました')
    const done = row.find('[data-test="copy-done"]')
    expect(done.exists()).toBe(true)
    expect(done.text()).toContain('コピーしました')
    expect(done.attributes('role')).toBe('status')
    expect(done.classes()).toContain('sr-only')

    // a failing clipboard leaves the URL selectable with an in-row alert
    stubClipboard(new Error('denied'))
    await btn.trigger('click')
    await settle()
    expect(row.find('[role="alert"]').text()).toContain('コピーできませんでした')
    expect(row.find('[data-test="copy-done"]').exists()).toBe(false)
    expect(row.find('[data-test="register-invite-issued-url"]').text()).toBe('https://h/register?token=R')
  })

  it('[covers:web-settings.form-dialog] Escape・外側押下・submit 成功・やめるで閉じ、開いた時は先頭 field・閉じたらトリガへ focus（TASK-46）', async () => {
    home({
      'POST /api/share-tickets': { status: 201, body: { url: 'https://h/share?token=X', expires_at: 0 } },
    })
    const { wrapper } = await mountApp('/settings/auth', { attach: true })
    const trigger = wrapper.find('[data-test="invite-issue"]')
    await trigger.trigger('click')
    await settle()
    const dlg = wrapper.find('[data-test="invite-dialog"]')
    expect(dlg.attributes('role')).toBe('dialog')
    expect(dlg.attributes('aria-modal')).toBe('true')
    // the focus lands on the first field ([data-autofocus])
    const note = dlg.find('[data-test="invite-note"]')
    expect(document.activeElement).toBe(note.element)

    // Escape closes the dialog and gives the focus back to the trigger
    await dlg.trigger('keydown', { key: 'Escape' })
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    // a press on the backdrop closes as well (a press inside does not)
    await trigger.trigger('click')
    await settle()
    await wrapper.find('.dialog-backdrop').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)
    await trigger.trigger('click')
    await settle()
    await wrapper.find('[data-test="invite-dialog"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(true)

    // a successful submit closes through the panel's own model write and
    // the focus returns to the trigger as well
    await wrapper.find('[data-test="invite-dialog"] [data-test="invite-submit"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)

    // the やめる button closes the same way and gives the focus back too
    await trigger.trigger('click')
    await settle()
    const cancel = wrapper
      .findAll('[data-test="invite-dialog"] button')
      .find((b) => b.text() === 'やめる')
    await cancel!.trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invite-dialog"]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
  })

  it('[covers:web-settings.register-invite-card] 全userにカード・dialog 制・メモ空は発行日時を送る・201字は止める（TASK-46）', async () => {
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
    // the dialog is closed: no standing memo input
    expect(wrapper.find('[data-test="register-invite-dialog"]').exists()).toBe(false)

    // open: the memo is prefilled with the issuance datetime
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="register-invite-dialog"]').exists()).toBe(true)
    expect(
      (wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-note"]').element as HTMLInputElement).value,
    ).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)

    // clearing the memo does not block the issue: the issuance datetime is
    // sent as the note (the backend requires a non-empty one)
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-note"]').setValue('')
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-submit"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')).toHaveLength(1)
    expect((f.to('POST', '/api/register-invitations')[0]!.body as { inviter_note: string }).inviter_note).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/,
    )
    // the dialog closed and the issued row carries the URL and the expiry
    expect(wrapper.find('[data-test="register-invite-dialog"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="register-invite-issued-url"]').text()).toBe('https://h/register?token=R')
    expect(wrapper.find('[data-test="register-invite-issued"]').text()).toContain('2026/10/17 00:00')

    // 201 characters (charCount, not bytes) is stopped before the API
    await wrapper.find('[data-test="register-invite-issue"]').trigger('click')
    await settle()
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-note"]').setValue('あ'.repeat(201))
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-submit"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')).toHaveLength(1)
    expect(wrapper.find('[data-test="register-invite-dialog"] [role="alert"]').text()).toContain(
      'メモは200文字以内で入力してください。',
    )

    // a typed note is sent as-is
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-note"]').setValue('妹')
    await wrapper.find('[data-test="register-invite-dialog"] [data-test="register-invite-submit"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/register-invitations')[1]!.body).toEqual({ inviter_note: '妹' })
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
      active_ledger_color: 'teal' as const,
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
      active_ledger_color: null,
      created_at: Date.UTC(2026, 9, 2, 0, 0),
      last_used_at: null,
    },
  ]
  const apps = (extra: Record<string, Handler | Handler[]> = {}) =>
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/oauth/grants': { body: GRANTS }, ...extra })

  it('[covers:web-apps.list-grants] client・scope・選択中 ledger（未選択・色 chip・option の色点）・JST 日時', async () => {
    apps()
    const { wrapper } = await mountApp('/apps')
    const g1 = wrapper.find('[data-test="grant-1"]').text()
    expect(g1).toContain('ChatGPT')
    expect(g1).toContain('家計簿の記録・編集')
    expect(wrapper.find('[data-test="grant-1"] [data-test="active-ledger"]').text()).toBe('家計')
    expect(wrapper.find('[data-test="grant-2"] [data-test="active-ledger"]').text()).toBe('未選択')
    expect(g1).toContain('2026/10/01 09:00')
    // TASK-20 §7-4: the selected-ledger dd carries the grant's own color chip
    // (active_ledger_color); an unselected grant shows none
    const chip = wrapper.find('[data-test="grant-1"] [data-test="active-ledger"] .ledger-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('style')).toContain('var(--ledger-teal)')
    expect(wrapper.find('[data-test="grant-2"] [data-test="active-ledger"] .ledger-chip').exists()).toBe(false)
    // the switch select's options open with the membership color dot — DOM
    // presence only in jsdom: native option popups do not paint it reliably
    // (the closed select's dropdown is not DOM-painted even in chromium, so
    // the real-paint check stays with the dd chip, §10-3)
    const options = wrapper.find('[data-test="grant-1"] [data-test="switch-select"]').findAll('option')
    expect(options).toHaveLength(3) // 家計簿を選択 placeholder + ME's 2 ledgers
    expect(options[0]!.find('.option-dot').exists()).toBe(false)
    expect(options[1]!.find('.option-dot').attributes('style')).toContain('var(--ledger-teal)')
    expect(options[2]!.find('.option-dot').attributes('style')).toContain('var(--ledger-orange)')
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
