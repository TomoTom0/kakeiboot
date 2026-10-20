<script setup lang="ts">
import { computed, ref } from 'vue'
import { authApi } from '../../api/auth'
import { charCount, errorMessage } from '../../composables/format'
import { useSessionStore } from '../../stores/session'
import IconButton from '../../components/IconButton.vue'

// Ledger sharing card (spec_auth.md 2-1), living in the auth tab: the owner
// of the default ledger issues share URLs (POST /api/invitations,
// {role, inviter_note?}; the URL is shown once). Wording rule from the
// real-device review: joining an existing ledger is sharing (the ledger name
// is spelled out in the heading) and the word "invitation" belongs to the
// registration-only invitation alone. The card itself always renders: a
// non-owner gets the explanation instead of an empty section.
const session = useSessionStore()
const error = ref('')
const busy = ref(false)
const inviteRole = ref<'editor' | 'viewer'>('editor')
const inviteNote = ref('')
const inviteUrl = ref('')

const defaultLedgerName = computed(
  () => session.me?.ledgers.find((l) => l.id === session.me?.default_ledger_id)?.name ?? '既定の家計簿',
)

async function issueInvite(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const note = inviteNote.value.trim()
    if (charCount(note) > 200) {
      error.value = 'メモは200文字以内で入力してください。'
      return
    }
    const res = await authApi.createInvitation(inviteRole.value, note || undefined)
    inviteUrl.value = res.url
    inviteNote.value = ''
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section
    class="card"
    data-test="invite-panel"
  >
    <h2>{{ defaultLedgerName }}を共有</h2>
    <div
      v-if="session.isDefaultLedgerOwner"
      data-test="invite"
    >
      <p class="muted small">
        この家計簿への参加（編集・閲覧）を依頼する共有 URL を発行します。URL は一度だけ表示されます。
      </p>
      <div class="inline-form">
        <select
          v-model="inviteRole"
          aria-label="権限"
          data-test="invite-role"
        >
          <option value="editor">
            編集
          </option>
          <option value="viewer">
            閲覧のみ
          </option>
        </select>
        <input
          v-model="inviteNote"
          type="text"
          placeholder="誰に渡すかのメモ（任意、運用者のみ閲覧）"
          aria-label="メモ"
          data-test="invite-note"
        >
        <IconButton
          icon="plus"
          label="共有 URL を発行"
          variant="primary"
          :disabled="busy"
          test="invite-issue"
          @click="issueInvite"
        />
      </div>
      <p
        v-if="inviteUrl"
        class="msg msg-info break"
        data-test="invite-url"
      >
        {{ inviteUrl }}
      </p>
    </div>
    <p
      v-else
      class="muted small"
      data-test="invite-forbidden"
    >
      家計簿の共有 URL の発行は、既定の家計簿の owner のみができます。
    </p>
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>
  </section>
</template>
