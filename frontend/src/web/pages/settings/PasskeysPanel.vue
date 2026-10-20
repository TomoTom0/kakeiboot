<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { authApi, type Passkey } from '../../api/auth'
import { createPasskey, isCancel } from '../../api/webauthn'
import { charCount, errorMessage, formatDateTime } from '../../composables/format'
import IconButton from '../../components/IconButton.vue'

// Passkey section (spec_auth.md 2-7), the first card of the auth tab
// (/settings/auth): list (synced / device-bound), add, rename and delete.
// Add and delete go through step-up; the last passkey cannot be deleted
// (the API answers 409). Moved from SettingsPage when the settings screen
// split into panels (TASK-36). TASK-47: the row actions, the add submit and
// the rename editor's pair are icon-only buttons (the row's own name rides
// as the accessible name); the destructive confirm keeps its words.
const passkeys = ref<Passkey[]>([])
const error = ref('')
const info = ref('')
const busy = ref(false)
const newLabel = ref('')
const editingId = ref<number | null>(null)
const editingLabel = ref('')
const deletingId = ref<number | null>(null)

function backupLabel(p: Passkey): string {
  if (p.backup_state === true) return '同期済み'
  if (p.backup_state === false) return '端末内'
  return '不明'
}

/** The row-scoped name for the icon buttons' accessible names (TASK-47). */
function nameOf(p: Passkey): string {
  return p.label ?? '名前なしのパスキー'
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
</script>

<template>
  <section
    class="card"
    data-test="passkeys-panel"
  >
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
              <IconButton
                icon="check"
                label="保存"
                variant="primary"
                :disabled="busy"
                test="rename-save"
                @click="saveRename(p.id)"
              />
              <IconButton
                icon="close"
                label="やめる"
                @click="editingId = null"
              />
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
            <IconButton
              icon="pencil"
              :label="`${nameOf(p)}の名前を変更`"
              test="rename"
              @click="startRename(p)"
            />
            <IconButton
              icon="trash"
              variant="danger"
              :label="`${nameOf(p)}を削除`"
              test="delete"
              @click="deletingId = p.id; editingId = null"
            />
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
      <IconButton
        icon="key-plus"
        label="パスキーを追加"
        variant="primary"
        :disabled="busy"
        test="add-passkey"
        @click="addPasskey"
      />
    </div>
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
  </section>
</template>
