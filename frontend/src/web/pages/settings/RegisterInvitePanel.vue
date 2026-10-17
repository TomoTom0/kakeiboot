<script setup lang="ts">
import { ref } from 'vue'
import { authApi } from '../../api/auth'
import { charCount, errorMessage, formatDateTime } from '../../composables/format'

// Registration-only invitation card (TASK-32, spec_auth.md 2-1), living in
// the auth tab: a URL that registers a new user with their own personal
// ledger and joins nothing (POST /api/register-invitations, {inviter_note};
// the note is mandatory and the URL is shown once). Any active user may
// issue — unlike the ledger-sharing card there is no owner gate. This is the
// only settings feature named with the word "invitation" (real-device
// review wording rule).
const error = ref('')
const busy = ref(false)
const registerNote = ref('')
const registerUrl = ref('')
const registerExpires = ref(0)

async function issueRegisterInvite(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const note = registerNote.value.trim()
    if (charCount(note) === 0) {
      error.value = 'メモを入力してください。'
      return
    }
    if (charCount(note) > 200) {
      error.value = 'メモは200文字以内で入力してください。'
      return
    }
    const res = await authApi.createRegisterInvitation(note)
    registerUrl.value = res.url
    registerExpires.value = res.expires_at
    registerNote.value = ''
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
    data-test="register-invite"
  >
    <h2>登録の招待</h2>
    <p class="muted small">
      家計簿への参加を伴わない新規ユーザー登録用の URL を発行します。受け取った人は自分専用の家計簿と一緒に登録できます。メモは必須で、運用者のみ閲覧できます。URL は一度だけ表示されます。
    </p>
    <div class="inline-form">
      <input
        v-model="registerNote"
        type="text"
        placeholder="誰に渡すかのメモ（必須、運用者のみ閲覧）"
        aria-label="メモ"
        data-test="register-invite-note"
      >
      <button
        class="btn"
        :disabled="busy"
        data-test="register-invite-issue"
        @click="issueRegisterInvite"
      >
        登録 URL を発行
      </button>
    </div>
    <p
      v-if="registerUrl"
      class="msg msg-info break"
      data-test="register-invite-url"
    >
      {{ registerUrl }}
    </p>
    <p
      v-if="registerUrl"
      class="muted small"
      data-test="register-invite-expires"
    >
      期限: {{ formatDateTime(registerExpires) }}
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
