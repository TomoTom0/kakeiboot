// Receipt labels (TASK-17, redesigned as managed labels in TASK-26): the
// fixed 5-label palette shared by the web screens and the widget, the
// spoken (aria-only) names and the URL query conversion used by the receipt
// context (labels=red,blue). The screen never shows color-name text: a
// titled label renders as a colored name chip and an untitled one as a bare
// color chip (LabelChip.vue); the names below exist for assistive tech only.
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
 * colors; unknown keys fall back to the raw string in the spoken name.
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

export function isLabelColor(v: string): v is LabelColor {
  return (LABEL_COLORS as readonly string[]).includes(v)
}

/** Position of a color in LABEL_COLORS (the definition / display order). */
export function labelIndexOf(color: string): number {
  return (LABEL_COLORS as readonly string[]).indexOf(color)
}

/**
 * Spoken name (TASK-26 1-3 R2): the title when set, otherwise the neutral
 * "ラベルN" (N = position in LABEL_COLORS, 1-based). aria-label only —
 * never a visible text node or a title attribute (the screen shows no
 * color-name or placeholder text). Unknown colors fall back to the raw key.
 */
export function labelAriaName(label: LabelLike, index: number): string {
  if (label.title) return label.title
  return index >= 0 && index < LABEL_COLORS.length ? `ラベル${index + 1}` : label.color
}

/** Spoken names joined with "、": "旅行、ラベル2". Empty for no labels. */
export function labelAriaList(labels: readonly LabelLike[] | null | undefined): string {
  return (labels ?? []).map((l) => labelAriaName(l, labelIndexOf(l.color))).join('、')
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
