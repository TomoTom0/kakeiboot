// The vertical bar's width cap off the ONE CSS token (TASK-162 §6-1: the
// --trend-bar-w definition in web/styles.css — the twin of --row-bar-h). The
// token is the single source: every vertical-bar DOM (the TrendBars
// .bar/.bar-stack and the Receipts .daily-bar) caps its width at
// min(cell, token) off THIS read — a JS mirror literal would drift from the
// stylesheet. The 48 fallback covers only an unreadable var (a missed
// definition, a non-px read) or a non-DOM environment.

/** The cap in px off --trend-bar-w as the element's computed style resolves
 * it (custom properties inherit, so any element inside :root reads it). */
export function barWidthCap(el: Element | null): number {
  if (!el || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return 48
  const v = Number.parseFloat(window.getComputedStyle(el).getPropertyValue('--trend-bar-w'))
  return Number.isFinite(v) && v > 0 ? v : 48
}
