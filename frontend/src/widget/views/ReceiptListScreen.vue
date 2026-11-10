<script setup lang="ts">
// view=receipt_list / item_list (spec §11-2): count, sum, thumbnails; tap opens
// the receipt via get_receipt (callTool) and the header shows a back button.
// Rows carry display-only label dots (TASK-17); labeling happens in the
// conversation (label_receipts). TASK-170 W-2: the rows ride the shared
// DataRow two-line grammar — the main line (thumb + store name + the w700
// amount) over the sub line (the top_items representative items + the
// datetime figure + the label dots at the right end); the item rows swap
// the name for the item and the sub line for date / store / category
// (muted text, the row itself stays pressable). The search matches and the
// item count no longer show (the representative items carry the line).
import { computed } from 'vue'
import type { ItemListEnvelope, ReceiptListEnvelope } from '@/shared/types'
import DataRow from '@/shared/components/DataRow.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import { isSafeImageUrl, topItemsText } from '@/shared/format'
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

/** the sub line's secondary figure: the date and, when present, the time */
function figureOf(date: string, time: string | null): string {
  return time ? `${date} ${time}` : date
}

/** the item rows' sub line: date / store / category as one muted text */
function itemSubText(storeName: string | null, date: string, category: string | null): string {
  return `${date} ・ ${storeName ?? '店名未設定'} ・ ${category ?? '未分類'}`
}
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
    <ul class="bb-rows">
      <TransitionGroup name="bb-appear">
        <li
          v-for="r in receipts"
          :key="r.receipt_id"
        >
          <DataRow
            :on-select="() => store.openReceipt(r.receipt_id)"
            :disabled="store.loading"
            :data-receipt="r.receipt_id"
            :name="r.store_name ?? '店名未設定'"
            :name-title="r.store_name ?? '店名未設定'"
            :sub-text="topItemsText(r.top_items)"
            :sub-figure="figureOf(r.purchased_on, r.purchased_time)"
            :labels="r.labels ?? []"
          >
            <template #main>
              <img
                v-if="r.has_image && thumb(r.receipt_id)"
                class="bb-thumb"
                :src="thumb(r.receipt_id) ?? undefined"
                alt=""
                loading="lazy"
                referrerpolicy="no-referrer"
              >
              <span
                class="row-name"
                :title="r.store_name ?? '店名未設定'"
              >{{ r.store_name ?? '店名未設定' }}</span>
            </template>
            <!-- review: MoneyAmount keeps the negative (値引) coloring spec §11-7 -->
            <template #amount>
              <span class="amount"><MoneyAmount :value="r.amount" /></span>
            </template>
          </DataRow>
        </li>
        <li
          v-for="it in items"
          :key="it.item_id"
        >
          <DataRow
            :on-select="() => store.openReceipt(it.receipt_id)"
            :disabled="store.loading"
            :data-receipt="it.receipt_id"
            :name="it.name"
            :name-title="it.name"
            :sub-text="itemSubText(it.store_name, it.purchased_on, it.category)"
          >
            <template #amount>
              <span class="amount"><MoneyAmount :value="it.amount_incl" /></span>
            </template>
          </DataRow>
        </li>
      </TransitionGroup>
    </ul>
    <p
      v-if="envelope.next_cursor"
      class="bb-muted bb-small"
    >
      続きは会話で「もっと見せて」と伝えてください
    </p>
  </article>
</template>
