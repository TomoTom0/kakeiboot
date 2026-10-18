// TASK-60 measurement helpers for verify-labels.spec.ts (verify-shell.spec.ts
// keeps its evaluates inline instead of importing these): the WCAG contrast
// arithmetic and a rect-inside-viewport predicate, per
// tmp/tasks/tm-60/design_browser-extension.md §4. Pure computation only — no
// page dependency lives here (the page-side local helpers stay duplicated
// per spec file, the tm-19 no-cross-import rule). No [covers:<id>] tag:
// these are helpers, not conditions.

export interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

/** Parse a computed color string: rgb(r,g,b) / rgba(r,g,b,a). Null when unparseable. */
export function parseColor(v: string): Rgb | null {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v.trim())
  if (!m) return null
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) }
}

/** WCAG relative luminance (sRGB channels linearized). */
export function relLuminance(c: Rgb): number {
  const lin = (ch: number): number => {
    const s = ch / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG contrast ratio of two colors: (L1+0.05)/(L2+0.05) with L1 the lighter. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** True when the rect sits fully inside the viewport: 0 <= left/right <= innerWidth and 0 <= top/bottom <= innerHeight. */
export function rectInViewport(
  rect: { left: number; right: number; top: number; bottom: number },
  innerWidth: number,
  innerHeight: number,
): boolean {
  return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
}
