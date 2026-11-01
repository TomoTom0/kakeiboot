<script setup lang="ts">
// The feed's panel list (TASK-146 §3): the v-for lives INSIDE this
// component so the ContentSwap pane's slot hands over a single static
// element — a slot-level keyed v-for made the transition patch loop on the
// feed (found as a jsdom worker OOM during TASK-146). The list rides the
// shared AppearList carrier (review MED2): the tail fetch's appended panels
// appear through the bb-appear grammar (the loaded ones stay put) and the
// pane rebuild's panels mount silent (the pane's motion is the one motion).
// The feed keeps every windowing / scroll / IO decision.
import AppearList from './AppearList.vue'
import LabelPicker from './LabelPicker.vue'
import ReceiptPanel from './ReceiptPanel.vue'
import type { ReceiptSummary } from '../api/data'
import { shortDate } from '../composables/period'

defineProps<{
  /** the feed's sequence, in list order */
  sequence: ReceiptSummary[]
  /** receipt ids currently mounting a real panel (the render window) */
  windowIds: number[]
  /** the snapshotted ledger the panels fetch through */
  activeLedger: number | null
}>()
const emit = defineEmits<{
  editingChange: [id: number, value: boolean]
  loaded: [id: number]
}>()
</script>

<template>
  <AppearList class="feed-list">
    <article
      v-for="s in sequence"
      :key="s.receipt_id"
      class="receipt-panel"
      :data-test="`receipt-panel-${s.receipt_id}`"
      :style="windowIds.includes(s.receipt_id) ? undefined : { minHeight: '18rem' }"
    >
      <ReceiptPanel
        v-if="windowIds.includes(s.receipt_id) && activeLedger !== null"
        :ledger-id="activeLedger"
        :receipt-id="s.receipt_id"
        @editing-change="(v) => emit('editingChange', s.receipt_id, v)"
        @loaded="emit('loaded', s.receipt_id)"
      >
        <!-- TASK-17: immediate label toggles in the viewing panel. The slot
             props carry the panel's receipt, the ledger, editability and
             applyReceipt; deletions and restores keep the panel in place. -->
        <template #labels="labelProps">
          <LabelPicker v-bind="labelProps" />
        </template>
      </ReceiptPanel>
      <p
        v-else
        class="receipt-panel-placeholder muted small"
      >
        {{ shortDate(s.purchased_on) }} {{ s.store_name ?? '店名なし' }}
      </p>
    </article>
  </AppearList>
</template>
