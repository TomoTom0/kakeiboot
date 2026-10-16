// Receipt color labels (TASK-17): the fixed 5-color palette shared by the
// web screens and the widget, the label -> text conversions (a11y: the
// color name is always present, spec_mcp-tools.md 12) and the URL query
// conversion used by the receipt context (labels=red,blue).
// Keep the color set in sync with the backend enum (domain labels.rs) and
// the SQL seed (migration 0009).

/** Label color keys. The array order is the definition / display order. */
export type LabelColor = 'red' | 'yellow' | 'green' | 'blue' | 'purple'

/** A label assigned to a receipt (title is optional: color-only by default). */
export interface Label {
  color: LabelColor
  title: string | null
}

/**
 * Loose display input: test data and hand-built envelopes carry plain string
 * colors; unknown keys fall back to the raw string in the display text.
 */
export interface LabelLike {
  color: string
  title: string | null
}

export const LABEL_COLORS: readonly LabelColor[] = ['red', 'yellow', 'green', 'blue', 'purple']

/**
 * Mirror of the backend limit `limits.max_label_title_chars`
 * (configs/<env>/mcp.toml, enforced by domain::labels::set_title); the two
 * must be changed together. Single source for the web UI and the mock.
 */
export const MAX_LABEL_TITLE_CHARS = 20

export const LABEL_NAME: Record<LabelColor, string> = {
  red: '赤',
  yellow: '黄',
  green: '緑',
  blue: '青',
  purple: '紫',
}

export function isLabelColor(v: string): v is LabelColor {
  return (LABEL_COLORS as readonly string[]).includes(v)
}

/** "赤: 旅行" when titled, otherwise just the color name. */
export function labelText(label: LabelLike): string {
  const name = isLabelColor(label.color) ? LABEL_NAME[label.color] : label.color
  return label.title ? `${name}: ${label.title}` : name
}

/** Color names joined with "・": "赤・青". Empty for no colors. */
export function labelColorsText(colors: readonly LabelColor[]): string {
  return colors.map((c) => LABEL_NAME[c]).join('・')
}

/** URL query value ("red,blue") -> colors in definition order; unknown colors are dropped. */
export function parseLabelQuery(v: string | null | undefined): LabelColor[] {
  if (!v) return []
  const parts = v.split(',').map((s) => s.trim())
  return LABEL_COLORS.filter((c) => parts.includes(c))
}

/** Colors -> URL query value; undefined when empty (the key is omitted). */
export function formatLabelQuery(colors: readonly LabelColor[]): string | undefined {
  const joined = colors.filter((c) => isLabelColor(c)).join(',')
  return joined === '' ? undefined : joined
}

/** Colors of a label list in definition order. */
export function labelColorsOf(labels: readonly LabelLike[] | null | undefined): LabelColor[] {
  return LABEL_COLORS.filter((c) => (labels ?? []).some((l) => l.color === c))
}
