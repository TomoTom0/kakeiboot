<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import PopoverMenu from './PopoverMenu.vue'

// The manage screens' trailing row "..." (TASK-40 §2-1): the same trigger
// rules as PageMenu (44px dots icon button, aria-haspopup=menu, aria-label
// from props — "{名前}の操作") but the items are buttons acting on the row:
// pressing one closes the menu and emits select(action). Open/close, the
// arrow keys, Escape, the outside pointerdown and the focus return to the
// trigger live in PopoverMenu / usePopover; the row editor opening (and its
// focus) is the caller's, after this component has closed the menu.
export interface RowMenuItem {
  action: string
  label: string
  danger?: boolean
  disabled?: boolean
  test?: string
}

defineProps<{
  items: RowMenuItem[]
  ariaLabel: string
  /** data-test of the trigger; callers use `row-menu-<id>` */
  test: string
  /** viewer: rendered but inert (the menu never opens) */
  disabled?: boolean
}>()

const emit = defineEmits<{ select: [action: string] }>()

const menuOpen = ref(false)

function pick(close: () => void, action: string): void {
  close()
  emit('select', action)
}
</script>

<template>
  <PopoverMenu
    v-model:open="menuOpen"
    class="row-menu"
  >
    <template #trigger="{ open }">
      <button
        type="button"
        class="row-action-btn"
        :data-test="test"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="ariaLabel"
        :disabled="disabled"
      >
        <AppIcon name="dots" />
      </button>
    </template>
    <template #default="{ close }">
      <button
        v-for="item in items"
        :key="item.action"
        type="button"
        class="menu-item"
        :class="{ danger: item.danger }"
        role="menuitem"
        :data-test="item.test"
        :disabled="item.disabled"
        @click="pick(close, item.action)"
      >
        {{ item.label }}
      </button>
    </template>
  </PopoverMenu>
</template>
