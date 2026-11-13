// Browser-side API stub for the real-browser checks: every /api/* request is
// answered by page.route from the in-memory mock DataApi (the same one the
// unit tests use), and /media/img/* returns a placeholder receipt image. No
// request reaches the Vite proxy / backend.

import type { Page, Route } from '@playwright/test'
import type { ConsentInfo, Grant, Me } from '@/web/api/auth'
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

// /media/img/* answer (TASK-184 review): a receipt-looking placeholder —
// cream thermal-paper ground, store head + datetime, dotted rules, the
// representative seven-line item table with 小計/合計/お預り/お釣り, and a
// barcode band — instead of the old uniform gray skeleton bars. Same 512x1024
// box, same route / content-type; only the picture changed. The lines mirror
// the README representative receipt (mock.ts SHOWCASE_RECEIPTS 10-13 5,336円).
const R_ITEMS: Array<[name: string, yen: string]> = [
  ['鶏もも肉2パック', '796'],
  ['豚バラ肉', '698'],
  ['米5kg', '2,280'],
  ['キリン一番搾り6缶', '948'],
  ['キャベツ', '198'],
  ['きゅうり', '158'],
  ['卵10個', '258'],
]
// fixed alternating barcode bar widths — no randomness, so captures are
// byte-stable across runs
const R_BARS = [3, 2, 4, 2, 3, 3, 2, 5, 2, 3, 4, 2, 3, 2, 4, 3, 2, 3, 5, 2, 3, 2, 4, 3, 2, 3, 2, 4, 2, 3, 3, 2, 4, 2, 3, 2, 5, 3, 2, 3]
const rLine = (name: string, yen: string, y: number, strong = false): string => {
  const size = strong ? 25 : 23
  const weight = strong ? ' font-weight="bold"' : ''
  return (
    `<text x="48" y="${y}" font-size="${size}"${weight} fill="#33312b">${name}</text>` +
    `<text x="464" y="${y}" text-anchor="end" font-size="${size}"${weight} fill="#33312b">${yen}</text>`
  )
}
const rRule = (y: number): string =>
  `<line x1="44" y1="${y}" x2="468" y2="${y}" stroke="#a49c8a" stroke-width="2" stroke-dasharray="7 5"/>`
const rBarcode = R_BARS.reduce<{ svg: string; x: number }>(
  (acc, w) => ({ svg: `${acc.svg}<rect x="${acc.x}" y="742" width="${w}" height="170" fill="#1e1d19"/>`, x: acc.x + w + 4 }),
  { svg: '', x: 122 },
).svg
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="1024" viewBox="0 0 512 1024" font-family="sans-serif">
<rect width="512" height="1024" fill="#f8f4e9"/>
<text x="256" y="94" text-anchor="middle" font-size="36" font-weight="bold" fill="#262521">サンライフ</text>
<text x="256" y="124" text-anchor="middle" font-size="20" fill="#57544b">2026年10月13日（火） 19:44</text>
${rRule(152)}
${R_ITEMS.map(([n, v], i) => rLine(n, v, 194 + i * 42)).join('\n')}
${rRule(486)}
${rLine('小計', '5,336', 522)}
${rLine('合計', '5,336', 562, true)}
${rRule(590)}
${rLine('お預り', '10,000', 626)}
${rLine('お釣り', '4,664', 664)}
${rBarcode}
</svg>`

// Consent screen fixture (TASK-37 usage figures): the scope descriptions are
// verbatim copies of the backend scope_description
// (backend/src/auth/oauth/mod.rs) so a captured consent.png shows exactly the
// wording the production consent screen shows.
export const CONSENT: ConsentInfo = {
  client_display: 'ChatGPT',
  client_id: 'https://chatgpt.com/x',
  scopes: [
    { name: 'ledger.read', description: '家計簿の参照（レシートや下書きの検索・閲覧、集計、カテゴリや店の一覧の表示）' },
    { name: 'ledger.write', description: '家計簿の変更（レシートの作成・修正・確定・削除、カテゴリや店の管理）' },
  ],
  ledger_name: 'default book',
  // the default ledger's own display color (TASK-20 §6-2 / §7-1: a real
  // palette key so the captured consent.png shows the chip as production does)
  ledger_color: 'teal',
  user_display_name: ME.display_name,
}

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
  if (method === 'GET' && rest === 'analysis')
    return api.getAnalysis(l, {
      axis: str('axis') as never,
      metric: str('metric') as never,
      month: str('month'),
      year: num(q.get('year')),
      from: str('from'),
      to: str('to'),
      category: str('category'),
      store: str('store'),
      store_id: num(q.get('store_id')),
      store_category: str('store_category'),
      item_query: str('item_query'),
      label_colors: labelColors(q.get('label_colors')),
      limit: num(q.get('limit')),
    })
  if (method === 'GET' && rest === 'analysis/trend')
    return api.getAnalysisTrend(l, {
      axis: str('axis') as never,
      metric: str('metric') as never,
      granularity: str('granularity') as never,
      month: str('month'),
      year: num(q.get('year')),
      from: str('from'),
      to: str('to'),
      category: str('category'),
      store: str('store'),
      store_id: num(q.get('store_id')),
      store_category: str('store_category'),
      item_query: str('item_query'),
      label_colors: labelColors(q.get('label_colors')),
      limit: num(q.get('limit')),
    })
  if (method === 'GET' && rest === 'analysis/item')
    return api.getAnalysisItem(l, {
      item_id: num(q.get('item_id')),
      item_query: str('item_query'),
      month: str('month'),
      year: num(q.get('year')),
      from: str('from'),
      to: str('to'),
      category: str('category'),
      store: str('store'),
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
 * (login screen). `feed` seeds extra mock receipts (104..112, TASK-19 §2-6)
 * for the feed tests; `richLabels` titles the five label definitions and puts
 * all five on receipt 102 (TASK-60 §5); `bareTags` strips receipt 101 (no
 * payment/category, no assigned labels — the seed of TASK-60 §9-1 alt-2,
 * unused by the specs since TASK-167's head rework, kept as the minimal-host
 * variation); `longDeletedHead` seeds the deleted long-store-name big-total
 * receipt 113 (TASK-175 review #2, reached by direct URL); `showcase` layers
 * the six-month README figure seed (TASK-184: 2026-05..10 lifestyle data on
 * top of the default, store names swapped to realistic ones); `grants` replaces the
 * /api/oauth/grants answer (default stays the empty list — TASK-20 §7-1 /
 * §10-3: the grant-row chip check feeds its own fixture rows). The default
 * mock data is unchanged, and the options combine freely.
 */
export async function installApiStub(
  page: Page,
  opts: {
    loggedIn?: boolean
    feed?: number
    richLabels?: boolean
    bareTags?: boolean
    longDeletedHead?: boolean
    showcase?: boolean
    grants?: Grant[]
    /** pinned "now" for page.clock (JST ISO); default 2026-10-15 */
    now?: string
  } = {},
): Promise<void> {
  const loggedIn = opts.loggedIn ?? true
  const api = createMockDataApi({
    feed: opts.feed,
    richLabels: opts.richLabels,
    bareTags: opts.bareTags,
    longDeletedHead: opts.longDeletedHead,
    showcase: opts.showcase,
  })

  // The mock data's era, pinned (TASK-162's browser-suite audit): the mock's
  // records live in 2026-10 and the app anchors its initial trend window /
  // current-month state on TODAY — a real clock drifts the whole suite's
  // "initial window" away from its fixtures the moment the calendar month
  // rolls over (the 2026-11-04 run caught INIT as 2026-06..11). The clock
  // starts at the unit tests' fixed "today" (2026-10-15 JST) and keeps
  // running from there, matching every fixture the spec files pin. `now`
  // overrides the pin for a spec that needs a different era — the README
  // capture (capture.readme.spec.ts) pins 10-31 so the showcase seed's
  // 10/19..30 rows ride the current month, week table and recent feed.
  await page.clock.install({ time: opts.now ?? '2026-10-15T12:00:00+09:00' })

  // SPA history fallback for document requests. The dev server itself now
  // retargets clean URLs to web.html (vite.config.ts devSpaFallbackPlugin,
  // TASK-29); serving the shell here too keeps the browser tests independent
  // of that plugin's registration order inside Vite's middleware chain.
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
    if (path === '/api/oauth/grants') return json(route, 200, opts.grants ?? [])
    if (path.startsWith('/api/oauth/requests/')) return json(route, 200, CONSENT)
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
