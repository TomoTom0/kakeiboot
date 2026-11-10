<script setup lang="ts">
// view=draft_list (spec §11-2): pending drafts across ledgers with the ledger
// name, image state text and a duplicate mark. Tap opens the detail via callTool.
// TASK-170 W-2: the rows ride the shared DataRow two-line grammar — the main
// line (store name + the w700 items total) over the sub line (date + image
// state + the ledger chip and the duplicate chip inline); the item count no
// longer shows.
import type { DraftListEnvelope } from '@/shared/types'
import DataRow from '@/shared/components/DataRow.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import { useWidgetStore } from '../stores/widget'

defineProps<{ envelope: DraftListEnvelope }>()
const store = useWidgetStore()
</script>

<template>
  <article
    class="bb-screen"
    data-test="draft-list-screen"
  >
    <h2 class="bb-title">
      未承認の下書き（{{ envelope.drafts.length }}件）
    </h2>
    <p
      v-if="envelope.drafts.length === 0"
      class="bb-muted"
    >
      下書きはありません
    </p>
    <ul class="bb-rows">
      <TransitionGroup name="bb-appear">
        <li
          v-for="row in envelope.drafts"
          :key="row.draft_id"
        >
          <DataRow
            :on-select="() => store.openDraft(row.draft_id)"
            :disabled="store.loading"
            :data-draft="row.draft_id"
            :name="row.store_name ?? '店名未設定'"
            :name-title="row.store_name ?? '店名未設定'"
          >
            <template #amount>
              <span class="amount"><MoneyAmount :value="row.items_total" /></span>
            </template>
            <template #sub>
              <span class="row-items">{{ row.purchased_on ?? '日付未設定' }} ・ {{ row.image_display }}</span>
              <span class="bb-chip">{{ row.ledger.name }}</span>
              <span
                v-if="row.possible_duplicates.length > 0"
                class="bb-chip bb-chip--warn"
                data-test="dup-mark"
              >重複の可能性</span>
            </template>
          </DataRow>
        </li>
      </TransitionGroup>
    </ul>
  </article>
</template>
