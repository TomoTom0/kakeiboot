// Usage pages (TASK-37): /usage topic list and /usage/connect, the ChatGPT
// connection walkthrough. Written test-first against the design
// (tmp/tasks/tm-37/design_usage.md) — the routes and pages do not exist yet,
// so these stay red until the implementation lands. The permission wording
// expectations are verbatim copies of the backend scope_description
// (backend/src/auth/oauth/mod.rs) so the page reconciles with the consent
// screen shown during the actual connection.
import { afterEach, describe, expect, it } from 'vitest'
import { ME, cleanup, mockFetch, mountApp, settle, stubClipboard } from './helpers'

afterEach(cleanup)

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/** Items of the top-right account menu (open it first). */
const accountItems = (w: W) => w.findAll('[data-test="account-menu"] [role="menuitem"]')

describe('UsagePage (/usage)', () => {
  it('[covers:web-usage.nav] 導線はアカウントメニュー（設定 → 接続中のアプリ → 使い方 → ログアウト）。NAV は4項目のまま・両ページとも表題「使い方」で ledger 帯なし', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper, router } = await mountApp('/usage')
    expect(wrapper.find('.topbar-title-text').text()).toBe('使い方')
    expect(wrapper.find('header.topbar').classes()).not.toContain('ledger-scoped')
    // the main navigation keeps the four data sections + the settings entry
    // of the sidebar's second group (TASK-56); usage itself is menu-only
    expect(wrapper.find('[data-test="sidebar"]').findAll('.side-link')).toHaveLength(5)
    expect(wrapper.find('[data-test="tabbar"]').findAll('a')).toHaveLength(4)
    expect(wrapper.find('[data-test="nav-usage"]').exists()).toBe(false)

    await wrapper.find('[data-test="account-button"]').trigger('click')
    const labels = accountItems(wrapper).map((i) => i.text().trim())
    expect(labels).toHaveLength(4)
    expect(labels[0]).toContain('設定')
    expect(labels[1]).toContain('接続中のアプリ')
    expect(labels[2]).toContain('使い方')
    expect(labels[3]).toContain('ログアウト')
    const usage = wrapper.find('[data-test="menu-usage"]')
    expect(usage.attributes('href')).toBe('/usage')
    expect(usage.attributes('aria-current')).toBe('page')

    // /usage/connect is bound to the same usage section: same title, no band
    await router.push('/usage/connect')
    await settle()
    expect(wrapper.find('.topbar-title-text').text()).toBe('使い方')
    expect(wrapper.find('header.topbar').classes()).not.toContain('ledger-scoped')
  })

  it('[covers:web-usage.topics] トピック一覧の行リンク「ChatGPTに接続」が /usage/connect へ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage')
    const topics = wrapper.find('[data-test="usage-topics"]')
    expect(topics.exists()).toBe(true)
    const link = topics.find('[data-test="topic-connect"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toContain('ChatGPTに接続')
    expect(link.attributes('href')).toBe('/usage/connect')
  })
})

describe('UsageConnectPage (/usage/connect)', () => {
  it('[covers:web-usage.connect-steps] 3ステップ構成・許可内容は backend の scope_description と同一文言・毎回許可・90日・/apps 導線', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage/connect')
    const steps = wrapper.findAll('ol.usage-steps > li')
    expect(steps.map((s) => s.attributes('data-test'))).toEqual(['step-1', 'step-2', 'step-3'])
    expect(steps[0]!.find('h2').text()).toContain('ChatGPT に接続URLを登録する')
    expect(steps[1]!.find('h2').text()).toContain('ログインして接続を許可する')
    expect(steps[2]!.find('h2').text()).toContain('ChatGPT でレシートを送る')

    // the permission list uses the consent screen's exact wording so the
    // explanation and the F5 screenshot can be read against each other
    const step2 = steps[1]!.text()
    expect(step2).toContain('家計簿の参照（レシートや下書きの検索・閲覧、集計、カテゴリや店の一覧の表示）')
    expect(step2).toContain('家計簿の変更（レシートの作成・修正・確定・削除、カテゴリや店の管理）')
    expect(step2).toContain('最初の接続先の家計簿')
    // the consent screen shows up on every (re)connection
    expect(step2).toContain('毎回')

    // the management card: the 90-day expiry and the /apps lead
    expect(wrapper.text()).toContain('90日')
    const apps = wrapper.findAll('a').filter((a) => a.attributes('href') === '/apps')
    expect(apps.length).toBeGreaterThan(0)
    expect(apps[0]!.text()).toContain('接続中のアプリ')
  })

  it('[covers:web-usage.chatgpt-link] step-1 の URL box 直後に ChatGPT 側サブ手順 ol（li 5件・DOM順）があり、手順1は https://chatgpt.com/ を別 tab で開くリンク「ChatGPT を開く」', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage/connect')
    const step1 = wrapper.find('li[data-test="step-1"]')
    expect(step1.exists()).toBe(true)

    // the ChatGPT-side sub steps sit inside step-1 after the URL box; the
    // numbering is list-style: decimal, so the sequence is verified on the
    // DOM order of the five li, not on any rendered numeral
    const sub = step1.find('ol[data-test="chatgpt-steps"]')
    expect(sub.exists()).toBe(true)
    expect(sub.findAll('li').map((li) => li.attributes('data-test'))).toEqual(['chatgpt-step-1', 'chatgpt-step-2', 'chatgpt-step-3', 'chatgpt-step-4', 'chatgpt-step-5'])

    // sub step 1 opens ChatGPT itself: external URL, new tab, no opener leak
    const link = sub.find('li[data-test="chatgpt-step-1"] a[data-test="chatgpt-open-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('https://chatgpt.com/')
    expect(link.attributes('target')).toBe('_blank')
    const rel = link.attributes('rel') ?? ''
    expect(rel).toContain('noopener')
    expect(rel).toContain('noreferrer')
    expect(link.text()).toBe('ChatGPT を開く')

    // regression frame: the URL box and the copy control stay as-is (the
    // copy-done feedback belongs to url-shown / copy-feedback-real)
    expect(wrapper.find('[data-test="connect-url-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="copy-url"]').exists()).toBe(true)
  })

  it('[covers:web-usage.url-shown] 接続URLは location.origin + /mcp を code 表示し、コピー成功は icon の check 切替 + sr-only の role=status・失敗は msg-error', async () => {
    const expected = `${location.origin}/mcp`
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const writeText = stubClipboard()
    const { wrapper } = await mountApp('/usage/connect')
    expect(wrapper.find('[data-test="connect-url-box"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="connect-url"]').text()).toBe(expected)
    // TASK-47/48: the copy control is an icon-only button (copy glyph)
    const btn = wrapper.find('[data-test="copy-url"]')
    expect(btn.text()).toBe('')
    expect(btn.attributes('aria-label')).toBe('URL をコピー')
    expect(btn.find('svg').html()).toContain('M4 16c-1.1 0-2-.9-2-2') // the "copy" back sheet
    await btn.trigger('click')
    await settle()
    expect(writeText).toHaveBeenCalledWith(expected)
    // the success is the icon swap to a check + the sr-only status line; no
    // visible text row is added inside the URL box (TASK-48)
    expect(btn.find('svg').html()).toContain('M20 6 9 17l-5-5') // the "check" glyph
    expect(btn.classes()).toContain('is-done')
    expect(btn.attributes('aria-label')).toBe('コピーしました')
    expect(btn.attributes('title')).toBe('コピーしました')
    const done = wrapper.find('[data-test="copy-done"]')
    expect(done.exists()).toBe(true)
    expect(done.text()).toContain('コピーしました')
    expect(done.attributes('role')).toBe('status')
    expect(done.classes()).toContain('sr-only')
    // the only element inside the box carrying the done text is the
    // visually-hidden status — no visible row joins the box layout
    const box = wrapper.find('[data-test="connect-url-box"]')
    const doneHolders = box.findAll(':scope > *').filter((el) => el.text().includes('コピーしました'))
    expect(doneHolders).toHaveLength(1)
    expect(doneHolders[0]!.classes()).toContain('sr-only')
    cleanup()

    // a rejected clipboard shows the select-and-copy guidance instead
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    stubClipboard(new Error('denied'))
    const failed = await mountApp('/usage/connect')
    await failed.wrapper.find('[data-test="copy-url"]').trigger('click')
    await settle()
    const msg = failed.wrapper.find('[data-test="connect-url-box"] .msg-error')
    expect(msg.exists()).toBe(true)
    expect(msg.text()).toContain('コピーできませんでした')
    expect(failed.wrapper.find('[data-test="copy-done"]').exists()).toBe(false)
    expect(failed.wrapper.find('[data-test="copy-url"]').classes()).not.toContain('is-done')
  })

  it('[covers:web-usage.figures] 各図は figure + figcaption・F1 は role=img の inline SVG・asset 未配置の図は placeholder で img なし', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage/connect')
    // five figures: F1 flow diagram, F2/F6 ChatGPT-side placeholders and the
    // F4/F5 self-screen screenshots (auto-captured, so they carry an img)
    const figs = wrapper.findAll('figure')
    expect(figs).toHaveLength(5)
    for (const f of figs) expect(f.find('figcaption').exists(), f.text()).toBe(true)

    // F1: the connection-flow diagram is an inline SVG exposing its content
    // as an accessible name (the charts pattern)
    const flow = wrapper.find('[data-test="connect-flow"]')
    expect(flow.exists()).toBe(true)
    expect(flow.attributes('role')).toBe('img')
    expect(flow.attributes('aria-label') ?? '').toContain('接続の流れ')
    const flowFig = figs.find((f) => f.find('[data-test="connect-flow"]').exists())
    expect(flowFig?.find('figcaption').exists()).toBe(true)

    const withImg = figs.filter((f) => f.find('img').exists())
    expect(withImg).toHaveLength(2)
    for (const f of withImg) expect(f.find('img').attributes('alt') ?? '').not.toBe('')

    // figures without an asset (the ChatGPT-side screenshots until the
    // manual capture lands) are placeholders: a swap-in note and no img.
    // Picked by the placeholder element itself — the F1 figure holds the
    // inline SVG, so "no img" alone would count it too (5 figures = 2 imgs +
    // 2 placeholders + the SVG flow)
    const placeholders = figs.filter((f) => f.find('.usage-fig-ph').exists())
    expect(placeholders).toHaveLength(2)
    for (const p of placeholders) {
      expect(p.text()).toContain('スクリーンショット')
      expect(p.find('img').exists()).toBe(false)
    }
  })
})

describe('AppsPage usage link', () => {
  it('[covers:web-usage.apps-link] /apps の未接続表示の直後に /usage/connect への「ChatGPTとの接続方法を見る」', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME }, 'GET /api/oauth/grants': { body: [] } })
    const { wrapper } = await mountApp('/apps')
    const empty = wrapper.find('[data-test="empty"]')
    expect(empty.text()).toContain('接続中のアプリはありません。')
    const link = wrapper.find('[data-test="usage-link"]')
    expect(link.text()).toBe('ChatGPTとの接続方法を見る')
    expect(link.attributes('href')).toBe('/usage/connect')
    // the lead sits right after the empty note
    expect(empty.element.nextElementSibling).toBe(link.element)
  })
})
