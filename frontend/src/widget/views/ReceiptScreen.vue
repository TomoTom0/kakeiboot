<script setup lang="ts">
// view=receipt (spec §11-2): same layout as the draft plus the deleted state.
// No operations (editing and labeling are done in the conversation); the
// labels show as display-only chips (TASK-17). TASK-175 H-7/H-9: the head
// rides the SHARED ReceiptHeader component — one MAIN row (the store name
// + the inline-label total at its right, no actions on the widget) over one
// SUB row (the muted context text + the LabelChip list at the right edge),
// and no operating-meta line (the receipt / revision numbers are edit-lock
// data, never displayed).
import { computed, ref } from 'vue'
import type { ReceiptEnvelope } from '@/shared/types'
import LabelChip from '@/shared/components/LabelChip.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import ItemTable, { type ItemRow } from '@/shared/components/ItemTable.vue'
import ReceiptHeader from '@/shared/components/ReceiptHeader.vue'
import { paymentLabel } from '@/shared/format'
import { labelIndexOf } from '@/shared/labels'
import LedgerBadge from '../components/LedgerBadge.vue'
import DetailImage from '../components/DetailImage.vue'

const props = defineProps<{ envelope: ReceiptEnvelope }>()
const selected = ref<number | null>(null)
const r = computed(() => props.envelope.receipt)
const storeName = computed(() => r.value.store?.name ?? r.value.store_name_raw ?? '店名未設定')
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
    <ReceiptHeader>
      <template #title>
        <span
          class="receipt-title-name"
          :title="storeName"
        >{{ storeName }}</span>
      </template>
      <template #total>
        <MoneyAmount :value="r.total_amount ?? r.items_total" />
      </template>
      <template #context>
        {{ r.purchased_on }}<template v-if="r.purchased_time">
          {{ r.purchased_time }}
        </template> ・ {{ paymentLabel(r.payment_method) }}<template v-if="r.store?.category">
          ・ {{ r.store.category }}
        </template>
      </template>
      <template #sub-end>
        <LabelChip
          v-for="l in r.labels ?? []"
          :key="l.color"
          :label="l"
          :index="labelIndexOf(l.color)"
        />
      </template>
    </ReceiptHeader>
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
      :items-total="r.items_total"
      :selected="selected"
      @select="select"
    />
    <p
      v-if="r.note"
      class="receipt-note"
    >
      {{ r.note }}
    </p>
  </article>
</template>
