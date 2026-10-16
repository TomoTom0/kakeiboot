<script setup lang="ts">
// view=receipt (spec §11-2): same layout as the draft plus the deleted state.
// No operations (editing and labeling are done in the conversation); the
// labels show as display-only dots (TASK-17).
import { computed, ref } from 'vue'
import type { ReceiptEnvelope } from '@/shared/types'
import LabelDots from '@/shared/components/LabelDots.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import ItemTable, { type ItemRow } from '@/shared/components/ItemTable.vue'
import { paymentLabel } from '@/shared/format'
import LedgerBadge from '../components/LedgerBadge.vue'
import DetailImage from '../components/DetailImage.vue'

const props = defineProps<{ envelope: ReceiptEnvelope }>()
const selected = ref<number | null>(null)
const r = computed(() => props.envelope.receipt)
const rows = computed<ItemRow[]>(() =>
  r.value.items.map((it) => ({
    key: it.item_id,
    name: it.name,
    amount: it.amount,
    category: it.category,
    discount: it.line_kind === 'discount',
    selectable: r.value.has_image && Array.isArray(it.bbox),
    detail: it.quantity !== 1 ? `${it.quantity}${it.unit ?? ''}` : null,
  })),
)
const bbox = computed(() => r.value.items.find((it) => it.item_id === selected.value)?.bbox ?? null)

function select(id: number) {
  selected.value = selected.value === id ? null : id
}
</script>

<template>
  <article
    class="bb-screen"
    data-test="receipt-screen"
  >
    <LedgerBadge :ledger="envelope.ledger" />
    <p
      v-if="r.deleted_at"
      class="bb-band bb-band--danger"
      data-test="deleted-band"
    >
      削除済み（90日以内なら復元できます）
    </p>
    <header class="bb-head">
      <h2 class="bb-title">
        {{ r.store?.name ?? r.store_name_raw ?? '店名未設定' }}
      </h2>
      <p class="bb-muted">
        {{ r.purchased_on }}<template v-if="r.purchased_time">
          {{ r.purchased_time }}
        </template> ・ {{ paymentLabel(r.payment_method) }}
      </p>
      <LabelDots
        v-if="r.labels?.length"
        :labels="r.labels"
        class="bb-labels"
      />
      <p class="bb-total">
        <span>合計</span>
        <MoneyAmount :value="r.total_amount ?? r.items_total" />
      </p>
      <p class="bb-muted bb-small">
        レシート #{{ r.receipt_id }} ・ rev {{ r.revision }}
      </p>
    </header>
    <p
      v-if="r.total_diff"
      class="bb-band bb-band--warn"
    >
      明細合計 <MoneyAmount :value="r.items_total" /> と印字合計の差 <MoneyAmount
        :value="r.total_diff"
        signed
      />
    </p>
    <DetailImage
      v-if="r.has_image && !r.deleted_at"
      :id="r.receipt_id"
      kind="receipt"
      :bbox="bbox"
    />
    <ItemTable
      :rows="rows"
      :selected="selected"
      @select="select"
    />
    <p
      v-if="r.note"
      class="bb-note"
    >
      {{ r.note }}
    </p>
  </article>
</template>
