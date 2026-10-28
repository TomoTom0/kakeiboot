// The deterministic series color assignment (TASK-105, design: tmp/tasks/
// tm-105/design_dashboard-visual.md §2), moved to shared/lib in TASK-116
// (design: tmp/tasks/tm-116/design_breakdown-expansion.md §3-3-3) so the web
// app and the widget read the SAME mapping: one pure function every screen
// (trend segments, RankedList rows, the payments zone, the week-row gradient,
// the daily-bar segments, the widget bar_v segments and bar_h rows) reads its
// color from, so the same key paints the same color everywhere.
//
// The mapping is pure arithmetic on the key alone — the window, the period,
// the screen and the visible top-N membership never enter — so an added key
// can never recolor an existing one. A number key (a category / store id)
// fills the slots in id-ascending cyclic order ((id - 1) mod 7), a string
// key (an item name, a payment method) hashes through FNV-1a, and null
// (未分類 / 店不明) falls to the unattributed rest color. The label axis
// reads the managed label palette's fixed table instead — keyed by the color
// NAME string (the live analysis key), with the numeric 1..5 ids kept as a
// compat path; every other key falls back to the common mappings.
//
// The return value is always a CSS custom property reference — the actual
// colors live in the stylesheets (web styles.css / widget style.css, both
// defining --series-1..7 / --series-rest for light and dark at the SAME
// values).
/** The breakdown axis union. Keep this IDENTICAL to the web AnalysisAxis
 * (frontend/src/web/api/data/types.ts): a new axis there must extend this
 * union too, or the shared mapping silently falls to the common path. */
export type SeriesAxis = 'category' | 'store' | 'item' | 'label' | 'payment_method'

/** series slot count (the palette size; design §3) */
export const SERIES_SLOT_COUNT = 7

/** the fixed rest / unattributed color */
export const SERIES_REST = 'var(--series-rest)'

/** the label axis's managed-color table. The live analysis key is the color
 * NAME string ('red' | 'yellow' | 'green' | 'blue' | 'purple' — the backend
 * groups labels BY color, stats.rs GROUP BY rl.color, and the web mock
 * mirrors it), so the name table is the primary path. The numeric 1..5 ids
 * stay as a compat path (the design's original id table in the LABEL_COLORS
 * order); every other key falls through to the common mappings */
const LABEL_NAMES_TABLE: Record<string, string> = {
  red: 'var(--label-red)',
  yellow: 'var(--label-yellow)',
  green: 'var(--label-green)',
  blue: 'var(--label-blue)',
  purple: 'var(--label-purple)',
}
const LABEL_IDS_TABLE: Record<number, string> = {
  1: 'var(--label-red)',
  2: 'var(--label-yellow)',
  3: 'var(--label-green)',
  4: 'var(--label-blue)',
  5: 'var(--label-purple)',
}

export function seriesColor(key: string | number | null, axis?: SeriesAxis): string {
  if (key === null) return SERIES_REST
  if (axis === 'label') {
    if (typeof key === 'string') {
      const managed = LABEL_NAMES_TABLE[key]
      if (managed !== undefined) return managed
      // an out-of-table name falls through to the FNV common mapping
    } else {
      const managed = LABEL_IDS_TABLE[key]
      if (managed !== undefined) return managed
      // an out-of-range id falls through to the number mapping
    }
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
