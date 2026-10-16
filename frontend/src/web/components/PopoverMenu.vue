<script setup lang="ts">
import { computed, nextTick, ref, useAttrs } from 'vue'
import { usePopover } from '../composables/popover'

// Shared popover menu (TASK-16 items 3/6, TASK-27 §4): one component for
// the ledger switcher and the top-right account menu. Open/close, the
// outside pointerdown, Escape and the focus return to the trigger live in
// usePopover (composables/popover.ts); the trigger slot renders the button
// (it receives `open` for aria-expanded); the default slot renders the
// items with their own roles (menuitem / menuitemradio) and receives
// `close` for explicit closing. Arrow keys move between [role^="menuitem"].
const open = defineModel<boolean>('open', { default: false })

const rootEl = ref<HTMLElement | null>(null)
const triggerWrap = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

const { toggle, close } = usePopover({ open, rootEl, triggerEl: triggerWrap, panelEl })

// data-test and friends go to the menu panel; class goes to the wrapper.
const attrs = useAttrs()
const panelAttrs = computed(() => {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) if (k !== 'class') rest[k] = v
  return rest
})

function menuItems(): HTMLElement[] {
  const root = rootEl.value
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const els = menuItems()
  if (!els.length) return
  if (!open.value) {
    open.value = true
    void nextTick(() => els[0]?.focus())
    return
  }
  const i = els.indexOf(document.activeElement as HTMLElement)
  const step = e.key === 'ArrowDown' ? 1 : -1
  const next = i === -1 ? 0 : Math.min(Math.max(i + step, 0), els.length - 1)
  els[next]?.focus()
}

defineOptions({ inheritAttrs: false })
</script>

<template>
  <div
    ref="rootEl"
    class="popover-menu"
    @keydown="onKeydown"
  >
    <div
      ref="triggerWrap"
      class="popover-trigger"
      @click="toggle"
    >
      <slot
        name="trigger"
        :open="open"
      />
    </div>
    <div
      v-if="open"
      ref="panelEl"
      class="menu popover-panel"
      role="menu"
      v-bind="panelAttrs"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
