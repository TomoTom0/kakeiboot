<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useDataApi, type StoreRow } from '../api/data'
import IconButton from '../components/IconButton.vue'
import RowMenu, { type RowMenuItem } from '../components/RowMenu.vue'
import { errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { useSessionStore } from '../stores/session'

// Store master (spec_mcp-tools.md 7-14: update; spec_data-model.md 5-2:
// merge is a web-only explicit, irreversible operation). Row editing
// follows the manage-screen rules (TASK-40 §2-3): no per-row buttons; the
// trailing "..." (編集 only) turns that row alone into the editor (Enter
// saves, Escape cancels, an unsaved switch to another row is blocked once)
// and results land on the row's inline status. Search and the collapsed
// two-step merge stay as they were.
const api = useDataApi()
const session = useSessionStore()

const rootEl = ref<HTMLElement | null>(null)
const stores = ref<StoreRow[]>([])
const categoryPaths = ref<string[]>([])
const query = ref('')
const error = ref('')
const info = ref('')
const busy = ref(false)

const ledgerId = useLedger(load)

// Editing needs editor or above in this ledger; viewers see the rows
// read-only (the "..." renders disabled, the menu never opens).
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})

// Inline results under the row they belong to: errors role=alert, success
// info (the past-reflection note) role=status.
type RowStatus = { role: 'alert' | 'status'; text: string }
const statusById = ref<Record<number, RowStatus>>({})

const statusOf = (id: number): RowStatus | null => statusById.value[id] ?? null
function setStatus(id: number, status: RowStatus): void {
  statusById.value = { ...statusById.value, [id]: status }
}
function clearStatus(id: number): void {
  if (statusById.value[id] === undefined) return
  const next = { ...statusById.value }
  delete next[id]
  statusById.value = next
}

interface EditorState {
  id: number
  name: string
  category: string | null
}

const editing = ref<EditorState | null>(null)
const mergeSource = ref<number | null>(null)
const mergeTarget = ref<number | null>(null)
const mergeConfirm = ref(false)
// one-time guard: picking another row's 編集 with unsaved input first shows
// the notice; the next pick goes through (discarding the input)
const blocked = ref(false)

function rowOf(id: number): StoreRow | null {
  return stores.value.find((s) => s.store_id === id) ?? null
}

function isDirty(): boolean {
  const e = editing.value
  if (e === null) return false
  const row = rowOf(e.id)
  if (row === null) return e.name.trim() !== ''
  return e.name !== row.name || e.category !== row.category
}

function openEditor(row: StoreRow): void {
  if (!canEdit.value || busy.value) return
  if (editing.value !== null && isDirty() && !blocked.value) {
    blocked.value = true
    setStatus(editing.value.id, { role: 'alert', text: '保存されていません' })
    return
  }
  if (editing.value !== null) clearStatus(editing.value.id)
  editing.value = { id: row.store_id, name: row.name, category: row.category }
  blocked.value = false
  clearStatus(row.store_id)
  // focus lands on the name input, past the menu's trigger return
  void nextTick(() => {
    rootEl.value
      ?.querySelector<HTMLElement>(`[data-test="store-${row.store_id}"] input[aria-label="店名"]`)
      ?.focus()
  })
}

function closeEditor(): void {
  if (editing.value !== null) clearStatus(editing.value.id)
  editing.value = null
  blocked.value = false
}

/** Escape / やめる give up — never while a save is in flight. */
function cancelEditor(): void {
  if (busy.value) return
  closeEditor()
}

const editItems: RowMenuItem[] = [{ action: 'menu-edit', label: '編集', test: 'menu-edit' }]

function onMenu(row: StoreRow, action: string): void {
  if (action === 'menu-edit') openEditor(row)
}

const sourceRow = computed(() => stores.value.find((s) => s.store_id === mergeSource.value) ?? null)
const targetRow = computed(() => stores.value.find((s) => s.store_id === mergeTarget.value) ?? null)

async function load(l: number): Promise<void> {
  try {
    const [rows, catalog] = await Promise.all([api.listStores(l, query.value), api.getCatalog(l, false)])
    stores.value = rows
    categoryPaths.value = catalog.store_categories.flatMap((c) => [
      c.name,
      ...c.children.map((x) => `${c.name}/${x.name}`),
    ])
  } catch (e) {
    error.value = errorMessage(e)
  }
  // drop an editor whose row left the list (merged away, filtered out)
  if (editing.value !== null && rowOf(editing.value.id) === null) closeEditor()
}

function search(): void {
  if (ledgerId.value !== null) void load(ledgerId.value)
}

async function run(task: (l: number) => Promise<void>): Promise<void> {
  if (ledgerId.value === null) return
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    await task(ledgerId.value)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

// The editor's own results (error and info) stay on its row (TASK-40 §2-3);
// only the merge / list errors use the card-level message.
async function saveEdit(): Promise<void> {
  const e = editing.value
  const l = ledgerId.value
  if (e === null || l === null || busy.value) return
  busy.value = true
  clearStatus(e.id)
  try {
    const res = await api.updateStore(l, e.id, { name: e.name, category: e.category })
    const note =
      res.before.category !== res.store.category
        ? `「${res.store.name}」を更新しました。店カテゴリの変更は過去のレシートの集計にも反映されます。`
        : `「${res.store.name}」を更新しました。`
    await load(l)
    // the editor may have been switched / discarded while the request was in
    // flight — only the one still on the same row closes here
    if (editing.value?.id !== e.id) return
    editing.value = null
    blocked.value = false
    setStatus(e.id, { role: 'status', text: note })
  } catch (err) {
    setStatus(e.id, { role: 'alert', text: errorMessage(err) })
  } finally {
    busy.value = false
  }
}

function reviewMerge(): void {
  error.value = ''
  info.value = ''
  mergeConfirm.value = false
  if (mergeSource.value === null || mergeTarget.value === null) {
    error.value = '統合元と統合先を選んでください。'
    return
  }
  if (mergeSource.value === mergeTarget.value) {
    error.value = '統合元と統合先に同じ店は選べません。'
    return
  }
  mergeConfirm.value = true
}

function doMerge(): Promise<void> {
  return run(async (l) => {
    if (mergeSource.value === null || mergeTarget.value === null) return
    const res = await api.mergeStores(l, mergeSource.value, mergeTarget.value)
    info.value = `「${res.merged_from.name}」を「${res.store.name}」に統合しました（レシート ${res.moved_receipts} 件を付け替え）。`
    mergeConfirm.value = false
    mergeSource.value = null
    mergeTarget.value = null
    await load(l)
  })
}
</script>

<template>
  <section
    ref="rootEl"
    class="card"
  >
    <h2>店</h2>
    <form
      class="inline-form"
      @submit.prevent="search"
    >
      <input
        v-model="query"
        type="search"
        placeholder="店名で検索"
        aria-label="店名で検索"
        data-test="query"
      >
      <IconButton
        icon="search"
        label="検索"
        type="submit"
      />
    </form>
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
    <ul
      class="rows"
      data-test="stores"
    >
      <li
        v-for="s in stores"
        :key="s.store_id"
        class="row"
        :data-test="`store-${s.store_id}`"
      >
        <div class="row-main">
          <strong data-test="store-name">{{ s.name }}</strong>
          <span class="muted small block">
            {{ s.category ?? 'カテゴリなし' }} / レシート <span data-test="receipt-count">{{ s.receipt_count }}</span> 件 / 最終 {{ s.last_purchased_on ?? '-' }}
          </span>
        </div>
        <div
          v-if="editing !== null && editing.id === s.store_id"
          class="row-editor"
        >
          <input
            v-model="editing.name"
            type="text"
            aria-label="店名"
            data-test="edit-name"
            @keydown.enter.prevent="saveEdit"
            @keydown.esc.prevent="cancelEditor"
          >
          <select
            v-model="editing.category"
            aria-label="店カテゴリ"
            data-test="edit-category"
            @keydown.enter.prevent="saveEdit"
            @keydown.esc.prevent="cancelEditor"
          >
            <option :value="null">
              なし
            </option>
            <option
              v-for="p in categoryPaths"
              :key="p"
              :value="p"
            >
              {{ p }}
            </option>
          </select>
          <IconButton
            icon="check"
            label="保存"
            variant="primary"
            :disabled="busy"
            test="edit-save"
            @click="saveEdit"
          />
          <IconButton
            icon="close"
            label="やめる"
            :disabled="busy"
            @click="cancelEditor"
          />
        </div>
        <RowMenu
          v-else
          :items="editItems"
          :ariaLabel="`${s.name}の操作`"
          :test="`row-menu-${s.store_id}`"
          :disabled="!canEdit"
          @select="(a) => onMenu(s, a)"
        />
        <p
          v-if="statusOf(s.store_id)"
          class="row-status"
          :role="statusOf(s.store_id)!.role"
        >
          {{ statusOf(s.store_id)!.text }}
        </p>
      </li>
    </ul>
  </section>

  <details
    class="card danger-zone"
    data-test="merge"
  >
    <summary>店の統合（元に戻せない操作）</summary>
    <p class="muted small">
      同じ店が別の名前で登録されているときに1つにまとめます。統合元のレシートは統合先に付け替えられ、統合元の名前は統合先の別名になります。
    </p>
    <div class="inline-form">
      <label>
        統合元
        <select
          v-model="mergeSource"
          data-test="merge-source"
          @change="mergeConfirm = false"
        >
          <option
            :value="null"
            disabled
          >
            選択
          </option>
          <option
            v-for="s in stores"
            :key="s.store_id"
            :value="s.store_id"
          >
            {{ s.name }}
          </option>
        </select>
      </label>
      <label>
        統合先
        <select
          v-model="mergeTarget"
          data-test="merge-target"
          @change="mergeConfirm = false"
        >
          <option
            :value="null"
            disabled
          >
            選択
          </option>
          <option
            v-for="s in stores"
            :key="s.store_id"
            :value="s.store_id"
          >
            {{ s.name }}
          </option>
        </select>
      </label>
      <button
        class="btn"
        data-test="merge-review"
        @click="reviewMerge"
      >
        統合内容を確認
      </button>
    </div>
    <div
      v-if="mergeConfirm && sourceRow && targetRow"
      class="confirm"
      data-test="merge-confirm-panel"
    >
      <p>
        「{{ sourceRow.name }}」（レシート {{ sourceRow.receipt_count }} 件）を「{{ targetRow.name }}」に統合します。「{{ sourceRow.name }}」は削除され、<strong>この操作は元に戻せません。</strong>
      </p>
      <div class="actions">
        <button
          class="btn btn-danger"
          :disabled="busy"
          data-test="merge-confirm"
          @click="doMerge"
        >
          統合する
        </button>
        <button
          class="btn"
          @click="mergeConfirm = false"
        >
          やめる
        </button>
      </div>
    </div>
  </details>
</template>
