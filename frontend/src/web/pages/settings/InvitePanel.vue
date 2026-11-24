<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { authApi, type IssuedInvitation, type ShareTicket } from '../../api/auth'
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
// Issuing goes through the share-ticket API (POST /api/share-tickets);
// the caller's still-open tickets are listed from GET /api/share-tickets
// and can be revoked (DELETE) — their plain URLs are never shown again.
const session = useSessionStore()
const busy = ref(false)

const openTickets = ref<ShareTicket[]>([])
const ticketsError = ref('')
const revokingRef = ref<string | null>(null)

async function loadTickets(): Promise<void> {
  try {
    openTickets.value = await authApi.listShareTickets()
    ticketsError.value = ''
  } catch (e) {
    ticketsError.value = errorMessage(e)
  }
}

onMounted(loadTickets)

async function revokeTicket(ticket: ShareTicket): Promise<void> {
  busy.value = true
  try {
    await authApi.deleteShareTicket(ticket.ticket_ref)
    openTickets.value = openTickets.value.filter((t) => t.ticket_ref !== ticket.ticket_ref)
    revokingRef.value = null
  } catch (e) {
    ticketsError.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

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
    const res = await authApi.createShareTicket(inviteRole.value, inviteLedgerId.value, effectiveNote)
    issued.value = [
      { note: effectiveNote, role: inviteRole.value, issuedAt: Date.now(), invitation: res, copied: false, copyFailed: false },
      ...issued.value,
    ]
    dialogOpen.value = false
    // the new ticket joins the open-ticket list (without its plain URL)
    void loadTickets()
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
      <TransitionGroup
        v-if="issued.length > 0"
        tag="ul"
        name="share-list"
        class="rows"
        data-test="invite-issued"
      >
        <li
          v-for="row in issued"
          :key="row.invitation.url"
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
      </TransitionGroup>
      <div
        v-if="openTickets.length > 0"
        data-test="share-tickets"
      >
        <h3>発行済みの共有 URL</h3>
        <p class="muted small">
          発行済みの共有 URL は再表示できません（URL は発行時のみ表示されます）。
        </p>
        <TransitionGroup
          tag="ul"
          name="share-list"
          class="rows"
        >
          <li
            v-for="t in openTickets"
            :key="t.ticket_ref"
            class="row"
            data-test="share-ticket-row"
          >
            <div class="row-main">
              <strong>{{ t.inviter_note || t.ledger_name }}</strong>
              <span class="badge">{{ ROLE_LABEL[t.role] }}</span>
              <span class="muted small block">{{ t.ledger_name }} / 発行 {{ formatDateTime(t.created_at) }} / 期限 {{ formatDateTime(t.expires_at) }}</span>
            </div>
            <div class="actions">
              <template v-if="revokingRef === t.ticket_ref">
                <span class="small">失効しますか？</span>
                <button
                  class="btn btn-danger"
                  :disabled="busy"
                  data-test="share-ticket-revoke-confirm"
                  @click="revokeTicket(t)"
                >
                  失効する
                </button>
                <button
                  class="btn"
                  :disabled="busy"
                  @click="revokingRef = null"
                >
                  やめる
                </button>
              </template>
              <IconButton
                v-else
                icon="trash"
                variant="danger"
                :label="`${t.inviter_note || t.ledger_name} の共有 URL を失効`"
                test="share-ticket-revoke"
                @click="revokingRef = t.ticket_ref"
              />
            </div>
          </li>
        </TransitionGroup>
      </div>
      <p
        v-if="ticketsError"
        class="msg msg-error"
        role="alert"
        data-test="share-tickets-error"
      >
        {{ ticketsError }}
      </p>
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
