<script setup lang="ts">
// view=receipt_list / item_list (spec §11-2): count, sum, thumbnails; tap opens
// the receipt via get_receipt (callTool) and the header shows a back button.
// Rows carry display-only label dots (TASK-17); labeling happens in the
// conversation (label_receipts).
import { computed } from 'vue'
import type { ItemListEnvelope, ReceiptListEnvelope } from '@/shared/types'
import LabelDots from '@/shared/components/LabelDots.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import { isSafeImageUrl } from '@/shared/format'
import LedgerBadge from '../components/LedgerBadge.vue'
import { useWidgetStore } from '../stores/widget'
import { MEDIA_ORIGIN } from '../config'

const props = defineProps<{ envelope: ReceiptListEnvelope | ItemListEnvelope }>()
const store = useWidgetStore()

function thumb(receiptId: number): string | null {
  // Thumbnails are keyed "receipt:<id>" in `_meta.images` (spec §7-8); original size, lazy.
  const url = store.screen?.meta.images?.[`receipt:${receiptId}`]?.url ?? null
  return isSafeImageUrl(url, MEDIA_ORIGIN) ? url : null
}
const receipts = computed(() => (props.envelope.view === 'receipt_list' ? props.envelope.receipts : []))
const items = computed(() => (props.envelope.view === 'item_list' ? props.envelope.items : []))
</script>

<template>
  <article
    class="bb-screen"
    data-test="receipt-list-screen"
  >
    <LedgerBadge :ledger="envelope.ledger" />
    <header class="bb-head">
      <h2 class="bb-title">
        {{ envelope.view === 'item_list' ? '品目の検索結果' : 'レシートの検索結果' }}
      </h2>
      <p class="bb-muted">
        <template v-if="envelope.period_resolved">
          {{ envelope.period_resolved.label }} ・
        </template>{{ envelope.total_count }}件 ・ 合計 <MoneyAmount :value="envelope.sum_amount" />
      </p>
    </header>
    <ul class="bb-list">
      <li
        v-for="r in receipts"
        :key="r.receipt_id"
      >
        <button
          type="button"
          class="bb-list__btn bb-list__btn--thumb"
          :disabled="store.loading"
          :data-receipt="r.receipt_id"
          @click="store.openReceipt(r.receipt_id)"
        >
          <img
            v-if="r.has_image && thumb(r.receipt_id)"
            class="bb-thumb"
            :src="thumb(r.receipt_id) ?? undefined"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
          >
          <span class="bb-list__body">
            <span class="bb-list__main">
              <span>{{ r.store_name ?? '店名未設定' }}</span>
              <MoneyAmount :value="r.amount" />
            </span>
            <span class="bb-list__sub">
              {{ r.purchased_on }}<template v-if="r.purchased_time"> {{ r.purchased_time }}</template> ・ {{ r.item_count }}行
              <template v-if="r.matched_items && r.matched_items.length > 0">
                ・ {{ r.matched_items.map((m) => m.name).join('、') }}
              </template>
              <LabelDots
                :labels="r.labels ?? []"
                compact
                class="bb-list__labels"
              />
            </span>
          </span>
        </button>
      </li>
      <li
        v-for="it in items"
        :key="it.item_id"
      >
        <button
          type="button"
          class="bb-list__btn"
          :disabled="store.loading"
          :data-receipt="it.receipt_id"
          @click="store.openReceipt(it.receipt_id)"
        >
          <span class="bb-list__main">
            <span>{{ it.name }}</span>
            <MoneyAmount :value="it.amount_incl" />
          </span>
          <span class="bb-list__sub">{{ it.purchased_on }} ・ {{ it.store_name ?? '店名未設定' }} ・ {{ it.category ?? '未分類' }}</span>
        </button>
      </li>
    </ul>
    <p
      v-if="envelope.next_cursor"
      class="bb-muted bb-small"
    >
      続きは会話で「もっと見せて」と伝えてください
    </p>
  </article>
</template>
