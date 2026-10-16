// PopoverPanel (TASK-27 §4): the shared non-modal dialog popover built on
// usePopover (composables/popover.ts) — forms and toggles go here while
// PopoverMenu keeps role=menu (its own expectations live in
// dashboard-shell.test.ts). Covered: open/close through the trigger, the
// dialog role and labels, focus management (data-autofocus, fallback to the
// first focusable element, back to the trigger on close) and the
// sheet-narrow variant's narrow-screen class.
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import PopoverPanel from '@/web/components/PopoverPanel.vue'

// The panel derives the narrow layout from matchMedia('(max-width: 480px)').
let narrow = false

beforeEach(() => {
  narrow = false
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === '(max-width: 480px)' && narrow,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

/** PopoverPanel props as passed by these helpers (label is a required prop). */
interface PanelProps {
  variant?: 'anchored' | 'sheet-narrow'
  label: string
}

/**
 * Mount PopoverPanel with a trigger button. The trigger slot hands out the
 * aria wiring; whatever it provides is v-bound onto the button as-is, so the
 * test pins "the slot provides aria-expanded / aria-controls" without
 * inventing further prop names.
 */
function mountPanel(props: PanelProps, content: () => unknown): VueWrapper {
  const host = defineComponent({
    setup: () => () =>
      h(PopoverPanel, props, {
        trigger: (scope: Record<string, unknown>) =>
          h('button', { type: 'button', 'data-test': 'trigger', ...scope }, '開く'),
        default: content,
      }),
  })
  return mount(host, { attachTo: document.body.appendChild(document.createElement('div')) })
}

/** Mount and click the trigger so the panel is open. */
async function openPanel(props: PanelProps, content: () => unknown): Promise<VueWrapper> {
  const wrapper = mountPanel(props, content)
  await wrapper.find('[data-test="trigger"]').trigger('click')
  await flushPromises()
  return wrapper
}

function keydownEscape(target: EventTarget = document.activeElement ?? document.body): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}

/** A pointer press outside the component (document.body hosts it). */
function pointerDownOutside(): void {
  for (const type of ['pointerdown', 'mousedown', 'click']) {
    document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  }
}

describe('PopoverPanel', () => {
  it('[covers:web-shell.popover-panel] トリガで開き role=dialog（aria-label・非モーダル）・aria-expanded / aria-controls、data-autofocus へフォーカス、Escape で閉じトリガへ', async () => {
    const wrapper = await openPanel(
      { variant: 'anchored', label: 'ラベルの選択' },
      // a focusable button precedes the autofocus target on purpose
      () => [h('button', { type: 'button' }, '先頭のボタン'), h('input', { 'data-autofocus': '' })],
    )
    const trigger = wrapper.find('[data-test="trigger"]')
    const panel = wrapper.find('[role="dialog"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('aria-label')).toBe('ラベルの選択')
    expect(panel.attributes('aria-modal')).not.toBe('true') // non-modal
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(panel.attributes('id')).toBeTruthy()
    expect(trigger.attributes('aria-controls')).toBe(panel.attributes('id'))
    // the focus goes to [data-autofocus], not to the first focusable element
    expect(document.activeElement).toBe(wrapper.find('[data-autofocus]').element)

    keydownEscape()
    await flushPromises()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('[covers:web-shell.popover-panel] data-autofocus が無ければ最初のフォーカス可能要素へ、外側 pointerdown で閉じトリガへフォーカス', async () => {
    const wrapper = await openPanel(
      { variant: 'anchored', label: '並べ替え' },
      () => [h('button', { type: 'button' }, '甲'), h('input')],
    )
    const inPanel = wrapper.findAll('[role="dialog"] button')
    expect(inPanel).toHaveLength(1)
    expect(document.activeElement).toBe(inPanel[0]!.element)

    pointerDownOutside()
    await flushPromises()
    const trigger = wrapper.find('[data-test="trigger"]')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('[covers:web-shell.popover-panel] sheet-narrow は 480px 以下だけで狭幅クラス、anchored には付かない', async () => {
    const content = () => [h('input')]
    narrow = true
    const narrowPanel = (await openPanel({ variant: 'sheet-narrow', label: '絞り込み' }, content)).find('[role="dialog"]')

    narrow = false
    const widePanel = (await openPanel({ variant: 'sheet-narrow', label: '絞り込み' }, content)).find('[role="dialog"]')
    const anchoredPanel = (await openPanel({ variant: 'anchored', label: '絞り込み' }, content)).find('[role="dialog"]')

    expect(narrowPanel.exists()).toBe(true)
    expect(widePanel.exists()).toBe(true)
    expect(anchoredPanel.exists()).toBe(true)
    // some class appears only at 480px or below...
    const narrowOnly = narrowPanel.classes().filter((c) => !widePanel.classes().includes(c))
    expect(narrowOnly.length).toBeGreaterThan(0)
    // ...and never on the anchored variant
    for (const c of narrowOnly) expect(anchoredPanel.classes()).not.toContain(c)
  })
})
