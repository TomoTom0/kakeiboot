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
  sessionStorage.clear()
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

  // TASK-149 D3 (web-common.fixed-guidance-names-both-services): the
  // connection lead names both services — a data name, not a neutral word
  it('[covers:web-common.fixed-guidance-names-both-services] req ありの接続案内は ChatGPT と Claude を併記', async () => {
    mockFetch({})
    const { wrapper } = await mountApp('/login?req=R')
    const lead = wrapper.find('.auth-lead')
    expect(lead.text()).toContain('ChatGPT')
    expect(lead.text()).toContain('Claude')
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
    // the navigation target is the path: the keys-less entry to / carries
    // the store's period on the query (the TASK-124 URL sync's write-back)
    expect(b.router.currentRoute.value.path).toBe('/')
  })

  it('[covers:web-login.share-return] kb_share_token があればログイン後に /share へ戻り、参加はまだしない', async () => {
    sessionStorage.setItem('kb_share_token', 'T')
    const f = mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { body: { next: 'home' } },
      'GET /api/auth/me': { body: ME },
      'POST /api/share/info': {
        body: {
          ledger_name: '家族',
          role: 'editor',
          issuer_display_name: '太郎',
          expires_at: Date.UTC(2026, 9, 23, 15, 0),
          session: { display_name: '太郎' },
          already_member: false,
        },
      },
    })
    const { wrapper, router } = await mountApp('/login')
    await wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/share')
    // back on the accept screen with its own explicit join button; the
    // login alone never calls accept
    expect(wrapper.find('[data-test="accept"]').exists()).toBe(true)
    expect(f.to('POST', '/api/share/accept')).toHaveLength(0)
    expect(f.to('POST', '/api/share/info')[0]!.body).toEqual({ token: 'T' })
  })

  it('[covers:web-login.share-return-req-wins] req 往復がある場合は kb_share_token より consent が優先', async () => {
    sessionStorage.setItem('kb_share_token', 'T')
    mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { body: { next: 'consent' } },
      'GET /api/oauth/requests/R': { status: 404, body: { error: 'not_found' } },
    })
    const { wrapper, router } = await mountApp('/login?req=R')
    await wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/oauth/consent?req=R')
  })

  it('[covers:web-shell.atomic-mount] login 完了は me 確定後に遷移し shell が即時（me 取得は1回）', async () => {
    const f = mockFetch({
      'POST /api/webauthn/login/start': { body: RCR },
      'POST /api/webauthn/login/finish': { body: { next: 'home' } },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper, router } = await mountApp('/login')
    await wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/')
    // the session settled before the navigation: the shell is up with the
    // route and the router guard did not fetch /me again (exactly one call)
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(true)
    expect(f.to('GET', '/api/auth/me')).toHaveLength(1)
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

  it('[covers:web-register.invite-no-default-choice] invite は家計簿を示すが既定化の選択肢は無く finish にも送らない', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': {
        body: { kind: 'invite', needs_display_name: true, ledger_name: '家族', role: 'editor', share_migrated: true },
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
    // no default-ledger checkbox anywhere in the registration flow (D-D1)
    expect(wrapper.find('[data-test="use-invited-default"]').exists()).toBe(false)
    // share_migrated: an already-registered visitor is pointed at a fresh
    // share URL instead of this form (design section 9-2)
    expect(wrapper.find('[data-test="share-migrated"]').text()).toContain('新しい共有 URL を依頼してください')
    await wrapper.find('[data-test="display-name"]').setValue('花子')
    await wrapper.find('form').trigger('submit')
    await settle()
    expect(f.to('POST', '/api/webauthn/register/finish')[0]!.body).toEqual({ credential: ATTESTATION })
  })

  it('[covers:web-register.invite-no-migrated-note] share_migrated でない invite には移行導線を出さない', async () => {
    mockFetch({
      'POST /api/webauthn/register/info': {
        body: { kind: 'invite', needs_display_name: true, ledger_name: '家族', role: 'viewer' },
      },
    })
    const { wrapper } = await mountApp('/register?token=T')
    expect(wrapper.find('[data-test="invite-info"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="share-migrated"]').exists()).toBe(false)
  })

  it('[covers:web-register.register-landing] register は setup と同じ画面で招待元家計簿の選択なし', async () => {
    const f = mockFetch({
      'POST /api/webauthn/register/info': { body: { kind: 'register', needs_display_name: true } },
      'POST /api/webauthn/register/start': { body: CCR },
      'POST /api/webauthn/register/finish': { body: {} },
      'GET /api/auth/me': { body: ME },
      'GET /api/passkeys': { body: [] },
    })
    const { wrapper } = await mountApp('/register?token=T')
    // the setup explanation and the display-name input; no ledger choice
    expect(wrapper.text()).toContain('新しいアカウントと、あなた専用の家計簿を作成します。')
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="use-invited-default"]').exists()).toBe(false)
    await wrapper.find('[data-test="display-name"]').setValue('花子')
    await wrapper.find('form').trigger('submit')
    await settle()
    // the finish body carries no use_invited_ledger_as_default
    expect(f.to('POST', '/api/webauthn/register/finish')[0]!.body).toEqual({ credential: ATTESTATION })
  })

  it('[covers:web-register.success-navigates-home] 登録完了でホームへ', async () => {
    const f = mockFetch({
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
    // me settled before the navigation (TASK-39): shell up, one /me call
    expect(wrapper.find('[data-test="sidebar"]').exists()).toBe(true)
    expect(f.to('GET', '/api/auth/me')).toHaveLength(1)
  })

  it('[covers:web-register.invalid-token-message] 無効な token は案内のみ', async () => {
    mockFetch({ 'POST /api/webauthn/register/info': { status: 400, body: { error: 'invalid_token' } } })
    const { wrapper } = await mountApp('/register?token=T')
    expect(wrapper.find('[data-test="invalid"]').text()).toContain('無効か、期限切れ')
    expect(wrapper.find('[data-test="register"]').exists()).toBe(false)
  })
})

describe('ShareAcceptPage', () => {
  const SHARE_INFO = {
    ledger_name: '家族',
    role: 'editor',
    issuer_display_name: '太郎',
    expires_at: Date.UTC(2026, 9, 23, 15, 0),
    session: { display_name: '花子' },
    already_member: false,
  }

  it('[covers:web-share.token-stashed-and-removed] token を sessionStorage へ退避し URL から消す・info は body で送る', async () => {
    const f = mockFetch({ 'POST /api/share/info': { body: SHARE_INFO } })
    const { router } = await mountApp('/share?token=T')
    expect(router.currentRoute.value.fullPath).toBe('/share')
    expect(router.currentRoute.value.query.token).toBeUndefined()
    expect(sessionStorage.getItem('kb_share_token')).toBe('T')
    expect(f.to('POST', '/api/share/info')[0]!.body).toEqual({ token: 'T' })
  })

  it('[covers:web-share.token-restored] query が無ければ sessionStorage の token で再開する', async () => {
    sessionStorage.setItem('kb_share_token', 'T2')
    const f = mockFetch({ 'POST /api/share/info': { body: SHARE_INFO } })
    const { wrapper } = await mountApp('/share')
    expect(f.to('POST', '/api/share/info')[0]!.body).toEqual({ token: 'T2' })
    expect(wrapper.find('[data-test="share-info"]').exists()).toBe(true)
  })

  it('[covers:web-share.no-token] token が無ければ元の URL への開き直しを案内し info を呼ばない', async () => {
    const f = mockFetch({})
    const { wrapper } = await mountApp('/share')
    expect(wrapper.find('[data-test="no-token"]').text()).toContain('元の共有 URL から開き直してください')
    expect(f.to('POST', '/api/share/info')).toHaveLength(0)
  })

  it('[covers:web-share.invalid-token] invalid_token は一文の無効表示のみ', async () => {
    mockFetch({ 'POST /api/share/info': { status: 400, body: { error: 'invalid_token' } } })
    const { wrapper } = await mountApp('/share?token=T')
    const text = wrapper.find('[data-test="invalid"]').text()
    expect(text).toBe('共有 URL が無効か、期限切れか、使用済みです。')
    expect(text).not.toContain('依頼してください')
    expect(text).not.toContain('開き直してください')
    expect(wrapper.find('[data-test="accept"]').exists()).toBe(false)
  })

  it('[covers:web-share.join-flow] ログイン済みは招待文と家計簿名・権限・期限を優先順に出し、accept で参加完了・token 退避を消す', async () => {
    const f = mockFetch({
      'POST /api/share/info': { body: SHARE_INFO },
      'POST /api/share/accept': { body: { ledger: { id: 3, name: '家族', role: 'editor' }, outcome: 'joined' } },
      'GET /api/auth/me': { body: ME },
    })
    const { wrapper } = await mountApp('/share?token=T')
    expect(wrapper.find('h1').text()).toBe('太郎 さんが家計簿を共有しました')
    expect(wrapper.find('[data-test="ledger-name"]').text()).toBe('家族')
    expect(wrapper.find('[data-test="role"]').text()).toBe('編集')
    expect(wrapper.find('[data-test="issuer"]').text()).toBe('太郎')
    expect(wrapper.find('[data-test="expires"]').text()).toContain('2026/10/24 まで有効')
    expect(wrapper.find('[data-test="expires"]').text()).not.toContain('00:00')
    expect(wrapper.find('[data-test="join-as"]').text()).toContain('花子')
    expect(wrapper.find('[data-test="join-as"]').text()).toContain('ログイン中')
    await wrapper.find('[data-test="accept"]').trigger('click')
    await settle()
    expect(f.to('POST', '/api/share/accept')[0]!.body).toEqual({ token: 'T' })
    expect(wrapper.find('[data-test="done"]').text()).toContain('家計簿『家族』を追加しました')
    expect(wrapper.find('[data-test="go-home"]').exists()).toBe(true)
    expect(sessionStorage.getItem('kb_share_token')).toBeNull()
    // the session reloads so the shell membership reflects the join
    expect(f.to('GET', '/api/auth/me')).toHaveLength(1)
  })

  it('[covers:web-share.accept-already-member] accept の already_member は既参加の完了表示', async () => {
    mockFetch({
      'POST /api/share/info': { body: SHARE_INFO },
      'POST /api/share/accept': { body: { ledger: { id: 3, name: '家族', role: 'editor' }, outcome: 'already_member' } },
      'GET /api/auth/me': { body: ME },
    })
    const { wrapper } = await mountApp('/share?token=T')
    await wrapper.find('[data-test="accept"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="already-member"]').text()).toContain('追加済みです')
    expect(sessionStorage.getItem('kb_share_token')).toBeNull()
  })

  it('[covers:web-share.info-already-member] info の already_member は参加ボタンを出さない', async () => {
    mockFetch({ 'POST /api/share/info': { body: { ...SHARE_INFO, already_member: true } } })
    const { wrapper } = await mountApp('/share?token=T')
    expect(wrapper.find('[data-test="already-member"]').text()).toContain('この家計簿は追加済みです')
    expect(wrapper.find('[data-test="accept"]').exists()).toBe(false)
  })

  it('[covers:web-share.needs-login] 未ログインはログインと無効状態の追加ボタンを固定配置で出し登録への言及は置かず、チケットは消費しない', async () => {
    const f = mockFetch({ 'POST /api/share/info': { body: { ...SHARE_INFO, session: null } } })
    const { wrapper, router } = await mountApp('/share?token=T')
    expect(wrapper.find('h1').text()).toBe('太郎 さんが家計簿を共有しました')
    expect(wrapper.find('[data-test="ledger-name"]').text()).toBe('家族')
    expect(wrapper.find('[data-test="accept"]').exists()).toBe(false)
    expect((wrapper.find('[data-test="accept-waiting"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(wrapper.text()).not.toContain('登録の招待')
    expect(wrapper.text()).not.toContain('アカウントをお持ちでない場合')
    await wrapper.find('[data-test="login"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/login')
    expect(f.to('POST', '/api/share/accept')).toHaveLength(0)
    // the stash survives the login round trip
    expect(sessionStorage.getItem('kb_share_token')).toBe('T')
  })

  it('[covers:web-share.accept-invalid] accept 時点の invalid_token は無効表示へ切り替える', async () => {
    mockFetch({
      'POST /api/share/info': { body: SHARE_INFO },
      'POST /api/share/accept': { status: 400, body: { error: 'invalid_token' } },
    })
    const { wrapper } = await mountApp('/share?token=T')
    await wrapper.find('[data-test="accept"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="invalid"]').exists()).toBe(true)
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
    ledger_color: 'teal' as const,
    user_display_name: '太郎',
  }

  it('[covers:web-consent.shows-request] 要求内容を表示する（最初の接続先の家計簿は色 chip 付き・null は chip 無し）', async () => {
    mockFetch({ 'GET /api/oauth/requests/R': { body: INFO } })
    const { wrapper } = await mountApp('/oauth/consent?req=R')
    expect(wrapper.find('[data-test="client-display"]').text()).toBe('ChatGPT')
    expect(wrapper.find('[data-test="client-id"]').text()).toBe('https://chatgpt.com/x')
    expect(wrapper.find('[data-test="scopes"]').text()).toContain('家計簿の記録・編集')
    expect(wrapper.find('[data-test="ledger-name"]').text()).toBe('家計')
    // TASK-20 §7-5: the first-connection ledger carries its display-color
    // chip next to the name
    const chip = wrapper.find('[data-test="ledger-name"] .ledger-chip')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('style')).toContain('var(--ledger-teal)')
    expect(wrapper.find('[data-test="ledger-note"]').text()).toContain('切り替えられます')
    expect(wrapper.find('[data-test="user-display-name"]').text()).toBe('太郎')
    expect(wrapper.find('[data-test="allow"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="deny"]').exists()).toBe(true)

    // a request with no initial ledger (ledger_color null) shows the name
    // without a chip
    cleanup()
    mockFetch({ 'GET /api/oauth/requests/R': { body: { ...INFO, ledger_color: null } } })
    const b = await mountApp('/oauth/consent?req=R')
    expect(b.wrapper.find('[data-test="ledger-name"] .ledger-chip').exists()).toBe(false)
    expect(b.wrapper.find('[data-test="ledger-name"]').text()).toBe('家計')
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

  it('[covers:web-consent.ledger-note-interpolates-client-display] 接続後の家計簿切替の注記は client_display を補間する', async () => {
    // TASK-149 D3: the ledger-switch note follows the connecting client's
    // display name (backend value) instead of a fixed service name
    mockFetch({
      'GET /api/oauth/requests/R': {
        body: { ...INFO, client_display: 'Claude', client_id: 'https://claude.ai/x' },
      },
    })
    const { wrapper } = await mountApp('/oauth/consent?req=R')
    expect(wrapper.find('[data-test="client-display"]').text()).toBe('Claude')
    const note = wrapper.find('[data-test="ledger-note"]')
    expect(note.text()).toContain('Claude')
    expect(note.text()).not.toContain('ChatGPT')
  })

  it('[covers:web-consent.invalid-message-service-neutral] 無効・期限切れ要求の案内にサービス名を含まない', async () => {
    // TASK-149 D3: for an invalid request the connecting service is not
    // determined, so the guidance drops any specific service name
    mockFetch({ 'GET /api/oauth/requests/R': { status: 404, body: { error: 'not_found' } } })
    const { wrapper } = await mountApp('/oauth/consent?req=R')
    const expired = wrapper.find('[data-test="expired"]')
    expect(expired.exists()).toBe(true)
    expect(expired.text()).not.toContain('ChatGPT')
    expect(expired.text()).not.toContain('Claude')
  })
})
