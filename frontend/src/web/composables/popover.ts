import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

// Shared popover behavior (TASK-27 §4-2): open/close with the focus
// returned to the trigger, closing on an outside pointerdown and on Escape,
// and a --popover-shift custom property that keeps the panel inside the
// viewport (16px margins) once it has opened. PopoverMenu (role=menu) and
// PopoverPanel (role=dialog) both sit on this.
export interface UsePopoverOptions {
  /** the open/close state (v-model:open on the components) */
  open: Ref<boolean>
  /** the whole component root: a pointerdown inside it does not close */
  rootEl: Ref<HTMLElement | null>
  /** the trigger area: closing returns the focus to its focusable element */
  triggerEl: Ref<HTMLElement | null>
  /** the floating panel, measured for the viewport shift */
  panelEl: Ref<HTMLElement | null>
  /** called after the panel has mounted; focus management is the caller's */
  onOpened?: () => void
}

export function usePopover(options: UsePopoverOptions): { toggle: () => void; close: () => void } {
  const { open, rootEl, triggerEl, panelEl, onOpened } = options

  function focusTrigger(): void {
    const wrap = triggerEl.value
    const target =
      wrap?.querySelector<HTMLElement>('button, [role="button"], a[href], input, select, textarea') ?? wrap
    target?.focus()
  }

  function close(): void {
    if (!open.value) return
    open.value = false
    focusTrigger()
  }

  function toggle(): void {
    if (open.value) close()
    else open.value = true
  }

  function onPointerDown(e: PointerEvent): void {
    const root = rootEl.value
    if (root && e.target instanceof Node && !root.contains(e.target)) close()
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open.value) {
      e.preventDefault()
      close()
    }
  }

  // anchored panels hang off the trigger's side: shift only the horizontal
  // overflow back in, 16px inside the viewport edges (jsdom measures 0x0,
  // in which case nothing shifts)
  function measureShift(): void {
    const panel = panelEl.value
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const margin = 16
    let shift = 0
    if (rect.width > 0) {
      if (rect.left < margin) shift = margin - rect.left
      else if (rect.right > window.innerWidth - margin) shift = window.innerWidth - margin - rect.right
    }
    // the correction lands AT ONCE: the panel rides a Transition whose
    // transform is live through the enter fade, so a plain property write
    // would ease the correction in — the panel visibly sliding into the
    // margin. Park the transition for the write, commit it with a forced
    // reflow, then hand the transform back to the fade
    const had = panel.style.transition
    panel.style.transition = 'none'
    panel.style.setProperty('--popover-shift', `${Math.round(shift)}px`)
    void panel.offsetWidth
    panel.style.transition = had
  }

  watch(
    open,
    (v) => {
      if (v) {
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeydown)
        void nextTick(() => {
          measureShift()
          onOpened?.()
        })
      } else {
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('keydown', onKeydown)
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown)
    document.removeEventListener('keydown', onKeydown)
  })

  return { toggle, close }
}
