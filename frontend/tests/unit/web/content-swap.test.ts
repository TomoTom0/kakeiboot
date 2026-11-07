// TASK-146 §3 (design: tmp/tasks/tm-146/design_period_navigation.md §3 方針2
// + the 単一演出原則 / 値の書換と遷移の境界 sections): ContentSwap — the ONE
// shared component every in-screen content transition goes through — and the
// two composables it pairs with: periodMove (the direction value derived from
// the period store, flush:'sync') and reducedMotion (the centralized
// prefers-reduced-motion probe navDirection.ts / trendWindow.ts used to
// implement privately). Written test-first: none of the three modules exist
// yet, so this file is red until the implementation lands.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { h, nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import AppearList from '@/web/components/AppearList.vue'
import ContentSwap, { ContentSwapActive } from '@/web/components/ContentSwap.vue'
import { prefersReducedMotion } from '@/web/composables/reducedMotion'
import { useTweenNumber } from '@/web/composables/useTweenNumber'

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

// TASK-161 §2-4 (web-common.period-move-voice, 指摘3): periodMove.ts is GONE
// — a period move no longer slides/remounts the pane (the committedKey drops
// the period range), the slide vocabulary stays shell-only (RouterView) and
// the §4 micro move gets its direction straight from the press. The old
// direction / consume tests (which exercised the composable and the step→
// slide wiring) left together with the module.
describe('periodMove 廃止 (TASK-161 §2-4)', () => {
  it('[covers:web-common.period-move-voice] periodMove.ts は存在せず SearchPage も usePeriodMove を import しない（slide語彙はshell RouterView専用）', () => {
    expect(existsSync(resolve(process.cwd(), 'src/web/composables/periodMove.ts'))).toBe(false)
    const search = readFileSync(resolve(process.cwd(), 'src/web/pages/SearchPage.vue'), 'utf8')
    expect(search.includes('periodMove')).toBe(false)
  })
})

// TASK-161 §2-2 (web-common.period-move-voice): the amount tween — the value
// vocabulary a period move rides when the pane no longer remounts. The
// review-高1 regressions: a mid-tween change to 0 (or a swapKey bump) must
// kill the running frames so the superseded amount can never come back, and
// a mid-tween re-target interpolates from the DISPLAYED value. rAF and the
// performance clock are pumped manually so the tween is deterministic
// without real 300ms waits.
describe('useTweenNumber (composable, TASK-161 §2-2)', () => {
  type Frame = () => void
  const handles = new Map<number, Frame>()
  let clock = 0
  let seq = 0
  beforeEach(() => {
    handles.clear()
    clock = 0
    seq = 0
    vi.stubGlobal('requestAnimationFrame', (cb: Frame) => {
      seq += 1
      handles.set(seq, cb)
      return seq
    })
    vi.stubGlobal('cancelAnimationFrame', (h: number) => handles.delete(h))
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })
  /** advance `ms` of tween time across `n` frames (each frame steps the
   *  clock before the batch runs, like the compositor would) */
  const frames = (n: number, ms = 100): void => {
    for (let i = 0; i < n; i++) {
      clock += ms
      const batch = [...handles.values()]
      handles.clear()
      for (const cb of batch) cb()
    }
  }

  it('[covers:web-common.period-move-voice] 出現（最初の変更）は即時確定・以後の変更はtween（0遷移もtween）', async () => {
    const src = ref(0)
    const shown = useTweenNumber(() => src.value)
    expect(shown.value).toBe(0)
    // the first change off the initial value is an appearance: instant
    src.value = 948
    await nextTick()
    expect(shown.value).toBe(948)
    // a later change tweens — a collapse to 0 included (a period move into
    // an empty month counts down on the live pane, review 中6): the first
    // frame lands part-way and further frames keep rolling
    src.value = 500
    await nextTick()
    frames(1)
    expect(shown.value).toBeGreaterThan(500)
    expect(shown.value).toBeLessThan(948)
    frames(10)
    expect(shown.value).toBe(500)
    src.value = 0
    await nextTick()
    expect(shown.value).toBeGreaterThan(0) // the tween to 0 is under way
    frames(10)
    expect(shown.value).toBe(0)
  })

  it('[covers:web-common.period-move-voice] tween中の0への変更は旧frameを殺す（確定後も旧金額が復活しない）・swapKey bumpも即時', async () => {
    const src = ref(0)
    const key = ref('a')
    const shown = useTweenNumber(() => src.value, { swapKey: () => key.value })
    src.value = 948
    await nextTick()
    expect(shown.value).toBe(948)
    // roll toward 2000, then interrupt with a collapse to 0 mid-tween: the
    // displayed value retargets DOWN immediately (the old target's frames
    // die) and settles at 0 — never bouncing back up to 2000
    src.value = 2000
    await nextTick()
    frames(2)
    expect(shown.value).toBeGreaterThan(948)
    const beforeZero = shown.value
    src.value = 0
    await nextTick()
    frames(1)
    expect(shown.value).toBeLessThan(beforeZero) // retargeted down from the DISPLAYED value
    frames(20)
    expect(shown.value).toBe(0)
    // the superseded tween's frames are gone: no resurrection ever
    frames(20)
    expect(shown.value).toBe(0)
    // a change that bumps the pane key lands at once (the pane fade carries
    // it) — and kills its own running frames the same way
    key.value = 'b'
    src.value = 700
    await nextTick()
    expect(shown.value).toBe(700)
    frames(20)
    expect(shown.value).toBe(700)
  })

  it('[covers:web-common.period-move-voice] tween中の再targetは現在の表示値から補間する（旧source起点に戻らない）', async () => {
    const src = ref(0)
    const shown = useTweenNumber(() => src.value)
    src.value = 948
    await nextTick()
    expect(shown.value).toBe(948)
    src.value = 2000
    await nextTick()
    frames(1) // clock 100/300: eased = 1-(2/3)^3 = 19/27 → ~1610
    const mid = shown.value
    expect(mid).toBeGreaterThan(948)
    expect(mid).toBeLessThan(2000)
    // re-target: the NEXT frame continues from `mid`, not from 948 — after
    // another 100ms the from-displayed interpolation sits at
    // mid + 19/27*(3000-mid) ≈ 0.704 of the way, strictly above the
    // from-stale value (mid stays queued nowhere)
    src.value = 3000
    await nextTick()
    frames(1)
    const fromDisplayed = mid + (19 / 27) * (3000 - mid)
    const fromStale = 948 + (19 / 27) * (3000 - 948)
    expect(shown.value).toBeGreaterThan(fromStale)
    expect(shown.value).toBeCloseTo(fromDisplayed, 0)
    frames(10)
    expect(shown.value).toBe(3000)
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
