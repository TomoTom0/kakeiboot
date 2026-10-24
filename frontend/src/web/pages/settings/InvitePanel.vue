<script setup lang="ts">
import { computed, ref } from 'vue'
import { authApi, type IssuedInvitation } from '../../api/auth'
import { charCount, errorMessage, formatDateTime } from '../../composables/format'
import FormDialog from '../../components/FormDialog.vue'
import { useSessionStore } from '../../stores/session'
import IconButton from '../../components/IconButton.vue'

// Ledger sharing card (spec_auth.md 2-1), living in the auth tab. TASK-46:
// the issue flow moved off the standing inline form into a small dialog
// (memo prefilled with the issuance datetime); issued URLs appear as
// passkey-style rows with a copy button (browser-local — the plain token
// comes back exactly once). TASK-78: the target ledger is chosen in the
// dialog among the ledgers the user owns. Wording rule from the real-device
// review: joining an existing ledger is sharing and the word "invitation"
// belongs to the registration-only card alone. The card itself always
// renders: a user with no owned ledger gets the explanation instead.
const session = useSessionStore()
const busy = ref(false)

const ROLE_LABEL: Record<'editor' | 'viewer', string> = { editor: '編集', viewer: '閲覧のみ' }

interface IssuedRow {
  note: string
  role: 'editor' | 'viewer'
  issuedAt: number
  invitation: IssuedInvitation
  copied: boolean
  copyFailed: boolean
}

const dialogOpen = ref(false)
const inviteLedgerId = ref<number | null>(null)
const inviteRole = ref<'editor' | 'viewer'>('editor')
const inviteNote = ref('')
const dialogError = ref('')
const issued = ref<IssuedRow[]>([])

const chosenLedger = computed(
  () => session.ownedLedgers.find((l) => l.id === inviteLedgerId.value) ?? null,
)

function openDialog(): void {
  // the default ledger when the user owns it, else the first owned ledger
  inviteLedgerId.value =
    session.ownedLedgers.find((l) => l.id === session.me?.default_ledger_id)?.id ??
    session.ownedLedgers[0]?.id ??
    null
  inviteRole.value = 'editor'
  inviteNote.value = formatDateTime(Date.now())
  dialogError.value = ''
  dialogOpen.value = true
}

async function issueInvite(): Promise<void> {
  if (inviteLedgerId.value === null) return
  busy.value = true
  dialogError.value = ''
  try {
    const note = inviteNote.value.trim()
    if (charCount(note) > 200) {
      dialogError.value = 'メモは200文字以内で入力してください。'
      return
    }
    // an empty memo falls back to the issuance datetime (TASK-46: the
    // backend accepts an absent note, the row still wants a label)
    const effectiveNote = note || formatDateTime(Date.now())
    const res = await authApi.createInvitation(inviteRole.value, inviteLedgerId.value, effectiveNote)
    issued.value = [
      { note: effectiveNote, role: inviteRole.value, issuedAt: Date.now(), invitation: res, copied: false, copyFailed: false },
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
    data-test="invite-panel"
  >
    <div class="card-head">
      <h2>家計簿を共有</h2>
      <div class="head-actions">
        <FormDialog
          v-if="session.ownedLedgers.length > 0"
          v-model:open="dialogOpen"
          label="共有 URL を発行"
          test="invite-dialog"
        >
          <template #trigger>
            <IconButton
              v-if="session.ownedLedgers.length > 0"
              icon="plus"
              label="共有 URL を発行"
              variant="primary"
              :disabled="busy"
              aria-haspopup="dialog"
              :aria-expanded="dialogOpen"
              test="invite-issue"
              @click="openDialog"
            />
          </template>
          <h3>{{ chosenLedger?.name ?? '家計簿' }}を共有</h3>
          <label class="field"><span>家計簿</span><select
            v-model="inviteLedgerId"
            data-test="invite-ledger"
          >
            <option
              v-for="l in session.ownedLedgers"
              :key="l.id"
              :value="l.id"
            >
              <span
                class="option-dot"
                :style="{ background: `var(--ledger-${l.color})` }"
              />{{ l.name }}
            </option>
          </select></label>
          <label class="field"><span>権限</span><select
            v-model="inviteRole"
            data-test="invite-role"
          >
            <option value="editor">
              編集
            </option>
            <option value="viewer">
              閲覧のみ
            </option>
          </select></label>
          <label class="field"><span>メモ</span><input
            v-model="inviteNote"
            type="text"
            placeholder="誰に渡すかのメモ（空欄なら発行日時・運用者のみ閲覧）"
            maxlength="200"
            data-autofocus
            data-test="invite-note"
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
              data-test="invite-submit"
              @click="issueInvite"
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
    <div
      v-if="session.ownedLedgers.length > 0"
      data-test="invite"
    >
      <p class="muted small">
        家計簿への参加を依頼する共有 URL を発行します（URL は一度だけ表示されます）。
      </p>
      <ul
        v-if="issued.length > 0"
        class="rows"
        data-test="invite-issued"
      >
        <li
          v-for="(row, i) in issued"
          :key="i"
          class="row"
          data-test="invite-issued-row"
        >
          <div class="row-main">
            <strong>{{ row.note }}</strong>
            <span class="badge">{{ ROLE_LABEL[row.role] }}</span>
            <span class="muted small block">発行 {{ formatDateTime(row.issuedAt) }} / 期限 {{ formatDateTime(row.invitation.expires_at) }}</span>
            <code
              class="break"
              data-test="invite-issued-url"
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
    </div>
    <p
      v-else
      class="muted small"
      data-test="invite-forbidden"
    >
      家計簿の共有 URL の発行は、家計簿のオーナーのみができます。
    </p>
  </section>
</template>
