/**
 * @vitest-environment node
 * (importing vite.config.ts runs fileURLToPath(new URL(..., import.meta.url)),
 * which needs the real file-scheme module URL of the node environment)
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../../../vite.config'
import type { Plugin, ViteDevServer } from 'vite'

// [covers:web-http.dev-proxy] The Vite dev server proxies the same-origin
// API paths to the backend whose port comes from configs/dev/app.toml (the
// single source of truth) — asserted on the config file text so the build
// cannot silently drift. Vitest runs with the frontend dir as cwd.
const configText = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')

// [covers:web-http.dev-strict-port] The mise task definitions live at the
// repo root (one level above the frontend cwd).
const miseText = readFileSync(resolve(process.cwd(), '../mise.toml'), 'utf8')

describe('vite dev server', () => {
  it('[covers:web-http.dev-proxy] /api,/oauth,/.well-known,/mcp を backend port へ', () => {
    // both ports are read from configs/dev/app.toml, never hardcoded
    expect(configText).toContain("configs/dev/app.toml")
    expect(configText).toContain('appConfig.server.port')
    expect(configText).not.toMatch(/127\.0\.0\.1:\d{4}/)
    for (const p of ["'/api'", "'/oauth'", "'/.well-known'", "'/mcp'"]) {
      expect(configText).toContain(p)
    }
  })

  // [covers:web-http.dev-spa-fallback] Vite 8's html fallback (default
  // appType 'spa') rewrites unmatched navigations to /index.html — which
  // does not exist in this multi-entry build (web.html / widget.html), so
  // clean URLs like / or /receipts/101 404 in dev while the production
  // backend serves web.html for every non-API path (static_files.rs
  // spa_fallback). Vite 8 no longer consumes a server.rewrites option, so
  // the fallback is retargeted by a configureServer post-hook that runs
  // after Vite's own fallback logic (assets, /favicon.ico and non-HTML
  // requests are excluded there; proxied paths are answered by the proxy
  // middleware before the fallback ever runs).
  it('[covers:web-http.dev-spa-fallback] clean URL（/ ・/receipts/101 等）を /web.html へ', () => {
    expect(configText).toContain('configureServer')
    expect(configText).toContain("req.url.replace('/index.html', '/web.html')")
    expect(configText).toMatch(/plugins:\s*\[vue\(\), devSpaFallbackPlugin\]/)
    // dead-option guard: Vite 8 silently ignores server.rewrites
    expect(configText).not.toContain('rewrites:')
  })

  // The config-text assertions above cannot see whether the middleware
  // actually rewrites — its registration order inside Vite's middleware
  // chain is an internal detail a future upgrade could change silently.
  // Exercise the captured post-hook middleware directly instead.
  type Middleware = (req: { url?: string }, _res: unknown, next: () => void) => void
  function runMiddleware(mw: Middleware, url: string): { after: string | undefined; nextCalled: boolean } {
    const req = { url }
    let nextCalled = false
    mw(req, {}, () => (nextCalled = true))
    return { after: req.url, nextCalled }
  }
  function pluginMiddleware(): Middleware {
    let registered: Middleware | undefined
    const plugin = (config.plugins as Plugin[]).find((p) => p.name === 'dev-spa-fallback-web-html')
    expect(plugin, 'devSpaFallbackPlugin is registered').toBeDefined()
    // ObjectHook is the function or a { handler } wrapper — unwrap either
    const hook = plugin!.configureServer
    const configure = (typeof hook === 'function' ? hook : hook?.handler) as unknown as (
      server: ViteDevServer,
    ) => (() => void) | undefined
    // calling configureServer(server) returns the post-hook (the function
    // Vite runs after its own html fallback); running it must register
    // exactly one middleware on the stub server (the plugin only calls
    // middlewares.use)
    const postHook = configure({ middlewares: { use: (m: unknown) => (registered = m as Middleware) } } as unknown as ViteDevServer)
    expect(postHook, 'configureServer returns the post-hook').toBeTypeOf('function')
    postHook!()
    expect(registered).toBeTypeOf('function')
    return registered!
  }

  it('[covers:web-http.dev-spa-fallback] middleware は /index.html のみ /web.html へ書換え、他は素通りして next を呼ぶ', () => {
    const mw = pluginMiddleware()
    // Vite's html fallback assigns req.url = '/index.html' verbatim (query
    // stripped), so the rewrite always matches at position 0
    expect(runMiddleware(mw, '/index.html')).toEqual({ after: '/web.html', nextCalled: true })
    // file-backed html entries, dev client, proxied paths and mid-string
    // occurrences are passed through untouched
    expect(runMiddleware(mw, '/web.html')).toEqual({ after: '/web.html', nextCalled: true })
    expect(runMiddleware(mw, '/widget.html')).toEqual({ after: '/widget.html', nextCalled: true })
    expect(runMiddleware(mw, '/@vite/client')).toEqual({ after: '/@vite/client', nextCalled: true })
    expect(runMiddleware(mw, '/api/receipts')).toEqual({ after: '/api/receipts', nextCalled: true })
    expect(runMiddleware(mw, '/web.html?next=/index.html')).toEqual({ after: '/web.html?next=/index.html', nextCalled: true })
  })

  it('[covers:web-http.dev-strict-port] dev:frontend は --strictPort 付きで起動（40281 占用時に別 port へ逃げない）', () => {
    // the port is the fixed assignment in configs/dev/app.toml
    // ([frontend].dev_port); moving to another port would hide the
    // collision. Same pattern as the playwright webServer command.
    expect(miseText).toMatch(/run = "pnpm dev --strictPort"/)
  })
})
