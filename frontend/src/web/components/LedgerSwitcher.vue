<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'
import { useSessionStore } from '../stores/session'

// Ledger switcher (TASK-16 item 3, reshaped into an account-menu section by
// TASK-101): the memberships (color chip, name, role, check) as
// menuitemradio rows rendered inside the account PopoverMenu — no trigger of
// its own in the topbar anymore. The choice itself stays in the session store
// (per-screen local state, spec_auth.md 6); even a single membership keeps
// its row so the color band and the check always show which book is active.
// Picking a row emits 'select' so the menu host closes through the same
// route the four plain items take (focus returns to the avatar button).
const session = useSessionStore()
const emit = defineEmits<{ select: [] }>()

const ledgers = computed(() => session.me?.ledgers ?? [])
const current = computed(() => session.selectedLedger)

const ROLE_LABEL: Record<string, string> = { editor: '編集', viewer: '閲覧のみ' }

function choose(id: number): void {
  session.selectedLedgerId = id
  emit('select')
}
</script>

<template>
  <!-- role="group": a labelled section of the menu, not focusable itself and
       outside the arrow roving ([role^="menuitem"] still picks the rows) -->
  <div
    class="ledger-menu-section"
    role="group"
    aria-label="家計簿"
  >
    <button
      v-for="l in ledgers"
      :key="l.id"
      type="button"
      role="menuitemradio"
      class="menu-item ledger-option"
      :aria-checked="l.id === current?.id"
      :data-test="`ledger-option-${l.id}`"
      @click="choose(l.id)"
    >
      <span
        class="ledger-chip"
        aria-hidden="true"
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
  </div>
</template>
