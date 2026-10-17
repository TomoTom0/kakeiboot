<script setup lang="ts">
import { computed, ref } from 'vue'
import { useDataApi, type StoreRow } from '../api/data'
import { errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'

// Store master (spec_mcp-tools.md 7-14: update; spec_data-model.md 5-2:
// merge is a web-only explicit, irreversible operation).
const api = useDataApi()
const stores = ref<StoreRow[]>([])
const categoryPaths = ref<string[]>([])
const query = ref('')
const error = ref('')
const info = ref('')
const busy = ref(false)
const editing = ref<{ id: number; name: string; category: string | null } | null>(null)
const mergeSource = ref<number | null>(null)
const mergeTarget = ref<number | null>(null)
const mergeConfirm = ref(false)

const ledgerId = useLedger(load)

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

function saveEdit(): Promise<void> {
  return run(async (l) => {
    const e = editing.value
    if (!e) return
    const res = await api.updateStore(l, e.id, { name: e.name, category: e.category })
    editing.value = null
    info.value =
      res.before.category !== res.store.category
        ? `「${res.store.name}」を更新しました。店カテゴリの変更は過去のレシートの集計にも反映されます。`
        : `「${res.store.name}」を更新しました。`
    await load(l)
  })
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
  <section class="card">
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
      <button
        class="btn"
        type="submit"
      >
        検索
      </button>
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
        <div
          v-if="editing && editing.id === s.store_id"
          class="row-main inline-form"
        >
          <input
            v-model="editing.name"
            type="text"
            aria-label="店名"
            data-test="edit-name"
          >
          <select
            v-model="editing.category"
            aria-label="店カテゴリ"
            data-test="edit-category"
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
          <button
            class="btn btn-primary"
            :disabled="busy"
            data-test="edit-save"
            @click="saveEdit"
          >
            保存
          </button>
          <button
            class="btn"
            @click="editing = null"
          >
            取消
          </button>
        </div>
        <template v-else>
          <div class="row-main">
            <strong data-test="store-name">{{ s.name }}</strong>
            <span class="muted small block">
              {{ s.category ?? 'カテゴリなし' }} / レシート <span data-test="receipt-count">{{ s.receipt_count }}</span> 件 / 最終 {{ s.last_purchased_on ?? '-' }}
            </span>
          </div>
          <div class="actions">
            <button
              class="btn"
              data-test="edit"
              @click="editing = { id: s.store_id, name: s.name, category: s.category }"
            >
              編集
            </button>
          </div>
        </template>
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
