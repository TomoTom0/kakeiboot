<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import {
  useDataApi,
  type DeleteReceiptResult,
  type PaymentMethod,
  type ReceiptItemPatch,
  type ReceiptSet,
  type ReceiptView,
} from '../api/data'
import { errorCodeOf, errorMessage, formatDateTime, formatYen } from '../composables/format'
import { PAYMENT_LABEL } from '../composables/labels'
import AppIcon from './AppIcon.vue'
import { dayLabel } from '../composables/period'
import { useCatalogStore } from '../stores/catalog'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

// One receipt in the feed (TASK-16 item 1): view by default, edit / delete /
// restore behind explicit actions (spec_mcp-tools.md 7-9, 7-10, 7-11).
// Edits carry the displayed revision (optimistic lock against chat edits);
// delete is preview -> confirm with the preview's revision; restore needs no
// confirmation. The labels slot is the TASK-17 insertion point.
const props = defineProps<{ ledgerId: number; receiptId: number }>()
const emit = defineEmits<{
  editingChange: [editing: boolean]
  changed: [receipt: ReceiptView]
  /** detail fetch settled (success or error): the feed's scroll
   * compensation waits for this instead of racing the fetch (TASK-19 2-7) */
  loaded: []
}>()

defineSlots<{
  labels(slotProps: {
    receipt: ReceiptView
    ledgerId: number
    canEdit: boolean
    editing: boolean
    applyReceipt: (next: ReceiptView) => void
  }): unknown
}>()

const api = useDataApi()
const session = useSessionStore()
const receipt = ref<ReceiptView | null>(null)
const error = ref('')
const info = ref('')
const busy = ref(false)
const preview = ref<DeleteReceiptResult | null>(null)

interface ItemDraft {
  item_id: number | null
  name: string
  amount: number
  category: string
  remove: boolean
}
interface Form {
  store_name: string
  purchased_on: string
  purchased_time: string
  payment_method: PaymentMethod | ''
  total_amount: string
  note: string
  items: ItemDraft[]
}
const form = ref<Form | null>(null)
const editing = computed(() => form.value !== null)
watch(editing, (v) => emit('editingChange', v))
// A feed navigation can unmount an open editor without the watch above
// running (browser back / the render window moving on); clear the flag so
// the feed does not stay locked with a stale editing id.
onUnmounted(() => {
  if (form.value !== null) emit('editingChange', false)
})

async function load(): Promise<void> {
  try {
    receipt.value = await api.getReceipt(props.ledgerId, props.receiptId)
    imageFailed.value = false
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    emit('loaded')
  }
}
onMounted(load)
watch(() => [props.ledgerId, props.receiptId], () => void load())

// The detail links below (TASK-74 §4-8) need the catalog's path → id map;
// a failed fetch must not break the panel (everything stays a plain span).
const catalog = useCatalogStore()
const period = usePeriodStore()
onMounted(() => {
  void catalog.load().catch(() => {})
})

/** Link query of the receipt's purchase month (D28 §5-1: a receipt without
 * a purchase date keeps the current period — urlQuery's three forms). */
const linkQuery = computed<Record<string, string>>(() =>
  receipt.value?.purchased_on
    ? { month: receipt.value.purchased_on.slice(0, 7) }
    : { ...period.urlQuery },
)

/** Read-mode item rows, each with its category's hierarchy-route target
 * (TASK-74 §4-8): null keeps the plain span — 未分類, a path the active
 * catalog cannot resolve, or the edit mode (no moving while editing). */
const itemRows = computed(() =>
  (receipt.value?.items ?? []).map((it) => {
    let catTo: RouteLocationRaw | null = null
    const path = it.category
    if (!editing.value && path) {
      const node = catalog.resolve('item', path)
      const parent = node === null ? null : catalog.parentIdOf('item', node.id)
      if (node) {
        catTo = {
          path: parent === null ? `/categories/${node.id}` : `/categories/${parent}/${node.id}`,
          query: linkQuery.value,
        }
      }
    }
    return { it, catTo }
  }),
)

// The role in the panel's own ledger decides editability (with the receipt
// not deleted); viewers stay read-only.
const canEdit = computed(() => {
  if (!receipt.value || receipt.value.deleted_at) return false
  const role = session.me?.ledgers.find((l) => l.id === props.ledgerId)?.role
  return role === 'owner' || role === 'editor'
})

/** Replace the panel's receipt wholesale (TASK-17 labels flow through here). */
function applyReceipt(next: ReceiptView): void {
  receipt.value = next
  emit('changed', next)
}

// Receipt image (spec_mcp-tools.md 11-5): the URL comes only from the API
// response and must point at /media/img/ — anything else is not rendered.
const imageUrl = computed<string | null>(() => {
  const raw = receipt.value?.image_url?.url
  if (!raw) return null
  try {
    const u = new URL(raw, window.location.origin)
    return u.pathname.startsWith('/media/img/') ? raw : null
  } catch {
    return null
  }
})
// Minimal expiry UX: /media tokens live ~15 min; on load error offer a
// reload, which re-fetches the detail (and a fresh token).
const imageFailed = ref(false)

function onImageError(): void {
  imageFailed.value = true
}

async function reloadImage(): Promise<void> {
  imageFailed.value = false
  await load()
}

function startEdit(): void {
  const r = receipt.value
  if (!r) return
  info.value = ''
  error.value = ''
  form.value = {
    store_name: r.store?.name ?? r.store_name_raw ?? '',
    purchased_on: r.purchased_on ?? '',
    purchased_time: r.purchased_time ?? '',
    payment_method: r.payment_method ?? '',
    total_amount: r.total_amount === null ? '' : String(r.total_amount),
    note: r.note ?? '',
    items: r.items.map((i) => ({
      item_id: i.item_id,
      name: i.name,
      amount: i.amount,
      category: i.category ?? '',
      remove: false,
    })),
  }
}

function addItem(): void {
  form.value?.items.push({ item_id: null, name: '', amount: 0, category: '', remove: false })
}

function diff(r: ReceiptView, f: Form): { set: ReceiptSet; upsert: ReceiptItemPatch[]; remove: number[] } {
  const set: ReceiptSet = {}
  const storeName = f.store_name.trim()
  if (storeName && storeName !== (r.store?.name ?? r.store_name_raw ?? '')) set.store_name = storeName
  if ((f.purchased_on || null) !== r.purchased_on) set.purchased_on = f.purchased_on || null
  if ((f.purchased_time || null) !== r.purchased_time) set.purchased_time = f.purchased_time || null
  if ((f.payment_method || null) !== r.payment_method) set.payment_method = f.payment_method || null
  const total = f.total_amount.trim() === '' ? null : Number(f.total_amount)
  if (total !== r.total_amount) set.total_amount = total
  if ((f.note || null) !== r.note) set.note = f.note || null
  const upsert: ReceiptItemPatch[] = []
  const remove: number[] = []
  for (const d of f.items) {
    if (d.item_id === null) {
      if (!d.remove && d.name.trim()) {
        upsert.push({ name: d.name.trim(), amount: Number(d.amount), category: d.category.trim() || null })
      }
      continue
    }
    if (d.remove) {
      remove.push(d.item_id)
      continue
    }
    const orig = r.items.find((i) => i.item_id === d.item_id)
    if (!orig) continue
    const patch: ReceiptItemPatch = { item_id: d.item_id }
    if (d.name.trim() !== orig.name) patch.name = d.name.trim()
    if (Number(d.amount) !== orig.amount) patch.amount = Number(d.amount)
    if ((d.category.trim() || null) !== orig.category) patch.category = d.category.trim() || null
    if (Object.keys(patch).length > 1) upsert.push(patch)
  }
  return { set, upsert, remove }
}

async function save(): Promise<void> {
  const r = receipt.value
  const f = form.value
  if (!r || !f) return
  const { set, upsert, remove } = diff(r, f)
  if (Object.keys(set).length === 0 && upsert.length === 0 && remove.length === 0) {
    form.value = null
    return
  }
  busy.value = true
  error.value = ''
  try {
    const res = await api.updateReceipt(props.ledgerId, r.receipt_id, {
      revision: r.revision,
      ...(Object.keys(set).length ? { set } : {}),
      ...(upsert.length ? { upsert_items: upsert } : {}),
      ...(remove.length ? { delete_item_ids: remove } : {}),
    })
    receipt.value = res.receipt
    form.value = null
    info.value = '保存しました。'
    emit('changed', res.receipt)
  } catch (e) {
    error.value = errorMessage(e)
    if (errorCodeOf(e) === 'stale_revision') {
      form.value = null
      await load()
    }
  } finally {
    busy.value = false
  }
}

async function requestDelete(): Promise<void> {
  if (!receipt.value) return
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    preview.value = await api.deleteReceipt(props.ledgerId, receipt.value.receipt_id, {})
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function confirmDelete(): Promise<void> {
  const p = preview.value
  if (!receipt.value || !p) return
  busy.value = true
  error.value = ''
  try {
    await api.deleteReceipt(props.ledgerId, receipt.value.receipt_id, {
      confirm: true,
      revision: p.revision,
    })
    info.value = '削除しました。90日以内なら復元できます。'
    form.value = null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    preview.value = null
    busy.value = false
    await load()
    if (receipt.value) emit('changed', receipt.value)
  }
}

async function restore(): Promise<void> {
  if (!receipt.value) return
  busy.value = true
  error.value = ''
  try {
    await api.deleteReceipt(props.ledgerId, receipt.value.receipt_id, {
      restore: true,
      revision: receipt.value.revision,
    })
    info.value = '復元しました。'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
    await load()
    if (receipt.value) emit('changed', receipt.value)
  }
}

const labelSlotProps = computed(() => ({
  get receipt(): ReceiptView {
    return receipt.value!
  },
  ledgerId: props.ledgerId,
  canEdit: canEdit.value,
  editing: editing.value,
  applyReceipt,
}))
</script>

<template>
  <div class="receipt-panel-body">
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

    <template v-if="receipt">
      <div
        v-if="receipt.deleted_at"
        class="msg msg-error deleted-banner"
      >
        <span>このレシートは削除済みです（集計に含まれません）。90日以内なら復元できます。</span>
        <button
          class="btn btn-small"
          :disabled="busy"
          data-test="restore"
          @click="restore"
        >
          <AppIcon
            name="undo"
            :size="16"
          />復元
        </button>
      </div>

      <section class="card receipt-head">
        <div>
          <h2
            class="detail-title"
            tabindex="-1"
          >
            <span data-test="store-name"><RouterLink
                                           v-if="receipt.store"
                                           class="store-link"
                                           :to="{ path: `/stores/${receipt.store.store_id}`, query: linkQuery }"
                                         >{{ receipt.store.name }}</RouterLink>
              <template v-else>{{ receipt.store_name_raw ?? '店名なし' }}</template></span>
            <span
              v-if="receipt.deleted_at"
              class="badge badge-danger"
              data-test="deleted"
            >削除済み</span>
          </h2>
          <p class="muted">
            {{ receipt.purchased_on ? dayLabel(receipt.purchased_on) : '日付なし' }} {{ receipt.purchased_time ?? '' }}
          </p>
          <div class="tags">
            <!-- TASK-65: the payment tag filters the receipts list (the
                 store-category tag pattern: the purchase month rides along) -->
            <RouterLink
              v-if="receipt.payment_method"
              class="tag tag-link"
              :to="{ path: '/receipts', query: { payment_method: receipt.payment_method, ...linkQuery } }"
              data-test="payment-method"
            >
              {{ PAYMENT_LABEL[receipt.payment_method] }}
            </RouterLink>
            <RouterLink
              v-if="receipt.store?.category"
              class="tag tag-link"
              :to="{ path: '/stores', query: { store_category: receipt.store.category, ...linkQuery } }"
              data-test="store-category"
            >
              {{ receipt.store.category }}
            </RouterLink>
            <span
              v-if="receipt.has_image"
              class="tag"
            >画像あり</span>
            <!-- TASK-17/26: the labels slot rides at the end of the tags row -->
            <slot
              name="labels"
              v-bind="labelSlotProps"
            />
          </div>
        </div>
        <div class="receipt-total">
          <span class="muted small">合計</span>
          <strong data-test="total">{{ formatYen(receipt.total_amount ?? receipt.items_total) }}</strong>
          <span
            v-if="receipt.total_diff"
            class="warn small"
          >明細合計 {{ formatYen(receipt.items_total) }}（差額 {{ formatYen(receipt.total_diff) }}）</span>
        </div>
      </section>

      <section
        v-if="form"
        class="card"
      >
        <h2>レシートの修正</h2>
        <form
          class="form"
          data-test="edit-form"
          @submit.prevent="save"
        >
          <p class="msg msg-info small">
            修正モードです。保存するまでレシートは変わりません。
          </p>
          <label class="field"><span>店名</span><input
            v-model="form.store_name"
            type="text"
            data-test="f-store"
          ></label>
          <label class="field"><span>購入日</span><input
            v-model="form.purchased_on"
            type="date"
            data-test="f-date"
          ></label>
          <label class="field"><span>時刻</span><input
            v-model="form.purchased_time"
            type="time"
            data-test="f-time"
          ></label>
          <label class="field"><span>支払方法</span>
            <select
              v-model="form.payment_method"
              data-test="f-payment"
            >
              <option value="">未設定</option>
              <option
                v-for="(label, key) in PAYMENT_LABEL"
                :key="key"
                :value="key"
              >{{ label }}</option>
            </select>
          </label>
          <label class="field"><span>印字合計（円）</span><input
            v-model="form.total_amount"
            type="number"
            data-test="f-total"
          ></label>
          <label class="field"><span>メモ</span><textarea
            v-model="form.note"
            rows="2"
            data-test="f-note"
          /></label>
          <h2>明細</h2>
          <div
            v-for="(it, idx) in form.items"
            :key="idx"
            class="item-edit"
            :data-test="`f-item-${idx}`"
          >
            <input
              v-model="it.name"
              type="text"
              aria-label="品名"
              data-test="f-item-name"
            >
            <input
              v-model.number="it.amount"
              type="number"
              aria-label="金額"
              data-test="f-item-amount"
            >
            <input
              v-model="it.category"
              type="text"
              placeholder="大分類/小分類"
              aria-label="カテゴリ"
              data-test="f-item-category"
            >
            <label class="check"><input
              v-model="it.remove"
              type="checkbox"
              data-test="f-item-remove"
            > 削除</label>
          </div>
          <button
            class="btn"
            type="button"
            data-test="add-item"
            @click="addItem"
          >
            明細を追加
          </button>
          <div class="actions">
            <button
              class="btn btn-primary"
              type="submit"
              :disabled="busy"
              data-test="save"
            >
              保存
            </button>
            <button
              class="btn"
              type="button"
              data-test="cancel-edit"
              @click="form = null; preview = null"
            >
              修正をやめる
            </button>
          </div>
        </form>

        <details
          v-if="!receipt.deleted_at"
          class="danger-zone"
          data-test="danger-zone"
        >
          <summary>このレシートを削除する</summary>
          <p class="muted small">
            削除すると集計から外れます。90日以内なら復元できます。
          </p>
          <div
            v-if="preview && preview.preview"
            class="confirm"
            data-test="delete-preview"
          >
            <p>
              {{ preview.preview.purchased_on ?? '日付なし' }} {{ preview.preview.store_name ?? '店名なし' }}（{{ formatYen(preview.preview.amount) }}、明細 {{ preview.preview.item_count }} 行）を削除します。90日以内なら復元できます。
            </p>
            <div class="actions">
              <button
                class="btn btn-danger"
                :disabled="busy"
                data-test="delete-confirm"
                @click="confirmDelete"
              >
                削除する
              </button>
              <button
                class="btn"
                @click="preview = null"
              >
                やめる
              </button>
            </div>
          </div>
          <button
            v-else
            class="btn"
            :disabled="busy"
            data-test="delete"
            @click="requestDelete"
          >
            <AppIcon
              name="trash"
              :size="16"
            />削除の確認へ
          </button>
        </details>
      </section>

      <div
        v-else
        class="receipt-body"
      >
        <section
          class="card"
          data-test="items-card"
        >
          <h2>明細</h2>
          <table
            class="items"
            data-test="items"
          >
            <tbody>
              <tr
                v-for="row in itemRows"
                :key="row.it.item_id"
              >
                <td>
                  {{ row.it.name }}
                  <RouterLink
                    v-if="row.catTo"
                    class="cat-link"
                    :to="row.catTo"
                    :data-test="`item-cat-${row.it.item_id}`"
                  >
                    {{ row.it.category }}
                  </RouterLink>
                  <span
                    v-else
                    class="muted small block"
                  >{{ row.it.category ?? '未分類' }}</span>
                </td>
                <td
                  class="num"
                  :class="{ neg: row.it.amount_incl < 0 }"
                >
                  {{ formatYen(row.it.amount_incl) }}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>明細合計</td>
                <td
                  class="num"
                  data-test="items-total"
                >
                  {{ formatYen(receipt.items_total) }}
                </td>
              </tr>
            </tfoot>
          </table>
          <p
            v-if="receipt.note"
            class="note break"
            data-test="note"
          >
            {{ receipt.note }}
          </p>
        </section>

        <section
          v-if="imageUrl"
          class="card"
        >
          <h2>画像</h2>
          <p
            v-if="imageFailed"
            class="muted small"
            data-test="image-expired"
          >
            画像の表示期限が切れました。
            <button
              class="btn btn-small"
              type="button"
              data-test="image-reload"
              @click="reloadImage"
            >
              再取得
            </button>
          </p>
          <figure
            v-else
            class="receipt-image"
          >
            <img
              :src="imageUrl"
              alt="レシート画像"
              data-test="receipt-image"
              @error="onImageError"
            >
          </figure>
        </section>
      </div>

      <footer
        v-if="!form"
        class="receipt-foot muted small"
      >
        <span>レシート #{{ receipt.receipt_id }} ・ 版 <span data-test="revision">{{ receipt.revision }}</span> ・ 更新 {{ formatDateTime(receipt.updated_at) }}</span>
        <button
          v-if="!receipt.deleted_at"
          class="btn btn-small btn-quiet"
          data-test="edit"
          @click="startEdit"
        >
          <AppIcon
            name="pencil"
            :size="14"
          />内容を修正
        </button>
      </footer>
    </template>
  </div>
</template>
