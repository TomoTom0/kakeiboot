/**
 * @vitest-environment node
 * (reads docs/usage, configs and the backend sources, all node-side)
 */
// TASK-141 docs/usage build-time ingestion (test-first): the Markdown corpus
// under docs/usage is the single source of the /usage/* prose, transformed by
// a Vite plugin (frontend/src/build/usage-docs.ts) into HTML parts and widget
// placements. The reconciliation checks here are the ones the design limits
// the tests to (tmp/tasks/tm-135/design_usage-docs.md §2-5): wording the
// ingestion itself cannot detect drifting. The plugin module does not exist
// yet — these stay red until the TASK-141 implementation lands.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'smol-toml'
import {
  loadUsageTopics,
  parseUsageFrontmatter,
  transformUsageMarkdown,
  type UsagePart,
} from '@/build/usage-docs'

const root = resolve(process.cwd(), '..')
const docsDir = resolve(root, 'docs/usage')
const assetsDir = resolve(process.cwd(), 'src/web/assets/usage')

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function hasKind<K extends UsagePart['kind']>(
  p: UsagePart,
  kind: K,
): p is Extract<UsagePart, { kind: K }> {
  return p.kind === kind
}

function isHtmlPart(p: UsagePart): p is Extract<UsagePart, { kind: 'html' }> {
  return p.kind === 'html'
}

function isImagePart(p: UsagePart): p is Extract<UsagePart, { kind: 'image' }> {
  return p.kind === 'image'
}

/** Concatenate the html parts of a doc (for prose/attribute assertions). */
function htmlOf(doc: { parts: UsagePart[] }): string {
  return doc.parts.filter(isHtmlPart).map((p) => p.html).join('')
}

describe('usage docs frontmatter / topic index', () => {
  it('[covers:usage-docs.frontmatter-required] 全 usage_*.md が title・summary・order を持ち、欠落 frontmatter は例外', () => {
    // every real file parses with the three required keys
    const topics = loadUsageTopics()
    const files = readdirSync(docsDir).filter((f) => /^usage_[a-z0-9-]+\.md$/.test(f))
    expect(topics).toHaveLength(files.length)
    for (const t of topics) {
      expect(t.title, t.slug).toMatch(/\S/)
      expect(t.summary, t.slug).toMatch(/\S/)
      expect(Number.isInteger(t.order), t.slug).toBe(true)
    }

    // a frontmatter missing any required key fails the parse instead of
    // falling back to defaults
    const withFm = (fm: string): string => `---\n${fm}\n---\n\n# t\n`
    expect(() => parseUsageFrontmatter(withFm('title: x\nsummary: y'))).toThrow()
    expect(() => parseUsageFrontmatter(withFm('title: x\norder: 1'))).toThrow()
    expect(() => parseUsageFrontmatter(withFm('summary: y\norder: 1'))).toThrow()
    // an unknown key fails too — a typo must not silently drop metadata
    expect(() => parseUsageFrontmatter(withFm('title: x\nsummary: y\norder: 1\nsubtitle: z'))).toThrow()
    const ok = parseUsageFrontmatter(withFm('title: x\nsummary: y\norder: 3'))
    expect(ok.title).toBe('x')
    expect(ok.summary).toBe('y')
    expect(ok.order).toBe(3)
  })

  it('[covers:usage-docs.topic-index-matches-readme] 生成された一覧（slug・順序）が docs/usage/README.md の表と一致', () => {
    const readme = readFileSync(resolve(docsDir, 'README.md'), 'utf8')
    // rows look like: | 1 | [usage_getting-started.md](usage_getting-started.md) | …
    const rows = [...readme.matchAll(/\|\s*(\d+)\s*\|\s*\[usage_([a-z0-9-]+)\.md\]/g)]
    // §2-8 + §6: the topic system is nine files (send-receipt absorbs review-draft)
    expect(rows).toHaveLength(9)
    const topics = loadUsageTopics()
    expect(topics.map((t) => t.order)).toEqual(rows.map((r) => Number(r[1] ?? 0)))
    expect(topics.map((t) => t.slug)).toEqual(rows.map((r) => r[2] ?? ''))
  })

  it('[covers:usage-docs.plugin-registered] vite.config.ts の plugins が取り込み plugin を登録する', () => {
    const cfg = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
    expect(cfg).toContain('usageDocsPlugin()')
  })
})

describe('transformUsageMarkdown', () => {
  it('[covers:usage-docs.transform-fenced-blocks] fenced block 3種が本文順に部品配置の列へ写像され属性が保たれる', () => {
    const doc = transformUsageMarkdown(
      [
        '# 見出し',
        '',
        '段落1',
        '',
        '```usage:connect-url',
        '```',
        '',
        '```usage:connect-flow',
        'caption: 流れの説明',
        '```',
        '',
        '```usage:figure-pending',
        'id: fig-x',
        'caption: 図の説明',
        'note: 差し替えメモ',
        '```',
        '',
        '段落2',
      ].join('\n'),
    )
    // HTML parts and widget placements keep the document order
    expect(doc.parts.map((p) => p.kind)).toEqual([
      'html',
      'connect-url',
      'connect-flow',
      'figure-pending',
      'html',
    ])
    const flow = doc.parts.find((p) => hasKind(p, 'connect-flow'))
    expect(flow?.caption).toBe('流れの説明')
    const pending = doc.parts.find((p) => hasKind(p, 'figure-pending'))
    expect(pending?.id).toBe('fig-x')
    expect(pending?.caption).toBe('図の説明')
    expect(pending?.note).toBe('差し替えメモ')
    // the plain prose survives as HTML (heading + both paragraphs)
    const html = htmlOf(doc)
    expect(html).toContain('<h1')
    expect(html).toContain('段落1')
    expect(html).toContain('段落2')
  })

  it('[covers:usage-docs.unknown-block-fails] 未知の usage:* 部品名は変換を失敗させる', () => {
    expect(() => transformUsageMarkdown('```usage:retired-thing\n```')).toThrow()
  })

  it('[covers:usage-docs.raw-html-disabled] 本文の生HTMLは HTML 片の要素として現れない', () => {
    const doc = transformUsageMarkdown(
      ['<script>alert(1)</script>', '', '<div class="x">埋め込み</div>', '', '**太字**'].join('\n'),
    )
    const html = htmlOf(doc)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<div')
    // markdown's own emphasis still renders
    expect(html).toContain('太字')
  })

  it('[covers:usage-docs.image-references-resolve] 画像参照は alt・caption を保ち assets/usage 配下の実在ファイルへ解決できる', () => {
    const topics = loadUsageTopics()
    // every image reference across the whole corpus (today they all live in
    // usage_connect.md, but the check is corpus-wide)
    const images = topics.flatMap((t) => t.doc.parts.filter(isImagePart))
    expect(images.length).toBeGreaterThan(0)
    for (const img of images) {
      expect(img.alt).not.toBe('')
      expect(img.caption).not.toBe('')
      const resolved = resolve(docsDir, img.src)
      expect(existsSync(resolved), img.src).toBe(true)
      // TASK-96 / capture.usage.spec.ts keep the assets where they are
      expect(resolved.startsWith(assetsDir), img.src).toBe(true)
    }

    // an image inline in a paragraph (anything but a standalone image line)
    // must fail the build instead of leaking an unresolved <img> into an html
    // part
    expect(() =>
      transformUsageMarkdown('本文の途中に ![alt](./x.png "cap") を貼る例'),
    ).toThrow()
  })
})

describe('usage docs reconciliation (design §2-5)', () => {
  it('[covers:usage-docs.no-internal-vocabulary] 本文に内部語彙（TASK-数字・chat_upload・tool名）を含まない', () => {
    const registry = readFileSync(resolve(root, 'backend/src/mcp/registry.rs'), 'utf8')
    // tool defs are `t("tool_name", …)` entries in the registry vec
    const toolNames = [...registry.matchAll(/\bt\(\s*"([a-z_]+)"/g)].map((m) => m[1] ?? '')
    expect(toolNames.length).toBeGreaterThanOrEqual(10)

    for (const f of readdirSync(docsDir).filter((f) => /^usage_[a-z0-9-]+\.md$/.test(f))) {
      const body = readFileSync(resolve(docsDir, f), 'utf8')
      expect(body, `${f}: TASK-<n>`).not.toMatch(/TASK-\d/)
      expect(body, `${f}: chat_upload`).not.toContain('chat_upload')
      for (const name of toolNames) expect(body, `${f}: tool ${name}`).not.toContain(name)
    }
  })

  it('[covers:usage-docs.scope-wording-matches-backend] 許可内容の語彙が backend scope_description と一致する', () => {
    const src = readFileSync(resolve(root, 'backend/src/auth/oauth/mod.rs'), 'utf8')
    const fn = src.match(/pub fn scope_description[\s\S]*?\n\}/)?.[0] ?? ''
    const wordings = [...fn.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '').filter((s) => s.length > 5)
    expect(wordings).toHaveLength(2)
    const connect = readFileSync(resolve(docsDir, 'usage_connect.md'), 'utf8')
    for (const w of wordings) expect(connect, w).toContain(w)
  })

  it('[covers:usage-docs.grant-days-match-configs] 本文の「90日」等の固定値が configs の grant_absolute_days と一致する', () => {
    const days = ['dev', 'stg', 'prod'].map((env) => {
      const raw: unknown = parse(readFileSync(resolve(root, `configs/${env}/auth.toml`), 'utf8'))
      const auth = isRecord(raw) ? raw['auth'] : undefined
      const oauth = isRecord(auth) ? auth['oauth'] : undefined
      const d = isRecord(oauth) ? oauth['grant_absolute_days'] : undefined
      if (typeof d !== 'number') throw new Error(`configs/${env}/auth.toml: grant_absolute_days missing`)
      return d
    })
    // the prose states the value once for all envs, so they must agree
    expect(new Set(days).size).toBe(1)
    const connect = readFileSync(resolve(docsDir, 'usage_connect.md'), 'utf8')
    expect(connect).toContain(`${days[0]!}日`)
  })
})
