import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type { ReportKind } from '@/shared/types'
import { statsEnvelope, statsMeta, trendMatrix } from '@/widget/fixtures'
import type { AllocatedSegment } from '@/shared/lib/stackedBars'
import { fakeHost, mountWidget, result } from './helpers'

const num = (v: string | undefined) => Number(v)

// TASK-116: the bar_v stack's segments — painted with seriesColor(key)
// CSS variable refs (var(--series-*) / var(--series-rest)).
// TASK-123 (design §4-4): the topmost segment of each bar (and the fallback
// single bar) is a top-rounded PATH, the rest are rects — so the selector
// below takes both shapes; the outline is the viewBox-unit stroke.
const segShapes = (w: VueWrapper) =>
  w
    .findAll('[data-section="monthly_trend"] rect, [data-section="monthly_trend"] path')
    .filter((r) => (r.attributes('fill') ?? '').startsWith('var(--series'))
const segTitle = (r: DOMWrapper<Element>) => r.element.querySelector('title')?.textContent ?? ''

/** The bar_v segments grouped by their owning bar (the g's bar title). */
function segsByBar(w: VueWrapper): Map<string, DOMWrapper<Element>[]> {
  const byBar = new Map<string, DOMWrapper<Element>[]>()
  for (const s of segShapes(w)) {
    const key = s.element.closest('g')?.querySelector('title')?.textContent ?? ''
    byBar.set(key, [...(byBar.get(key) ?? []), s])
  }
  return byBar
}

describe('stats dashboard', () => {
  it('[covers:widget.stats-chart-values] bar lengths follow the values; bar_v stacks its series (bottom = first series)', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    // bar_h (TASK-129): the widths follow the values over the REPORT-level
    // shared scale — the aggregation spans every bar's outer amount in the
    // report (by_category max 30000, top_stores max 22000, bar_v bucket
    // totals max 52000) so barScale(52000) = 100000, NOT the section-local
    // niceMax(30000)=50000. The row colors are the key-based mapping
    // (1=食費 s1, 2=日用品 s2, keys=[null] rest) and the shapes come from the
    // common renderer (.bb-seg — each shape carries its stroke-inclusive
    // outer size as data-size)
    const bars = wrapper.findAll('[data-section="by_category"] .bb-seg')
    const BAR_W = 320 - 110 - 70
    const widths = bars.map((b) => num(b.attributes('data-size')))
    expect(widths[0]! / widths[1]!).toBeCloseTo(30000 / 12000, 5)
    expect(widths[1]! / widths[2]!).toBeCloseTo(12000 / 10000, 5)
    expect(widths[0]!).toBeCloseTo((30000 / 100000) * BAR_W, 1)
    expect(bars.map((b) => b.attributes('fill'))).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])
    // bar_v (TASK-116): each bar is a segment column off the matrix —
    // every month holds 食費+日用品+ほか except 2026-07 (日用品 value 0 is
    // omitted): 5 bars x 3 segments + 1 bar x 2 = 17
    const segs = segShapes(wrapper)
    expect(segs).toHaveLength(17)
    // every segment carries the share-form hover title「名称 金額（n%）」
    const titleTexts = segs.map((s) => segTitle(s))
    expect(titleTexts.every((t) => /^(食費|日用品|ほか) [\d,]+円（\d+%）$/.test(t))).toBe(true)
    // the same key paints the identical token as the bar_h rows: the 2026-10
    // bar holds all three — 食費 s1 / 日用品 s2 / ほか rest
    const byBar = segsByBar(wrapper)
    expect(byBar.size).toBe(6)
    const last = byBar.get('2026年10月: 52,000円')!
    expect(last.map((s) => s.attributes('fill')).sort()).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])
    // the bar's own title (year-month + amount) survives the segmentation
    const titles = wrapper.findAll('[data-section="monthly_trend"] g > title')
    expect(titles).toHaveLength(6)
    expect(titles.at(-1)!.text()).toBe('2026年10月: 52,000円')
    const card = wrapper.find('[data-test="totals-card"]').text()
    for (const t of ['52,000円', '31件']) expect(card).toContain(t)
  })

  it('[covers:widget.stats-chart-values] bar_v geometry (TASK-123): viewBox-unit stroke outline (rect = allocation − 2, 2-unit boundaries, no overlap), top segment a rounded path, clipPath gone', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    const segs = segShapes(wrapper)
    // §4-4: the outline is a stroke in viewBox units — width 2 (±1 unit off
    // every edge), colored by the --seg-outline token, and NEVER
    // non-scaling (§4-8's proportional grammar; the 320-unit viewBox scales
    // to the rendered width)
    for (const s of segs) {
      expect(s.attributes('stroke'), `${s.element.tagName} stroke`).toBe('var(--seg-outline)')
      expect(s.attributes('stroke-width')).toBe('2')
      expect(s.attributes('vector-effect')).toBeUndefined()
    }
    // §4-4 v5: clipPath is abolished (a clip cannot stroke the rounded
    // corners — the top segment itself is the rounded shape now)
    expect(wrapper.findAll('[data-section="monthly_trend"] clipPath')).toHaveLength(0)
    const byBar = segsByBar(wrapper)
    // the bar width keeps its math (slot * 0.7); every rect is the
    // allocation minus 2 units (stroke-inclusive outer size = allocation)
    const W = 320
    const LEFT = 36
    const barW = ((W - LEFT) / 6) * 0.7
    const counts: number[] = []
    for (const [barTitle, col] of byBar) {
      counts.push(col.length)
      // exactly ONE path per bar — the TOPMOST segment (rounded top, square
      // baseline side), carrying an arc in its outline
      const paths = col.filter((s) => s.element.tagName === 'path')
      expect(paths.length, `${barTitle} top path count`).toBe(1)
      expect(paths[0]!.attributes('d') ?? '', `${barTitle} the top path is rounded (arc commands)`).toMatch(/A|a/)
      // the rects: same x and width inside the bar (allocation − 2 all round)
      const rects = col.filter((s) => s.element.tagName === 'rect')
      for (const r of rects) {
        expect(num(r.attributes('width')), `${barTitle} rect width`).toBeCloseTo(barW - 2, 1)
      }
      const xs = new Set(rects.map((r) => r.attributes('x')))
      expect(xs.size, `${barTitle} the column's rects share one x`).toBe(1)
      // stack order: bottom rect (max y) = the first series; neighbours sit
      // exactly 2 units apart (own stroke 1 + neighbour stroke 1 — the
      // strokes abut with no overlap, the fills never touch)
      const sorted = [...rects].sort((a, b) => num(b.attributes('y')) - num(a.attributes('y')))
      expect(sorted[0]!.attributes('fill'), `${barTitle} bottom = first series`).toBe('var(--series-1)')
      for (let i = 1; i < sorted.length; i++) {
        const lower = sorted[i - 1]!
        const upper = sorted[i]!
        expect(
          num(lower.attributes('y')) - (num(upper.attributes('y')) + num(upper.attributes('height'))),
          `${barTitle} the 2-unit stroke boundary`,
        ).toBeCloseTo(2, 2)
      }
      // the bottom rect's stroke-inclusive outer bottom (y + h + 1) is the
      // plot base (TOP 8 + plotH 132 = 140): the allocation starts at base
      const bottom = sorted[0]!
      expect(num(bottom.attributes('y')) + num(bottom.attributes('height')) + 1, `${barTitle} base`).toBeCloseTo(140, 2)
    }
    // the value-0 series month (2026-07: 日用品 0) draws no s2 shape: that
    // bar holds exactly 2 segments (食費 + ほか) while the others hold 3
    expect(counts.sort()).toEqual([2, 3, 3, 3, 3, 3])
  })

  // TASK-123 (§4-1/§4-5, web-common.stack-dimension-rules): the widget
  // assembly is top-3 +「ほか」too — the matrix keeps the backend's top-5
  // contract (mcp-stats.trend-matrix-meta) and the FRONTEND slices to 3,
  // folding ranks 4-5 (and a sub-5% top-3 member per bucket) into the
  // residual grey
  it('[covers:web-common.stack-dimension-rules] bar_v 組立は上位3+「ほか」: 4-5位と5%未満は残余へ合算（matrix の上位5契約は不変）', async () => {
    const m = trendMatrix()
    m.series = [
      { key: 1, label: '食費', values: [30000, 33000, 29000, 36000, 35000, 38000], total: 199000 },
      { key: 2, label: '日用品', values: [8000, 9000, 0, 10000, 9000, 10000], total: 46000 },
      { key: 3, label: '交通費', values: [1000, 0, 0, 0, 0, 0], total: 1000 },
      { key: 4, label: '趣味', values: [500, 0, 0, 0, 0, 0], total: 500 },
      { key: 5, label: 'その他', values: [100, 0, 0, 0, 0, 0], total: 100 },
    ]
    m.bucket_totals = [39600, 42000, 29000, 46000, 44000, 48000]
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: { trend_matrix: m } }))
    const byBar = segsByBar(wrapper)
    // 2026-05 (bucket 39600): 交通費 1000 (2.5% < 5%) and ranks 4-5 fold
    // into「ほか」(1000 + 500 + 100 = 1600) — drawn: 食費 / 日用品 / ほか
    // (the bar titles keep the section ROW amounts, the segments the matrix)
    const may = byBar.get('2026年5月: 41,000円')!
    expect(may.map((s) => segTitle(s))).toEqual([
      '食費 30,000円（76%）',
      '日用品 8,000円（20%）',
      'ほか 1,600円（4%）',
    ])
    // the months without the small series draw no ほか at all (the residual
    // is 0 there): 2026-07 (29000) holds 食費 alone
    expect(byBar.get('2026年7月: 39,000円')!.map((s) => segTitle(s))).toEqual(['食費 29,000円（100%）'])
    expect(byBar.get('2026年6月: 45,000円')!.map((s) => segTitle(s)).filter((t) => t.startsWith('ほか'))).toEqual([])
    // every segment still carries the outline stroke (top path included)
    for (const s of segShapes(wrapper)) expect(s.attributes('stroke')).toBe('var(--seg-outline)')
  })

  it('[covers:widget.stats-chart-values] bar_v without a matrix (or with a mismatched one) keeps the single-bar fallback (TASK-123: the same top-rounded path + stroke)', async () => {
    // no _meta at all (backend not yet shipping the matrix / a meta-less host)
    const bare = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(segShapes(bare.wrapper)).toHaveLength(6)
    expect(bare.wrapper.findAll('[data-section="monthly_trend"] rect')).toHaveLength(0)
    expect(bare.wrapper.findAll('[data-section="monthly_trend"] rect title')).toHaveLength(0)
    const bareShapes = segShapes(bare.wrapper)
    expect(bareShapes.every((r) => r.attributes('fill') === 'var(--series-1)')).toBe(true)
    // the fallback is the SAME grammar as the stacked top segment: one
    // top-rounded path per bar with the outline stroke (the old standalone
    // rx=2 rect is gone)
    expect(bareShapes.every((r) => r.element.tagName === 'path')).toBe(true)
    for (const r of bareShapes) {
      expect(r.attributes('stroke')).toBe('var(--seg-outline)')
      expect(r.attributes('stroke-width')).toBe('2')
    }

    // a matrix whose buckets disagree with the section rows (6 rows vs 7
    // months) also drops the segments — one shape per bar
    const mismatched = trendMatrix()
    mismatched.buckets = [...mismatched.buckets, '2026-11']
    const m = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: { trend_matrix: mismatched } }))
    expect(segShapes(m.wrapper)).toHaveLength(6)
    expect(m.wrapper.findAll('[data-section="monthly_trend"] rect')).toHaveLength(0)
  })

  it('[covers:widget.stats-chart-values] chart kinds: stacked_bar, line (test-only section), table, scatter_line', async () => {
    const stacked = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_category') }))
    const segs = stacked.wrapper.findAll('[data-chart="stacked_bar"] .bb-seg')
    expect(segs).toHaveLength(3)
    // TASK-129: the bar is no longer the always-full 100% stack — its full
    // length is the rows sum over the report scale: 52000/barScale(52000)=
    // 100000 × 320 = 166.4 (the shapes carry their stroke-inclusive outer
    // sizes as data-size)
    expect(segs.reduce((s, r) => s + num(r.attributes('data-size')), 0)).toBeCloseTo((52000 / 100000) * 320, 1)
    // the stacked_bar segments are key-based too (1 / 2 / null)
    expect(segs.map((r) => r.attributes('fill'))).toEqual(['var(--series-1)', 'var(--series-2)', 'var(--series-rest)'])
    // and every segment carries the renderer outline
    for (const r of segs) expect(r.attributes('stroke')).toBe('var(--seg-outline)')

    // line: no real report emits it anymore (the monthly trend is bar_v), so
    // the renderer coverage rides the test-only 'monthly_trend_line' fixture
    // section (TASK-116) — same expectations as before
    const line = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(line.wrapper.findAll('[data-chart="line"] circle.bb-chart__point')).toHaveLength(6)
    expect(line.wrapper.find('[data-chart="line"] path.bb-chart__line').attributes('d')).toMatch(/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+){5}$/)
    const ys = line.wrapper.findAll('[data-chart="line"] circle.bb-chart__point').map((c) => num(c.attributes('cy')))
    expect(Math.min(...ys)).toBe(ys[5]) // largest value (52000) is drawn highest

    const table = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_payment_method') }))
    expect(table.wrapper.findAll('[data-chart="table"] tr')).toHaveLength(2)
    expect(table.wrapper.find('[data-chart="table"]').text()).toContain('40,000円')

    const scatter = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    const pts = scatter.wrapper.findAll('[data-chart="scatter_line"] circle.bb-chart__point')
    expect(pts).toHaveLength(3)
    expect(pts[0]!.attributes('r')).toBe('4')
  })

  // TASK-129 (design §4-3, widget.stats-seg-renderer): the common SVG
  // renderer the three charts route their segment outlines through — written
  // test-first, the contract IS this test. Props: the allocated segments,
  // the bar's full drawn `length`, the direction (dir 'v' stacks bottom-up
  // with the cap at the top end, 'h' left-to-right with the cap at the right
  // end), the cross `size`, and the base/cross coordinates. Every shape
  // carries class bb-seg and its stroke-inclusive outer size as data-size.
  it('[covers:widget.stats-seg-renderer] BarSegs: AllocatedSegment列をrect/pathで描く（stroke=--seg-outline・width2・outline=falseはstrokeなし・データ端のみcap path・rect=配分−2）', async () => {
    // lazy import: the renderer is the TASK-129 new build (test-first) — a
    // statically analyzable import would fail the WHOLE file at vite's
    // import-analysis before the existing (implementation-neutral) tests can
    // run, so the path stays opaque (@vite-ignore)
    const rendererPath = '@/shared/components/charts/BarSegs.vue'
    const { default: BarSegs } = await import(/* @vite-ignore */ rendererPath)
    const segs: AllocatedSegment[] = [
      { label: 'a', value: 60, color: 'var(--series-1)', size: 60, outline: true },
      { label: 'b', value: 40, color: 'var(--series-2)', size: 40, outline: false },
    ]
    const h = mount(BarSegs, { props: { segs, length: 100, dir: 'h', size: 16, base: 10, cross: 6 } })
    const hShapes = h.findAll('.bb-seg')
    expect(hShapes).toHaveLength(2)
    expect(hShapes.map((s) => s.attributes('data-size'))).toEqual(['60', '40'])
    expect(hShapes[0]!.attributes('fill')).toBe('var(--series-1)')
    expect(hShapes[0]!.attributes('stroke')).toBe('var(--seg-outline)')
    expect(hShapes[0]!.attributes('stroke-width')).toBe('2')
    expect(hShapes[0]!.attributes('vector-effect')).toBeUndefined()
    // rule F: the outline=false segment paints fill only
    expect(hShapes[1]!.attributes('stroke')).toBeUndefined()
    // the data end alone rounds: the LAST segment ('h' → right end) is the
    // capped path (arc commands), the base segment stays a rect whose drawn
    // width is the allocation − 2 (stroke-inclusive outer = allocation)
    expect(hShapes[0]!.element.tagName).toBe('rect')
    expect(num(hShapes[0]!.attributes('width'))).toBeCloseTo(58, 1)
    expect(hShapes[1]!.element.tagName).toBe('path')
    expect(hShapes[1]!.attributes('d') ?? '').toMatch(/A|a/)
    // 'h' geometry: the bar starts at base, grows rightward, height 16−2 at
    // cross+1 (stroke-inclusive)
    expect(num(hShapes[0]!.attributes('x'))).toBeCloseTo(11, 1)
    expect(num(hShapes[0]!.attributes('y'))).toBeCloseTo(7, 1)
    expect(num(hShapes[0]!.attributes('height'))).toBeCloseTo(14, 1)
    // 'v' mirrors it: bottom-up from the baseline, the TOP (data end) shape
    // alone carries the arc — the bar_v grammar the existing tests pin
    const v = mount(BarSegs, { props: { segs, length: 100, dir: 'v', size: 12, base: 140, cross: 20 } })
    const vShapes = v.findAll('.bb-seg')
    expect(vShapes).toHaveLength(2)
    expect(vShapes[0]!.element.tagName).toBe('rect')
    expect(vShapes[1]!.element.tagName).toBe('path')
    expect(vShapes[1]!.attributes('d') ?? '').toMatch(/A|a/)
    // the first segment anchors the baseline (outer bottom = base)
    expect(num(vShapes[0]!.attributes('y')) + num(vShapes[0]!.attributes('height')) + 1).toBeCloseTo(140, 1)
    expect(num(vShapes[0]!.attributes('width'))).toBeCloseTo(10, 1) // 12−2
  })

  // TASK-129 (widget.stats-chart-values + widget.stats-seg-renderer): the
  // bar_h grammar — the report-level shared scale (below), the renderer
  // outline on every row bar, the data-end cap, the rx=2 abolition.
  it('[covers:widget.stats-chart-values][covers:widget.stats-seg-renderer] bar_h 幾何: 全周stroke・データ端cap・rx=2廃止・高さ16 viewUnit維持（rect=14）', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    for (const section of ['by_category', 'top_stores']) {
      const bars = wrapper.findAll(`[data-section="${section}"] .bb-seg`)
      expect(bars.length, `${section} rows`).toBeGreaterThan(0)
      for (const b of bars) {
        expect(b.attributes('stroke'), `${section} stroke`).toBe('var(--seg-outline)')
        expect(b.attributes('stroke-width'), `${section} stroke-width`).toBe('2')
        // the old four-corner rx=2 is gone (the data end alone rounds, as a
        // path — no rx attribute on any row shape)
        expect(b.attributes('rx'), `${section} rx`).toBeUndefined()
      }
      // every row bar is the capped path now (single segment = data end)
      expect(bars.every((b) => b.element.tagName === 'path'), `${section} capped paths`).toBe(true)
    }
    // the row keeps its 16-unit bar height: the outer size rides data-size
    // (the stroke-inclusive height; 16 = ROW−14 unchanged)
    const bars = wrapper.findAll('[data-section="by_category"] .bb-seg')
    expect(bars.every((b) => num(b.attributes('data-size')) > 0)).toBe(true)
    // top_stores rides the same report scale: 22000/100000 of the bar width
    const BAR_W = 320 - 110 - 70
    const store = wrapper.findAll('[data-section="top_stores"] .bb-seg')
    expect(num(store[0]!.attributes('data-size'))).toBeCloseTo((22000 / 100000) * BAR_W, 1)
  })

  // TASK-129 (widget.stats-chart-values + web-common.stack-dimension-rules):
  // the ShareBar absolute scale and the composition mode — the full length
  // is the rows sum / report scale (never the always-full stack), the
  // API-assembled rows keep their lineup (no top-3 slicing, no 5% fold),
  // the legend follows the bar's real composition and a fold keeps the
  // money sum, the null-key row is the rest-flagged fold target.
  it('[covers:widget.stats-chart-values][covers:widget.stats-seg-renderer] ShareBar: 全長=rows総和/報告scale・上位3化/5%fold不適用・fold時凡例は合算後で金額保持・null keyはrest写像', async () => {
    // (1) the plain by_category fixture: sum 52000 → barScale = 100000 →
    // full length 166.4 (NOT 320); three segments, no re-assembly
    const plain = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_category') }))
    const plainSegs = plain.wrapper.findAll('[data-chart="stacked_bar"] .bb-seg')
    expect(plainSegs).toHaveLength(3)
    expect(plainSegs.reduce((s, r) => s + num(r.attributes('data-size')), 0)).toBeCloseTo((52000 / 100000) * 320, 1)
    // (2) a 5-row composition with a 4.3% member: NO top-3 slicing and NO
    // 5% fold (the stackedOf rules do not apply — the API's lineup stands)
    const five = statsEnvelope('by_category')
    five.sections[0]!.rows = [
      { keys: [1], labels: ['食費'], value: 56000, share: 0.6 },
      { keys: [2], labels: ['日用品'], value: 30000, share: 0.3 },
      { keys: [3], labels: ['交通費'], value: 4000, share: 0.04 },
      { keys: [4], labels: ['趣味'], value: 2000, share: 0.02 },
      { keys: [5], labels: ['雑貨'], value: 2000, share: 0.02 },
    ]
    const fiveW = await mountWidget(fakeHost({ toolOutput: five }))
    const fiveSegs = fiveW.wrapper.findAll('[data-chart="stacked_bar"] .bb-seg')
    expect(fiveSegs).toHaveLength(5)
    // sum 94000 → barScale = 100000 → full length 300.8; all five clear the
    // minimum (6.4 units at the smallest), so nothing folds
    expect(fiveSegs.reduce((s, r) => s + num(r.attributes('data-size')), 0)).toBeCloseTo((94000 / 100000) * 320, 1)
    // (3) a fold: 小口 (0.96 units, sub-minimum) folds into the null-key
    // その他 row — the legend follows the merged composition, the money sum
    // is preserved (2,300円 = 300 + 2,000) and the rest keeps its data name
    const foldEnv = statsEnvelope('by_category')
    foldEnv.sections[0]!.rows = [
      { keys: [1], labels: ['食費'], value: 45000, share: 0.95 },
      { keys: [2], labels: ['小口'], value: 300, share: 0.01 },
      { keys: [null], labels: ['その他'], value: 2000, share: 0.04 },
    ]
    const foldW = await mountWidget(fakeHost({ toolOutput: foldEnv }))
    const foldSegs = foldW.wrapper.findAll('[data-chart="stacked_bar"] .bb-seg')
    expect(foldSegs).toHaveLength(2)
    // sum 47300 → barScale = 100000 → full length 151.36
    expect(foldSegs.reduce((s, r) => s + num(r.attributes('data-size')), 0)).toBeCloseTo((47300 / 100000) * 320, 1)
    const legend = foldW.wrapper.findAll('[data-chart="stacked_bar"] .bb-legend li')
    expect(legend.length).toBe(2)
    const legendText = legend.map((l) => l.text())
    expect(legendText.some((t) => t.includes('食費') && t.includes('45,000円'))).toBe(true)
    expect(legendText.some((t) => t.includes('その他') && t.includes('2,300円'))).toBe(true)
    // the bar shares one composition basis: 45000/47300 = 95.1%
    expect(legendText.some((t) => t.includes('95.1%'))).toBe(true)
  })

  // TASK-129 (widget.stats-seg-renderer): the three charts route their
  // segment outlines through the ONE common renderer — every segment shape
  // of bar_v, bar_h and stacked_bar carries the renderer's bb-seg class
  // (bar_v's existing geometry tests above keep pinning the actual shapes).
  it('[covers:widget.stats-seg-renderer] 3 chart（bar_v・bar_h・stacked_bar）のセグメント shape はすべて共通rendererの class bb-seg を持つ', async () => {
    const overview = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    for (const section of ['monthly_trend', 'by_category', 'top_stores']) {
      const shapes = overview.wrapper.findAll(`[data-section="${section}"] rect, [data-section="${section}"] path`)
      const segShapes = shapes.filter((r) => (r.attributes('fill') ?? '').startsWith('var(--series'))
      expect(segShapes.length, `${section} segment shapes`).toBeGreaterThan(0)
      expect(segShapes.every((r) => r.classes().includes('bb-seg')), `${section} bb-seg class`).toBe(true)
      expect(segShapes.every((r) => r.attributes('data-size') !== undefined), `${section} data-size`).toBe(true)
    }
    const byCat = await mountWidget(fakeHost({ toolOutput: statsEnvelope('by_category') }))
    const shareSegs = byCat.wrapper.findAll('[data-chart="stacked_bar"] .bb-seg')
    expect(shareSegs.length).toBeGreaterThan(0)
  })

  it('[covers:widget.stats-chart-axis-ends] bar_v labels: axis ends only, full form, single bar', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview'), meta: statsMeta('monthly_overview') }))
    const texts = wrapper.findAll('[data-section="monthly_trend"] text.bb-chart__axis')
    const bottom = texts.filter((t) => t.attributes('y') === '154')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]!.text()).toBe('2026年5月')
    expect(bottom[0]!.attributes('text-anchor')).toBe('start')
    expect(bottom[0]!.attributes('x')).toBe('36')
    expect(bottom[1]!.text()).toBe('2026年10月')
    expect(bottom[1]!.attributes('text-anchor')).toBe('end')
    expect(bottom[1]!.attributes('x')).toBe('320')
    // each bar keeps its full title (label + amount). TASK-116: the segments
    // carry their own <title> inside each rect, so the bar count limits the
    // search to the bar titles (direct g children) — still exactly 6
    const titles = wrapper.findAll('[data-section="monthly_trend"] g > title')
    expect(titles).toHaveLength(6)
    expect(titles[0]!.text()).toBe('2026年5月: 41,000円')

    const one = statsEnvelope('monthly_overview')
    const trend = one.sections.find((s) => s.id === 'monthly_trend')!
    trend.rows = [trend.rows[trend.rows.length - 1]!]
    const single = await mountWidget(fakeHost({ toolOutput: one, meta: statsMeta('monthly_overview') }))
    const bottomOne = single.wrapper.findAll('[data-section="monthly_trend"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(bottomOne).toHaveLength(1)
    expect(bottomOne[0]!.text()).toBe('2026年10月')
    expect(bottomOne[0]!.attributes('text-anchor')).toBe('start')
  })

  it('[covers:widget.stats-scatter-axis-ends] scatter_line labels: axis ends, JA dates, dup/single guards', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    const bottom = wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(bottom).toHaveLength(2)
    expect(bottom[0]!.text()).toBe('2026年8月2日')
    expect(bottom[0]!.attributes('text-anchor')).toBe('start')
    expect(bottom[0]!.attributes('x')).toBe('36')
    expect(bottom[1]!.text()).toBe('2026年10月5日')
    expect(bottom[1]!.attributes('text-anchor')).toBe('end')
    expect(bottom[1]!.attributes('x')).toBe('320')
    // each point keeps its title, rebuilt from the converted label
    const titles = wrapper.findAll('[data-chart="scatter_line"] g title')
    expect(titles).toHaveLength(3)
    expect(titles[0]!.text()).toBe('2026年8月2日（スーパーみどり 駅前店）: 238円')

    const dup = statsEnvelope('item_price_history')
    // 3 points kept; the last row is set to the first's date so the dup guard hides the end label
    dup.sections[0]!.rows[2]!.labels[0] = '2026-08-02'
    const dupW = await mountWidget(fakeHost({ toolOutput: dup }))
    const dupBottom = dupW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(dupBottom).toHaveLength(1)
    expect(dupBottom[0]!.text()).toBe('2026年8月2日')
    expect(dupBottom[0]!.attributes('text-anchor')).toBe('start')

    const one = statsEnvelope('item_price_history')
    one.sections[0]!.rows = [one.sections[0]!.rows[0]!]
    const oneW = await mountWidget(fakeHost({ toolOutput: one }))
    const oneBottom = oneW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')
    expect(oneBottom).toHaveLength(1)
    expect(oneBottom[0]!.text()).toBe('2026年8月2日')
    expect(oneBottom[0]!.attributes('text-anchor')).toBe('start')

    const raw = statsEnvelope('item_price_history')
    raw.sections[0]!.rows[0]!.labels[0] = '8/2'
    const rawW = await mountWidget(fakeHost({ toolOutput: raw }))
    expect(rawW.wrapper.findAll('[data-chart="scatter_line"] text.bb-chart__axis').filter((t) => t.attributes('y') === '154')[0]!.text()).toBe('8/2')
  })

  it('[covers:widget.stats-period-switch] period / report switch re-runs summarize_spending', async () => {
    const host = fakeHost({
      toolOutput: statsEnvelope('monthly_overview'),
      callTool: async (_n, a) => result(statsEnvelope((a as { report: ReportKind }).report, '2026年9月')),
    })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'monthly_overview', period: { preset: 'last_month' } })
    expect(wrapper.find('[data-test="totals-card"]').text()).toContain('2026年9月')
    await wrapper.find('[data-test="report-select"]').setValue('by_store')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'by_store' })
    expect(wrapper.find('[data-section="by_store"]').exists()).toBe(true)
  })

  it('[covers:widget.stats-period-switch] a period switch swaps _meta (trend_matrix) along with the envelope', async () => {
    // the re-run returns a consistently doubled matrix (series AND totals, so
    // the shares stay the same): only the segment amounts change — proof the
    // new response's meta took over the screen, not the initial one
    const doubled = trendMatrix()
    doubled.series = doubled.series.map((s) => ({ ...s, values: s.values.map((v) => v * 2), total: s.total * 2 }))
    doubled.bucket_totals = doubled.bucket_totals.map((v) => v * 2)
    const host = fakeHost({
      toolOutput: statsEnvelope('monthly_overview'),
      meta: statsMeta('monthly_overview'),
      callTool: async (_n, a) =>
        result(statsEnvelope((a as { report: ReportKind }).report, '2026年9月'), { meta: { trend_matrix: doubled } }),
    })
    const { wrapper } = await mountWidget(host)
    // the LAST 食費 segment = the newest month (2026-10, 38,000); the bars
    // render in ascending month order so find() would pick 2026-05 instead
    const segTitleOfFood = (w: VueWrapper) =>
      segShapes(w)
        .map((s) => segTitle(s))
        .filter((t) => t.startsWith('食費'))
        .at(-1)!
    expect(segTitleOfFood(wrapper)).toBe('食費 38,000円（73%）')
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(segTitleOfFood(wrapper)).toBe('食費 76,000円（73%）')
  })

  it('[covers:widget.stats-period-switch] explicit ledger is kept, item history needs its filter', async () => {
    const explicit = { ...statsEnvelope('by_store'), ledger: { id: 2, name: '実家', source: 'explicit' as const } }
    const host = fakeHost({ toolOutput: explicit, callTool: async () => result(explicit) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="period-select"]').setValue('this_year')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith('summarize_spending', { report: 'by_store', period: { preset: 'this_year' }, ledger_id: 2 })

    const noFilter = await mountWidget(fakeHost({ toolOutput: statsEnvelope('item_price_history') }))
    expect(noFilter.wrapper.find('[data-test="period-select"]').attributes('disabled')).toBeDefined()

    const withFilter = { ...statsEnvelope('item_price_history'), filters: { item_query: '牛乳' } }
    const h2 = fakeHost({ toolOutput: withFilter, callTool: async () => result(withFilter) })
    const m2 = await mountWidget(h2)
    await m2.wrapper.find('[data-test="period-select"]').setValue('last_6_months')
    await flushPromises()
    expect(h2.callTool).toHaveBeenLastCalledWith('summarize_spending', {
      report: 'item_price_history',
      period: { preset: 'last_6_months' },
      filters: { item_query: '牛乳' },
    })
  })

  it('[covers:widget.fullscreen-toggle] fullscreen button toggles the display mode', async () => {
    const host = fakeHost({ toolOutput: statsEnvelope() })
    const { wrapper } = await mountWidget(host)
    const btn = () => wrapper.find('[data-test="fullscreen-button"]')
    expect(btn().text()).toBe('全画面')
    await btn().trigger('click')
    expect(host.requestDisplayMode).toHaveBeenLastCalledWith('fullscreen')
    expect(btn().text()).toBe('戻す')
    await btn().trigger('click')
    expect(host.requestDisplayMode).toHaveBeenLastCalledWith('inline')
    expect(btn().text()).toBe('全画面')
  })

  // TASK-170 W-5 (design: tmp/tasks/tm-170/design_widget-row-grammar.md v3
  // §2): the totals card's value climbs to the web total's strongest tier —
  // 1.9rem w700 (the old 1.5rem is gone) — and the contract-only table
  // fallback aligns its amounts (w700 tabular right). Static: the tier is a
  // stylesheet property jsdom cannot evaluate.
  it('[covers:widget.stats-total-tier] 合計カードの値は最強階層（1.9rem w700）・table fallback の金額は w700 tabular right', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(wrapper.find('[data-test="totals-card"] .bb-card__value').exists()).toBe(true)
    const css = readFileSync(resolve(process.cwd(), 'src/widget/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const value = /\.bb-card__value\s*\{[^}]*\}/.exec(css)
    expect(value, '.bb-card__value rule').not.toBeNull()
    expect(value![0]).not.toMatch(/font-size:\s*1\.5rem/)
    expect(value![0]).toMatch(/font-size:\s*1\.9rem/)
    expect(value![0]).toMatch(/font-weight:\s*700/)
    const td = /\.bb-table[^{}]*td[^{]*\{[^}]*\}/.exec(css)
    expect(td, '.bb-table td rule').not.toBeNull()
    expect(td![0]).toMatch(/font-weight:\s*700/)
    expect(td![0]).toMatch(/tabular-nums/)
  })
})
