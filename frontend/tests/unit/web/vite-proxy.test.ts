import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// [covers:web-http.dev-proxy] The Vite dev server proxies the same-origin
// API paths to the backend whose port comes from configs/dev/app.toml (the
// single source of truth) — asserted on the config file text so the build
// cannot silently drift. Vitest runs with the frontend dir as cwd.
const configText = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')

describe('vite dev proxy', () => {
  it('[covers:web-http.dev-proxy] /api,/oauth,/.well-known,/mcp を backend port へ', () => {
    // both ports are read from configs/dev/app.toml, never hardcoded
    expect(configText).toContain("configs/dev/app.toml")
    expect(configText).toContain('appConfig.server.port')
    expect(configText).not.toMatch(/127\.0\.0\.1:\d{4}/)
    for (const p of ["'/api'", "'/oauth'", "'/.well-known'", "'/mcp'"]) {
      expect(configText).toContain(p)
    }
  })
})
