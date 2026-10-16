import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as webauthn from '@/web/api/webauthn'
import { externalNav } from '@/web/composables/navigate'
import { ASSERTION, ATTESTATION, CCR, ME, RCR, cleanup, mockFetch, mountApp, settle } from './helpers'

vi.mock('@/web/api/webauthn', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/web/api/webauthn')>()
  return {
    ...orig,
    createPasskey: vi.fn(),
    getPasskey: vi.fn(),
  }
})

beforeEach(() => {
  vi.mocked(webauthn.getPasskey).mockReset().mockResolvedValue(ASSERTION)
  vi.mocked(webauthn.createPasskey).mockReset().mockResolvedValue(ATTESTATION)
})
afterEach(cleanup)

describe('router', () => {
  it('[covers:web-router.requires-auth-redirects-login] 未ログインで認証必須画面はログインへ', async () => {
    mockFetch({ 'GET /api/auth/me': { status: 401, body: { error: 'unauthorized' } } })
    const { router } = await mountApp('/')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('[covers:web-router.public-routes-no-session] 登録画面はセッション確認なし', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': { body: { kind: 'setup', needs_display_name: true } },
    })
    const { router } = await mountApp('/register?token=T')
    expect(router.currentRoute.value.path).toBe('/register')
    expect(f.to('GET', '/api/auth/me')).toHaveLength(0)
  })
})

describe('LoginPage', () => {
  it('[covers:web-login.guidance-shown] ログインはボタンのみ（入力欄・案内文なし）', async () => {
    mockFetch({})
    const { wrapper } = await mountApp('/login')
    expect(wrapper.find('[data-test="login"]').text()).toBe('パスキーでログイン')
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('[data-test="guide"]').exists()).toBe(false)
  })

  it('[covers:web-login.next-consent-navigates] next=consent かつ req ありは同意画面へ', async () => {
    const f = mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { body: { next: 'consent' } },
      'GET /api/oauth/requests/R': { status: 404, body: { error: 'not_found' } },
    })
    const a = await mountApp('/login?req=R')
    await a.wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(a.router.currentRoute.value.fullPath).toBe('/oauth/consent?req=R')
    expect(f.to('POST', '/api/webauthn/login/finish')[0]!.body).toEqual({ credential: ASSERTION })
  })

  it('[covers:web-login.next-consent-navigates] req なしの next はホームへ', async () => {
    mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { body: { next: 'home' } },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const b = await mountApp('/login')
    await b.wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(b.router.currentRoute.value.fullPath).toBe('/')
  })

  it('[covers:web-login.failure-message] 401 は区別しない文言を出し遷移しない', async () => {
    mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { status: 401, body: { error: 'unauthorized' } },
    })
    const { wrapper, router } = await mountApp('/login')
    await wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('ログインできませんでした')
    expect(router.currentRoute.value.path).toBe('/login')
  })
})

describe('RegisterPage', () => {
  it('[covers:web-register.token-removed-from-url] token を URL から消し body で送る', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': { body: { kind: 'setup', needs_display_name: true } },
    })
    const { router } = await mountApp('/register?token=T')
    expect(router.currentRoute.value.fullPath).toBe('/register')
    expect(router.currentRoute.value.query.token).toBeUndefined()
    expect(f.to('POST', '/api/webauthn/register/info')[0]!.body).toEqual({ token: 'T' })
  })

  it('[covers:web-register.setup-requires-display-name] 表示名は必須・100文字まで', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': { body: { kind: 'setup', needs_display_name: true } },
      'POST /api/webauthn/register/start': { body: CCR },
      'POST /api/webauthn/register/finish': { body: {} },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper } = await mountApp('/register?token=T')
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('表示名')
    await wrapper.find('[data-test="display-name"]').setValue('あ'.repeat(101))
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(f.to('POST', '/api/webauthn/register/start')).toHaveLength(0)
    await wrapper.find('[data-test="display-name"]').setValue('あ'.repeat(100))
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(f.to('POST', '/api/webauthn/register/start')[0]!.body).toEqual({ token: 'T', display_name: 'あ'.repeat(100) })
  })

  it('[covers:web-register.recovery-no-display-name] recovery は表示名入力なし', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': {
        body: { kind: 'recovery', needs_display_name: false, user_display_name: '太郎' },
      },
      'POST /api/webauthn/register/start': { body: CCR },
      'POST /api/webauthn/register/finish': { body: {} },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper } = await mountApp('/register?token=T')
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="recovery-info"]').text()).toContain('太郎')
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(f.to('POST', '/api/webauthn/register/start')[0]!.body).toEqual({ token: 'T' })
  })

  it('[covers:web-register.invite-default-ledger-choice] invite は家計簿と既定化の選択を送る', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': {
        body: { kind: 'invite', needs_display_name: true, ledger_name: '家族', role: 'editor' },
      },
      'POST /api/webauthn/register/start': { body: CCR },
      'POST /api/webauthn/register/finish': { body: {} },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper } = await mountApp('/register?token=T')
    const text = wrapper.find('[data-test="invite-info"]').text()
    expect(text).toContain('家族')
    expect(text).toContain('編集')
    await wrapper.find('[data-test="use-invited-default"]').setValue(true)
    await wrapper.find('[data-test="display-name"]').setValue('花子')
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(f.to('POST', '/api/webauthn/register/finish')[0]!.body).toEqual({
      credential: ATTESTATION,
      use_invited_ledger_as_default: true,
    })
  })

  it('[covers:web-register.success-navigates-home] 登録完了でホームへ', async () => {
    mockFetch({
      'POST /api/webauthn/register/info': { body: { kind: 'setup', needs_display_name: true } },
      'POST /api/webauthn/register/start': { body: CCR },
      'POST /api/webauthn/register/finish': { body: {} },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper, router } = await mountApp('/register?token=T')
    await wrapper.find('[data-test="display-name"]').setValue('太郎')
    await wrapper.find('[data-test="label"]').setValue('iPhone')
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(webauthn.createPasskey).toHaveBeenCalledWith(CCR)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('[covers:web-register.invalid-token-message] 無効な token は案内のみ', async () => {
    mockFetch({ 'POST /api/webauthn/register/info': { status: 400, body: { error: 'invalid_token' } } })
    const { wrapper } = await mountApp('/register?token=T')
    expect(wrapper.find('[data-test="invalid"]').text()).toContain('無効か、期限切れ')
    expect(wrapper.find('[data-test="register"]').exists()).toBe(false)
  })
})

describe('ConsentPage', () => {
  const INFO = {
    client_display: 'ChatGPT',
    client_id: 'https://chatgpt.com/x',
    scopes: [
      { name: 'ledger.read', description: '家計簿の閲覧' },
      { name: 'ledger.write', description: '家計簿の記録・編集' },
    ],
    ledger_name: '家計',
    user_display_name: '太郎',
  }

  it('[covers:web-consent.shows-request] 要求内容を表示する', async () => {
    mockFetch({ 'GET /api/oauth/requests/R': { body: INFO } })
    const { wrapper } = await mountApp('/oauth/consent?req=R')
    expect(wrapper.find('[data-test="client-display"]').text()).toBe('ChatGPT')
    expect(wrapper.find('[data-test="client-id"]').text()).toBe('https://chatgpt.com/x')
    expect(wrapper.find('[data-test="scopes"]').text()).toContain('家計簿の記録・編集')
    expect(wrapper.find('[data-test="ledger-name"]').text()).toBe('家計')
    expect(wrapper.find('[data-test="ledger-note"]').text()).toContain('切り替えられます')
    expect(wrapper.find('[data-test="user-display-name"]').text()).toBe('太郎')
    expect(wrapper.find('[data-test="allow"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="deny"]').exists()).toBe(true)
  })

  it('[covers:web-consent.decision-redirects] 許可・拒否とも decision を送り redirect_to へ遷移', async () => {
    for (const decision of ['allow', 'deny'] as const) {
      const f = mockFetch({
        'GET /api/oauth/requests/R': { body: INFO },
        'POST /oauth/authorize/decision': { body: { redirect_to: `https://chatgpt.com/cb?${decision}` } },
      })
      const assign = vi.spyOn(externalNav, 'assign').mockImplementation(() => {})
      const { wrapper } = await mountApp('/oauth/consent?req=R')
      await wrapper.find(`[data-test="${decision}"]`).trigger('click')
      await settle()
      expect(f.to('POST', '/oauth/authorize/decision')[0]!.body).toEqual({ req: 'R', decision })
      expect(assign).toHaveBeenCalledWith(`https://chatgpt.com/cb?${decision}`)
      cleanup()
    }
  })

  it('[covers:web-consent.unauth-to-login] 未ログインは req を引き継いでログインへ', async () => {
    mockFetch({ 'GET /api/oauth/requests/R': { status: 401, body: { error: 'unauthorized' } } })
    const { router } = await mountApp('/oauth/consent?req=R')
    expect(router.currentRoute.value.fullPath).toBe('/login?req=R')
  })

  it('[covers:web-consent.not-found-message] 期限切れは案内のみで許可ボタンなし', async () => {
    mockFetch({ 'GET /api/oauth/requests/R': { status: 404, body: { error: 'not_found' } } })
    const { wrapper } = await mountApp('/oauth/consent?req=R')
    expect(wrapper.find('[data-test="expired"]').text()).toContain('期限切れ')
    expect(wrapper.find('[data-test="allow"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="deny"]').exists()).toBe(false)
  })
})
