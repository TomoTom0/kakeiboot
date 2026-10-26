// The deterministic series color assignment (TASK-105, design: tmp/tasks/
// tm-105/design_dashboard-visual.md §2): one pure function every screen
// (trend segments, RankedList rows, the payments zone) reads its color from,
// so the same key paints the same color everywhere.
//
// The mapping is pure arithmetic on the key alone — the window, the period,
// the screen and the visible top-N membership never enter — so an added key
// can never recolor an existing one. A number key (a category / store /
// label id) fills the slots in id-ascending cyclic order ((id - 1) mod 7),
// a string key (an item name, a payment method) hashes through FNV-1a, and
// null (未分類 / 店不明) falls to the unattributed rest color. The label axis
// reads the managed label palette's fixed table instead (1..5 in the
// LABEL_COLORS order; out-of-range ids fall back to the number mapping).
//
// The return value is always a CSS custom property reference — the actual
// colors live in styles.css (--series-1..7 / --series-rest, light and dark).
import type { AnalysisAxis } from '../api/data'

/** series slot count (the palette size; design §3) */
export const SERIES_SLOT_COUNT = 7

/** the fixed rest / unattributed color */
export const SERIES_REST = 'var(--series-rest)'

/** the label axis's managed-color table: label ids 1..5 map onto the
 * LABEL_COLORS order (red / yellow / green / blue / purple — shared/labels) */
const LABEL_COLORS_TABLE: Record<number, string> = {
  1: 'var(--label-red)',
  2: 'var(--label-yellow)',
  3: 'var(--label-green)',
  4: 'var(--label-blue)',
  5: 'var(--label-purple)',
}

export function seriesColor(key: string | number | null, axis?: AnalysisAxis): string {
  if (key === null) return SERIES_REST
  if (axis === 'label' && typeof key === 'number') {
    const managed = LABEL_COLORS_TABLE[key]
    if (managed !== undefined) return managed
  }
  if (typeof key === 'number') {
    // the id-ascending cyclic fill as key-local arithmetic: negatives (never
    // issued, kept safe) still land in [0, 7)
    const slot = (((key - 1) % SERIES_SLOT_COUNT) + SERIES_SLOT_COUNT) % SERIES_SLOT_COUNT
    return `var(--series-${slot + 1})`
  }
  // FNV-1a 32bit (own implementation, no dependency): a stable spread of
  // name-keyed series (item names, payment methods) over the slots
  let h = 0x811c9dc5
  for (const b of new TextEncoder().encode(key)) {
    h ^= b
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `var(--series-${(h % SERIES_SLOT_COUNT) + 1})`
}
