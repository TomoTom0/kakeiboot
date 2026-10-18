<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon, { type IconName } from './AppIcon.vue'
import PopoverMenu from './PopoverMenu.vue'

// The "..." page menu (TASK-45 §2-1): a thin wrapper over PopoverMenu placed
// at the right end of the browsing pages' toolbar row (where the standalone
// .manage-link used to be). Open/close, the outside pointerdown, Escape, the
// arrow keys and the focus return live in PopoverMenu / usePopover; this
// component only renders the 44px dots trigger and the link items. TASK-75
// dropped the wrapper's own .page-menu class: the list pages take this in
// through BrowseToolbar's `menu` slot and the detail pages through PageHead's
// `menu` slot, each of which owns the row's alignment.
export interface PageMenuItem {
  to: string
  label: string
  icon?: IconName
  test?: string
}

defineProps<{ items: PageMenuItem[]; ariaLabel: string }>()

const menuOpen = ref(false)
</script>

<template>
  <PopoverMenu v-model:open="menuOpen">
    <template #trigger="{ open }">
      <button
        type="button"
        class="page-menu-trigger"
        data-test="page-menu"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="ariaLabel"
      >
        <AppIcon name="dots" />
      </button>
    </template>
    <template #default="{ close }">
      <RouterLink
        v-for="item in items"
        :key="item.to"
        :to="item.to"
        class="menu-item"
        role="menuitem"
        :data-test="item.test"
        @click="close"
      >
        <AppIcon
          v-if="item.icon"
          :name="item.icon"
        />{{ item.label }}
      </RouterLink>
    </template>
  </PopoverMenu>
</template>
