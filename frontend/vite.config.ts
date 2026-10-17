import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { parse } from 'smol-toml'

// Single source of truth for ports: configs/dev/app.toml (local development).
const appConfig = parse(
  readFileSync(new URL('../configs/dev/app.toml', import.meta.url), 'utf8'),
) as { server: { port: number }; frontend: { dev_port: number } }

// Dev proxy: same-origin paths the SPA calls are forwarded to the backend
// (configs/dev/app.toml [server].port), so cookies and Origin stay first-party.
const backend = `http://127.0.0.1:${appConfig.server.port}`

// Multi-entry build: `web` (regular SPA) and `widget` (MCP widget HTML).
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: appConfig.frontend.dev_port,
    proxy: {
      '/api': backend,
      '/oauth': backend,
      '/.well-known': backend,
      '/mcp': backend,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // without an explicit css target the Lightning CSS minifier rewrites
    // "max-width: 899px" queries into the Level 4 range syntax
    // "(width<=899px)", which Safari < 16.4 / Chrome < 104 treat as an
    // unknown media feature: the whole block is dropped there and the
    // mobile shell (menu button, tabbar, drawer sidebar) disappears.
    // Safari 15 keeps the classic (max-width: ...) form.
    cssTarget: 'safari15',
    rollupOptions: {
      input: {
        web: fileURLToPath(new URL('./web.html', import.meta.url)),
        widget: fileURLToPath(new URL('./widget.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
  },
})
