// Build-time ingestion of docs/usage (TASK-141, TASK-135 decision §2-3/§2-4):
// the Markdown corpus under docs/usage is the single source of the /usage/*
// prose. This module turns it into HTML fragments plus widget placements at
// build time — the Markdown parser never enters the browser bundle. The web
// side reads the result through the `virtual:usage-docs` module served by
// usageDocsPlugin(); the node-side tests import this module directly.
//
// Corpus rules (docs/usage/README.md): a frontmatter block with title /
// summary / order, fenced `usage:*` blocks for the interactive widgets,
// standalone image lines (`![alt](relative-path "caption")`), app-internal
// links as route paths and cross-topic links as usage_<topic>.md. Raw HTML in
// the Markdown is disabled; an unknown `usage:*` widget fails the build.
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import MarkdownIt from 'markdown-it'
import type { Plugin } from 'vite'

export interface UsageFrontmatter {
  title: string
  summary: string
  order: number
}

// One rendered piece of a usage document, in document order: `html` is a
// build-time-generated fragment (raw HTML disabled at transform), the rest are
// widget placements the common UsageDocument component maps to components.
export type UsagePart =
  | { kind: 'html'; html: string }
  | { kind: 'connect-url' }
  | { kind: 'connect-flow'; caption: string }
  | { kind: 'figure-pending'; id: string; caption: string; note: string }
  | { kind: 'image'; src: string; alt: string; caption: string }

export interface UsageDocument {
  parts: UsagePart[]
}

export interface UsageTopic extends UsageFrontmatter {
  /** /usage/<slug> — the file name without the usage_ prefix and .md suffix */
  slug: string
  doc: UsageDocument
}

// repo root = <root>/frontend/src/build → three levels up
const rootDir = resolve(dirnameOf(import.meta.url), '..', '..', '..')
const docsDir = join(rootDir, 'docs', 'usage')
const frontendDir = join(rootDir, 'frontend')

function dirnameOf(url: string): string {
  const file = fileURLToPath(url)
  const slash = file.lastIndexOf(sep)
  return slash === -1 ? '.' : file.slice(0, slash)
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\s*\)$/
const IMAGE_PARAGRAPH_RE = /<p>@@USAGE_IMG:(\d+)@@<\/p>/
const KEY_VALUE_RE = /^([a-z-]+): ?(.*)$/
const FENCE_INFO_RE = /^usage:([a-z-]+)$/

const md = new MarkdownIt({ html: false, linkify: false, breaks: false })

// External links open in a new tab without an opener leak; cross-topic
// `usage_<topic>.md` links resolve to their /usage/<topic> render target.
// The Markdown syntax cannot carry attributes — the transform adds them.
const defaultLinkOpen = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (token) {
    // attrGet types the stored value as string | number (HTML attribute
    // values); only a string href can match the rules below
    const raw = token.attrGet('href')
    const href = typeof raw === 'string' ? raw : ''
    const topic = /^usage_([a-z0-9-]+)\.md$/.exec(href)
    if (topic) {
      token.attrSet('href', `/usage/${topic[1] ?? ''}`)
    } else if (/^https?:/.test(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
  }
  if (defaultLinkOpen) return defaultLinkOpen(tokens, idx, options, env, self)
  return self.renderToken(tokens, idx, options)
}

// The walkthrough step headings carry their number in the prose text
// ("## 1. ChatGPT に接続URLを登録する" — the round-chip step numbering the
// former UsageConnectPage drew with the ol.usage-steps counter: digits only,
// the ". " stays in the text). The heading keeps its full text; the leading
// "N. " is split into a chip span followed by the ". " separator at render.
const defaultHeadingOpen = md.renderer.rules.heading_open
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const open = defaultHeadingOpen
    ? defaultHeadingOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
  if (tokens[idx]?.tag !== 'h2') return open
  const inline = tokens[idx + 1]
  const first = inline?.children?.[0]
  if (!inline?.children || !first || first.type !== 'text') return open
  const m = /^(\d+)\.\s+(.*)$/.exec(first.content)
  if (!m) return open
  first.content = m[2] ?? ''
  return `${open}<span class="usage-step-no">${m[1] ?? ''}</span>. `
}

/** `key: value` lines (frontmatter and fenced-block attributes). */
function parseKeyValues(src: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of src.split('\n')) {
    const m = KEY_VALUE_RE.exec(line)
    if (m) values[m[1] ?? ''] = m[2] ?? ''
  }
  return values
}

/** Frontmatter with the three required keys — a missing one fails the parse
 * (no silent defaults; the corpus is the source of truth). An unknown key
 * fails too (a typo must not silently drop metadata). `public` is the only
 * optional key the design carries (TASK-135 §2-3). */
const ALLOWED_FRONTMATTER_KEYS = ['title', 'summary', 'order', 'public']

export function parseUsageFrontmatter(src: string): UsageFrontmatter {
  const block = FRONTMATTER_RE.exec(src)
  if (!block) throw new Error('usage doc: frontmatter block (--- title/summary/order ---) missing')
  const values = parseKeyValues(block[1] ?? '')
  for (const key of Object.keys(values)) {
    if (!ALLOWED_FRONTMATTER_KEYS.includes(key)) {
      throw new Error(`usage doc frontmatter: unknown key "${key}" (allowed: ${ALLOWED_FRONTMATTER_KEYS.join(', ')})`)
    }
  }
  const title = values['title'] ?? ''
  const summary = values['summary'] ?? ''
  const order = Number(values['order'])
  if (title === '' || summary === '' || !Number.isInteger(order)) {
    throw new Error('usage doc frontmatter requires a non-empty title, summary and an integer order')
  }
  return { title, summary, order }
}

/** Allowed fenced-block attributes per widget (design §2-4). */
const WIDGET_ATTRS: Record<string, readonly string[]> = {
  'connect-url': [],
  'connect-flow': ['caption'],
  'figure-pending': ['id', 'caption', 'note'],
}

function widgetPart(info: string, content: string, fileContext: string): UsagePart {
  const name = FENCE_INFO_RE.exec(info.trim())?.[1] ?? ''
  const allowed = WIDGET_ATTRS[name]
  if (!allowed) throw new Error(`${fileContext}: unknown usage fenced block "usage:${name || info.trim()}"`)
  const attrs = parseKeyValues(content)
  for (const key of Object.keys(attrs)) {
    if (!allowed.includes(key)) throw new Error(`${fileContext}: usage:${name} takes no "${key}" attribute`)
  }
  for (const key of allowed) {
    if ((attrs[key] ?? '') === '') throw new Error(`${fileContext}: usage:${name} requires "${key}"`)
  }
  if (name === 'connect-url') return { kind: 'connect-url' }
  if (name === 'connect-flow') return { kind: 'connect-flow', caption: attrs['caption'] ?? '' }
  return {
    kind: 'figure-pending',
    id: attrs['id'] ?? '',
    caption: attrs['caption'] ?? '',
    note: attrs['note'] ?? '',
  }
}

/**
 * Markdown body (frontmatter already stripped) → HTML fragments and widget
 * placements in document order. Standalone image lines become `image` parts
 * (alt + the title-as-caption); a `usage:*` fenced block at any other place
 * than the top level, an inline image, or an unknown widget name fails.
 */
export function transformUsageMarkdown(src: string): UsageDocument {
  const images: { src: string; alt: string; caption: string }[] = []
  const prepared = src
    .split('\n')
    .map((line) => {
      const m = IMAGE_LINE_RE.exec(line.trim())
      if (!m) return line
      if (!m[3]) {
        throw new Error(`usage doc image needs a "title" caption (the figure caption): ${m[2] ?? ''}`)
      }
      const i =
        images.push({ src: m[2] ?? '', alt: m[1] ?? '', caption: m[3] ?? '' }) - 1
      return `@@USAGE_IMG:${i}@@`
    })
    .join('\n')

  const tokens = md.parse(prepared, {})
  const parts: UsagePart[] = []
  const pushHtml = (fragment: string): void => {
    const pieces = fragment.split(IMAGE_PARAGRAPH_RE)
    for (let k = 0; k < pieces.length; k += 2) {
      const html = pieces[k] ?? ''
      if (html.trim() !== '') parts.push({ kind: 'html', html })
      const index = pieces[k + 1]
      if (index !== undefined) {
        const img = images[Number(index)]
        if (!img) throw new Error(`usage doc: unknown image placeholder ${index}`)
        parts.push({ kind: 'image', ...img })
      }
    }
  }

  let depth = 0
  let runStart = 0
  for (const [i, token] of tokens.entries()) {
    if (token.type === 'fence' && token.info.trim().startsWith('usage:')) {
      if (depth > 0) throw new Error('usage doc: usage fenced block must sit at the top level of the document')
      pushHtml(md.renderer.render(tokens.slice(runStart, i), md.options, {}))
      parts.push(widgetPart(token.info, token.content, 'usage doc'))
      runStart = i + 1
    }
    depth += token.nesting
  }
  pushHtml(md.renderer.render(tokens.slice(runStart), md.options, {}))

  const flat = parts.filter(isHtmlPart).map((p) => p.html).join('')
  if (flat.includes('@@USAGE_IMG:') || /<img[\s>]/i.test(flat)) {
    throw new Error(
      'usage doc: an image must be the only content of its line (standalone image line), not inline in a paragraph',
    )
  }
  return { parts }
}

function isHtmlPart(p: UsagePart): p is Extract<UsagePart, { kind: 'html' }> {
  return p.kind === 'html'
}

/** Every usage_*.md topic of docs/usage, order-ascending (the /usage list). */
export function loadUsageTopics(): UsageTopic[] {
  return readdirSync(docsDir)
    .filter((f) => /^usage_[a-z0-9-]+\.md$/.test(f))
    .map((f) => {
      const src = readFileSync(join(docsDir, f), 'utf8')
      const frontmatter = parseUsageFrontmatter(src)
      const body = src.replace(FRONTMATTER_RE, '').replace(/^\n+/, '')
      return {
        slug: f.slice('usage_'.length, f.length - '.md'.length),
        ...frontmatter,
        doc: transformUsageMarkdown(body),
      }
    })
    .sort((a, b) => a.order - b.order)
}

const VIRTUAL_ID = 'virtual:usage-docs'
const RESOLVED_ID = `\0${VIRTUAL_ID}`

/**
 * Serves the corpus as `virtual:usage-docs` (used by vite.config.ts for the
 * dev server, the build and vitest alike). Image parts keep their docs/usage
 * -relative `src` in loadUsageTopics(); here they are rewritten to root-absolute
 * Vite import specifiers so the screenshots resolve as regular assets
 * (TASK-96 keeps the files under src/web/assets/usage).
 */
export function usageDocsPlugin(): Plugin {
  return {
    name: 'usage-docs',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : undefined
    },
    // dev server: an md edit under docs/usage must invalidate the virtual
    // module without a restart. addWatchFile alone does not carry the change
    // through Vite's module graph (verified on Vite 8), so the watcher also
    // gets the directory and the plugin invalidates the module itself.
    configureServer(server) {
      const invalidate = (file: string): void => {
        if (file.startsWith(docsDir + sep)) {
          const mod = server.moduleGraph.getModuleById(RESOLVED_ID)
          if (mod) server.moduleGraph.invalidateModule(mod)
        }
      }
      server.watcher.add(docsDir)
      server.watcher.on('change', invalidate)
      server.watcher.on('unlink', invalidate)
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      const imports: string[] = []
      let n = 0
      const partCode = (p: UsagePart): string => {
        if (p.kind !== 'image') return JSON.stringify(p)
        const spec = `/${relative(frontendDir, resolve(docsDir, p.src)).split(sep).join('/')}`
        const binding = `__usageImg${n++}`
        imports.push(`import ${binding} from ${JSON.stringify(spec)}`)
        return `{"kind":"image","src":${binding},"alt":${JSON.stringify(p.alt)},"caption":${JSON.stringify(p.caption)}}`
      }
      const topics = loadUsageTopics()
      for (const topic of topics) {
        for (const part of topic.doc.parts) {
          if (part.kind === 'image') this.addWatchFile(resolve(docsDir, part.src))
        }
      }
      const topicsCode = topics
        .map((t) => {
          const parts = t.doc.parts.map(partCode).join(',')
          return `{"slug":${JSON.stringify(t.slug)},"title":${JSON.stringify(t.title)},"summary":${JSON.stringify(t.summary)},"order":${t.order},"doc":{"parts":[${parts}]}}`
        })
        .join(',')
      return `${imports.join('\n')}\nexport const usageTopics = [${topicsCode}]\n`
    },
  }
}
