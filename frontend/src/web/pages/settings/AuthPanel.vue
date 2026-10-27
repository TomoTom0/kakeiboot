<script setup lang="ts">
import InvitePanel from './InvitePanel.vue'
import PasskeysPanel from './PasskeysPanel.vue'
import RegisterInvitePanel from './RegisterInvitePanel.vue'

// Auth tab: passkey management, the registration-only invitation (the only
// feature that may call itself an invitation) and the ledger sharing card
// (any owned ledger, chosen at issue time — TASK-78), stacked as cards in
// this order. The wrapper div is the single root the settings tab
// <Transition> needs: a multi-root panel is a fragment and the tab swap
// animation is skipped entirely (real-device fix).
</script>

<template>
  <div class="settings-panel">
    <PasskeysPanel />
    <RegisterInvitePanel />
    <InvitePanel />
  </div>
</template>
