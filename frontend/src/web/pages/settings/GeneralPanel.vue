<script setup lang="ts">
import AppIcon from '../../components/AppIcon.vue'
import { useSessionStore } from '../../stores/session'

// General tab (spec_auth.md 7-1): the display name and the ledger
// memberships as a display-only list. The account number is NOT shown on the
// web UI at all (TASK-38 real-device follow-up: the number display and its
// copy button were removed; the operator CLI `user list` is where the number
// lives). The per-ledger color choice UI is gone: colors are assigned
// automatically when a membership is created and cannot be changed by the
// user (TASK-34).
const session = useSessionStore()

const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', editor: '編集', viewer: '閲覧のみ' }
</script>

<template>
  <section class="card">
    <h2>アカウント</h2>
    <dl
      v-if="session.me"
      class="kv"
    >
      <dt>表示名</dt>
      <dd data-test="display-name">
        {{ session.me.display_name }}
      </dd>
      <dt>家計簿</dt>
      <dd>
        <ul
          class="list ledger-color-list"
          data-test="ledgers"
        >
          <li
            v-for="l in session.me.ledgers"
            :key="l.id"
            class="ledger-color-row"
          >
            <div class="ledger-color-head">
              <span
                class="ledger-chip"
                :style="{ background: `var(--ledger-${l.color})` }"
              ><AppIcon
                name="book"
                :size="14"
              /></span>
              <strong>{{ l.name }}</strong>
              <span class="muted small">{{ ROLE_LABEL[l.role] ?? l.role }}</span>
            </div>
          </li>
        </ul>
      </dd>
    </dl>
  </section>
</template>
