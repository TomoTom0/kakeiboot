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
