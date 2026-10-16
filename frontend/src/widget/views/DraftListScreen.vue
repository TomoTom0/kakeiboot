<script setup lang="ts">
// view=draft_list (spec §11-2): pending drafts across ledgers with the ledger
// name, image state text and a duplicate mark. Tap opens the detail via callTool.
import type { DraftListEnvelope } from '@/shared/types'
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
    <ul class="bb-list">
      <li
        v-for="row in envelope.drafts"
        :key="row.draft_id"
      >
        <button
          type="button"
          class="bb-list__btn"
          :disabled="store.loading"
          :data-draft="row.draft_id"
          @click="store.openDraft(row.draft_id)"
        >
          <span class="bb-list__main">
            <span>{{ row.store_name ?? '店名未設定' }}</span>
            <MoneyAmount :value="row.items_total" />
          </span>
          <span class="bb-list__sub">
            <span class="bb-chip">{{ row.ledger.name }}</span>
            {{ row.purchased_on ?? '日付未設定' }} ・ {{ row.item_count }}行 ・ {{ row.image_display }}
            <span
              v-if="row.possible_duplicates.length > 0"
              class="bb-chip bb-chip--warn"
              data-test="dup-mark"
            >重複の可能性</span>
          </span>
        </button>
      </li>
    </ul>
  </article>
</template>
