<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import { authApi, type LedgerColor, type Passkey } from '../api/auth'
import { createPasskey, isCancel } from '../api/webauthn'
import { charCount, errorMessage, formatDateTime } from '../composables/format'
import { LEDGER_COLOR_NAMES } from '../composables/ledger'
import { useSessionStore } from '../stores/session'

// Own account (spec_auth.md 7-1: account number on the web screen), passkey
// management (2-7: add / rename / delete, add and delete need step-up, the
// last passkey cannot be deleted), invitations (2-1) and logout (3).
const router = useRouter()
const session = useSessionStore()
const passkeys = ref<Passkey[]>([])
const error = ref('')
const info = ref('')
const busy = ref(false)
const newLabel = ref('')
const editingId = ref<number | null>(null)
const editingLabel = ref('')
const deletingId = ref<number | null>(null)
const inviteRole = ref<'editor' | 'viewer'>('editor')
const inviteNote = ref('')
const inviteUrl = ref('')

const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', editor: '編集', viewer: '閲覧のみ' }
const isOwner = computed(() => session.me?.ledgers.some((l) => l.role === 'owner') ?? false)

function backupLabel(p: Passkey): string {
  if (p.backup_state === true) return '同期済み'
  if (p.backup_state === false) return '端末内'
  return '不明'
}

async function reload(): Promise<void> {
  try {
    passkeys.value = await authApi.listPasskeys()
  } catch (e) {
    error.value = errorMessage(e)
  }
}

onMounted(reload)

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    await task()
  } catch (e) {
    error.value = isCancel(e) ? 'パスキーの操作が完了しませんでした。' : errorMessage(e)
  } finally {
    busy.value = false
  }
}

function addPasskey(): Promise<void> {
  return run(async () => {
    const label = newLabel.value.trim()
    if (charCount(label) > 100) {
      error.value = 'パスキーの名前は100文字以内で入力してください。'
      return
    }
    const ccr = await authApi.passkeyStart()
    const credential = await createPasskey(ccr)
    await authApi.passkeyFinish(credential, label || undefined)
    newLabel.value = ''
    info.value = 'パスキーを追加しました。'
    await reload()
  })
}

function startRename(p: Passkey): void {
  editingId.value = p.id
  editingLabel.value = p.label ?? ''
  deletingId.value = null
}

function saveRename(id: number): Promise<void> {
  return run(async () => {
    const label = editingLabel.value.trim()
    if (label === '' || charCount(label) > 100) {
      error.value = '名前は1〜100文字で入力してください。'
      return
    }
    await authApi.renamePasskey(id, label)
    editingId.value = null
    await reload()
  })
}

function confirmDelete(id: number): Promise<void> {
  return run(async () => {
    try {
      await authApi.deletePasskey(id)
      info.value = 'パスキーを削除しました。'
    } finally {
      deletingId.value = null
    }
    await reload()
  })
}

function issueInvite(): Promise<void> {
  return run(async () => {
    const note = inviteNote.value.trim()
    if (charCount(note) > 200) {
      error.value = 'メモは200文字以内で入力してください。'
      return
    }
    const res = await authApi.createInvitation(inviteRole.value, note || undefined)
    inviteUrl.value = res.url
    inviteNote.value = ''
  })
}

function logout(all: boolean): Promise<void> {
  return run(async () => {
    if (all) await authApi.logoutAll()
    else await authApi.logout()
    session.clear()
    await router.replace('/login')
  })
}

// Ledger display color (TASK-16 item 3): per-user, chosen from the fixed
// palette. Changing it PUTs the membership color and reloads me. The radios
// react to click and change alike (activation order differs across
// environments); the in-flight / same-color guards keep it to one PUT.
// `chosen` mirrors me into the v-model so a failed PUT can roll the native
// checked state back to the server's color.
const LEDGER_COLOR_KEYS = Object.keys(LEDGER_COLOR_NAMES) as LedgerColor[]
const busyColor = ref(false)
const chosen: Record<number, LedgerColor> = reactive({})
for (const l of session.me?.ledgers ?? []) chosen[l.id] = l.color

async function changeColor(ledgerId: number, color: LedgerColor): Promise<void> {
  if (busyColor.value) return
  if (session.me?.ledgers.some((l) => l.id === ledgerId && l.color === color)) return
  busyColor.value = true
  error.value = ''
  try {
    await authApi.setMembershipColor(ledgerId, color)
    await session.loadMe()
    info.value = '家計簿の色を変更しました。'
  } catch (e) {
    error.value = errorMessage(e)
    // the clicked radio never applied: re-check the server's color
    const current = session.me?.ledgers.find((x) => x.id === ledgerId)?.color
    if (current) chosen[ledgerId] = current
  } finally {
    busyColor.value = false
  }
}
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
      <dt>アカウント番号</dt>
      <dd>
        <strong data-test="account-number">{{ session.me.account_number }}</strong>
        <span class="muted small block">パスキーを失くしたときに運用者へ伝える番号です。</span>
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
            <fieldset
              class="ledger-colors"
              role="radiogroup"
              :aria-label="`${l.name}の色`"
            >
              <label
                v-for="c in LEDGER_COLOR_KEYS"
                :key="c"
              >
                <input
                  v-model="chosen[l.id]"
                  type="radio"
                  :name="`ledger-color-${l.id}`"
                  :value="c"
                  :disabled="busyColor"
                  @click="changeColor(l.id, c)"
                  @change="changeColor(l.id, c)"
                >
                <span
                  class="ledger-chip"
                  :style="{ background: `var(--ledger-${c})` }"
                  aria-hidden="true"
                ><AppIcon
                  name="book"
                  :size="13"
                /></span>
                <span>{{ LEDGER_COLOR_NAMES[c] }}</span>
              </label>
            </fieldset>
          </li>
        </ul>
      </dd>
    </dl>
  </section>

  <p
    v-if="error"
    class="msg msg-error"
    role="alert"
    data-test="error"
  >
    {{ error }}
  </p>
  <p
    v-if="info"
    class="msg msg-info"
    data-test="info"
  >
    {{ info }}
  </p>

  <section
    class="card"
    data-test="data-manage"
  >
    <h2>データの管理</h2>
    <p class="muted small">
      カテゴリや店の名前の変更・整理を行います。ふだんの閲覧は「カテゴリ」「店」の画面で行えます。
    </p>
    <ul class="link-list">
      <li>
        <RouterLink
          to="/settings/categories"
          class="link-item"
          data-test="manage-categories"
        >
          <AppIcon name="tag" /><span>カテゴリの管理<span class="muted small block">名前の変更・移動・アーカイブ</span></span><AppIcon
            name="chevron-right"
            :size="16"
          />
        </RouterLink>
      </li>
      <li>
        <RouterLink
          to="/settings/stores"
          class="link-item"
          data-test="manage-stores"
        >
          <AppIcon name="store" /><span>店の管理<span class="muted small block">名前・種別の変更、重複した店の統合</span></span><AppIcon
            name="chevron-right"
            :size="16"
          />
        </RouterLink>
      </li>
      <li>
        <RouterLink
          to="/settings/labels"
          class="link-item"
          data-test="manage-labels"
        >
          <AppIcon name="tag" /><span>ラベルの管理<span class="muted small block">色ラベルのタイトル編集</span></span><AppIcon
            name="chevron-right"
            :size="16"
          />
        </RouterLink>
      </li>
    </ul>
  </section>

  <section class="card">
    <h2>パスキー</h2>
    <ul
      class="rows"
      data-test="passkeys"
    >
      <li
        v-for="p in passkeys"
        :key="p.id"
        class="row"
        :data-test="`passkey-${p.id}`"
      >
        <div class="row-main">
          <template v-if="editingId === p.id">
            <input
              v-model="editingLabel"
              type="text"
              aria-label="パスキーの名前"
              data-test="rename-input"
            >
            <div class="actions">
              <button
                class="btn btn-primary"
                :disabled="busy"
                data-test="rename-save"
                @click="saveRename(p.id)"
              >
                保存
              </button>
              <button
                class="btn"
                @click="editingId = null"
              >
                取消
              </button>
            </div>
          </template>
          <template v-else>
            <strong>{{ p.label ?? '名前なし' }}</strong>
            <span class="badge">{{ backupLabel(p) }}</span>
            <span class="muted small block">登録 {{ formatDateTime(p.created_at) }} / 最終使用 {{ formatDateTime(p.last_used_at) }}</span>
          </template>
        </div>
        <div
          v-if="editingId !== p.id"
          class="actions"
        >
          <template v-if="deletingId === p.id">
            <span class="small">削除しますか？</span>
            <button
              class="btn btn-danger"
              :disabled="busy"
              data-test="delete-confirm"
              @click="confirmDelete(p.id)"
            >
              削除する
            </button>
            <button
              class="btn"
              @click="deletingId = null"
            >
              やめる
            </button>
          </template>
          <template v-else>
            <button
              class="btn"
              data-test="rename"
              @click="startRename(p)"
            >
              名前を変更
            </button>
            <button
              class="btn"
              data-test="delete"
              @click="deletingId = p.id; editingId = null"
            >
              削除
            </button>
          </template>
        </div>
      </li>
    </ul>
    <div class="inline-form">
      <input
        v-model="newLabel"
        type="text"
        placeholder="追加するパスキーの名前（任意）"
        aria-label="追加するパスキーの名前"
        data-test="new-label"
      >
      <button
        class="btn btn-primary"
        :disabled="busy"
        data-test="add-passkey"
        @click="addPasskey"
      >
        パスキーを追加
      </button>
    </div>
  </section>

  <section
    v-if="isOwner"
    class="card"
    data-test="invite"
  >
    <h2>家計簿に招待</h2>
    <p class="muted small">
      あなたの既定の家計簿（オーナーである場合）への招待 URL を発行します。URL は一度だけ表示されます。
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
      <button
        class="btn"
        :disabled="busy"
        data-test="invite-issue"
        @click="issueInvite"
      >
        招待 URL を発行
      </button>
    </div>
    <p
      v-if="inviteUrl"
      class="msg msg-info break"
      data-test="invite-url"
    >
      {{ inviteUrl }}
    </p>
  </section>

  <section class="card">
    <h2>ログアウト</h2>
    <div class="actions">
      <button
        class="btn"
        :disabled="busy"
        data-test="logout"
        @click="logout(false)"
      >
        ログアウト
      </button>
      <button
        class="btn"
        :disabled="busy"
        data-test="logout-all"
        @click="logout(true)"
      >
        すべての端末からログアウト
      </button>
    </div>
  </section>
</template>
