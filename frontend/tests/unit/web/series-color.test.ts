// TASK-105 (design: tmp/tasks/tm-105/design_dashboard-visual.md §2): the
// deterministic series color assignment of the breakdown axes. Written
// test-first: frontend/src/web/lib/seriesColor.ts did not exist yet when this
// landed. The mapping must be pure arithmetic on the key — window / period /
// screen / top-N membership never enter — so an added key can never recolor an
// existing one, and every screen (trend segments, RankedList rows, the
// payments zone) reads the same color off the same key.
// TASK-116 (design: tmp/tasks/tm-116/design_breakdown-expansion.md §3-3-3):
// the function moved to shared/lib so the widget reads the same mapping —
// only the import path changed, the expectations are unchanged.
import { describe, expect, it } from 'vitest'
import { SERIES_REST, SERIES_SLOT_COUNT, seriesColor } from '@/shared/lib/seriesColor'

describe('seriesColor (lib, TASK-105)', () => {
  it('[covers:web-common.series-color-assignment] 定数: slot数7・restは--series-rest参照・戻り値はCSS変数参照のみ（関数は色値を持たない）', () => {
    // the palette size and the rest color are part of the contract the
    // stylesheet relies on (§2-1): the function returns custom-property refs
    // only, so the actual colors stay owned by styles.css (light/dark)
    expect(SERIES_SLOT_COUNT).toBe(7)
    expect(SERIES_REST).toBe('var(--series-rest)')
    for (const key of [1, 8, null, '食費'] as const) {
      const v = seriesColor(key)
      expect(v, `seriesColor(${JSON.stringify(key)})`).toMatch(/^var\(--(series|label)-[a-z0-9-]+\)$/)
      expect(v, 'never a raw color value').not.toMatch(/#|rgb|hsl/)
    }
  })

  it('[covers:web-common.series-color-assignment] number写像: ((id-1) mod 7) の循環slot（1→s1・7→s7・8→s1・15→s1）= ID昇順s1..s7充填と同一', () => {
    // ID 昇順で s1..s7 を充填し、8番目が s1 に戻る循環と、key 単体の算術が
    // 同じ結果になることが「窓・期間・画面・上位顔ぶれに非依存」の根拠
    for (let id = 1; id <= 7; id++) expect(seriesColor(id), `id=${id}`).toBe(`var(--series-${id})`)
    expect(seriesColor(8)).toBe('var(--series-1)')
    expect(seriesColor(15)).toBe('var(--series-1)') // (15-1) % 7 === 0
    expect(seriesColor(9)).toBe('var(--series-2)')
    expect(seriesColor(22)).toBe('var(--series-1)') // 3周目の先頭
  })

  it('[covers:web-common.series-color-assignment] key null（未分類・店不明）は残余と同じ --series-rest', () => {
    // null は色付き系列に割り当てず名称表記で区別する（残余「ほか」と同色で
    // 意味対応する）
    expect(seriesColor(null)).toBe('var(--series-rest)')
    // the label axis does not special-case null either
    expect(seriesColor(null, 'label')).toBe('var(--series-rest)')
  })

  it('[covers:web-common.series-color-assignment] string写像: FNV-1a 32bit % 7（手計算期待値『食費』→s3・同一stringは常に同一slot・異なるstringは分布）', () => {
    // 手計算: '食費' = UTF-8 bytes e9 a3 9f e8 b2 bb
    //   h = 2166136261 (FNV offset basis)
    //   for each byte: h ^= byte; h = (h * 16777619) mod 2^32
    //   -> 1506238337; 1506238337 % 7 = 2 (0-based slot 2) -> var(--series-3)
    expect(seriesColor('食費')).toBe('var(--series-3)')
    // determinism: the same string always lands on the same slot, regardless
    // of the axis prop (a non-label axis keeps the common mapping)
    expect(seriesColor('食費')).toBe(seriesColor('食費'))
    expect(seriesColor('食費', 'category')).toBe(seriesColor('食費'))
    expect(seriesColor('食費', 'store')).toBe(seriesColor('食費'))
    // distribution: distinct strings spread over several slots (品目名・支払
    // 方法が単一色に潰れないことの代表例）
    const slots = new Set(['食費', '牛乳', '現金', 'credit_card', '品目A', '品目B'].map((s) => seriesColor(s)))
    expect(slots.size).toBeGreaterThanOrEqual(4)
    expect(seriesColor('牛乳')).toBe('var(--series-2)') // 863845942 % 7 = 1
    expect(seriesColor('credit_card')).toBe('var(--series-4)') // 964717379 % 7 = 3
  })

  it('[covers:web-common.series-color-assignment] label軸は管理色の固定表（実API key=色名string red/yellow/green/blue/purple→var(--label-*)・number 1..5は互換）で範囲外keyは共通写像へfallback', () => {
    // the live label-axis key is the color NAME string (backend stats.rs
    // groups BY rl.color; the web mock mirrors it, mock.ts key: color name)
    // — the name table is the primary path
    expect(seriesColor('red', 'label')).toBe('var(--label-red)')
    expect(seriesColor('yellow', 'label')).toBe('var(--label-yellow)')
    expect(seriesColor('green', 'label')).toBe('var(--label-green)')
    expect(seriesColor('blue', 'label')).toBe('var(--label-blue)')
    expect(seriesColor('purple', 'label')).toBe('var(--label-purple)')
    // an out-of-table name falls back to the FNV common mapping on the
    // label axis too (a color the palette does not manage)
    expect(seriesColor('orange', 'label')).toBe(seriesColor('orange'))
    expect(seriesColor('orange', 'label')).toMatch(/^var\(--series-\d\)$/)
    // the numeric 1..5 ids stay as the compat path (the design's original
    // id table in the LABEL_COLORS order); out-of-range ids fall to the
    // number mapping
    expect(seriesColor(1, 'label')).toBe('var(--label-red)')
    expect(seriesColor(2, 'label')).toBe('var(--label-yellow)')
    expect(seriesColor(3, 'label')).toBe('var(--label-green)')
    expect(seriesColor(4, 'label')).toBe('var(--label-blue)')
    expect(seriesColor(5, 'label')).toBe('var(--label-purple)')
    // out-of-range ids fall back to the number mapping (9 -> slot 2)
    expect(seriesColor(9, 'label')).toBe(seriesColor(9))
    expect(seriesColor(9, 'label')).toBe('var(--series-2)')
    // a non-label axis never reads the label table (not for names either:
    // a color name outside the label axis is just another string key)
    expect(seriesColor('red')).toBe(seriesColor('red'))
    expect(seriesColor(1, 'category')).toBe('var(--series-1)')
    expect(seriesColor(2, 'store')).toBe('var(--series-2)')
  })

  it('[covers:web-common.series-color-assignment] 追加不変: 別keyの追加で既存keyの写像が不変（純関数・IDベースであることの表明回帰）', () => {
    const before = new Map<string | number | null, string>([
      [1, seriesColor(1)],
      [7, seriesColor(7)],
      [15, seriesColor(15)],
      ['食費', seriesColor('食費')],
      ['牛乳', seriesColor('牛乳')],
      [null, seriesColor(null)],
    ])
    // a new category / a new item name lands somewhere, but never recolors
    // the existing keys (the "追加カテゴリが既存keyの色を壊さない" guarantee)
    for (const added of [2, 8, 22, '品目A', '品目B', 'credit_card'] as const) {
      expect(seriesColor(added)).toMatch(/^var\(--series-\d\)$/)
    }
    expect(seriesColor(1)).toBe(before.get(1))
    expect(seriesColor(7)).toBe(before.get(7))
    expect(seriesColor(15)).toBe(before.get(15))
    expect(seriesColor('食費')).toBe(before.get('食費'))
    expect(seriesColor('牛乳')).toBe(before.get('牛乳'))
    expect(seriesColor(null)).toBe(before.get(null))
  })
})
