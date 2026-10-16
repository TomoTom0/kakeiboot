<script setup lang="ts">
// Ledger badge (spec §3-2, §11-2): always show the target ledger; flag one-off
// selection and drafts whose ledger is not the active one.
import type { LedgerRef } from '@/shared/types'

defineProps<{ ledger: LedgerRef | null }>()
</script>

<template>
  <p
    v-if="ledger"
    class="bb-badge"
    data-test="ledger-badge"
  >
    <span class="bb-badge__label">家計簿</span>
    <span class="bb-badge__name">{{ ledger.name }}</span>
    <span
      v-if="ledger.source === 'explicit'"
      class="bb-badge__note"
    >一時指定</span>
    <span
      v-else-if="ledger.source === 'draft'"
      class="bb-badge__note"
    >確定先</span>
  </p>
</template>
