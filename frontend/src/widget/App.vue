<script setup lang="ts">
// Single-template SPA routed by structuredContent.view (spec §11-1, §11-2).
import { useWidgetStore } from './stores/widget'
import DraftScreen from './views/DraftScreen.vue'
import DraftListScreen from './views/DraftListScreen.vue'
import DraftBatchScreen from './views/DraftBatchScreen.vue'
import ReceiptScreen from './views/ReceiptScreen.vue'
import ReceiptListScreen from './views/ReceiptListScreen.vue'
import StatsScreen from './views/StatsScreen.vue'

const store = useWidgetStore()
</script>

<template>
  <div
    class="bb-app"
    :class="{ 'bb-app--fullscreen': store.displayMode === 'fullscreen' }"
  >
    <nav
      v-if="store.canGoBack"
      class="bb-nav"
    >
      <button
        type="button"
        class="bb-btn bb-btn--ghost"
        data-test="back-button"
        @click="store.back()"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
        ><path
          d="M10 3 5 8l5 5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        /></svg>
        戻る
      </button>
    </nav>
    <p
      v-if="store.loading"
      class="bb-muted"
      role="status"
      data-test="loading"
    >
      読み込み中
    </p>
    <p
      v-if="store.error"
      class="bb-band bb-band--danger"
      role="alert"
      data-test="error"
    >
      {{ store.error }}
    </p>

    <template v-if="store.envelope">
      <DraftScreen
        v-if="store.envelope.view === 'draft'"
        :key="`d${store.envelope.draft.draft_id}`"
        :envelope="store.envelope"
      />
      <DraftListScreen
        v-else-if="store.envelope.view === 'draft_list'"
        :envelope="store.envelope"
      />
      <DraftBatchScreen
        v-else-if="store.envelope.view === 'draft_batch'"
        :envelope="store.envelope"
      />
      <ReceiptScreen
        v-else-if="store.envelope.view === 'receipt'"
        :key="`r${store.envelope.receipt.receipt_id}`"
        :envelope="store.envelope"
      />
      <ReceiptListScreen
        v-else-if="store.envelope.view === 'receipt_list' || store.envelope.view === 'item_list'"
        :envelope="store.envelope"
      />
      <StatsScreen
        v-else-if="store.envelope.view === 'stats'"
        :envelope="store.envelope"
      />
    </template>
    <p
      v-else-if="!store.error"
      class="bb-muted"
      data-test="initial"
    >
      家計簿の結果を待っています
    </p>
  </div>
</template>
