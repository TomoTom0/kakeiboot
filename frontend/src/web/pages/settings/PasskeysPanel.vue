<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { authApi, type Passkey } from '../../api/auth'
import { createPasskey, isCancel } from '../../api/webauthn'
import { charCount, errorMessage, formatDateTime } from '../../composables/format'

// Passkey section (spec_auth.md 2-7), the first card of the auth tab
// (/settings/auth): list (synced / device-bound), add, rename and delete.
// Add and delete go through step-up; the last passkey cannot be deleted
// (the API answers 409). Moved from SettingsPage when the settings screen
// split into panels (TASK-36).
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
