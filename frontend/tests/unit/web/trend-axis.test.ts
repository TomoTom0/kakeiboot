// TASK-42 (design: tmp/tasks/tm-42/design_trend-labels.md §2-1 / §4-3) laid
// down the axis-label helper both trend surfaces share; TASK-100 (design:
// tmp/tasks/tm-100/design_trend-chart-axes.md §1-1 / §4) extends it: the
// axis thins to at most 5 ticks (axisTickIndices) and axisMonthLabels gains
// the `items` array TrendBars renders, with a single year-boundary format
// rule. The jsdom tests (dashboard-shell / view-pages) pin the rendered
// axis; this file pins the thinning and format rules on the helpers.
import { describe, expect, it } from 'vitest'
import { axisMonthLabels, axisTickIndices, axisTickIndicesWide, monthLabel, shiftMonth } from '@/web/composables/period'
import { compactYen } from '@/shared/components/charts/types'

const months = (start: string, n: number): string[] =>
  Array.from({ length: n }, (_, i) => shiftMonth(start, i))

// TASK-162 §5-5 landed: axisMonthLabels returns the `years` array (the
// window's start year + the first January boundary, 「YYYY」4-digit labels)
// alongside the always-short items — the test-first runtime guard that
// threw until period.ts shipped it is gone, the calls read the signature
const labelsWithYears = (keys: string[], ticks?: number[]): NonNullable<ReturnType<typeof axisMonthLabels>> => {
  const v = axisMonthLabels(keys, ticks)
  if (v === null) throw new Error('axisMonthLabels returned null for a non-empty key list')
  return v
}

describe('axisTickIndices', () => {
  it('[covers:web-browse.trend-axis-minimal] 0→[]・n<=5 は全index・6→[0,2,4,5]（TASK-161 §6-2: 幅未測定〔jsdom〕のcount間引きfallback — 測定後は幅ベースで全label表示され得る。両端保証は常に不変）', () => {
    expect(axisTickIndices(0)).toEqual([])
    expect(axisTickIndices(1)).toEqual([0])
    expect(axisTickIndices(2)).toEqual([0, 1])
    expect(axisTickIndices(3)).toEqual([0, 1, 2])
    expect(axisTickIndices(5)).toEqual([0, 1, 2, 3, 4])
    expect(axisTickIndices(6)).toEqual([0, 2, 4, 5])
  })

  it('[covers:web-browse.trend-axis-minimal] step=ceil((n-1)/4): 9→[0,2,4,6,8]・12→[0,3,6,9,11]・13→[0,3,6,9,12]・18→[0,5,10,15,17]', () => {
    expect(axisTickIndices(9)).toEqual([0, 2, 4, 6, 8])
    expect(axisTickIndices(12)).toEqual([0, 3, 6, 9, 11])
    expect(axisTickIndices(13)).toEqual([0, 3, 6, 9, 12])
    expect(axisTickIndices(18)).toEqual([0, 5, 10, 15, 17])
  })

  it('[covers:web-browse.trend-axis-minimal] 10→[0,3,6,9]・14→[0,4,8,13]（旧 step=ceil(n/5) は6件になった反例の回帰）', () => {
    expect(axisTickIndices(10)).toEqual([0, 3, 6, 9])
    expect(axisTickIndices(14)).toEqual([0, 4, 8, 13])
  })

  it('[covers:web-browse.trend-axis-minimal] 常に 0 と n-1 を含み件数は5以下（昇順・重複なし）', () => {
    for (let n = 1; n <= 30; n++) {
      const idx = axisTickIndices(n)
      expect(idx.length, `n=${n}`).toBeLessThanOrEqual(5)
      expect(idx[0], `n=${n}`).toBe(0)
      expect(idx[idx.length - 1], `n=${n}`).toBe(n - 1)
      expect(new Set(idx).size, `n=${n}`).toBe(idx.length)
      expect(idx, `n=${n}`).toEqual([...idx].sort((a, b) => a - b))
    }
  })
})

describe('axisMonthLabels', () => {
  it('[covers:web-browse.trend-axis-minimal] 単年窓は全ラベル「M月」・単月は items が「10月」1件で last=null・空は null', () => {
    // a single-year 6-month window: ticks [0,2,4,5], every label short — the
    // TASK-162 year row adds the start-year tick (§5-2)
    expect(labelsWithYears(months('2026-05', 6))).toEqual({
      first: '5月',
      last: '10月',
      items: [
        { key: '2026-05', label: '5月' },
        { key: '2026-07', label: '7月' },
        { key: '2026-09', label: '9月' },
        { key: '2026-10', label: '10月' },
      ],
      years: [{ key: '2026-05', label: '2026' }],
    })
    // a single month: items keep the one label, last stays null (the
    // first/last contract ReceiptsPage consumes is unchanged)
    expect(labelsWithYears(["2026-10"])).toEqual({
      first: '10月',
      last: null,
      items: [{ key: '2026-10', label: '10月' }],
      years: [{ key: '2026-10', label: '2026' }],
    })
    expect(axisMonthLabels([])).toBeNull()
  })

  it('[covers:web-browse.trend-axis-minimal][covers:web-browse.trend-year-ticks] 跨年窓もitemsは全て短形式「M月」（フル形式廃止）・年は独立tick行（先頭の年+年境界）で返す（TASK-162 §5）', () => {
    // a 12-month cross-year window: every items label is SHORT now (the full
    // "YYYY年M月" form is withdrawn — the year rides its own tick row), and
    // the years array carries the window's start year + the year boundary
    expect(labelsWithYears(months('2025-11', 12))).toEqual({
      first: '2025年11月',
      last: '2026年10月',
      items: [
        { key: '2025-11', label: '11月' },
        { key: '2026-02', label: '2月' },
        { key: '2026-05', label: '5月' },
        { key: '2026-08', label: '8月' },
        { key: '2026-10', label: '10月' },
      ],
      years: [
        { key: '2025-11', label: '2025' },
        { key: '2026-01', label: '2026' },
      ],
    })
    // year mode (Jan..Dec): the first label stays short too, the start year
    // sits on the window head alone (no boundary inside a single-year window)
    expect(labelsWithYears(months('2026-01', 12))).toEqual({
      first: '1月',
      last: '12月',
      items: [
        { key: '2026-01', label: '1月' },
        { key: '2026-04', label: '4月' },
        { key: '2026-07', label: '7月' },
        { key: '2026-10', label: '10月' },
        { key: '2026-12', label: '12月' },
      ],
      years: [{ key: '2026-01', label: '2026' }],
    })
    // a single-year window that starts mid-year: one start-year tick at the
    // head, no boundary
    expect(labelsWithYears(months('2026-05', 6)).years).toEqual([{ key: '2026-05', label: '2026' }])
  })

  it('[covers:web-browse.trend-year-ticks] 年tickは月tick間引きに依らず「1月のcell」に置く（間引かれた1月にも年は置かれる）', () => {
    // a cross-year window where the thinning (count rule n=12 -> [0,3,6,9,11])
    // does NOT show 2026-01's month label — the year tick still sits on the
    // January cell (the year row is independent of the month row's thinning)
    const keys = months('2025-11', 12)
    const thinned = labelsWithYears(keys, [0, 3, 6, 9, 11])
    expect(thinned?.items.map((t) => t.key)).not.toContain('2026-01')
    expect(thinned?.years.map((y) => y.key)).toContain('2026-01')
    expect(thinned?.years.map((y) => y.label)).toEqual(['2025', '2026'])
    // years never collide with each other: one tick per year at most (the
    // minimum spacing is 12 cells). A MULTI-YEAR window (review 中4: a
    // 24-month custom range) carries EVERY year boundary — the second
    // January (2027-01) kept its tick too, not only the first boundary
    const twoYear = labelsWithYears(months('2025-07', 24))
    expect(twoYear?.years).toEqual([
      { key: '2025-07', label: '2025' },
      { key: '2026-01', label: '2026' },
      { key: '2027-01', label: '2027' },
    ])
  })
})

// TASK-161 §6-2 (web-browse.trend-axis-minimal, review 中3): the width-based
// thinning rule — the positions come from the ACTUAL label strings the caller
// will draw (a full "YYYY年M月" at a year turn, a compactYen value), measured
// against the neighbouring distance. The end position always stays and
// REPLACES its crowding predecessor; an unmeasured pitch keeps the count
// fallback.
describe('axisTickIndicesWide', () => {
  /** the width of the string at index i, monospace at 14px (TrendBars' working em) */
  const w = (s: string): number => Array.from(s).length * 14

  it('[covers:web-browse.trend-axis-minimal] pitch<=0はcount間引きfallback・両端常時保証・昇順重複なし', () => {
    expect(axisTickIndicesWide(6, 0, () => 100)).toEqual(axisTickIndices(6))
    for (const n of [1, 2, 6, 12, 20]) {
      const idx = axisTickIndicesWide(n, 48, () => 28)
      expect(idx[0], `n=${n}`).toBe(0)
      expect(idx[idx.length - 1], `n=${n}`).toBe(n - 1)
      expect(new Set(idx).size, `n=${n}`).toBe(idx.length)
      expect(idx, `n=${n}`).toEqual([...idx].sort((a, b) => a - b))
    }
  })

  it('[covers:web-browse.trend-axis-minimal] 単月幅labelは実測pitchで間引く（狭帯: 隣接不可・1個空き可・末尾は直前を置換）・広幅は全表示', () => {
    const est = (i: number): number => w(`${i + 1}月`)
    // a narrow-band pitch (~48px): "5月" (28) + margin 32 needs 60 — an
    // adjacent label never fits, an every-other one does, and the END
    // replaces its crowding predecessor (0→2→4, then 5 takes 4's place)
    expect(axisTickIndicesWide(6, 48, est)).toEqual([0, 2, 5])
    // a desktop-class pitch: every adjacent label fits — all indices show
    expect(axisTickIndicesWide(6, 110, est)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('[covers:web-browse.trend-axis-minimal] 年跨ぎの全形式label幅で判定する（広いlabelの手前が間引かれる・単月幅前提だと表示される逆例）', () => {
    const keys = months('2025-11', 12)
    // the caller's real strings: a label goes FULL form when ITS year turns
    // against the previous key (the axis format rule's own comparison)
    const est = (i: number): number =>
      w(keys[i - 1] !== undefined && keys[i]!.slice(0, 4) !== keys[i - 1]!.slice(0, 4) ? monthLabel(keys[i]!) : `${Number(keys[i]!.slice(5))}月`)
    // a pitch where the short labels all fit but the FULL "2026年1月" (98px)
    // does not: measuring the real strings skips the wide label's slot
    const byShort = axisTickIndicesWide(12, 62, (i) => w(`${Number(keys[i]!.slice(5))}月`))
    const byReal = axisTickIndicesWide(12, 62, est)
    expect(byShort).toContain(2) // 2026-01 sits adjacent-fit under the short-only estimate
    expect(byReal).not.toContain(2) // the full form needs 98px + margin — the real rule skips it
    expect(byReal[0]).toBe(0)
    expect(byReal[byReal.length - 1]).toBe(11)
  })

  it('[covers:web-browse.trend-axis-minimal] 末尾tickは直前との間隔が保てないとき直前を置換し・保てるときは追加・最初の末端は置換しない', () => {
    // pitch 30, every label 28 + margin 32 = 60: only every-other fits; at
    // n=7 the end (6) has room after 4 and appends; at n=8 the end (7) sits
    // right after 6's slot — it REPLACES the crowding 6 instead of stacking
    const est = (i: number): number => w(`${i + 1}月`)
    expect(axisTickIndicesWide(7, 30, est)).toEqual([0, 2, 4, 6])
    expect(axisTickIndicesWide(8, 30, est)).toEqual([0, 2, 4, 7])
    // n=2 never trades the FIRST end away: both ends stay, crowded or not
    expect(axisTickIndicesWide(2, 10, est)).toEqual([0, 1])
  })

  it('[covers:web-browse.trend-axis-minimal] 値label（compactYen実測）も同一規則（大金額の広い文字列が間引きを進める）', () => {
    const vals = [948, 1200, 948, 948, 12000, 948, 948]
    const est = (i: number): number => w(compactYen(vals[i]!))
    // "1.2万" (4ch = 56) + 32 = 88: at a 46px pitch a neighbour after the
    // wide value never fits, an every-other gap does
    expect(axisTickIndicesWide(7, 46, est)).toEqual([0, 2, 4, 6])
  })
})

// TASK-122 (PR#3 review): the 千 band rounds at the hundred-yen step so the
// axis keeps one decimal — the same precision the 万 band has. Moving the
// / 10 inside Math.round collapsed 1,500 to "2千" and mislabeled the
// niceMax 5,000 midpoint tick ("3千" instead of "2.5千").
describe('compactYen', () => {
  it('[covers:web-browse.trend-y-axis] 千帯は百円単位の丸めで小数1桁を保持（1500→1.5千・2500→2.5千）', () => {
    expect(compactYen(1500)).toBe('1.5千')
    expect(compactYen(2500)).toBe('2.5千')
    // the niceMax(5000) window renders [5千, 2.5千, 0]
    expect(compactYen(5000)).toBe('5千')
    // hundred-yen rounding: 1,504 -> 15.04 -> round -> 1.5千
    expect(compactYen(1504)).toBe('1.5千')
    expect(compactYen(1490)).toBe('1.5千')
  })

  it('[covers:web-browse.trend-y-axis] 帯境界: 1000→1千・万帯は小数1桁・千未満はそのまま・0→0', () => {
    expect(compactYen(1000)).toBe('1千')
    expect(compactYen(948)).toBe('948')
    expect(compactYen(12000)).toBe('1.2万')
    expect(compactYen(0)).toBe('0')
  })
})
