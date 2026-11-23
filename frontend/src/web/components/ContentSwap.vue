<script lang="ts">
// ContentSwap (TASK-146 §3 方針2): the ONE shared component every in-screen
// content transition goes through. The shell's RouterView recipe — no mode
// (both panes move at once), the leaving pane parked absolute, the wrapper
// relative with an overflow guard — reused on the same slide vocabulary,
// with dir='swap' crossing through the fade vocabulary instead. The swapKey
// is the COMMITTED content's identity (each page's load() bumps it once the
// response lands), so a mid-refetch press keeps the old content in place at full opacity (the
// two-stage render of web-shell.loading-skeleton) and the transition fires
// at the commit, never at the press. The first appearance (the skeleton ->
// data handover included) rides the appear fade. prefers-reduced-motion
// skips the machinery entirely (no classes, an instant swap; the stylesheet
// repeats the guard). The slot must be a single root element — the key is
// cloned onto it, which is what turns a key change into a transition.
import {
  cloneVNode,
  Comment,
  defineComponent,
  h,
  provide,
  ref,
  Transition,
  watch,
  type InjectionKey,
  type Ref,
} from 'vue'
import { prefersReducedMotion } from '../composables/reducedMotion'

export type SwapDir = 'forward' | 'back' | 'swap'

/** the pane's committed key — provided for the single-motion coordination:
 *  while a pane transition runs, the trend chart suppresses its own fade and
 *  AppearList keeps the fresh row mounts of the rebuilt pane silent
 *  (設計§3 単一演出原則) */
export const ContentSwapActive: InjectionKey<Readonly<Ref<boolean>>> = Symbol('content-swap-active')

/** the transition vocabulary of a dir — a guard (not a cast) so the runtime
 *  prop stays a plain String while an unknown dir falls back to the fade */
function vocabOf(dir: string): string {
  if (dir === 'forward') return 'slide-forward'
  if (dir === 'back') return 'slide-back'
  return 'page'
}

export default defineComponent({
  name: 'ContentSwap',
  props: {
    /** the committed content's identity; unchanged mid-refetch by contract */
    swapKey: { type: String, required: true },
    /** the move's shape — TASK-161 §2-4: the slide vocabulary is the shell
     *  navigation's alone; the in-page callers keep the default fade (a
     *  period move renders in place, never through the pane) */
    dir: { type: String, default: 'swap' },
  },
  setup(props, { slots }) {
    // true while the pane transition runs (the first appear included): the
    // trend chart inside the pane reads it and keeps its own fade off
    const swapping = ref(true)
    provide(ContentSwapActive, swapping)
    // the vocabulary is CAPTURED at the commit (review MED1): the sync watch
    // reads dir once per swapKey change and the render replays the captured
    // value, so a dir arriving after the capture (the next press while the
    // transition still runs) can never re-patch a transition already in
    // flight. The capture
    // starts at the fade vocabulary — the first appearance rides the fade
    // whatever dir says, a pane never slides in from a direction that was
    // never moved along — and a swap before the appear even finishes
    // already carries the move's direction
    let vocab = 'page'
    watch(
      () => props.swapKey,
      () => {
        vocab = vocabOf(props.dir)
        swapping.value = !prefersReducedMotion()
      },
      { flush: 'sync' },
    )
    return () => {
      // a leading HTML comment in the caller's template rides the slot array
      // as a Comment vnode — the pane is the first ELEMENT vnode, not [0]
      const inner = slots.default?.() ?? []
      const pane = inner.find((v) => v.type !== Comment) ?? null
      const child = pane === null ? null : cloneVNode(pane, { key: props.swapKey })
      if (child === null) return h('div', { class: 'content-swap' })
      if (prefersReducedMotion()) return h('div', { class: 'content-swap' }, [child])
      return h('div', { class: 'content-swap' }, [
        h(
          Transition,
          {
            appear: true,
            name: vocab,
            onAfterEnter: () => {
              swapping.value = false
            },
          },
          // a FRESH vnode per call — re-serving one captured vnode makes the
          // transition patch revisit the same node and loop (found as an
          // OOM on the feed's v-for pane)
          () => cloneVNode(child),
        ),
      ])
    }
  },
})
</script>
