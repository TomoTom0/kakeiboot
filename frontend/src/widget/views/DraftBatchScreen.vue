<script setup lang="ts">
// view=draft_batch (TASK-18, spec §11-2 / §11-3): the drafts of one
// create_receipt_drafts call as rows (the same presentation as the draft list)
// with a per-row state, an approve-all button and an in-envelope detail. The
// row detail comes from structuredContent without callTool; rejected entries
// and unreferenced images are conversation-side information and never rows.
import { computed } from 'vue'
import type { ApproveBatchResult, DraftBatchEnvelope, DraftView } from '@/shared/types'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import LedgerBadge from '../components/LedgerBadge.vue'
import { useWidgetStore } from '../stores/widget'

type RowState = { kind: 'pending' | 'approved' | 'attention'; text: string }

const props = defineProps<{ envelope: DraftBatchEnvelope }>()
const store = useWidgetStore()

const resultsByDraft = computed(() => {
  const m = new Map<number, ApproveBatchResult>()
  for (const r of props.envelope.results ?? []) m.set(r.draft_id, r)
  return m
})

/** Per-row state: the widget's approved map first, then the batch result, then the draft status. */
function rowState(d: DraftView): RowState {
  const known = store.approvedMap[d.draft_id]
  if (typeof known === 'number') return { kind: 'approved', text: `登録済み #${known}` }
  const r = resultsByDraft.value.get(d.draft_id)
  if (r) {
    if (r.outcome === 'approved' || r.outcome === 'idempotent') {
      return { kind: 'approved', text: `登録済み #${r.receipt_id ?? '-'}` }
    }
    // stale: the row now shows the latest revision and goes out again with the next press
    if (r.outcome === 'stale_revision' && d.status === 'pending') return { kind: 'pending', text: '内容が更新されています' }
    return { kind: 'attention', text: '要確認' }
  }
  if (d.status === 'approved') return { kind: 'approved', text: `登録済み #${d.approved_receipt_id ?? '-'}` }
  if (d.status === 'pending') return { kind: 'pending', text: '未登録' }
  return { kind: 'attention', text: '要確認' }
}

const rows = computed(() =>
  props.envelope.drafts.map((d) => ({
    draft: d,
    state: rowState(d),
    storeName: d.payload.store_name ?? d.payload.store_name_raw ?? '店名未設定',
    purchasedOn: d.payload.purchased_on ?? '日付未設定',
  })),
)
const withImage = computed(() => props.envelope.drafts.filter((d) => d.image.status === 'attached').length)
const withoutImage = computed(() => props.envelope.drafts.length - withImage.value)
const pendingCount = computed(() => rows.value.filter((r) => r.state.kind === 'pending').length)
const hasStale = computed(() => (props.envelope.results ?? []).some((r) => r.outcome === 'stale_revision'))
</script>

<template>
  <article
    class="bb-screen"
    data-test="draft-batch-screen"
  >
    <LedgerBadge :ledger="envelope.ledger" />
    <header class="bb-head">
      <h2 class="bb-title">
        下書きの一括登録
      </h2>
      <p
        class="bb-muted"
        data-test="batch-count"
      >
        下書き {{ envelope.drafts.length }} 件（画像あり {{ withImage }} / 画像なし {{ withoutImage }}）
      </p>
    </header>

    <p
      v-if="hasStale"
      class="bb-band bb-band--warn"
      role="status"
      data-test="stale-band"
    >
      内容が更新されています。確認して再度登録してください。
    </p>

    <button
      v-if="envelope.drafts.length > 0"
      type="button"
      class="bb-btn bb-btn--primary"
      :disabled="store.batchApproving || pendingCount === 0"
      data-test="approve-all-button"
      @click="store.approveAll()"
    >
      {{ store.batchApproving ? '登録中' : `すべて登録（${pendingCount} 件）` }}
    </button>

    <p
      v-if="envelope.drafts.length === 0"
      class="bb-muted"
    >
      下書きはありません
    </p>
    <ul class="bb-list">
      <li
        v-for="row in rows"
        :key="row.draft.draft_id"
      >
        <button
          type="button"
          class="bb-list__btn"
          :disabled="store.loading || store.batchApproving"
          :data-draft="row.draft.draft_id"
          @click="store.openBatchDraft(row.draft)"
        >
          <span class="bb-list__main">
            <span>{{ row.storeName }}</span>
            <MoneyAmount :value="row.draft.resolution.items_total" />
            <span
              class="bb-batch-state"
              :class="`bb-batch-state--${row.state.kind}`"
              data-test="row-state"
            >{{ row.state.text }}</span>
          </span>
          <span class="bb-list__sub">
            {{ row.purchasedOn }} ・ {{ row.draft.payload.items.length }}行 ・ {{ row.draft.image.display }}
            <span
              v-if="row.draft.possible_duplicates?.length"
              class="bb-chip bb-chip--warn"
              data-test="dup-mark"
            >重複の可能性</span>
          </span>
        </button>
      </li>
    </ul>
  </article>
</template>
