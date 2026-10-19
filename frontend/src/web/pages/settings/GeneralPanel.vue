<script setup lang="ts">
import { nextTick, ref } from 'vue'
import AppIcon from '../../components/AppIcon.vue'
import RowMenu, { type RowMenuItem } from '../../components/RowMenu.vue'
import { useDataApi } from '../../api/data'
import { ApiError } from '../../api/http'
import { errorMessage } from '../../composables/format'
import { useSessionStore } from '../../stores/session'

// General tab (spec_auth.md 7-1): the display name and the ledger
// memberships. The account number is NOT shown on the web UI at all
// (TASK-38 real-device follow-up: the number display and its copy button
// were removed; the operator CLI `user list` is where the number lives). The
// per-ledger color choice UI is gone: colors are assigned automatically when
// a membership is created and cannot be changed by the user (TASK-34).
// TASK-20: owner / editor rows carry the trailing "..." (名前を変更) that
// turns the row into an inline rename editor (Enter saves, Escape gives up,
// the result lands on the row); viewer rows stay display-only with no menu.
const session = useSessionStore()
const api = useDataApi()

const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', editor: '編集', viewer: '閲覧のみ' }

const menuItems: RowMenuItem[] = [{ action: 'rename', label: '名前を変更', test: 'menu-rename' }]

const rootEl = ref<HTMLElement | null>(null)
// one editor at a time; switching rows simply discards the draft (the list
// is short — no unsaved guard, TASK-20 7-2)
const editingId = ref<number | null>(null)
const editName = ref('')
const busy = ref(false)
// inline result on the row it belongs to: success role=status, failure role=alert
const statusOf = ref<{ id: number; role: 'status' | 'alert'; text: string } | null>(null)

function openRename(id: number, name: string): void {
  if (busy.value) return
  editingId.value = id
  editName.value = name
  statusOf.value = null
  // focus lands on the name input, past the menu's trigger return
  void nextTick(() => {
    rootEl.value?.querySelector<HTMLElement>('input[aria-label="家計簿名"]')?.focus()
  })
}

function onMenu(id: number, name: string, action: string): void {
  if (action === 'rename') openRename(id, name)
}

/** Escape / やめる give up — never while a save is in flight. */
function cancel(): void {
  if (busy.value) return
  editingId.value = null
  statusOf.value = null
}

// The backend answers one flat 400 invalid_request for empty / too long /
// duplicate names (TASK-20 2-1), so the row alert uses one shared copy.
const INVALID_NAME = '名前が空・100字を超える・または同じ名前の家計簿が既にあります。'

async function save(): Promise<void> {
  const id = editingId.value
  if (id === null || busy.value) return
  busy.value = true
  statusOf.value = null
  try {
    const res = await api.renameLedger(id, { name: editName.value })
    // the session store update carries the new name to the LedgerSwitcher
    // and every ledger-scoped screen without a re-fetch (TASK-20 7-3)
    session.renameLedger(id, res.name)
    editingId.value = null
    statusOf.value = { id, role: 'status', text: '保存しました' }
  } catch (e) {
    statusOf.value = {
      id,
      role: 'alert',
      text: e instanceof ApiError && e.status === 400 ? INVALID_NAME : errorMessage(e),
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section
    ref="rootEl"
    class="card"
  >
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
            <RowMenu
              v-if="editingId !== l.id && l.role !== 'viewer'"
              :items="menuItems"
              :ariaLabel="`${l.name}の操作`"
              :test="`row-menu-${l.id}`"
              @select="onMenu(l.id, l.name, $event)"
            />
            <div
              v-if="editingId === l.id"
              class="ledger-row-editor"
            >
              <input
                v-model="editName"
                type="text"
                aria-label="家計簿名"
                maxlength="100"
                data-test="edit-name"
                @keydown.enter.prevent="save"
                @keydown.esc.prevent="cancel"
              >
              <button
                class="btn btn-primary"
                type="button"
                :disabled="busy"
                data-test="edit-save"
                @click="save"
              >
                保存
              </button>
              <button
                class="btn"
                type="button"
                :disabled="busy"
                @click="cancel"
              >
                やめる
              </button>
            </div>
            <p
              v-if="statusOf !== null && statusOf.id === l.id"
              class="msg"
              :class="statusOf.role === 'alert' ? 'msg-error' : 'msg-info'"
              :role="statusOf.role"
            >
              {{ statusOf.text }}
            </p>
          </li>
        </ul>
      </dd>
    </dl>
  </section>
</template>
