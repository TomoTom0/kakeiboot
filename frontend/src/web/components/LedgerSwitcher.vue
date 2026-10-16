<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PopoverMenu from './PopoverMenu.vue'
import AppIcon from './AppIcon.vue'
import { useSessionStore } from '../stores/session'

// Ledger switcher (TASK-16 item 3): a trigger chip in the selected ledger's
// color plus a popover list of the memberships (color, name, role, check).
// The choice itself stays in the session store (per-screen local state,
// spec_auth.md 6); even a single membership keeps the trigger so the color
// band and chip always show which book is active.
const session = useSessionStore()
const route = useRoute()

const menuOpen = ref(false)
const ledgers = computed(() => session.me?.ledgers ?? [])
const current = computed(() => session.selectedLedger)

// Close on real navigation only: the receipt feed rewrites its URL while
// scrolling (id / query changes within the route) and must not close this.
const navKey = computed(() => (route.name === 'receipt' ? 'receipt' : route.path))
watch(navKey, () => {
  menuOpen.value = false
})

const ROLE_LABEL: Record<string, string> = { editor: '編集', viewer: '閲覧のみ' }

function choose(id: number): void {
  session.selectedLedgerId = id
}
</script>

<template>
  <PopoverMenu
    v-model:open="menuOpen"
    class="ledger-switch"
    data-test="ledger-menu"
  >
    <template #trigger="{ open }">
      <button
        type="button"
        class="ledger-trigger"
        data-test="ledger-switch"
        aria-haspopup="menu"
        :aria-expanded="open"
        :aria-label="`家計簿: ${current?.name ?? ''}（切り替え）`"
      >
        <span
          class="ledger-chip"
          :style="{ background: `var(--ledger-${current?.color ?? 'teal'})` }"
        ><AppIcon
          name="book"
          :size="15"
        /></span>
        <span class="ledger-name">{{ current?.name }}</span>
      </button>
    </template>
    <template #default="{ close }">
      <button
        v-for="l in ledgers"
        :key="l.id"
        type="button"
        role="menuitemradio"
        class="menu-item ledger-option"
        :aria-checked="l.id === current?.id"
        :data-test="`ledger-option-${l.id}`"
        @click="choose(l.id); close()"
      >
        <span
          class="ledger-chip"
          :style="{ background: `var(--ledger-${l.color})` }"
        ><AppIcon
          name="book"
          :size="15"
        /></span>
        <span class="ledger-option-name">{{ l.name }}</span>
        <span
          v-if="l.role !== 'owner'"
          class="muted small"
        >{{ ROLE_LABEL[l.role] ?? l.role }}</span>
        <AppIcon
          v-if="l.id === current?.id"
          name="check"
          class="ledger-check"
          :size="16"
        />
      </button>
    </template>
  </PopoverMenu>
</template>
