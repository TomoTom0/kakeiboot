/**
 * @vitest-environment node
 * (imports the build plugin and reads the config files, both node-side)
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inlineWidgetHtml } from '@/build/inline-widget-html'

// [covers:widget.single-file-html-build] The widget entry must build into a
// self-contained HTML (spec_mcp-tools.md 11-1): ChatGPT loads the template
// as one ui:// resource and cannot resolve /assets/* references, which is
// what left the draft panel a white box (TASK-50).

type FakeAsset = { type: 'asset'; source: string }
type FakeChunk = { type: 'chunk'; code: string }
type FakeBundle = Record<string, FakeAsset | FakeChunk>

function widgetHtml(source: string): FakeAsset {
  return { type: 'asset', source }
}

/** Run the plugin's generateBundle with a minimal Rollup context. */
function runGenerate(bundle: FakeBundle): { errors: unknown[] } {
  const plugin = inlineWidgetHtml()
  const errors: unknown[] = []
  const ctx = {
    error(e: unknown): never {
      throw e
    },
  }
  const hook = plugin.generateBundle as unknown as (
    this: typeof ctx,
    options: unknown,
    bundle: FakeBundle,
  ) => void
  try {
    hook.call(ctx, {}, bundle)
  } catch (e) {
    errors.push(e)
  }
  return { errors }
}

describe('inline widget html plugin', () => {
  it('[covers:widget.single-file-html-build] script・stylesheet を inline し modulepreload を除去する', () => {
    const bundle: FakeBundle = {
      'widget.html': widgetHtml(
        [
          '<!doctype html><html lang="ja"><head><meta charset="UTF-8" />',
          '<title>budget-book widget</title>',
          '<script type="module" crossorigin src="/assets/widget-Ck0EYMOd.js"></script>',
          '<link rel="modulepreload" crossorigin href="/assets/LabelDots-DS2HcaGO.js">',
          '<link rel="stylesheet" crossorigin href="/assets/widget-BGVt-B26.css">',
          '</head><body><div id="app"></div></body></html>',
        ].join('\n'),
      ),
      'assets/widget-Ck0EYMOd.js': {
        type: 'chunk',
        code: 'const s = "</script>"; console.log(s); createApp().mount("#app")',
      },
      'assets/widget-BGVt-B26.css': {
        type: 'asset',
        source: '.bb-app { color: var(--bb-fg); }',
      },
    }
    const { errors } = runGenerate(bundle)
    expect(errors).toEqual([])
    const html = String((bundle['widget.html'] as FakeAsset).source)
    // modulepreload is gone (its target is not emitted)
    expect(html).not.toContain('modulepreload')
    expect(html).not.toContain('LabelDots')
    // no external script/link reference survives
    expect(html).not.toMatch(/<script[^>]*\ssrc=/)
    expect(html).not.toMatch(/<link[^>]*\shref=/)
    // the JS is inlined as a module script, with </script escaped
    expect(html).toContain('<script type="module">')
    expect(html).toContain('const s = "<\\/script>";')
    expect(html).not.toContain('"</script>"')
    // the CSS is inlined as a style element
    expect(html).toContain('<style>')
    expect(html).toContain('.bb-app { color: var(--bb-fg); }')
    // the standalone files are not emitted anymore
    expect(bundle['assets/widget-Ck0EYMOd.js']).toBeUndefined()
    expect(bundle['assets/widget-BGVt-B26.css']).toBeUndefined()
  })

  it('[covers:widget.single-file-html-build] 参照する asset が bundle に無い・CSS 内 url()/@import は build を落とす', () => {
    // a script reference whose file is not in the bundle: the postcondition
    // must fail the build instead of silently leaving an external reference
    const missing = {
      'widget.html': widgetHtml(
        '<script type="module" src="/assets/ghost.js"></script>',
      ),
    }
    expect(runGenerate(missing).errors).toHaveLength(1)

    // CSS with an external url() cannot be inlined self-contained
    const cssUrl = {
      'widget.html': widgetHtml('<link rel="stylesheet" href="/assets/a.css">'),
      'assets/a.css': { type: 'asset' as const, source: '.x { background: url(/assets/bg.png) }' },
    }
    expect(runGenerate(cssUrl).errors).toHaveLength(1)

    // CSS @import is the same
    const cssImport = {
      'widget.html': widgetHtml('<link rel="stylesheet" href="/assets/a.css">'),
      'assets/a.css': { type: 'asset' as const, source: "@import './other.css';" },
    }
    expect(runGenerate(cssImport).errors).toHaveLength(1)
  })

  it('[covers:widget.single-file-html-build] build script と widget pass の wiring が設定から外れていない', () => {
    // The single-file property is only as good as the wiring that runs the
    // widget pass: package.json must chain it after the web build, the
    // widget pass (vite.widget.config.ts) must keep the single entry +
    // codeSplitting:false + emptyOutDir:false + the inline plugin, and the
    // web pass must build web.html only (no orphan widget chunks). The
    // plugin itself must be a post plugin: Vite 8 (rolldown) renders the
    // HTML entry after the core plugins, so without enforce: 'post' the
    // bundle holds just the JS/CSS chunks and widget.html cannot be found.
    const pkg = readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    expect(pkg).toMatch(/"build":\s*"vue-tsc[^"]*&& vite build && vite build --config vite\.widget\.config\.ts"/)
    const widgetCfg = readFileSync(resolve(process.cwd(), 'vite.widget.config.ts'), 'utf8')
    expect(widgetCfg).toMatch(/codeSplitting:\s*false/)
    expect(widgetCfg).toMatch(/emptyOutDir:\s*false/)
    expect(widgetCfg).toContain('inlineWidgetHtml()')
    expect(widgetCfg).toMatch(/input:\s*\{\s*widget:/)
    const webCfg = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')
    expect(webCfg).toMatch(/input:\s*\{\s*web:/)
    expect(webCfg).not.toMatch(/widget:\s*fileURLToPath/)
    expect(inlineWidgetHtml().enforce).toBe('post')
    expect(inlineWidgetHtml().apply).toBe('build')
  })
})
