import { readFileSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'
import { parse } from 'smol-toml'

// Real-browser checks (chromium headless) against the Vite dev server.
// The backend is not started: tests/browser/stub.ts answers /api/* and
// /media/* inside the browser (page.route) from the in-memory mock DataApi,
// so the logged-in screens render without a session.
//
// Port: configs/dev/app.toml [frontend].dev_port is the single source of truth.
const appConfig = parse(
  readFileSync(new URL('../configs/dev/app.toml', import.meta.url), 'utf8'),
) as { frontend: { dev_port: number } }
const baseURL = `http://localhost:${appConfig.frontend.dev_port}`

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.ts',
  // The mock DataApi imports '@/...' (path alias in tsconfig.app.json).
  tsconfig: './tsconfig.vitest.json',
  // Generated outputs live under test-results/ (gitignored as a directory).
  outputDir: 'test-results/browser/artifacts',
  reporter: [['list']],
  fullyParallel: false,
  workers: 1,
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
  },
  webServer: {
    command: 'pnpm dev --strictPort',
    // the web entry is web.html (no index.html; tests/browser/stub.ts serves it for app routes)
    url: `${baseURL}/web.html`,
    // An already running dev server (mise run dev:frontend) is reused and left running.
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
