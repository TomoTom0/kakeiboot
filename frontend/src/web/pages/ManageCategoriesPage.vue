<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDataApi, type Catalog, type CategoryKind, type CategoryNode } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import RowMenu, { type RowMenuItem } from '../components/RowMenu.vue'
import { errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { useSessionStore } from '../stores/session'

// Category management (spec_data-model.md 5-1, spec_mcp-tools.md 7-13):
// two levels, create / rename / move / archive / unarchive, no deletion.
// Redesigned in TASK-40 §2-2: top categories are collapsible group headers
// (.cat-head with a chevron, an add-child "+" and a trailing "..." RowMenu)
// and their children live in a guided ul.cat-children block. Every row
// operation is picked from the "..." menu — rename / move turn that row
// alone into the editor (Enter saves, Escape cancels, an unsaved switch to
// another row is blocked once), archive / unarchive run immediately. The
// fold state persists in sessionStorage per ledger x kind, and the kind tab
// selection rides on the URL (?kind=, with ?focus= / ?new= deep links
// consumed on mount).
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const rootEl = ref<HTMLElement | null>(null)
const showArchived = ref(false)
const catalog = ref<Catalog | null>(null)
const loadError = ref('')
const busy = ref(false)

const kind = computed<CategoryKind>(() => (route.query.kind === 'store' ? 'store' : 'item'))
const roots = computed<CategoryNode[]>(() =>
  catalog.value ? (kind.value === 'item' ? catalog.value.item_categories : catalog.value.store_categories) : [],
)

// Name editing needs editor or above in this ledger; viewers stay read-only
// (the "..." and the "+" buttons render disabled, the menu never opens).
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})

// ---------------------------------------------------------------- fold state

const FOLD_KEY = 'bb-cat-fold'

// A corrupted value (a string instead of the id array, non-numeric ids)
// drops that key instead of leaking into foldedIds as a string.
function readFold(): Record<string, number[]> {
  try {
    const raw = sessionStorage.getItem(FOLD_KEY)
    const v = raw === null ? null : JSON.parse(raw)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, number[]> = {}
    for (const [k, ids] of Object.entries(v)) {
      if (Array.isArray(ids) && ids.every((x) => typeof x === 'number' && Number.isFinite(x))) out[k] = ids
    }
    return out
  } catch {
    return {}
  }
}

function writeFold(): void {
  try {
    const pruned: Record<string, number[]> = {}
    for (const [k, v] of Object.entries(fold.value)) if (v.length > 0) pruned[k] = v
    sessionStorage.setItem(FOLD_KEY, JSON.stringify(pruned))
  } catch {
    // inaccessible storage: keep the in-component state only
  }
}

const fold = ref<Record<string, number[]>>(readFold())
const ledgerId = useLedger(load)
const foldKey = computed(() => `${ledgerId.value ?? '-'}:${kind.value}`)
const foldedIds = computed<number[]>(() => fold.value[foldKey.value] ?? [])

function setFolded(ids: number[]): void {
  fold.value = { ...fold.value, [foldKey.value]: ids }
  writeFold()
}

function toggleFold(id: number): void {
  const cur = foldedIds.value
  setFolded(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
}

function unfold(id: number): void {
  if (foldedIds.value.includes(id)) setFolded(foldedIds.value.filter((x) => x !== id))
}

// ------------------------------------------------------------- tree lookups

interface NodeHit {
  node: CategoryNode
  /** parent top-category name ('' when the node is a top category) */
  parentName: string
  /** the group's id to expand for a child node (null for a top category) */
  parentId: number | null
}

function findNode(id: number): NodeHit | null {
  for (const r of roots.value) {
    if (r.id === id) return { node: r, parentName: '', parentId: null }
    for (const c of r.children) if (c.id === id) return { node: c, parentName: r.name, parentId: r.id }
  }
  return null
}

function pathOf(hit: NodeHit): string {
  return hit.parentName === '' ? hit.node.name : `${hit.parentName}/${hit.node.name}`
}

// --------------------------------------------------------------- row status

// Inline results under the row they belong to (TASK-40 §2-2): errors are
// role=alert, success info is role=status.
type RowStatus = { role: 'alert' | 'status'; text: string }
const statusById = ref<Record<number, RowStatus>>({})

function statusOf(id: number): RowStatus | null {
  return statusById.value[id] ?? null
}

function setStatus(id: number, status: RowStatus): void {
  statusById.value = { ...statusById.value, [id]: status }
}

function clearStatus(id: number): void {
  if (statusById.value[id] === undefined) return
  const next = { ...statusById.value }
  delete next[id]
  statusById.value = next
}

// --------------------------------------------------------------- row editor

interface EditorState {
  id: number
  name: string
  /** move target: '' = make it a top category, otherwise a root name */
  parent: string
  /** the path API calls are sent against; refreshed from the refetched list */
  basisPath: string
}

const editor = ref<EditorState | null>(null)
// one-time guard: picking another row's menu item with unsaved input first
// shows the notice; the next pick goes through (discarding the input)
const blocked = ref(false)

function isEditing(id: number): boolean {
  return editor.value?.id === id
}

function isDirty(): boolean {
  const e = editor.value
  if (e === null) return false
  const hit = findNode(e.id)
  if (hit === null) return e.name.trim() !== '' || e.parent !== ''
  return e.name !== hit.node.name || e.parent !== hit.parentName
}

function moveTargets(id: number): string[] {
  return roots.value.filter((r) => r.id !== id).map((r) => r.name)
}

function openEditor(node: CategoryNode, parentName: string, focus: 'name' | 'move'): void {
  if (!canEdit.value || busy.value) return
  if (editor.value !== null && isDirty() && !blocked.value) {
    blocked.value = true
    setStatus(editor.value.id, { role: 'alert', text: '保存されていません' })
    return
  }
  if (editor.value !== null) clearStatus(editor.value.id)
  editor.value = { id: node.id, name: node.name, parent: parentName, basisPath: parentName === '' ? node.name : `${parentName}/${node.name}` }
  blocked.value = false
  clearStatus(node.id)
  // focus lands on the requested input, past the menu's trigger return
  void nextTick(() => {
    const wanted = focus === 'move' ? 'select[aria-label="移動先"]' : 'input[aria-label="新しい名前"]'
    rootEl.value?.querySelector<HTMLElement>(`[data-test="cat-${node.id}"] ${wanted}`)?.focus()
  })
}

function closeEditor(): void {
  if (editor.value !== null) clearStatus(editor.value.id)
  editor.value = null
  blocked.value = false
}

/** Escape / やめる give up — never while a save sequence is in flight. */
function cancelEditor(): void {
  if (busy.value) return
  closeEditor()
}

/** One save bundles rename + move as a single sequence (TASK-40 §2-2). */
async function saveEditor(): Promise<void> {
  const e = editor.value
  const l = ledgerId.value
  if (e === null || l === null || busy.value) return
  const hit = findNode(e.id)
  if (hit === null) {
    closeEditor()
    return
  }
  const newName = e.name.trim()
  const nameChanged = newName !== hit.node.name
  const parentChanged = e.parent !== hit.parentName
  if (!nameChanged && !parentChanged) {
    closeEditor()
    return
  }
  busy.value = true
  clearStatus(e.id)
  let path = e.basisPath
  let finalPath = path
  try {
    if (nameChanged) {
      const res = await api.manageCategory(l, { kind: kind.value, action: 'rename', category: path, new_name: newName })
      path = res.category.path
      finalPath = path
    }
    if (parentChanged) {
      // the move goes out on the (possibly renamed) path — the old one 404s
      const res = await api.manageCategory(l, {
        kind: kind.value,
        action: 'move',
        category: path,
        new_parent: e.parent === '' ? null : e.parent,
      })
      finalPath = res.category.path
    }
    await load(l)
    // the editor may have been switched / discarded while the requests were
    // in flight — only the one still on the same row closes here
    if (editor.value?.id !== e.id) return
    editor.value = null
    blocked.value = false
    setStatus(e.id, { role: 'status', text: `「${finalPath}」を更新しました。` })
  } catch (err) {
    // refetch so confirmed changes show, then keep the editor open on the
    // refreshed basis path (a stale basis would 404 on re-save)
    await load(l)
    const fresh = findNode(e.id)
    if (fresh !== null) e.basisPath = pathOf(fresh)
    setStatus(e.id, { role: 'alert', text: errorMessage(err) })
  } finally {
    busy.value = false
  }
}

/** Archive / unarchive run straight from the menu, no editor, no confirm. */
async function runImmediate(id: number, action: 'archive' | 'unarchive', path: string): Promise<void> {
  const l = ledgerId.value
  if (l === null || busy.value) return
  busy.value = true
  clearStatus(id)
  try {
    await api.manageCategory(l, { kind: kind.value, action, category: path })
    await load(l)
  } catch (e) {
    setStatus(id, { role: 'alert', text: errorMessage(e) })
  } finally {
    busy.value = false
  }
}

function rootMenuItems(root: CategoryNode): RowMenuItem[] {
  return [
    { action: 'menu-rename', label: '名前を変更', test: 'menu-rename' },
    root.archived
      ? { action: 'menu-unarchive', label: 'アーカイブから戻す', test: 'menu-unarchive' }
      : { action: 'menu-archive', label: 'アーカイブする', danger: true, test: 'menu-archive' },
  ]
}

function childMenuItems(child: CategoryNode): RowMenuItem[] {
  return [
    { action: 'menu-rename', label: '名前を変更', test: 'menu-rename' },
    { action: 'menu-move', label: '移動先を変更', test: 'menu-move' },
    child.archived
      ? { action: 'menu-unarchive', label: 'アーカイブから戻す', test: 'menu-unarchive' }
      : { action: 'menu-archive', label: 'アーカイブする', danger: true, test: 'menu-archive' },
  ]
}

function onRootMenu(root: CategoryNode, action: string): void {
  if (action === 'menu-rename') openEditor(root, '', 'name')
  else if (action === 'menu-archive') void runImmediate(root.id, 'archive', root.name)
  else if (action === 'menu-unarchive') void runImmediate(root.id, 'unarchive', root.name)
}

function onChildMenu(root: CategoryNode, child: CategoryNode, action: string): void {
  if (action === 'menu-rename') openEditor(child, root.name, 'name')
  else if (action === 'menu-move') openEditor(child, root.name, 'move')
  else if (action === 'menu-archive') void runImmediate(child.id, 'archive', `${root.name}/${child.name}`)
  else if (action === 'menu-unarchive') void runImmediate(child.id, 'unarchive', `${root.name}/${child.name}`)
}

// --------------------------------------------------------------------- add

// One add row at a time: 'top' = the heading's big-category row (before the
// list), a root id = a child row at the end of that group's children.
const addFor = ref<'top' | number | null>(null)
const addValue = ref('')
const addStatus = ref<RowStatus | null>(null)

function focusAddInput(): void {
  void nextTick(() => rootEl.value?.querySelector<HTMLElement>('.add-row input')?.focus())
}

function beginAddTop(): void {
  if (!canEdit.value || busy.value) return
  addFor.value = 'top'
  addValue.value = ''
  addStatus.value = null
  focusAddInput()
}

function beginAddChild(root: CategoryNode): void {
  if (!canEdit.value || busy.value) return
  unfold(root.id) // the "+" of a folded group expands it first
  addFor.value = root.id
  addValue.value = ''
  addStatus.value = null
  focusAddInput()
}

function closeAdd(): void {
  addFor.value = null
  addValue.value = ''
  addStatus.value = null
}

/** Escape / やめる give up — never while a create is in flight. */
function cancelAdd(): void {
  if (busy.value) return
  closeAdd()
}

async function submitAdd(): Promise<void> {
  const l = ledgerId.value
  const forId = addFor.value
  if (forId === null || l === null || busy.value) return
  const raw = addValue.value.trim()
  if (raw === '') return
  if (raw.includes('/')) {
    addStatus.value = {
      role: 'alert',
      text: '/ は使えません。小分類は大分類ヘッダの + から、大分類は一覧上部の + から追加してください。',
    }
    return
  }
  // '' = a top category (the path is the input as-is); otherwise the parent
  // group's name prefixes the path. A vanished parent just closes the row.
  const parentName = forId === 'top' ? '' : (findNode(forId)?.node.name ?? null)
  if (parentName === null) {
    closeAdd()
    return
  }
  busy.value = true
  try {
    const res = await api.manageCategory(l, {
      kind: kind.value,
      action: 'create',
      category: parentName === '' ? raw : `${parentName}/${raw}`,
    })
    if (!res.created) {
      addStatus.value = { role: 'status', text: `「${res.category.path}」はすでにあります。` }
      return
    }
    closeAdd()
    await load(l)
  } catch (e) {
    addStatus.value = { role: 'alert', text: errorMessage(e) }
  } finally {
    busy.value = false
  }
}

// -------------------------------------------------------- kind tab & query

// A kind switch is a context switch: the open editor / add row closes and
// unsaved input is discarded without the one-time guard notice.
function switchKind(k: CategoryKind): void {
  if (kind.value === k) return
  closeEditor()
  closeAdd()
  void router.replace({ query: { ...route.query, kind: k } })
}

// ?focus=<id> opens that node's editor (parent expanded); ?new=top | <root
// id> opens the matching add row. Unresolvable ids do nothing but have the
// query cleared. Consumed once, right after the first catalog load.
const queryConsumed = ref(false)

async function consumeQuery(): Promise<void> {
  if (queryConsumed.value) return
  queryConsumed.value = true
  const focusRaw = typeof route.query.focus === 'string' && route.query.focus !== '' ? route.query.focus : null
  const newRaw = typeof route.query.new === 'string' && route.query.new !== '' ? route.query.new : null
  if (focusRaw !== null) {
    const hit = findNode(Number(focusRaw))
    if (hit !== null) {
      if (hit.parentId !== null) unfold(hit.parentId)
      openEditor(hit.node, hit.parentName, 'name')
    }
  } else if (newRaw !== null) {
    if (newRaw === 'top') {
      if (canEdit.value) {
        addFor.value = 'top'
        addValue.value = ''
        addStatus.value = null
        focusAddInput()
      }
    } else {
      const root = roots.value.find((r) => r.id === Number(newRaw))
      if (root !== undefined && canEdit.value) {
        unfold(root.id)
        addFor.value = root.id
        addValue.value = ''
        addStatus.value = null
        focusAddInput()
      }
    }
  }
  if (focusRaw !== null || newRaw !== null) {
    void router.replace({ query: { ...route.query, focus: undefined, new: undefined } })
  }
}

// -------------------------------------------------------------------- load

async function load(l: number): Promise<void> {
  try {
    catalog.value = await api.getCatalog(l, showArchived.value)
    loadError.value = ''
  } catch (e) {
    loadError.value = errorMessage(e)
  }
  // drop an editor whose row left the list (hidden by the archived toggle,
  // archived / moved away from another screen)
  if (editor.value !== null && findNode(editor.value.id) === null) closeEditor()
  await consumeQuery()
}

watch(showArchived, () => {
  if (ledgerId.value !== null) void load(ledgerId.value)
})

// A ledger switch is a context switch too: drop the editing state and the
// per-row statuses (ids belong to the previous ledger's tree).
watch(ledgerId, () => {
  editor.value = null
  blocked.value = false
  closeAdd()
  statusById.value = {}
})
</script>

<template>
  <section
    ref="rootEl"
    class="card"
  >
    <div class="card-head">
      <h2>カテゴリ</h2>
      <div class="head-actions">
        <button
          type="button"
          class="row-action-btn"
          data-test="add-top"
          aria-label="大分類を追加"
          :disabled="!canEdit"
          @click="beginAddTop"
        >
          <AppIcon name="plus" />
        </button>
        <button
          type="button"
          class="link-btn"
          data-test="show-archived"
          :aria-pressed="showArchived ? 'true' : 'false'"
          @click="showArchived = !showArchived"
        >
          {{ showArchived ? 'アーカイブ済みを隠す' : 'アーカイブ済みを表示' }}
        </button>
      </div>
    </div>
    <div class="tabs">
      <button
        type="button"
        class="tab"
        :class="{ active: kind === 'item' }"
        data-test="kind-item"
        @click="switchKind('item')"
      >
        品目カテゴリ
      </button>
      <button
        type="button"
        class="tab"
        :class="{ active: kind === 'store' }"
        data-test="kind-store"
        @click="switchKind('store')"
      >
        店カテゴリ
      </button>
    </div>
    <p
      v-if="loadError"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ loadError }}
    </p>
    <div
      v-if="addFor === 'top'"
      class="add-row"
    >
      <input
        v-model="addValue"
        type="text"
        aria-label="新しい大分類名"
        @keydown.enter.prevent="submitAdd"
        @keydown.esc.prevent="cancelAdd"
      >
      <button
        class="btn btn-primary"
        type="button"
        :disabled="busy || addValue.trim() === ''"
        @click="submitAdd"
      >
        作成
      </button>
      <button
        class="btn"
        type="button"
        :disabled="busy"
        @click="cancelAdd"
      >
        やめる
      </button>
      <p
        v-if="addStatus"
        class="row-status"
        :role="addStatus.role"
      >
        {{ addStatus.text }}
      </p>
    </div>
    <ul
      class="rows"
      data-test="categories"
    >
      <li
        v-for="root in roots"
        :key="root.id"
        class="cat-group"
        :data-test="`cat-${root.id}`"
      >
        <div class="cat-head">
          <button
            type="button"
            class="row-action-btn cat-fold"
            data-test="fold"
            :aria-expanded="foldedIds.includes(root.id) ? 'false' : 'true'"
            :aria-controls="`cat-children-${root.id}`"
            :aria-label="`${root.name}の子カテゴリ ${root.children.length} 件を${foldedIds.includes(root.id) ? '開く' : '閉じる'}`"
            :disabled="isEditing(root.id)"
            @click="toggleFold(root.id)"
          >
            <AppIcon name="chevron-down" />
          </button>
          <span
            class="cat-name"
            data-test="cat-name"
          >{{ root.name }}</span>
          <span
            v-if="root.archived"
            class="badge"
          >アーカイブ済み</span>
          <span
            v-if="foldedIds.includes(root.id)"
            class="cat-count"
            aria-hidden="true"
          >({{ root.children.length }})</span>
          <button
            v-if="!isEditing(root.id)"
            type="button"
            class="row-action-btn cat-add"
            :data-test="`add-child-${root.id}`"
            :aria-label="`${root.name}に小分類を追加`"
            :disabled="!canEdit"
            @click="beginAddChild(root)"
          >
            <AppIcon name="plus" />
          </button>
          <RowMenu
            v-if="!isEditing(root.id)"
            class="cat-menu"
            :items="rootMenuItems(root)"
            :ariaLabel="`${root.name}の操作`"
            :test="`row-menu-${root.id}`"
            :disabled="!canEdit"
            @select="(a) => onRootMenu(root, a)"
          />
        </div>
        <div
          v-if="isEditing(root.id)"
          class="row-editor"
        >
          <input
            v-model="editor!.name"
            type="text"
            aria-label="新しい名前"
            @keydown.enter.prevent="saveEditor"
            @keydown.esc.prevent="cancelEditor"
          >
          <select
            v-model="editor!.parent"
            aria-label="移動先"
            @keydown.enter.prevent="saveEditor"
            @keydown.esc.prevent="cancelEditor"
          >
            <option value="">
              大分類にする
            </option>
            <option
              v-for="t in moveTargets(root.id)"
              :key="t"
              :value="t"
            >
              {{ t }} の下へ
            </option>
          </select>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="busy"
            @click="saveEditor"
          >
            保存
          </button>
          <button
            class="btn"
            type="button"
            :disabled="busy"
            @click="cancelEditor"
          >
            やめる
          </button>
        </div>
        <p
          v-if="statusOf(root.id)"
          class="row-status"
          :role="statusOf(root.id)!.role"
        >
          {{ statusOf(root.id)!.text }}
        </p>
        <ul
          v-if="!foldedIds.includes(root.id)"
          :id="`cat-children-${root.id}`"
          class="cat-children"
        >
          <li
            v-for="child in root.children"
            :key="child.id"
            class="row"
            :data-test="`cat-${child.id}`"
          >
            <div class="row-main">
              <span data-test="cat-name">{{ child.name }}</span>
              <span
                v-if="child.archived"
                class="badge"
              >アーカイブ済み</span>
            </div>
            <div
              v-if="isEditing(child.id)"
              class="row-editor"
            >
              <input
                v-model="editor!.name"
                type="text"
                aria-label="新しい名前"
                @keydown.enter.prevent="saveEditor"
                @keydown.esc.prevent="cancelEditor"
              >
              <select
                v-model="editor!.parent"
                aria-label="移動先"
                @keydown.enter.prevent="saveEditor"
                @keydown.esc.prevent="cancelEditor"
              >
                <option value="">
                  大分類にする
                </option>
                <option
                  v-for="t in moveTargets(child.id)"
                  :key="t"
                  :value="t"
                >
                  {{ t }} の下へ
                </option>
              </select>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="busy"
                @click="saveEditor"
              >
                保存
              </button>
              <button
                class="btn"
                type="button"
                :disabled="busy"
                @click="cancelEditor"
              >
                やめる
              </button>
            </div>
            <RowMenu
              v-else
              :items="childMenuItems(child)"
              :ariaLabel="`${child.name}の操作`"
              :test="`row-menu-${child.id}`"
              :disabled="!canEdit"
              @select="(a) => onChildMenu(root, child, a)"
            />
            <p
              v-if="statusOf(child.id)"
              class="row-status"
              :role="statusOf(child.id)!.role"
            >
              {{ statusOf(child.id)!.text }}
            </p>
          </li>
          <li
            v-if="addFor === root.id"
            class="row add-row"
          >
            <input
              v-model="addValue"
              type="text"
              aria-label="新しい小分類名"
              @keydown.enter.prevent="submitAdd"
              @keydown.esc.prevent="cancelAdd"
            >
            <button
              class="btn btn-primary"
              type="button"
              :disabled="busy || addValue.trim() === ''"
              @click="submitAdd"
            >
              作成
            </button>
            <button
              class="btn"
              type="button"
              :disabled="busy"
              @click="cancelAdd"
            >
              やめる
            </button>
            <p
              v-if="addStatus"
              class="row-status"
              :role="addStatus.role"
            >
              {{ addStatus.text }}
            </p>
          </li>
        </ul>
      </li>
    </ul>
    <p class="muted small">
      カテゴリは削除できません。使わないものはアーカイブすると一覧や候補に出なくなります。
    </p>
  </section>
</template>
