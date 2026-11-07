import type { PaymentMethod } from './types'

const yen = new Intl.NumberFormat('ja-JP')

/** Amount in yen with ja-JP grouping. Negative values keep the minus sign (spec §11-7). */
export function formatYen(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const sign = value < 0 ? '-' : ''
  return `${sign}${yen.format(Math.abs(value))}円`
}

/** Signed difference (+/-) used for comparisons with the previous period. */
export function formatSignedYen(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  return value > 0 ? `+${formatYen(value)}` : formatYen(value)
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-'
  const pct = Math.round(value * 10) / 10
  return `${pct > 0 ? '+' : ''}${pct}%`
}

/**
 * Truncate a label in JS before passing it to an SVG <text> node (spec §11-6).
 * Counts code points so surrogate pairs are not split.
 */
export function truncateLabel(label: string, max: number): string {
  const chars = Array.from(label)
  if (chars.length <= max) return label
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/**
 * Estimate a text's drawn width under the monospace assumption (TASK-161
 * §6-2): every code point paints one em — the char-count × em conversion the
 * axis-label thinning and the in-bar series labels share. A canvas measure
 * would be exact but is overkill for a fit decision; the estimate errs wide
 * (CJK-heavy labels thin/hide a little early, never overlapping).
 */
export function estimateTextWidth(text: string, fontPx: number): number {
  return Array.from(text).length * fontPx
}

/**
 * Truncate a label to a drawn-width budget (TASK-161 §6-1/§6-2 — the px twin
 * of truncateLabel): the widest code-point prefix (plus the … tail) that fits
 * `maxWidth` at `fontPx`, never empty. A label that already fits returns
 * unchanged.
 */
export function truncateLabelWidth(label: string, maxWidth: number, fontPx: number): string {
  if (fontPx <= 0) return label
  const budget = Math.floor(maxWidth / fontPx)
  const chars = Array.from(label)
  if (chars.length <= budget) return label
  return `${chars.slice(0, Math.max(1, budget - 1)).join('')}…`
}

/**
 * The VERTICAL bars' in-segment label fit (TASK-162 §2-3, design: tmp/tasks/
 * tm-162/design_breakdown_stack.md v2): the label runs top→bottom, so the
 * fit axis is the segment's drawn HEIGHT and the width is a fixed 1-em +
 * paddings (15px) that never needs judging. The full name whenever
 * `estimateTextWidth(label, font) + the 0.02em tracking` fits the height
 * minus the 4px end paddings, the … tail truncation next, null when even the
 * 1-char + … minimum cannot fit (the caller keeps the colour-only fallback —
 * the jsdom unmeasured size 0 lands here). The letter-spacing rides the
 * estimate as a per-char 2% of the em (§3-1's token), erring wide.
 */
export function verticalSegLabel(label: string, sizePx: number, fontPx = 11): string | null {
  // the tracking-inclusive per-char pitch: 1em + 0.02em letter-spacing
  const pitch = fontPx * 1.02
  const avail = sizePx - 4
  // the half-pixel tolerance: the 26px fold bar's own arithmetic (2 × 11px +
  // 4px pads) leaves the「○…」minimum at exactly 22px of glyphs — the 2%
  // tracking's 0.44px must not evict the minimum the fold guarantees
  const fits = (text: string): boolean => Array.from(text).length * pitch <= avail + 0.5
  if (avail <= 0 || label === '') return null
  if (fits(label)) return label
  const fitted = truncateLabelWidth(label, avail, pitch)
  return fits(fitted) ? fitted : null
}

/**
 * Format an ISO date "YYYY-MM-DD" as "YYYY年M月D日" for chart axis labels (spec §11-6).
 * Returns `raw` unchanged when it does not strictly match the form — no Date parsing,
 * so timezone shifts and loose formats stay out of scope.
 */
export function formatIsoDateJa(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : raw
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: '現金',
  credit_card: 'クレジットカード',
  debit_card: 'デビットカード',
  e_money: '電子マネー',
  qr_code: 'QRコード決済',
  point: 'ポイント',
  gift_card: 'ギフトカード',
  bank_transfer: '銀行振込',
  other: 'その他',
}

export function paymentLabel(method: PaymentMethod | null | undefined): string {
  if (!method) return '-'
  return PAYMENT_LABELS[method] ?? method
}

export const MEDIA_PATH_PREFIX = '/media/img/'

/**
 * Only `_meta` image URLs that point at `<origin>/media/img/<token>` may be put in
 * `<img :src>` (spec §11-6). `allowedOrigin` pins the backend origin when known
 * (build-time `VITE_MEDIA_ORIGIN`); otherwise any https origin is accepted and the
 * resource CSP (`resourceDomains`, spec §11-4) restricts the actual load.
 * http is allowed only for loopback hosts (local development).
 */
export function isSafeImageUrl(raw: unknown, allowedOrigin?: string | null): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false
  if (url.username || url.password || url.search || url.hash) return false
  if (!url.pathname.startsWith(MEDIA_PATH_PREFIX)) return false
  const token = url.pathname.slice(MEDIA_PATH_PREFIX.length)
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return false
  if (allowedOrigin && url.origin !== allowedOrigin) return false
  return true
}
