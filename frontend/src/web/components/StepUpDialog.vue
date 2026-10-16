<script setup lang="ts">
import { ref } from 'vue'
import { authApi } from '../api/auth'
import { getPasskey, isCancel } from '../api/webauthn'
import { errorMessage } from '../composables/format'
import { useSessionStore } from '../stores/session'

// Step-up re-authentication (spec_auth.md 2-6). The ceremony starts from a
// button press because browsers require a user gesture for WebAuthn.
const session = useSessionStore()
const busy = ref(false)
const error = ref('')

async function confirm(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const rcr = await authApi.reauthStart()
    const credential = await getPasskey(rcr)
    await authApi.reauthFinish(credential)
    session.finishStepUp(true)
  } catch (e) {
    error.value = isCancel(e) ? 'パスキーでの確認が完了しませんでした。' : errorMessage(e)
  } finally {
    busy.value = false
  }
}

function cancel(): void {
  error.value = ''
  session.finishStepUp(false)
}
</script>

<template>
  <div
    v-if="session.stepUpOpen"
    class="dialog-backdrop"
  >
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      data-test="stepup-dialog"
    >
      <h2 id="stepup-title">
        本人確認
      </h2>
      <p>この操作にはパスキーでの本人確認が必要です（10分間有効）。</p>
      <p
        v-if="error"
        class="msg msg-error"
        role="alert"
      >
        {{ error }}
      </p>
      <div class="actions">
        <button
          class="btn btn-primary"
          :disabled="busy"
          data-test="stepup-confirm"
          @click="confirm"
        >
          パスキーで確認
        </button>
        <button
          class="btn"
          :disabled="busy"
          data-test="stepup-cancel"
          @click="cancel"
        >
          キャンセル
        </button>
      </div>
    </div>
  </div>
</template>
