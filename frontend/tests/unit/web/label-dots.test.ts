// LabelDots and the shared label text helpers (TASK-17): display-only color
// dots with color-name text + aria, and the label <-> text conversions.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LabelDots from '@/shared/components/LabelDots.vue'
import { LABEL_COLORS, labelColorsText, labelText } from '@/shared/labels'

const LABELS = [
  { color: 'red', title: '旅行' },
  { color: 'blue', title: null },
]

describe('shared/labels text', () => {
  it('[covers:web-receipts.label-dots-a11y] labelText は「色名: タイトル」/「色名」、labelColorsText は「赤・青」、LABEL_COLORS は5色の定義順', () => {
    expect(labelText(LABELS[0]!)).toBe('赤: 旅行')
    expect(labelText(LABELS[1]!)).toBe('青')
    expect(labelColorsText(['red', 'blue'])).toBe('赤・青')
    expect(labelColorsText([])).toBe('')
    expect([...LABEL_COLORS]).toEqual(['red', 'yellow', 'green', 'blue', 'purple'])
  })
})

describe('LabelDots', () => {
  it('[covers:web-receipts.label-dots-a11y] 各ドットは role=img・aria-label・title、compact はドットのみ、0件は非描画', () => {
    const full = mount(LabelDots, { props: { labels: LABELS } })
    const dots = full.findAll('[data-test="label-dot"]')
    expect(dots).toHaveLength(2)
    expect(dots[0]!.attributes('role')).toBe('img')
    expect(dots[0]!.attributes('aria-label')).toBe('赤: 旅行')
    expect(dots[0]!.attributes('title')).toBe('赤: 旅行')
    expect(dots[1]!.attributes('role')).toBe('img')
    expect(dots[1]!.attributes('aria-label')).toBe('青')
    expect(full.text()).toContain('旅行')

    const compact = mount(LabelDots, { props: { labels: LABELS, compact: true } })
    const cd = compact.findAll('[data-test="label-dot"]')
    expect(cd).toHaveLength(2)
    expect(cd[0]!.attributes('aria-label')).toBe('赤: 旅行')
    expect(compact.text()).not.toContain('旅行')

    const none = mount(LabelDots, { props: { labels: [] } })
    expect(none.element.children).toHaveLength(0)
    expect(none.text()).toBe('')
  })
})
