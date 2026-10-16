import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// vitest runs with cwd = frontend/ (jsdom makes import.meta.url non-file).
const SRC = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|vue)$/.test(p) ? [p] : []
  })
}

const FORBIDDEN: [string, RegExp][] = [
  ['fetch', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['sendFollowUpMessage', /sendFollowUpMessage/],
  ['getFileDownloadUrl', /getFileDownloadUrl/],
  ['toolInput', /toolInput\b/],
  ['innerHTML', /innerHTML/],
  ['outerHTML', /outerHTML/],
  ['insertAdjacentHTML', /insertAdjacentHTML/],
  ['document.write', /document\.write/],
  ['v-html', /v-html/],
  ['emoji', /\p{Extended_Pictographic}/u],
]

describe('widget source guard', () => {
  it('[covers:widget.forbidden-apis-absent] no direct network, unused host APIs, HTML injection or emoji', () => {
    const files = [...walk(join(SRC, 'widget')), ...walk(join(SRC, 'shared'))]
    expect(files.length).toBeGreaterThan(10)
    const hits: string[] = []
    for (const f of files) {
      // Comments may mention the forbidden names to document the rule.
      const code = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/<!--[\s\S]*?-->/g, '')
      for (const [name, re] of FORBIDDEN) if (re.test(code)) hits.push(`${f}: ${name}`)
    }
    expect(hits).toEqual([])
  })
})
