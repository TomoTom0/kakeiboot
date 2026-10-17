// LabelDots and the shared label spoken-name helpers (TASK-17, redesigned
// as managed labels in TASK-26): compact 8px color dots and a LabelChip
// list by default, with the color names gone from the visible text — the
// names below exist for aria only.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LabelDots from '@/shared/components/LabelDots.vue'
import { LABEL_COLORS, labelAriaList, labelAriaName } from '@/shared/labels'

const LABELS = [
  { color: 'red', title: '旅行' },
  { color: 'blue', title: null },
]

describe('shared/labels spoken names', () => {
  it('[covers:web-receipts.label-dots-a11y] labelAriaName は名前/ラベルN・labelAriaList は「、」結合、LABEL_COLORS は5色の定義順', () => {
    expect(labelAriaName(LABELS[0]!, 0)).toBe('旅行')
    expect(labelAriaName(LABELS[1]!, 3)).toBe('ラベル4')
    expect(labelAriaList(LABELS)).toBe('旅行、ラベル4')
    expect(labelAriaList([])).toBe('')
    expect(labelAriaList(null)).toBe('')
    expect([...LABEL_COLORS]).toEqual(['red', 'yellow', 'green', 'blue', 'purple'])
  })
})

describe('LabelDots', () => {
  it('[covers:web-receipts.label-dots-a11y] aria は名前/ラベルN・title は名前ありのみ・名前なしの可視テキストは空・非 compact は LabelChip・0件は非描画', () => {
    // compact: 8px dots, the spoken name as aria-label, a title only when
    // titled (an untitled label shows no text at all)
    const compact = mount(LabelDots, { props: { labels: LABELS, compact: true } })
    const cd = compact.findAll('[data-test="label-dot"]')
    expect(cd).toHaveLength(2)
    expect(cd[0]!.attributes('role')).toBe('img')
    expect(cd[0]!.attributes('aria-label')).toBe('旅行')
    expect(cd[0]!.attributes('title')).toBe('旅行')
    expect(cd[1]!.attributes('role')).toBe('img')
    expect(cd[1]!.attributes('aria-label')).toBe('ラベル4')
    expect(cd[1]!.attributes('title')).toBeUndefined()
    expect(compact.text()).toBe('')

    // default: the labels render as LabelChip list (titled = the name chip,
    // untitled = the bare color chip, still no color-name text)
    const full = mount(LabelDots, { props: { labels: LABELS } })
    const chips = full.findAll('.label-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.classes()).toContain('label-red')
    expect(chips[0]!.classes()).toContain('titled')
    expect(chips[0]!.text()).toBe('旅行')
    expect(chips[1]!.classes()).toContain('label-blue')
    expect(chips[1]!.text()).toBe('')
    expect(full.text()).toBe('旅行')

    const none = mount(LabelDots, { props: { labels: [] } })
    expect(none.element.children).toHaveLength(0)
    expect(none.text()).toBe('')
  })
})
