// TASK-129 (design: tmp/tasks/tm-129/design_ranked-row-bar.md v3 §4-1): the
// unified absolute scale every bar representation shares — written test-first,
// the contract IS this test (frontend/src/shared/lib/stackedBars.ts gains the
// `barScale(maxValue)` pure function: the single planning-layer source of the
// nice 1/2/5 ceiling the value→length direct mapping divides by). The screen
// (web) / report (widget) level aggregation — max over each bar's outer
// amount (row value / week total / bucket total / stacked rows sum) — is
// pinned by the page-level tests (dashboard-shell / view-pages /
// widget/stats), not here.
import { describe, expect, it } from 'vitest'
import { barScale } from '@/shared/lib/stackedBars'
import { axisTicksOf } from '@/shared/lib/axisTicks'
import { estimateTextWidth, truncateLabelWidth } from '@/shared/format'
import { niceMax } from '@/shared/components/charts/types'

describe('barScale (TASK-129 web-common.bar-scale)', () => {
  it('[covers:web-common.bar-scale] nice 1/2/5 段階への切り上げ（948→1000・340000→500000・ちょうど段階値は不変）', () => {
    expect(barScale(948)).toBe(1000)
    expect(barScale(999)).toBe(1000)
    // exactly on a step: the step value itself (no further headroom)
    expect(barScale(1000)).toBe(1000)
    expect(barScale(1001)).toBe(2000)
    expect(barScale(2000)).toBe(2000)
    expect(barScale(340000)).toBe(500000)
    expect(barScale(500000)).toBe(500000)
    // the small-yen steps the fixtures ride on (Home mock: max 948 → 1000)
    expect(barScale(550)).toBe(1000)
    expect(barScale(948)).toBe(1000)
  })

  it('[covers:web-common.bar-scale] 0・負・非有限は 1（niceMax と同値運用・全定義域で一致）', () => {
    expect(barScale(0)).toBe(1)
    expect(barScale(-5)).toBe(1)
    expect(barScale(Number.NaN)).toBe(1)
    expect(barScale(Number.POSITIVE_INFINITY)).toBe(1)
    // the axis precedent (trend-y-axis) keeps identical values: the scale
    // source widens (screen/report shared), the step ladder does not fork
    for (const v of [0, 1, 9, 100, 948, 1000, 1234, 52000, 2188, 1600, 340000, 999999]) {
      expect(barScale(v), `v=${v}`).toBe(niceMax(v))
    }
  })
})

// TASK-161 §5-3 (design: tmp/tasks/tm-161/design_period_ui.md v2 —
// web-common.axis-ticks): the absolute-tick ladder over a scale, the ONE
// subdivision rule the Home header breakdown's horizontal graduation and the
// trend y-axis read. Written test-first; the helper lives beside barScale in
// shared/lib.
describe('axisTicksOf (TASK-161 web-common.axis-ticks)', () => {
  it('[covers:web-common.axis-ticks] steps既定4は5点（0・1/4・1/2・3/4・1）・labelはcompactYen（0・250・500・750・1千）', () => {
    const ticks = axisTicksOf(1000)
    expect(ticks.map((t) => t.ratio)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(ticks.map((t) => t.value)).toEqual([0, 250, 500, 750, 1000])
    expect(ticks.map((t) => t.label)).toEqual(['0', '250', '500', '750', '1千'])
  })

  it('[covers:web-common.axis-ticks] steps=2は3点（0・1/2・1 = 縦軸現行語彙と同一）', () => {
    const ticks = axisTicksOf(1000, 2)
    expect(ticks.map((t) => t.ratio)).toEqual([0, 0.5, 1])
    expect(ticks.map((t) => t.label)).toEqual(['0', '500', '1千'])
  })

  it('[covers:web-common.axis-ticks] 純関数（同引数で同値）・昇順・両端必含・scale=0でも崩れない', () => {
    for (const steps of [4, 2] as const) {
      const a = axisTicksOf(2000, steps)
      const b = axisTicksOf(2000, steps)
      expect(a).toEqual(b)
      expect(a[0]!.ratio).toBe(0)
      expect(a[a.length - 1]!.ratio).toBe(1)
      expect(a.map((t) => t.ratio)).toEqual([...a.map((t) => t.ratio)].sort((x, y) => x - y))
      // a degenerate scale keeps the ladder drawable (barScale(0) = 1 is the
      // real-world floor; the helper itself never divides by the steps)
      expect(axisTicksOf(0, steps).every((t) => t.value === 0)).toBe(true)
    }
  })
})

// TASK-161 §6-1/§6-2: the monospace text-width estimate and the width-budget
// truncation the axis thinning and the in-bar series labels share
// (shared/format.ts — the px twin of truncateLabel).
describe('text width utilities (TASK-161 §6)', () => {
  it('estimateTextWidth は等幅前提のコードポイント数×em（サロゲートペアも1字）', () => {
    expect(estimateTextWidth('5月', 14)).toBe(28)
    expect(estimateTextWidth('2026年10月', 10)).toBe(80)
    // surrogate pairs count once, like truncateLabel's code-point walk
    // (𩸽 is one code point beyond the BMP, painted by a surrogate pair)
    expect(estimateTextWidth('𩸽𩸽', 10)).toBe(20)
    expect(estimateTextWidth('', 10)).toBe(0)
  })

  it('truncateLabelWidth は幅budget内の最大prefix+…・収まればそのまま・最小1字', () => {
    // fits: unchanged (no … tail)
    expect(truncateLabelWidth('食費', 100, 10)).toBe('食費')
    // 26 chars at 11px need 286 units; the 110-unit column keeps 9 + …
    expect(truncateLabelWidth('<script>alert(1)</script>', 110, 11)).toBe('<script>a…')
    // the budget always keeps at least one code point before the tail
    expect(truncateLabelWidth('abcdefghijklmnopqrstuvwxyz', 12, 10)).toBe('a…')
  })
})
