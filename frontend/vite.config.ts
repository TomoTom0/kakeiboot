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
