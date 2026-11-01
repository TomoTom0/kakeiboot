// TASK-146 §3 (design: tmp/tasks/tm-146/design_period_navigation.md §3 方針2
// + the 単一演出原則 / 値の書換と遷移の境界 sections): ContentSwap — the ONE
// shared component every in-screen content transition goes through — and the
// two composables it pairs with: periodMove (the direction value derived from
// the period store, flush:'sync') and reducedMotion (the centralized
// prefers-reduced-motion probe navDirection.ts / trendWindow.ts used to
// implement privately). Written test-first: none of the three modules exist
// yet, so this file is red until the implementation lands.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AppearList from '@/web/components/AppearList.vue'
import ContentSwap, { ContentSwapActive } from '@/web/components/ContentSwap.vue'
import { usePeriodMove } from '@/web/composables/periodMove'
import { prefersReducedMotion } from '@/web/composables/reducedMotion'
import { usePeriodStore } from '@/web/stores/period'

// the reduced-motion probe doubles: helpers' matchMedia stub belongs to
// mountApp, and this file mounts the component directly
let reduced = false

beforeEach(() => {
  // the period store anchors its defaults on "today" — keep the fixtures'
  // 2026-10-15 so the direction cases are deterministic
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  reduced = false
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: reduced && media.includes('reduce'),
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** ContentSwap with a slot whose text names the committed key. */
function swap(swapKey: string, dir: 'forward' | 'back' | 'swap') {
  return mount(ContentSwap, {
    props: { swapKey, dir },
    slots: { default: `<p data-test="slot">${swapKey}</p>` },
    global: { stubs: { transition: false } },
  })
}

/** the motion classes currently held by the wrapper's children */
const motionClasses = (w: ReturnType<typeof swap>): string[] =>
  Array.from<Element>(w.element.children).flatMap((el) =>
    Array.from<string>(el.classList).filter((c) => c.includes('-enter-') || c.includes('-leave-')),
  )

describe('ContentSwap (component, TASK-146 §3)', () => {
  it('[covers:web-common.content-swap] mount: slot を1つ描き wrapper は content-swap・初回出現は appear fade（page-enter-*）', () => {
    const w = swap('a', 'forward')
    expect(w.classes()).toContain('content-swap')
    expect(w.element.children).toHaveLength(1)
    const child = w.element.firstElementChild!
    expect(child.getAttribute('data-test')).toBe('slot')
    // the first appearance (skeleton -> data included) rides the appear fade
    // of the fade vocabulary — not the slide machinery
    expect(child.classList.contains('page-enter-active')).toBe(true)
    expect(child.classList.contains('page-enter-from')).toBe(true)
    w.unmount()
  })

  it('[covers:web-common.content-swap] swapKey 切替は dir の語彙で遷移: forward/back は shell と同じ slide 族・swap は fade（page-*）', async () => {
    for (const dir of ['forward', 'back'] as const) {
      const w = swap('a', dir)
      await w.setProps({ swapKey: 'b' })
      await nextTick()
      const motion = motionClasses(w)
      expect(motion.some((c) => c.startsWith(`slide-${dir}-enter-`)), dir).toBe(true)
      expect(motion.some((c) => c.startsWith(`slide-${dir}-leave-`)), dir).toBe(true)
      w.unmount()
    }
    // dir='swap' crosses through the fade vocabulary instead
    const w = swap('a', 'swap')
    await w.setProps({ swapKey: 'b' })
    await nextTick()
    const motion = motionClasses(w)
    expect(motion.some((c) => c.startsWith('page-enter-'))).toBe(true)
    expect(motion.some((c) => c.startsWith('page-leave-'))).toBe(true)
    expect(motion.some((c) => c.startsWith('slide-'))).toBe(false)
    w.unmount()
  })

  it('[covers:web-common.content-swap] swapKey 不変の dir 変化では遷移しない（commit 识別子が動いた時だけ発火）', async () => {
    const w = swap('a', 'forward')
    await nextTick()
    await w.setProps({ dir: 'back' })
    await nextTick()
    expect(w.element.children).toHaveLength(1)
    expect(
      Array.from<string>(w.element.firstElementChild!.classList).some((c) => c.startsWith('slide-back')),
    ).toBe(false)
    w.unmount()
  })

  it('[covers:web-common.content-swap] prefers-reduced-motion では class 付与なし（初回も切替も即時）', async () => {
    reduced = true
    const w = swap('a', 'forward')
    const child = w.element.firstElementChild!
    expect(child.getAttribute('data-test')).toBe('slot')
    expect(motionClasses(w)).toEqual([])
    await w.setProps({ swapKey: 'b' })
    await nextTick()
    expect(w.element.children).toHaveLength(1)
    expect(w.element.firstElementChild!.getAttribute('data-test')).toBe('slot')
    expect(motionClasses(w)).toEqual([])
    w.unmount()
  })
})

describe('periodMove (composable, TASK-146 §3 + review MED1)', () => {
  it('[covers:web-common.content-swap] 方向確定: mode 変化→swap・range from 増→forward・減→back・range 不変の変化→swap（flush sync で即時）', () => {
    const period = usePeriodStore()
    const move = usePeriodMove(ref('k0'))
    // the initial value before any move (the first commit appears, it never
    // slides) — 'swap' is the neutral member
    expect(move.dir.value).toBe('swap')
    // a later month: the from date moves up -> forward
    period.setMonth('2026-11')
    expect(move.dir.value).toBe('forward')
    // an earlier month -> back
    period.setMonth('2026-09')
    expect(move.dir.value).toBe('back')
    // a mode change wins over the range move -> swap
    period.mode = 'week'
    expect(move.dir.value).toBe('swap')
    // within the same mode, a later week -> forward again
    period.setWeek('2026-10-19')
    expect(move.dir.value).toBe('forward')
    // a change that leaves the range alone (labels, a refetch) -> swap
    period.setLabelColors(['red'])
    expect(move.dir.value).toBe('swap')
  })

  it('[covers:web-common.content-swap] consume (review MED1): dir は commit（committedKey 変化）1回で消費され swap へ戻る。局所filter変更の commit は fade のままで・次の移動は正しい方向を再導出する', async () => {
    const period = usePeriodStore()
    const committedKey = ref('k0')
    const move = usePeriodMove(committedKey)
    // a step forward, then the step's load settles (the commit)
    period.setMonth('2026-11')
    expect(move.dir.value).toBe('forward')
    committedKey.value = 'k1'
    await nextTick()
    // the direction served exactly one commit — the value is consumed
    expect(move.dir.value).toBe('swap')
    // a LOCAL filter change (a commit with no period move: a listQuery
    // context, a search tab) must cross through the fade, never a stale slide
    committedKey.value = 'k1|filter'
    await nextTick()
    expect(move.dir.value).toBe('swap')
    // the consumption never breaks the derivation: the next step still
    // derives its own direction along the pressed way
    period.setMonth('2026-09')
    expect(move.dir.value).toBe('back')
    committedKey.value = 'k2'
    await nextTick()
    expect(move.dir.value).toBe('swap')
    period.setMonth('2026-12')
    expect(move.dir.value).toBe('forward')
  })
})

// MED1 end-to-end: the page grammar (ContentSwap fed by periodMove bound to
// the page's committedKey) — the slide serves exactly the stepped commit and
// every later local-filter commit crosses through the fade
const SwapHost = defineComponent({
  components: { ContentSwap },
  setup() {
    const period = usePeriodStore()
    const committedKey = ref('k0')
    const move = usePeriodMove(committedKey)
    let n = 0
    return {
      committedKey,
      dir: move.dir,
      // the load commit every page performs when its response lands (a step
      // and a local filter change both end here — only the step moves dir)
      commit: () => {
        n += 1
        committedKey.value = `k${n}`
      },
      stepNext: () => period.setMonth('2026-11'),
      stepBack: () => period.setMonth('2026-09'),
    }
  },
  template: `
    <main>
      <ContentSwap :swap-key="committedKey" :dir="dir">
        <p data-test="pane">{{ committedKey }}</p>
      </ContentSwap>
      <button data-test="next" @click="stepNext">next</button>
      <button data-test="back" @click="stepBack">back</button>
      <button data-test="commit" @click="commit">commit</button>
    </main>`,
})

/** the motion classes of the pane currently showing the given key */
function paneMotion(w: ReturnType<typeof mount>, key: string): string[] {
  const panes: Element[] = Array.from(w.element.querySelectorAll('[data-test="pane"]'))
  const pane = panes.find((el) => el.textContent === key)
  return pane === undefined ? [] : Array.from<string>(pane.classList)
}

describe('ContentSwap x periodMove consume (review MED1)', () => {
  it('[covers:web-common.content-swap] step→commit は slide・その後の局所filter変更の commit は fade（stale slide しない）・逆方向stepは常に正しい方向', async () => {
    const w = mount(SwapHost, { global: { stubs: { transition: false } } })
    // the first appearance fades whatever dir holds (requirement: appear)
    expect(paneMotion(w, 'k0')).toContain('page-enter-active')

    // a step forward, then its load settles: the slide-forward serves it
    await w.find('[data-test="next"]').trigger('click')
    await w.find('[data-test="commit"]').trigger('click')
    const stepped = paneMotion(w, 'k1')
    expect(stepped.some((c) => c.startsWith('slide-forward-enter-'))).toBe(true)

    // a local filter change commits next: the consumed dir must NOT slide
    await w.find('[data-test="commit"]').trigger('click')
    const filtered = paneMotion(w, 'k2')
    expect(filtered.some((c) => c.startsWith('page-enter-'))).toBe(true)
    expect(filtered.some((c) => c.startsWith('slide-'))).toBe(false)

    // the opposite step still slides its own way (the reset broke nothing)
    await w.find('[data-test="back"]').trigger('click')
    await w.find('[data-test="commit"]').trigger('click')
    expect(paneMotion(w, 'k3').some((c) => c.startsWith('slide-back-enter-'))).toBe(true)
    w.unmount()
  })
})

// MED2: the shared bb-appear list carrier. A fresh list mount DURING a pane
// transition is the pane rebuild itself — its rows must not run the appear
// fade on top of the pane's motion; any later fresh mount (a "さらに表示"
// page opening a NEW day group) keeps the appear fade, and appended rows
// keep entering through the grammar (appear gates only the fresh mounts)
const rowsSlot = (rows: string[]) => rows.map((r) => h('li', { key: r, 'data-test': `row-${r}` }, r))

const rowHasAppear = (w: ReturnType<typeof mount>, row: string): boolean =>
  Array.from(w.find(`[data-test="row-${row}"]`).element.classList).some((c) =>
    c.startsWith('bb-appear'),
  )

describe('AppearList (component, review MED2)', () => {
  it('[covers:web-common.content-swap] pane 遷移中の fresh mount は行appearなし（二重演出しない）・pane 遷移外の fresh mount は appear fade・provider なしは appear のまま', () => {
    // the pane transition is running: the rows of the rebuilt pane stay put
    const swapping = mount(AppearList, {
      slots: { default: () => rowsSlot(['a', 'b']) },
      global: { provide: { [ContentSwapActive]: ref(true) }, stubs: { 'transition-group': false } },
    })
    expect(rowHasAppear(swapping, 'a')).toBe(false)
    swapping.unmount()
    // outside a pane transition (a "さらに表示" NEW day group): appear fade
    const settled = mount(AppearList, {
      slots: { default: () => rowsSlot(['a', 'b']) },
      global: { provide: { [ContentSwapActive]: ref(false) }, stubs: { 'transition-group': false } },
    })
    expect(rowHasAppear(settled, 'a')).toBe(true)
    settled.unmount()
    // with no ContentSwap above (a standalone list): the appear stays on
    const standalone = mount(AppearList, {
      slots: { default: () => rowsSlot(['a', 'b']) },
      global: { stubs: { 'transition-group': false } },
    })
    expect(rowHasAppear(standalone, 'a')).toBe(true)
    standalone.unmount()
  })

  it('[covers:web-common.content-swap] 追加行の enter は appear 制御の対象外（pane 遷移中でも追加行は出現fadeのまま）', async () => {
    const rows = ref(['a', 'b'])
    const w = mount(AppearList, {
      slots: { default: () => rowsSlot(rows.value) },
      global: { provide: { [ContentSwapActive]: ref(true) }, stubs: { 'transition-group': false } },
    })
    await nextTick()
    rows.value = [...rows.value, 'c']
    await nextTick()
    expect(rowHasAppear(w, 'a')).toBe(false)
    expect(rowHasAppear(w, 'c')).toBe(true)
    w.unmount()
  })

  it('[covers:web-common.content-swap] ContentSwap pane 再構築では pane のみが遷移し行はappearしない（初回も）', async () => {
    const w = mount(ContentSwap, {
      props: { swapKey: 'a', dir: 'forward' },
      slots: { default: () => [h(AppearList, () => rowsSlot(['x']))] },
      global: { stubs: { transition: false, 'transition-group': false } },
    })
    // the first appearance: the pane fades as one motion, rows stay silent
    expect(w.find('ul').classes()).toContain('page-enter-active')
    expect(rowHasAppear(w, 'x')).toBe(false)
    // a period step commit rebuilds the pane: the pane slides, and the rows
    // of the rebuilt pane never re-run their appear fade (no double motion)
    await w.setProps({ swapKey: 'b' })
    const entering = w
      .findAll('ul')
      .filter((u) => u.classes().includes('slide-forward-enter-active'))
    expect(entering).toHaveLength(1)
    expect(rowHasAppear(w, 'x')).toBe(false)
    w.unmount()
  })
})

describe('reducedMotion (composable, TASK-146 §3)', () => {
  it('[covers:web-common.content-swap] prefers-reduced-motion 判定の一元化（navDirection/trendWindow の私有実装は廃止）', () => {
    expect(prefersReducedMotion()).toBe(false)
    reduced = true
    expect(prefersReducedMotion()).toBe(true)
    // the two private probes fold into the composable: both modules import
    // it and neither keeps its own matchMedia reading
    const src = (p: string) => readFileSync(resolve(process.cwd(), 'src/web', p), 'utf8')
    expect(src('composables/navDirection.ts')).toMatch(/from '\.\/reducedMotion'/)
    expect(src('composables/trendWindow.ts')).toMatch(/from '\.\/reducedMotion'/)
    expect(src('composables/navDirection.ts')).not.toMatch(/function prefersReducedMotion/)
    expect(src('composables/trendWindow.ts')).not.toMatch(/prefers-reduced-motion/)
  })
})
