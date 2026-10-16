// Browser-side API stub for the real-browser checks: every /api/* request is
// answered by page.route from the in-memory mock DataApi (the same one the
// unit tests use), and /media/img/* returns a placeholder receipt image. No
// request reaches the Vite proxy / backend.

import type { Page, Route } from '@playwright/test'
import type { Me } from '@/web/api/auth'
import { ApiError } from '@/web/api/http'
import { createMockDataApi } from '@/web/api/data/mock'
import type { DataApi } from '@/web/api/data/types'
import { isLabelColor, type LabelColor } from '@/shared/labels'

export const ME: Me = {
  user_id: 1,
  account_number: 'BB-7K3M-Q9XA',
  display_name: '山田 花子',
  default_ledger_id: 1,
  ledgers: [
    { id: 1, name: 'default book', role: 'owner', color: 'teal' },
    { id: 2, name: '家族の家計簿', role: 'editor', color: 'orange' },
  ],
  auth_at: Date.now(),
}

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="1024" viewBox="0 0 512 1024">
<rect width="512" height="1024" fill="#f4f1ea"/>
${Array.from({ length: 20 }, (_, i) => `<rect x="48" y="${80 + i * 44}" width="${200 + ((i * 53) % 220)}" height="14" fill="#c9c3b6"/>`).join('')}
</svg>`

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function labelColors(v: string | null): LabelColor[] | undefined {
  if (!v) return undefined
  return v.split(',').filter(isLabelColor)
}

function num(v: string | null): number | undefined {
  return v === null || v === '' ? undefined : Number(v)
}

async function dispatch(api: DataApi, method: string, path: string, q: URLSearchParams, body: unknown): Promise<unknown> {
  const m = /^\/api\/ledgers\/(\d+)\/(.+)$/.exec(path)
  if (!m) throw new ApiError(404, 'not_found')
  const l = Number(m[1])
  const rest = m[2]!
  const str = (k: string) => q.get(k) ?? undefined
  const b = body as never
  let r: RegExpExecArray | null
  if (method === 'GET' && rest === 'catalog') return api.getCatalog(l, q.get('include_archived') === 'true')
  if (method === 'POST' && rest === 'categories') return api.manageCategory(l, b)
  if (method === 'GET' && rest === 'stores') return api.listStores(l, str('query'))
  if (method === 'GET' && rest === 'labels') return api.listLabels(l)
  if (method === 'GET' && rest === 'stats')
    return api.getStats(l, {
      report: str('report') as never,
      month: str('month'),
      year: num(q.get('year')),
      from: str('from'),
      to: str('to'),
      category: str('category'),
      store: str('store'),
      item_query: str('item_query'),
      label_colors: labelColors(q.get('label_colors')),
    })
  if (method === 'GET' && rest === 'receipts')
    return api.listReceipts(l, {
      from: str('from'),
      to: str('to'),
      store: str('store'),
      category: str('category'),
      item_query: str('item_query'),
      label_colors: labelColors(q.get('label_colors')),
      include_deleted: q.get('include_deleted') === 'true',
      limit: num(q.get('limit')),
      cursor: str('cursor'),
    })
  if ((r = /^stores\/(\d+)$/.exec(rest)) && method === 'PATCH') return api.updateStore(l, Number(r[1]), b)
  if ((r = /^stores\/(\d+)\/merge$/.exec(rest)) && method === 'POST')
    return api.mergeStores(l, Number(r[1]), (body as { into_store_id: number }).into_store_id)
  if ((r = /^receipts\/(\d+)$/.exec(rest))) {
    if (method === 'GET') return api.getReceipt(l, Number(r[1]))
    if (method === 'PATCH') return api.updateReceipt(l, Number(r[1]), b)
  }
  if ((r = /^receipts\/(\d+)\/delete$/.exec(rest)) && method === 'POST') return api.deleteReceipt(l, Number(r[1]), b)
  if ((r = /^receipts\/(\d+)\/labels$/.exec(rest)) && method === 'POST') return api.setReceiptLabels(l, Number(r[1]), b)
  if ((r = /^labels\/([a-z]+)$/.exec(rest)) && method === 'PATCH') {
    const color = r[1]!
    if (!isLabelColor(color)) throw new ApiError(404, 'not_found')
    return api.updateLabelTitle(l, color, b)
  }
  throw new ApiError(404, 'not_found')
}

/**
 * Install the stub on a page. `loggedIn: false` makes /api/auth/me answer 401
 * (login screen).
 */
export async function installApiStub(page: Page, opts: { loggedIn?: boolean } = {}): Promise<void> {
  const loggedIn = opts.loggedIn ?? true
  const api = createMockDataApi()

  // SPA history fallback: the Vite dev server has no index.html (the web entry
  // is web.html) and answers 404 for /receipts/101 etc., so document requests
  // for app routes are served the web.html shell.
  await page.route(
    (url) => !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/media/') && !/\.[a-z0-9]+$/i.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback()
      const origin = new URL(route.request().url()).origin
      const res = await route.fetch({ url: `${origin}/web.html` })
      return route.fulfill({ response: res })
    },
  )

  await page.route((url) => url.pathname.startsWith('/media/img/'), (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER_SVG }),
  )
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const method = req.method()
    const path = url.pathname
    if (path === '/api/auth/me') {
      return loggedIn ? json(route, 200, ME) : json(route, 401, { error: 'unauthorized' })
    }
    if (path === '/api/auth/logout') return route.fulfill({ status: 204 })
    if (path === '/api/oauth/grants') return json(route, 200, [])
    if (path === '/api/passkeys') return json(route, 200, [])
    if (path.startsWith('/api/webauthn/')) return json(route, 400, { error: 'stubbed' })
    try {
      const body = req.postData() ? (JSON.parse(req.postData()!) as unknown) : undefined
      const result = await dispatch(api, method, path, url.searchParams, body)
      return result === undefined ? route.fulfill({ status: 204 }) : json(route, 200, result)
    } catch (e) {
      if (e instanceof ApiError) return json(route, e.status, { error: e.code })
      return json(route, 500, { error: String(e) })
    }
  })
}
