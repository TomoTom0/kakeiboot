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
import type { ViteDevServer } from 'vite'
import {
  loadUsageTopics,
  parseUsageFrontmatter,
  transformUsageMarkdown,
  usageDocsPlugin,
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

  it('[covers:usage-docs.frontmatter-order-nonempty] order の空値（未記入・空白）は order 0 として受理されず例外', () => {
    // PR4 review: `Number('') === 0` is an integer, so an empty `order:` used
    // to slip through Number.isInteger as a legitimate order 0 — the empty
    // value itself must be rejected before the integer check.
    const withFm = (fm: string): string => `---\n${fm}\n---\n\n# t\n`
    expect(() => parseUsageFrontmatter(withFm('title: x\nsummary: y\norder:'))).toThrow()
    expect(() => parseUsageFrontmatter(withFm('title: x\nsummary: y\norder: '))).toThrow()
    expect(() => parseUsageFrontmatter(withFm('title: x\nsummary: y\norder:  \t'))).toThrow()
    // an explicit 0 stays a valid integer (only the empty value is rejected)
    expect(parseUsageFrontmatter(withFm('title: x\nsummary: y\norder: 0')).order).toBe(0)
  })

  it('[covers:usage-docs.frontmatter-public-not-accepted] 未使用の public key は unknown key として失敗する（silent no-op にしない）', () => {
    // PR4 review: `public` appears in neither the output type nor the emitted
    // module, so accepting it was a silent no-op — contradicting the "a typo
    // must fail" design of the unknown-key check. Until it gains an effect it
    // fails like any other unknown key (docs/usage/README.md lists exactly
    // title/summary/order).
    const withFm = (fm: string): string => `---\n${fm}\n---\n\n# t\n`
    expect(() =>
      parseUsageFrontmatter(withFm('title: x\nsummary: y\norder: 1\npublic: true')),
    ).toThrow(/unknown key "public"/)
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

  it('[covers:usage-docs.image-top-level-only] list item 内に置いた image line は top level 規約違反として変換を失敗させる', () => {
    // PR4 review: the image line passes IMAGE_LINE_RE after trim(), so inside
    // a list item it becomes a placeholder wrapped in <li><p>…</p></li>; the
    // old partial-match IMAGE_PARAGRAPH_RE split it out and orphaned the
    // <li>/<\/li> tags across html parts with no error. An image is only
    // allowed as a top-level standalone line.
    // an image line indented as a list item's own paragraph (passes
    // IMAGE_LINE_RE after trim()): placeholder renders as <li><p>…</p></li>
    expect(() =>
      transformUsageMarkdown(['- 項目', '', '  ![alt](./x.png "cap")', ''].join('\n')),
    ).toThrow(/top level/)
    // tight list continuation: placeholder renders bare inside <li> (no <p>)
    expect(() => transformUsageMarkdown('- 説明\n  ![alt](./x.png "cap")\n')).toThrow(
      /top level/,
    )
    // a plain top-level standalone image line keeps extracting normally
    const doc = transformUsageMarkdown('前段\n\n![alt](./x.png "cap")\n\n後段')
    expect(doc.parts.map((p) => p.kind)).toEqual(['html', 'image', 'html'])
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

  it('[covers:usage-docs.connect-topic-covers-both-services] 接続トピックは ChatGPT と Claude 両サービスの登録手順に言及する', () => {
    // TASK-149 D3: the connect topic is a common flow plus per-service
    // registration steps, naming both services (service names are data
    // names; a neutral wording is NOT used). Removing one service's
    // registration steps must fail here, so beyond both service names the
    // per-service step headings themselves are asserted (meaning-bearing
    // substrings of the corpus headings, not exact-sentence pins).
    const connect = readFileSync(resolve(docsDir, 'usage_connect.md'), 'utf8')
    expect(connect).toContain('ChatGPT')
    expect(connect).toContain('Claude')
    expect(connect).toContain('ChatGPT に登録する')
    expect(connect).toContain('Claude に登録する')
  })

  it('[covers:usage-docs.send-receipt-mentions-claude] レシート送信トピックは Claude での画像の扱いに言及する', () => {
    // TASK-149 D3: in Claude the conversation image is read by the model,
    // so the record carries no image file — the send-receipt topic notes
    // this. Removing the note must fail here, so the note's own
    // meaning-bearing phrase is asserted in addition to the Claude mention.
    const send = readFileSync(resolve(docsDir, 'usage_send-receipt.md'), 'utf8')
    expect(send).toContain('Claude')
    expect(send).toContain('記録に写真は付きません')
  })
})

// Structural mocks of the plugin hook contexts (PR4 review regressions): the
// two hooks under test touch only addWatchFile (load) resp. watcher +
// moduleGraph (configureServer). The type guards narrow the mocks to the hook
// parameter types without casts.
interface AddWatchCollector {
  addWatchFile(file: string): void
}

type LoadHookWithCollectorThis = (this: AddWatchCollector, id: string) => unknown

function toLoadHook(h: unknown): h is LoadHookWithCollectorThis {
  return typeof h === 'function'
}

interface DevServerProbe {
  watcher: {
    add(path: string): void
    on(event: string, listener: (file: string) => void): void
  }
  moduleGraph: {
    getModuleById(id: string): { id: string | null } | null | undefined
    invalidateModule(mod: { id: string | null }): void
  }
}

function toDevServer(s: DevServerProbe): s is ViteDevServer {
  return typeof s.watcher.add === 'function' && typeof s.moduleGraph.invalidateModule === 'function'
}

// Vite plugin hooks are invoked with a minimal logger context as `this`.
interface HookContextProbe {
  error(e: unknown): never
  warn(warning: unknown): void
  info(msg: unknown): void
  debug(msg: unknown): void
}

function toHookContext(
  c: HookContextProbe,
): c is import('vite').MinimalPluginContextWithoutEnvironment {
  return typeof c.error === 'function' && typeof c.warn === 'function'
}

const RESOLVED_VIRTUAL_ID = '\0virtual:usage-docs'

describe('usageDocsPlugin watch / invalidation', () => {
  it('[covers:usage-docs.dev-watcher-add-event] dev watcher は add・change・unlink の全てで virtual module を invalidate する', () => {
    // PR4 review: watching only change/unlink missed new usage_*.md files
    // (including the added side of a rename) — a new topic never showed up on
    // the dev pages without a restart.
    const plugin = usageDocsPlugin()
    const handlers: Record<string, ((file: string) => void)[]> = {}
    const addedDirs: string[] = []
    let invalidated = 0
    const server: DevServerProbe = {
      watcher: {
        add: (path) => {
          addedDirs.push(path)
        },
        on: (event, listener) => {
          handlers[event] = [...(handlers[event] ?? []), listener]
        },
      },
      moduleGraph: {
        getModuleById: () => ({ id: RESOLVED_VIRTUAL_ID }),
        invalidateModule: () => {
          invalidated += 1
        },
      },
    }
    expect(plugin.configureServer).toBeTypeOf('function')
    if (!toDevServer(server)) throw new Error('unreachable: structural probe')
    if (typeof plugin.configureServer !== 'function') throw new Error('unreachable')
    const ctx: HookContextProbe = {
      error: (e) => {
        throw e
      },
      warn: () => {},
      info: () => {},
      debug: () => {},
    }
    if (!toHookContext(ctx)) throw new Error('unreachable: structural probe')
    plugin.configureServer.call(ctx, server)
    expect(addedDirs).toEqual([docsDir])
    for (const event of ['add', 'change', 'unlink']) {
      expect(handlers[event], event).toHaveLength(1)
      handlers[event]?.[0]?.(`${docsDir}/usage_connect.md`)
    }
    expect(invalidated).toBe(3)
    // a change outside docs/usage must not invalidate
    handlers['change']?.[0]?.(`${root}/frontend/src/web/router.ts`)
    expect(invalidated).toBe(3)
  })

  it('[covers:usage-docs.plugin-watches-markdown-source] load は正本の usage_*.md 本体を watch に登録する', () => {
    // PR4 review: load() registered only the image src files, so with
    // `vite build --watch` (no configureServer watcher) a Markdown edit was
    // not part of the rebuild set.
    const plugin = usageDocsPlugin()
    const watched: string[] = []
    const collector: AddWatchCollector = {
      addWatchFile: (file) => {
        watched.push(file)
      },
    }
    expect(plugin.load).toBeTypeOf('function')
    if (!toLoadHook(plugin.load)) throw new Error('unreachable: load must be a function hook')
    const code = plugin.load.call(collector, RESOLVED_VIRTUAL_ID)
    expect(code).toBeTypeOf('string')
    expect(String(code)).toContain('export const usageTopics')
    const mdFiles = readdirSync(docsDir).filter((f) => /^usage_[a-z0-9-]+\.md$/.test(f))
    for (const f of mdFiles) {
      expect(watched, f).toContain(resolve(docsDir, f))
    }
    // the image files stay watched as before
    expect(watched.some((w) => !w.endsWith('.md'))).toBe(true)
  })
})
