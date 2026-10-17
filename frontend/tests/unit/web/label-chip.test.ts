// The managed-label UI parts (TASK-26): LabelChip (the shared visual of one
// label), LabelToggleGroup (the five labels as toggle chips shared by the
// picker and filter popovers) and the LabelFilter toolbar button (word when
// unselected, color dots when active, a compact icon-only variant). The
// screen never shows color-name text anywhere (web-labels
// .no-color-names-on-screen).
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LabelChip from '@/shared/components/LabelChip.vue'
import LabelDots from '@/shared/components/LabelDots.vue'
import type { Label, LabelColor } from '@/shared/labels'
import LabelFilter from '@/web/components/LabelFilter.vue'
import LabelToggleGroup from '@/web/components/LabelToggleGroup.vue'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { useLabelsStore } from '@/web/stores/labels'
import { useSessionStore } from '@/web/stores/session'

const TITLED = { color: 'red', title: '旅行' }
const BARE = { color: 'blue', title: null }

/** Visible text / title attributes must never carry these (aria is exempt). */
const FORBIDDEN = [/赤|黄|緑|青|紫/, /ラベル[1-5]/, /名前なし/]
function expectNoColorNames(text: string, titles: string[]): void {
  for (const re of FORBIDDEN) {
    expect(text, `visible text "${text}"`).not.toMatch(re)
    for (const t of titles) expect(t, `title "${t}"`).not.toMatch(re)
  }
}

afterEach(() => {
  setDataApi(null)
  document.body.innerHTML = ''
})

describe('LabelChip', () => {
  it('[covers:web-labels.label-chip] 名前ありは名前テキスト+色クラス+title、名前なしはテキスト空、selected はリング+チェック、aria は名前/ラベルN', () => {
    const titled = mount(LabelChip, { props: { label: TITLED, index: 0 } })
    expect(titled.classes()).toContain('label-red')
    expect(titled.classes()).toContain('titled')
    expect(titled.text()).toBe('旅行')
    expect(titled.attributes('title')).toBe('旅行')
    expect(titled.attributes('aria-label')).toBe('旅行')
    expect(titled.attributes('role')).toBe('img')
    expect(titled.find('.label-check').exists()).toBe(false)

    const bare = mount(LabelChip, { props: { label: BARE, index: 3 } })
    expect(bare.classes()).toContain('label-blue')
    expect(bare.text()).toBe('') // no text at all for an untitled label
    expect(bare.attributes('title')).toBeUndefined()
    // neutral spoken name from the definition order (blue = 4th)
    expect(bare.attributes('aria-label')).toBe('ラベル4')

    // selected: the ring class plus the check (white and centered when bare)
    const sel = mount(LabelChip, { props: { label: BARE, index: 3, selected: true } })
    expect(sel.classes()).toContain('selected')
    expect(sel.find('.label-check').exists()).toBe(true)
    const selTitled = mount(LabelChip, { props: { label: TITLED, index: 0, selected: true, size: 'sm' } })
    expect(selTitled.classes()).toContain('sm')
    expect(selTitled.find('.label-check').exists()).toBe(true)
    expect(selTitled.text()).toBe('旅行')

    expectNoColorNames(titled.text() + bare.text() + selTitled.text(), [
      titled.attributes('title') ?? '',
      bare.attributes('title') ?? '',
    ])
  })
})

describe('LabelToggleGroup', () => {
  const DEFINITIONS: Label[] = [
    { color: 'red', title: '旅行' },
    { color: 'yellow', title: null },
    { color: 'green', title: '誕生日' },
    { color: 'blue', title: null },
    { color: 'purple', title: null },
  ]

  interface GroupProps {
    selected?: LabelColor[]
    definitions?: Label[]
    disabled?: boolean
  }

  function mountGroup(props: GroupProps = {}) {
    const wrapper = mount(LabelToggleGroup, {
      props: {
        selected: ['red'],
        definitions: DEFINITIONS,
        groupLabel: 'ラベル',
        ...props,
      },
      attachTo: document.body.appendChild(document.createElement('div')),
    })
    return wrapper
  }

  it('[covers:web-labels.toggle-group] 5個のLabelChipボタン・aria-pressed・矢印キー移動・disabled', async () => {
    const wrapper = mountGroup()
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(5)
    // one button per label, each wrapping a chip, pressed state as aria-pressed
    expect(buttons[0]!.attributes('aria-pressed')).toBe('true')
    expect(buttons[1]!.attributes('aria-pressed')).toBe('false')
    expect(buttons[0]!.find('.label-chip').classes()).toContain('selected')
    expect(buttons[0]!.attributes('aria-label')).toBe('旅行')
    expect(buttons[1]!.attributes('aria-label')).toBe('ラベル2')
    expect(wrapper.attributes('role')).toBe('group')
    expect(wrapper.attributes('aria-label')).toBe('ラベル')

    // clicking emits the color
    await buttons[2]!.trigger('click')
    expect(wrapper.emitted('toggle')).toEqual([['green']])

    // ArrowRight / ArrowLeft rove the focus through the buttons
    buttons[0]!.element.focus()
    await buttons[0]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1]!.element)
    await buttons[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[2]!.element)
    await buttons[2]!.trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[1]!.element)

    // disabled group: no focusable buttons
    const disabled = mountGroup({ disabled: true })
    for (const b of disabled.findAll('button')) expect(b.attributes('disabled')).toBeDefined()
    wrapper.unmount()
    disabled.unmount()
  })
})

describe('LabelFilter button', () => {
  async function mountFilter(props: { modelValue?: LabelColor[]; compact?: boolean } = {}) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const api: DataApi = createMockDataApi()
    Object.assign(api, {
      listLabels: vi.fn(async () => ({
        labels: [
          { color: 'red', title: '旅行' },
          { color: 'yellow', title: null },
          { color: 'green', title: null },
          { color: 'blue', title: null },
          { color: 'purple', title: null },
        ],
      })),
    })
    setDataApi(api)
    const labels = useLabelsStore(pinia)
    const session = useSessionStore(pinia)
    session.selectedLedgerId = 1
    await labels.load(1)
    await flushPromises()
    const wrapper = mount(LabelFilter, {
      props: { modelValue: props.modelValue ?? [], compact: props.compact },
      global: { plugins: [pinia] },
      attachTo: document.body.appendChild(document.createElement('div')),
    })
    return wrapper
  }

  it('[covers:web-labels.filter-button] 未選択は語あり、選択中は語なし+点+accent、compact はアイコンのみ、aria-label、解除', async () => {
    // unselected: the word rides along
    const plain = await mountFilter()
    const btn = plain.find('[data-test="label-filter-button"]')
    expect(btn.text()).toContain('ラベル')
    expect(btn.attributes('aria-label')).toBe('ラベルで絞り込み')
    expect(btn.classes()).not.toContain('active')
    expect(btn.find('.label-filter-dot').exists()).toBe(false)

    // a selection drops the word for the chosen colors' dots
    const active = await mountFilter({ modelValue: ['red', 'yellow'] })
    const activeBtn = active.find('[data-test="label-filter-button"]')
    expect(activeBtn.classes()).toContain('active')
    expect(activeBtn.text()).not.toContain('ラベル')
    const dots = activeBtn.findAll('.label-filter-dot')
    expect(dots).toHaveLength(2)
    expect(dots[0]!.classes()).toContain('label-red')
    // aria names the chosen labels (title first, neutral names after)
    expect(activeBtn.attributes('aria-label')).toBe('ラベルで絞り込み: 旅行、ラベル2')

    // the popover carries the toggle group and the clear button
    await activeBtn.trigger('click')
    await flushPromises()
    const group = active.find('.label-toggle-group')
    expect(group.exists()).toBe(true)
    expect(active.find('[data-test="label-filter-red"]').attributes('aria-pressed')).toBe('true')
    const clear = active.find('[data-test="label-filter-clear"]')
    expect(clear.attributes('disabled')).toBeUndefined()
    await clear.trigger('click')
    expect(active.emitted('update:modelValue')).toEqual([[[]]])
    // clearing keeps the popover open for further adjustments
    expect(activeBtn.attributes('aria-expanded')).toBe('true')

    // compact: icon only, no word even when unselected
    const compact = await mountFilter({ modelValue: [], compact: true })
    const compactBtn = compact.find('[data-test="label-filter-button"]')
    expect(compactBtn.classes()).toContain('compact')
    expect(compactBtn.text()).toBe('')

    // with no selection the clear button is disabled
    await plain.find('[data-test="label-filter-button"]').trigger('click')
    await flushPromises()
    expect(plain.find('[data-test="label-filter-clear"]').attributes('disabled')).toBeDefined()

    expectNoColorNames(plain.text() + active.text() + compact.text(), [])
    for (const w of [plain, active, compact]) w.unmount()
  })
})

describe('LabelDots no-color-names guard', () => {
  it('[covers:web-labels.no-color-names-on-screen] compact も通常も可視テキスト・title に色名・ラベルN・名前なしを出さない', () => {
    const full = mount(LabelDots, { props: { labels: [TITLED, BARE] } })
    const compact = mount(LabelDots, { props: { labels: [TITLED, BARE], compact: true } })
    // the non-compact list renders LabelChips (titled = the name, bare = no text)
    expect(full.findAll('.label-chip')).toHaveLength(2)
    expect(full.text()).toBe('旅行')
    const titles = full.findAll('[title]').map((n) => n.attributes('title') ?? '')
    expect(titles).toEqual(['旅行'])
    expectNoColorNames(full.text() + compact.text(), titles)
    full.unmount()
    compact.unmount()
  })
})
