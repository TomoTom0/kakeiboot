// Build-time plugin (TASK-50): the ChatGPT sandbox loads the widget
// template as one ui:// resource (spec_mcp-tools.md 11-1) and cannot
// resolve /assets/* references — an un-inlined build left the draft panel a
// blank white box. This plugin inlines widget.html's module scripts and
// stylesheets into the HTML, drops the modulepreload links (their targets
// are not emitted) and fails the build whenever an external reference would
// survive. Build-only code: nothing imports it from the app entries, so it
// never enters the bundles. Used by vite.widget.config.ts.
import type { Plugin } from 'vite'

type BundleFile = { type?: string; code?: string; source?: string | Uint8Array }

/** Emitted file key of an asset URL ("/assets/x.js", "./assets/x.css"). */
function bundleKey(url: string): string {
  return url.replace(/^\//, '').replace(/^\.\//, '')
}

function assetText(f: BundleFile | undefined): string | null {
  if (!f) return null
  if (typeof f.code === 'string') return f.code
  if (typeof f.source === 'string') return f.source
  if (f.source instanceof Uint8Array) return new TextDecoder().decode(f.source)
  return null
}

export function inlineWidgetHtml(): Plugin {
  return {
    name: 'inline-widget-html',
    apply: 'build',
    // Vite 8 (rolldown) renders the HTML entry only after the core plugins,
    // so widget.html appears in the bundle for post plugins — without this
    // the bundle holds just the JS/CSS chunks and the HTML cannot be found.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = bundle as unknown as Record<string, BundleFile>
      const htmlFile = files['widget.html']
      if (!htmlFile || typeof htmlFile.source !== 'string') {
        this.error('widget.html not found in the build output')
        return
      }
      let html = htmlFile.source
      // modulepreload targets are not emitted — drop the links entirely
      html = html.replace(/<link\b[^>]*rel="modulepreload"[^>]*>\s*/g, '')
      // inline the module scripts ("</script" would close the host tag, so
      // it is escaped; "<\/script" is the same character sequence in every
      // JS string / template / regex context)
      html = html.replace(/<script\b[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g, (whole, url: string) => {
        const key = bundleKey(url)
        const text = assetText(files[key])
        if (text === null) {
          this.error(`widget.html references "${url}" which is not in the bundle`)
          return whole
        }
        delete files[key]
        // `</script` and `<!--` both terminate (or double-escape) the inline
        // script context for the HTML parser — escape both
        const safe = text
          .replace(/<\/script/gi, '<\\/script')
          .replace(/<!--/g, '<\\!--')
        return `<script type="module">\n${safe}\n</script>`
      })
      // inline the stylesheets
      html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (whole) => {
        const url = /href="([^"]+)"/.exec(whole)?.[1] ?? ''
        const key = bundleKey(url)
        const text = assetText(files[key])
        if (text === null) {
          this.error(`widget.html references "${url}" which is not in the bundle`)
          return whole
        }
        if (/<\/style/i.test(text)) {
          this.error(`stylesheet "${url}" contains "</style" and cannot be inlined`)
        }
        if (/url\(|@import/.test(text)) {
          this.error(`stylesheet "${url}" has external references (url()/@import) and cannot be inlined`)
        }
        delete files[key]
        return `<style>\n${text}\n</style>`
      })
      // postcondition: the served template must be self-contained
      if (/<script\b[^>]*\ssrc=/.test(html)) {
        this.error('widget.html still references an external script')
      }
      if (/<link\b[^>]*\shref=/.test(html)) {
        this.error('widget.html still references an external link')
      }
      htmlFile.source = html
    },
  }
}
