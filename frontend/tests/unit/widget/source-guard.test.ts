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

// TASK-170 (design: tmp/tasks/tm-170/design_widget-row-grammar.md v3
// §2 W-2/W-3/W-4/W-6/W-9・指摘2（残）): the row grammar's home is the SHARED
// stylesheet pair (shared/styles/row-grammar.css + motion.css) imported by
// BOTH entry points — the surface style.css carries no row vocabulary of its
// own. Static checks, read lazily inside each test (the files land with the
// implementation; a module-level read would fail the file's collection).
describe('TASK-170 row grammar wiring (static)', () => {
  const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')

  it('[covers:widget.row-hover-guard] 行washは @media (hover: hover) 内のみ・focus-visible は media 外・両 main.ts が row-grammar.css を import・--bb-hover は light/dark 両定義', () => {
    const css = strip(read('src/shared/styles/row-grammar.css'))
    // the wash lives ONLY inside the hover-capable media (the widget's main
    // environment is a phone — touch must not keep a sticky wash)
    const m = /@media[^{]*hover:\s*hover[^{]*\{/.exec(css)
    expect(m, '@media (hover: hover) block').not.toBeNull()
    const open = css.indexOf('{', m!.index)
    let depth = 0
    let end = -1
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    const hoverBlock = css.slice(open + 1, end)
    expect(hoverBlock).toMatch(/\.data-row[^{]*:hover[^{]*\{[^}]*var\(--bb-hover\)/)
    // focus-visible sits OUTSIDE the media (keyboard focus exists regardless
    // of hover capability), and no row hover rule leaks out of the media
    const outside = css.slice(0, m!.index) + css.slice(end + 1)
    expect(outside).toMatch(/\.data-row[^{]*:focus-visible/)
    expect(outside).not.toMatch(/\.data-row[^{]*:hover/)
    // both entry points import the shared row grammar ahead of their own sheet
    for (const entry of ['src/web/main.ts', 'src/widget/main.ts']) {
      const src = read(entry)
      expect(src, `${entry} imports row-grammar.css`).toMatch(/row-grammar\.css/)
      const sharedAt = src.indexOf('row-grammar.css')
      const surfaceAt = src.search(/styles?\.css/)
      expect(sharedAt, `${entry} shared css precedes the surface sheet`).toBeLessThan(surfaceAt)
    }
    // the wash token exists for both themes (light / dark blocks)
    const widgetCss = read('src/widget/style.css')
    expect((widgetCss.match(/--bb-hover:/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('[covers:widget.row-appear] bb-appear 語彙は shared/styles/motion.css・両 main.ts import・一覧3画面とItemTableが参照', () => {
    const css = strip(read('src/shared/styles/motion.css'))
    expect(css).toMatch(/\.bb-appear-enter-active[^{]*\{[^}]*transition:\s*opacity/)
    expect(css).toMatch(/\.bb-appear-enter-from[^{]*\{[^}]*opacity:\s*0/)
    expect(css).toMatch(/\.bb-appear-move[^{]*\{[^}]*transition:\s*transform/)
    // reduced-motion turns the vocabulary off
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'))
    expect(reduced).toMatch(/\.bb-appear[^{]*\{[^}]*transition:\s*none/)
    for (const entry of ['src/web/main.ts', 'src/widget/main.ts']) {
      expect(read(entry), `${entry} imports motion.css`).toMatch(/motion\.css/)
    }
    // the row carriers wire the vocabulary (the shared AppearList or a
    // TransitionGroup named bb-appear — either satisfies the grammar)
    for (const f of [
      'src/widget/views/ReceiptListScreen.vue',
      'src/widget/views/DraftListScreen.vue',
      'src/widget/views/DraftBatchScreen.vue',
      'src/shared/components/ItemTable.vue',
    ]) {
      expect(read(f), `${f} references the bb-appear vocabulary`).toMatch(/bb-appear|AppearList/)
    }
  })

  it('[covers:widget.receipt-list-row-grammar][covers:widget.receipt-detail-item-tiers][covers:widget.note-display][covers:widget.receipt-head-grammar] 旧語彙（bb-list・bb-items・bb-total・bb-labels・bb-note・bb-head・bb-title・bb-head-label・receipt-total）は削除され明細・頭部は shared token/component 参照', () => {
    const widgetCss = read('src/widget/style.css')
    for (const v of ['.bb-list', '.bb-items', '.bb-total', '.bb-labels', '.bb-note', '.bb-head', '.bb-title', '.bb-head-label', '.receipt-total']) {
      expect(widgetCss, `${v} is gone from widget/style.css`).not.toContain(v)
    }
    // ItemTable rides the shared .items token; the note vocabulary is .receipt-note
    const itemTable = read('src/shared/components/ItemTable.vue')
    expect(itemTable).not.toContain('bb-items')
    expect(itemTable).toContain('items-total')
    expect(strip(read('src/shared/styles/row-grammar.css'))).toMatch(/\.receipt-note[^{]*\{[^}]*pre-wrap/)
    // review指摘2: the name + inline category share one wrappable container
    // and the amount keeps its own non-shrinking space (a long category
    // wraps, never pushes the amount out of the row)
    const rgCss = strip(read('src/shared/styles/row-grammar.css'))
    expect(rgCss).toMatch(/\.item-line[^{]*\{[^}]*min-width:\s*0/)
    expect(rgCss).toMatch(/\.item-btn \.num[^{]*\{[^}]*white-space:\s*nowrap/)
    // TASK-175 H-7/H-9: the head is the SHARED ReceiptHeader component —
    // both screens mount it and their own head vocabulary (.bb-head /
    // .bb-title / the widget-side .receipt-total rules) is gone from
    // widget/style.css into shared/styles/row-grammar.css
    for (const f of ['src/widget/views/ReceiptScreen.vue', 'src/widget/views/DraftScreen.vue']) {
      const src = read(f)
      expect(src, `${f} mounts ReceiptHeader`).toContain('ReceiptHeader')
      expect(src, `${f} bb-head gone`).not.toContain('bb-head')
      expect(src, `${f} bb-title gone`).not.toContain('bb-title')
      expect(src, `${f} bb-total gone`).not.toContain('bb-total')
      expect(src, `${f} bb-note gone`).not.toContain('bb-note')
    }
    // the head total (strongest tier) and the title-name ellipsis are SHARED
    // definitions now (overflow-wrap: anywhere is gone with .bb-title)
    expect(rgCss).toMatch(/\.receipt-total(__value)?[^{]*\{[\s\S]{0,200}?font-size:\s*1\.9rem/)
    expect(rgCss).toMatch(/\.receipt-title-name[^{]*\{[^}]*text-overflow:\s*ellipsis/)
    expect(widgetCss).not.toMatch(/overflow-wrap:\s*anywhere/)
  })
})
