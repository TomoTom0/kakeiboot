<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useDataApi, type Catalog, type CategoryKind, type CategoryNode } from '../api/data'
import { errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'

// Category management (spec_data-model.md 5-1, spec_mcp-tools.md 7-13):
// two levels, create / rename / move / archive / unarchive, no deletion.
const api = useDataApi()
const kind = ref<CategoryKind>('item')
const showArchived = ref(false)
const catalog = ref<Catalog | null>(null)
const error = ref('')
const info = ref('')
const busy = ref(false)
const newPath = ref('')
const editing = ref<{ path: string; mode: 'rename' | 'move'; value: string } | null>(null)

const ledgerId = useLedger(load)
watch(showArchived, () => {
  if (ledgerId.value !== null) void load(ledgerId.value)
})

const roots = computed<CategoryNode[]>(() =>
  catalog.value ? (kind.value === 'item' ? catalog.value.item_categories : catalog.value.store_categories) : [],
)

async function load(l: number): Promise<void> {
  try {
    catalog.value = await api.getCatalog(l, showArchived.value)
  } catch (e) {
    error.value = errorMessage(e)
  }
}

async function act(
  action: 'create' | 'rename' | 'move' | 'archive' | 'unarchive',
  category: string,
  extra: { new_name?: string; new_parent?: string | null } = {},
): Promise<void> {
  if (ledgerId.value === null) return
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    const res = await api.manageCategory(ledgerId.value, { kind: kind.value, action, category, ...extra })
    info.value =
      action === 'create' && !res.created
        ? `「${res.category.path}」は既にあります。`
        : `「${res.category.path}」を更新しました。`
    editing.value = null
    if (action === 'create') newPath.value = ''
    await load(ledgerId.value)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function create(): Promise<void> {
  return act('create', newPath.value.trim())
}

function startEdit(path: string, mode: 'rename' | 'move', current: string): void {
  editing.value = { path, mode, value: current }
}

function submitEdit(): Promise<void> {
  const e = editing.value
  if (!e) return Promise.resolve()
  if (e.mode === 'rename') return act('rename', e.path, { new_name: e.value.trim() })
  return act('move', e.path, { new_parent: e.value === '' ? null : e.value })
}

function moveTargets(path: string): string[] {
  return roots.value.filter((r) => r.name !== path).map((r) => r.name)
}

function rowsOf(): { node: CategoryNode; path: string; depth: number; parent: string | null }[] {
  const out: { node: CategoryNode; path: string; depth: number; parent: string | null }[] = []
  for (const r of roots.value) {
    out.push({ node: r, path: r.name, depth: 0, parent: null })
    for (const c of r.children) out.push({ node: c, path: `${r.name}/${c.name}`, depth: 1, parent: r.name })
  }
  return out
}
</script>

<template>
  <section class="card">
    <h2>カテゴリ</h2>
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: kind === 'item' }"
        data-test="kind-item"
        @click="kind = 'item'; editing = null"
      >
        品目カテゴリ
      </button>
      <button
        class="tab"
        :class="{ active: kind === 'store' }"
        data-test="kind-store"
        @click="kind = 'store'; editing = null"
      >
        店カテゴリ
      </button>
    </div>
    <label class="check">
      <input
        v-model="showArchived"
        type="checkbox"
        data-test="show-archived"
      >
      アーカイブ済みも表示
    </label>
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
      data-test="categories"
    >
      <li
        v-for="r in rowsOf()"
        :key="r.node.id"
        class="row"
        :class="{ child: r.depth === 1 }"
        :data-test="`cat-${r.path}`"
      >
        <div class="row-main">
          <span data-test="cat-name">{{ r.node.name }}</span>
          <span
            v-if="r.node.archived"
            class="badge"
          >アーカイブ済み</span>
          <form
            v-if="editing && editing.path === r.path"
            class="inline-form"
            @submit.prevent="submitEdit"
          >
            <input
              v-if="editing.mode === 'rename'"
              v-model="editing.value"
              type="text"
              aria-label="新しい名前"
              data-test="edit-input"
            >
            <select
              v-else
              v-model="editing.value"
              aria-label="移動先"
              data-test="move-select"
            >
              <option value="">
                大分類にする
              </option>
              <option
                v-for="t in moveTargets(r.path)"
                :key="t"
                :value="t"
              >
                {{ t }} の下へ
              </option>
            </select>
            <button
              class="btn btn-primary"
              type="submit"
              :disabled="busy"
              data-test="edit-save"
            >
              保存
            </button>
            <button
              class="btn"
              type="button"
              @click="editing = null"
            >
              取消
            </button>
          </form>
        </div>
        <div
          v-if="!editing || editing.path !== r.path"
          class="actions"
        >
          <button
            class="btn"
            data-test="rename"
            @click="startEdit(r.path, 'rename', r.node.name)"
          >
            改名
          </button>
          <button
            class="btn"
            data-test="move"
            @click="startEdit(r.path, 'move', r.parent ?? '')"
          >
            移動
          </button>
          <button
            v-if="r.node.archived"
            class="btn"
            :disabled="busy"
            data-test="unarchive"
            @click="act('unarchive', r.path)"
          >
            戻す
          </button>
          <button
            v-else
            class="btn"
            :disabled="busy"
            data-test="archive"
            @click="act('archive', r.path)"
          >
            アーカイブ
          </button>
        </div>
      </li>
    </ul>
    <form
      class="inline-form"
      data-test="create-form"
      @submit.prevent="create"
    >
      <input
        v-model="newPath"
        type="text"
        placeholder="大分類 または 大分類/小分類"
        aria-label="新しいカテゴリ"
        data-test="new-path"
      >
      <button
        class="btn btn-primary"
        type="submit"
        :disabled="busy || newPath.trim() === ''"
        data-test="create"
      >
        作成
      </button>
    </form>
    <p class="muted small">
      カテゴリは削除できません。使わないものはアーカイブすると一覧や候補に出なくなります。
    </p>
  </section>
</template>
