<script setup lang="ts">
// view=draft (spec §11-2): ledger badge, header, duplicate band, image state,
// line list (unknown category in warning color), totals diff, revision and the
// approve button (spec §11-3). Editing happens in the conversation.
import { computed, ref } from 'vue'
import type { DraftEnvelope } from '@/shared/types'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import ItemTable, { type ItemRow } from '@/shared/components/ItemTable.vue'
import { paymentLabel } from '@/shared/format'
import LedgerBadge from '../components/LedgerBadge.vue'
import DuplicateBand from '../components/DuplicateBand.vue'
import DetailImage from '../components/DetailImage.vue'
import { useWidgetStore } from '../stores/widget'

const props = defineProps<{ envelope: DraftEnvelope }>()
const store = useWidgetStore()
const selected = ref<number | null>(null)

const d = computed(() => props.envelope.draft)
const p = computed(() => d.value.payload)
const catStatus = computed(() => new Map(d.value.resolution.categories.map((c) => [c.line_no, c])))
const rows = computed<ItemRow[]>(() =>
  p.value.items.map((it) => {
    const c = catStatus.value.get(it.line_no)
    return {
      key: it.line_no,
      name: it.name,
      amount: it.amount,
      category: it.category ?? c?.resolved ?? null,
      categoryStatus: c?.status ?? null,
      discount: it.line_kind === 'discount',
      selectable: d.value.image.status === 'attached' && Array.isArray(it.bbox),
    }
  }),
)
const bbox = computed(() => p.value.items.find((it) => it.line_no === selected.value)?.bbox ?? null)
const STATUS_TEXT: Record<string, string> = { discarded: '破棄済み', expired: '期限切れ' }

function select(lineNo: number) {
  selected.value = selected.value === lineNo ? null : lineNo
}
</script>

<template>
  <article
    class="bb-screen"
    data-test="draft-screen"
  >
    <LedgerBadge :ledger="envelope.ledger" />
    <header class="bb-head">
      <h2 class="bb-title">
        {{ p.store_name ?? p.store_name_raw ?? '店名未設定' }}
      </h2>
      <p class="bb-muted">
        {{ p.purchased_on ?? '日付未設定' }}<template v-if="p.purchased_time">
          {{ p.purchased_time }}
        </template> ・ {{ paymentLabel(p.payment_method) }}
      </p>
      <p class="bb-total">
        <span>合計</span>
        <MoneyAmount :value="p.total_amount ?? d.resolution.items_total" />
      </p>
      <p class="bb-muted bb-small">
        下書き #{{ d.draft_id }} ・ rev {{ d.revision }}
      </p>
    </header>

    <DuplicateBand
      :duplicates="d.possible_duplicates"
      :warnings="envelope.warnings"
    />

    <p
      v-if="d.resolution.total_diff"
      class="bb-band bb-band--warn"
      data-test="total-diff"
    >
      明細合計 <MoneyAmount :value="d.resolution.items_total" /> と印字合計の差 <MoneyAmount
        :value="d.resolution.total_diff"
        signed
      />
    </p>

    <DetailImage
      v-if="d.image.status === 'attached'"
      :id="d.draft_id"
      kind="draft"
      :bbox="bbox"
    />
    <p
      v-else
      class="bb-muted"
      data-test="image-display"
    >
      {{ d.image.display }}
    </p>

    <ItemTable
      :rows="rows"
      :selected="selected"
      @select="select"
    />
    <p
      v-if="p.note"
      class="bb-note"
    >
      {{ p.note }}
    </p>

    <footer class="bb-actions">
      <p
        v-if="store.approveMessage"
        class="bb-message"
        :class="{ 'bb-message--error': store.approvePhase === 'error' || store.approvePhase === 'stale' }"
        role="status"
        data-test="approve-message"
      >
        {{ store.approveMessage }}
      </p>
      <button
        v-if="store.showApproveButton"
        type="button"
        class="bb-btn bb-btn--primary"
        :disabled="store.approveDisabled"
        data-test="approve-button"
        @click="store.approve()"
      >
        {{ store.approvePhase === 'submitting' ? '登録中' : 'この内容で登録' }}
      </button>
      <p
        v-else-if="d.status === 'approved' && store.approvePhase !== 'done' && store.approvePhase !== 'conflict'"
        class="bb-message"
        data-test="approved-label"
      >
        登録済み（レシート #{{ d.approved_receipt_id ?? '-' }}）
      </p>
      <p
        v-else-if="STATUS_TEXT[d.status] && store.approvePhase !== 'conflict'"
        class="bb-muted"
      >
        {{ STATUS_TEXT[d.status] }}
      </p>
    </footer>
  </article>
</template>
