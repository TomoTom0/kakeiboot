// Usage screens (TASK-37, reworked by TASK-141): /usage lists the topics and
// /usage/:topic renders the docs/usage Markdown corpus ingested at build time
// through a Vite plugin (frontend/src/build/usage-docs.ts). Written test-first
// against the TASK-135 decision record (tmp/tasks/tm-135/design_usage-docs.md
// §2-3..§2-5, §6) — the ingestion and the dynamic route do not exist yet, so
// the topics/route/content expectations stay red until the implementation
// lands. The permission wording expectations are verbatim copies of the
// backend scope_description (backend/src/auth/oauth/mod.rs) so the page
// reconciles with the consent screen shown during the actual connection.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { routes } from '@/web/router'
import type { RouteRecordRaw } from 'vue-router'
import { ME, cleanup, mockFetch, mountApp, settle, stubClipboard } from './helpers'

afterEach(cleanup)

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/** Items of the top-right account menu (open it first). */
const accountItems = (w: W) => w.findAll('[data-test="account-menu"] [role="menuitem"]')

const docsDir = resolve(process.cwd(), '../docs/usage')

/** The docs/usage corpus read independently of the ingestion: the test builds
 * its expectations from the files themselves, so the screen is verified
 * against the source of truth rather than against the plugin's own output
 * (README/index reconciliation lives in usage-docs.test.ts). */
interface DocTopic {
  slug: string
  title: string
  summary: string
  order: number
  /** first prose sentence opener — proves the body, not just the title, renders */
  sample: string
}

function readDocTopics(): DocTopic[] {
  const names = readdirSync(docsDir).filter((f) => /^usage_[a-z0-9-]+\.md$/.test(f))
  return names
    .map((f) => {
      const src = readFileSync(resolve(docsDir, f), 'utf8')
      const fm = src.match(/^---\n([\s\S]*?)\n---/)
      if (!fm) throw new Error(`${f}: no frontmatter`)
      const pick = (key: string): string => {
        const m = fm[1]!.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!m) throw new Error(`${f}: frontmatter missing ${key}`)
        return m[1] ?? ''
      }
      const body = src.slice(fm[0].length)
      const prose = body.split('\n').find((line) => line.trim() !== '' && !line.trim().startsWith('#'))
      if (!prose) throw new Error(`${f}: no prose line`)
      return {
        slug: f.replace(/^usage_/, '').replace(/\.md$/, ''),
        title: pick('title'),
        summary: pick('summary'),
        order: Number(pick('order')),
        sample: prose.trim().slice(0, 10),
      }
    })
    .sort((a, b) => a.order - b.order)
}

describe('UsagePage (/usage)', () => {
  it('[covers:web-usage.nav] 導線はアカウントメニュー（設定 → 接続中のアプリ → 使い方 → ログアウト）。NAV は4項目のまま・全トピックで表題「使い方」で ledger 帯なし', async () => {
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

    // /usage/connect keeps its URL on the dynamic /usage/:topic route and any
    // other topic stays in the same usage section: same title, no band
    await router.push('/usage/connect')
    await settle()
    expect(wrapper.find('.topbar-title-text').text()).toBe('使い方')
    expect(wrapper.find('header.topbar').classes()).not.toContain('ledger-scoped')
    await router.push('/usage/passkey')
    await settle()
    expect(wrapper.find('.topbar-title-text').text()).toBe('使い方')
    expect(wrapper.find('header.topbar').classes()).not.toContain('ledger-scoped')
  })

  it('[covers:web-usage.topics] トピック一覧は frontmatter 由来（order 昇順・title・summary）で ChatGPTに接続が /usage/connect へ', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage')
    const topics = wrapper.find('[data-test="usage-topics"]')
    expect(topics.exists()).toBe(true)

    // the list is generated from docs/usage frontmatter: every topic, in
    // order, with the title and summary as written (adding a topic file is
    // the only step needed — TASK-135 §2-3)
    const expected = readDocTopics()
    expect(expected).toHaveLength(9) // §2-8 + §6: nine topics
    const links = topics.findAll('a')
    expect(links).toHaveLength(expected.length)
    expected.forEach((t, i) => {
      const link = links[i]!
      expect(link.attributes('href'), t.slug).toBe(`/usage/${t.slug}`)
      expect(link.text(), t.slug).toContain(t.title)
      expect(link.text(), t.slug).toContain(t.summary)
    })

    // the ChatGPT connection topic keeps the existing /usage/connect URL
    const connect = topics.find('[data-test="topic-connect"]')
    expect(connect.exists()).toBe(true)
    expect(connect.attributes('href')).toBe('/usage/connect')
  })
})

describe('UsageConnectPage (/usage/connect)', () => {
  it('[covers:web-usage.connect-steps] Markdown本文由来の3ステップ見出し・許可内容は backend の scope_description と同一文言・毎回許可・90日・/apps 導線・トピック間リンク', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage/connect')
    // the three step headings from usage_connect.md, in document order (the
    // exact container markup is up to the ingestion — the headings are prose)
    const heads = wrapper.findAll('h2').map((h) => h.text())
    const steps = [
      '1. ChatGPT に接続URLを登録する',
      '2. ログインして接続を許可する',
      '3. ChatGPT でレシートを送る',
    ]
    const idx = steps.map((s) => heads.findIndex((t) => t.includes(s)))
    for (const [i, s] of steps.entries()) expect(idx[i], s).toBeGreaterThanOrEqual(0)
    expect([...idx].sort((a, b) => a - b), 'steps appear in document order').toEqual(idx)

    // the permission list uses the consent screen's exact wording so the
    // explanation and the F5 screenshot can be read against each other
    const text = wrapper.text()
    expect(text).toContain('家計簿の参照（レシートや下書きの検索・閲覧、集計、カテゴリや店の一覧の表示）')
    expect(text).toContain('家計簿の変更（レシートの作成・修正・確定・削除、カテゴリや店の管理）')
    expect(text).toContain('最初の接続先の家計簿')
    // the consent screen shows up on every (re)connection
    expect(text).toContain('毎回')
    // the fixed grant window (grant_absolute_days, plain prose in the md)
    expect(text).toContain('90日')
    // the /apps lead and the cross-topic link (usage_send-receipt.md →
    // /usage/send-receipt, design §2-5 internal link resolution)
    const apps = wrapper.findAll('a').filter((a) => a.attributes('href') === '/apps')
    expect(apps.length).toBeGreaterThan(0)
    expect(apps[0]!.text()).toContain('接続中のアプリ')
    const send = wrapper.findAll('a').filter((a) => a.attributes('href') === '/usage/send-receipt')
    expect(send.length).toBeGreaterThan(0)
    expect(send[0]!.text()).toContain('レシートを送る')
  })

  it('[covers:web-usage.chatgpt-link] ChatGPT 側サブ手順の ordered list 5件・手順1は https://chatgpt.com/ を別 tab で開くリンク「ChatGPT を開く」', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { wrapper } = await mountApp('/usage/connect')

    // the md carries several ordered lists (the ledger-switch steps etc.);
    // the ChatGPT-side sub steps are the five-item one whose first item
    // links to chatgpt.com — the numbering itself is list-style: decimal, so
    // the sequence is verified on the DOM order of the five li
    const target = wrapper.findAll('ol').find((ol) => {
      const items = ol.findAll(':scope > li')
      const first = items[0]?.find('a')
      return items.length === 5 && first?.attributes('href') === 'https://chatgpt.com/'
    })
    expect(target, 'ChatGPT 側サブ手順（5項目の ordered list）').toBeDefined()
    const items = target!.findAll(':scope > li')
    expect(items).toHaveLength(5)

    // sub step 1 opens ChatGPT itself: external URL, new tab, no opener leak
    // (the md link syntax cannot carry attributes — the ingestion adds them)
    const link = items[0]!.find('a')
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

describe('usage topics on the dynamic route (TASK-141)', () => {
  it('[covers:web-usage.topic-route-guarded] /usage/:topic は section: usage で meta.public 無し（session guard）・/usage/connect は動的routeで解決', async () => {
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const { router } = await mountApp('/usage/connect')
    const rec = router.getRoutes().find((r) => r.path === '/usage/:topic')
    expect(rec, 'route /usage/:topic').toBeDefined()
    expect(rec?.meta.section).toBe('usage')
    expect(rec?.meta.public).toBeUndefined()
    // the existing /usage/connect URL resolves through the dynamic route
    expect(router.currentRoute.value.matched[0]?.path).toBe('/usage/:topic')
  })

  // every topic renders its Markdown body — title plus the first prose
  // sentence read straight from docs/usage, so the corpus is what is on
  // screen (one component serves all topics, TASK-135 §2-3)
  describe.each(readDocTopics())('topic $slug', ({ slug, title, sample }) => {
    it('[covers:web-usage.topics-content-rendered] /usage/:slug に frontmatter の title と本文冒頭が出る', async () => {
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      const { wrapper } = await mountApp(`/usage/${slug}`)
      expect(wrapper.text(), slug).toContain(title)
      expect(wrapper.text(), slug).toContain(sample)
    })
  })

  it('[covers:usage-docs.links-resolve-to-routes] 本文のアプリ内リンクは router 定義に解決でき、トピック間相対リンクは実在トピックへ向かう', () => {
    const topics = readDocTopics()
    expect(topics.length).toBeGreaterThan(0)
    const slugs = new Set(topics.map((t) => t.slug))

    // collect every route path (children included) for the absolute links
    const staticPaths = new Set<string>()
    const collect = (rs: readonly RouteRecordRaw[]): void => {
      for (const r of rs) {
        staticPaths.add(r.path)
        if (r.children) collect(r.children)
      }
    }
    collect(routes)
    expect(staticPaths.has('/usage/:topic')).toBe(true)

    // links are read straight from the Markdown sources (the ingestion's own
    // output is not used to build its expectations); images are skipped
    for (const t of topics) {
      const src = readFileSync(resolve(docsDir, `usage_${t.slug}.md`), 'utf8')
      const targets = [...src.matchAll(/(^|[^!])\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[2] ?? '')
      for (const href of targets) {
        if (/^https?:/.test(href)) continue // external links are out of scope
        const md = href.match(/^usage_([a-z0-9-]+)\.md$/)
        if (md) {
          // a cross-topic link must name an existing topic (its /usage/<slug>
          // render target — the rendered href is checked in connect-steps)
          expect(slugs.has(md[1] ?? ''), `${t.slug}: ${href}`).toBe(true)
        } else {
          expect(staticPaths.has(href), `${t.slug}: ${href}`).toBe(true)
        }
      }
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
