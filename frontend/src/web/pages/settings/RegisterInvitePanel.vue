<script setup lang="ts">
import { ref } from 'vue'
import { authApi, type IssuedInvitation } from '../../api/auth'
import { charCount, errorMessage, formatDateTime } from '../../composables/format'
import FormDialog from '../../components/FormDialog.vue'
import IconButton from '../../components/IconButton.vue'

// Registration-only invitation card (TASK-32, spec_auth.md 2-1), living in
// the auth tab: a URL that registers a new user with their own personal
// ledger and joins nothing (POST /api/register-invitations, {inviter_note};
// the URL is shown once). TASK-46: the issue flow lives in a small dialog
// whose memo is prefilled with the issuance datetime — an empty memo sends
// that datetime so the backend's non-empty rule is met. Any active user may
// issue — unlike the ledger-sharing card there is no owner gate. This is the
// only settings feature named with the word "invitation" (real-device
// review wording rule).
const busy = ref(false)

interface IssuedRow {
  note: string
  issuedAt: number
  invitation: IssuedInvitation
  copied: boolean
  copyFailed: boolean
}

const dialogOpen = ref(false)
const registerNote = ref('')
const dialogError = ref('')
const issued = ref<IssuedRow[]>([])

function openDialog(): void {
  registerNote.value = formatDateTime(Date.now())
  dialogError.value = ''
  dialogOpen.value = true
}

async function issueRegisterInvite(): Promise<void> {
  busy.value = true
  dialogError.value = ''
  try {
    const note = registerNote.value.trim()
    if (charCount(note) > 200) {
      dialogError.value = 'メモは200文字以内で入力してください。'
      return
    }
    // an empty memo falls back to the issuance datetime (the backend
    // requires a non-empty note)
    const sent = note || formatDateTime(Date.now())
    const res = await authApi.createRegisterInvitation(sent)
    issued.value = [
      { note: sent, issuedAt: Date.now(), invitation: res, copied: false, copyFailed: false },
      ...issued.value,
    ]
    dialogOpen.value = false
  } catch (e) {
    dialogError.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function copyUrl(row: IssuedRow): Promise<void> {
  row.copied = false
  row.copyFailed = false
  try {
    await navigator.clipboard.writeText(row.invitation.url)
    row.copied = true
  } catch {
    row.copied = false
    row.copyFailed = true
  }
}
</script>

<template>
  <section
    class="card"
    data-test="register-invite"
  >
    <div class="card-head">
      <h2>登録の招待</h2>
      <div class="head-actions">
        <FormDialog
          v-model:open="dialogOpen"
          label="登録 URL を発行"
          test="register-invite-dialog"
        >
          <template #trigger>
            <IconButton
              icon="plus"
              label="登録 URL を発行"
              variant="primary"
              :disabled="busy"
              aria-haspopup="dialog"
              :aria-expanded="dialogOpen"
              test="register-invite-issue"
              @click="openDialog"
            />
          </template>
          <h3>登録 URL を発行</h3>
          <label class="field"><span>メモ</span><input
            v-model="registerNote"
            type="text"
            placeholder="誰に渡すかのメモ（空欄なら発行日時・運用者のみ閲覧）"
            maxlength="200"
            data-autofocus
            data-test="register-invite-note"
          ></label>
          <p
            v-if="dialogError"
            class="msg msg-error"
            role="alert"
          >
            {{ dialogError }}
          </p>
          <div class="actions">
            <button
              class="btn btn-primary"
              :disabled="busy"
              data-test="register-invite-submit"
              @click="issueRegisterInvite"
            >
              発行
            </button>
            <button
              class="btn"
              :disabled="busy"
              @click="dialogOpen = false"
            >
              やめる
            </button>
          </div>
        </FormDialog>
      </div>
    </div>
    <p class="muted small">
      新規ユーザー登録用の URL を発行します（メモは運用者のみ閲覧可・URL は一度だけ表示されます）。
    </p>
    <ul
      v-if="issued.length > 0"
      class="rows"
      data-test="register-invite-issued"
    >
      <li
        v-for="(row, i) in issued"
        :key="i"
        class="row"
        data-test="register-invite-issued-row"
      >
        <div class="row-main">
          <strong>{{ row.note }}</strong>
          <span class="badge">登録</span>
          <span class="muted small block">発行 {{ formatDateTime(row.issuedAt) }} / 期限 {{ formatDateTime(row.invitation.expires_at) }}</span>
          <code
            class="break"
            data-test="register-invite-issued-url"
          >{{ row.invitation.url }}</code>
          <p
            v-if="row.copied"
            class="small"
            role="status"
          >
            コピーしました
          </p>
          <p
            v-if="row.copyFailed"
            class="msg msg-error"
            role="alert"
          >
            コピーできませんでした。URL を選択してコピーしてください。
          </p>
        </div>
        <div class="actions">
          <IconButton
            :icon="row.copied ? 'check' : 'copy'"
            :label="row.copied ? 'コピーしました' : 'URL をコピー'"
            class="copy-btn"
            :class="{ 'is-done': row.copied }"
            test="copy"
            @click="copyUrl(row)"
          />
          <span
            v-if="row.copied"
            class="sr-only"
            role="status"
            data-test="copy-done"
          >コピーしました</span>
        </div>
      </li>
    </ul>
  </section>
</template>
