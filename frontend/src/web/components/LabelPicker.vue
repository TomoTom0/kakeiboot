<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import LabelDots from '@/shared/components/LabelDots.vue'
import { LABEL_COLORS, labelColorsOf, type Label, type LabelColor } from '@/shared/labels'
import { useDataApi, type ReceiptView } from '../api/data'
import AppIcon from './AppIcon.vue'
import LabelToggleGroup from './LabelToggleGroup.vue'
import PopoverPanel from './PopoverPanel.vue'
import { useLabelsStore } from '../stores/labels'

// Label picker in the ReceiptPanel labels slot (TASK-17, reshaped in
// TASK-26 2-3): the assigned labels show as LabelChip list at the end of
// the tags row; a small tag-plus button (canEdit only) opens a PopoverPanel
// with the five-label toggle group. The display always shows `desired`
// (the user's intent); sends are serialized per receipt (one request at a
// time, consecutive taps compose into a single diff) and a macrotask
// debounce keeps taps issued in quick succession on one request. A
// response updates `confirmed` only (never `desired`) and is written back
// through applyReceipt with the panel's latest receipt, so a content edit
// saved while a label request is in flight keeps its revision (labels never
// bump it). TASK-51: a selection closes the popover — the chip animating
// into the tags row is the confirmation — and the focus returns to the
// trigger (PopoverPanel's own focus return only runs on its Escape /
// outside close, so the picker focuses its trigger itself). A failure of an
// already-closed popover shows as the warning badge on the button (with a
// visually-hidden note) and reappears in the popover once reopened. While
// editing the form the button is disabled; the request in flight and the
// queued diff still run to completion.
const props = defineProps<{
  receipt: ReceiptView
  ledgerId: number
  canEdit: boolean
  editing: boolean
  applyReceipt: (next: ReceiptView) => void
}>()

const api = useDataApi()
const labelsStore = useLabelsStore()
void labelsStore.load(props.ledgerId)

const open = ref(false)
const confirmed = ref<LabelColor[]>(labelColorsOf(props.receipt.labels))
const desired = ref<LabelColor[]>(labelColorsOf(props.receipt.labels))
const sending = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const addBtnEl = ref<HTMLButtonElement | null>(null)

function titles(): Record<LabelColor, string | null> {
  const out = {} as Record<LabelColor, string | null>
  for (const l of labelsStore.definitions(props.ledgerId)) out[l.color] = l.title
  return out
}
const titleOf = (c: LabelColor): string | null => titles()[c] ?? null

/** Current labels as Label[] (desired state, titled when known). */
const currentLabels = computed<Label[]>(() =>
  desired.value.map((c) => ({ color: c, title: titleOf(c) })),
)

const definitions = computed(() => labelsStore.definitions(props.ledgerId))

/** Opening is refused while the receipt form is being edited (the trigger
 * button is disabled; this also guards synthetic clicks on it). */
function onOpenChange(v: boolean): void {
  open.value = v && props.editing ? false : v
}

function toggle(c: LabelColor): void {
  if (!props.canEdit || props.editing) return
  desired.value = desired.value.includes(c) ? desired.value.filter((x) => x !== c) : [...desired.value, c]
  error.value = ''
  scheduleSend()
  // TASK-51: the selection closes the popover and the focus goes back to
  // the trigger — the toggle button unmounts with the dialog, so without
  // this the focus would drop to the body
  open.value = false
  void nextTick(() => addBtnEl.value?.focus())
}

/** Debounce across one macrotask: taps within the same burst compose. */
function scheduleSend(): void {
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null
      void pump()
    }, 0)
  }
}

async function pump(): Promise<void> {
  if (sending.value) return
  const add = desired.value.filter((c) => !confirmed.value.includes(c))
  const remove = confirmed.value.filter((c) => !desired.value.includes(c))
  if (add.length === 0 && remove.length === 0) return
  const input: { add?: LabelColor[]; remove?: LabelColor[] } = {}
  if (add.length > 0) input.add = add
  if (remove.length > 0) input.remove = remove
  const sentColors = [...add, ...remove]
  sending.value = true
  try {
    const res = await api.setReceiptLabels(props.ledgerId, props.receipt.receipt_id, input)
    confirmed.value = labelColorsOf(res.labels)
    // write back on the panel's latest receipt: a save that landed in the
    // meantime keeps its revision (the response carries no newer one)
    props.applyReceipt({ ...props.receipt, labels: res.labels })
  } catch {
    error.value = 'ラベルを変更できませんでした。もう一度操作してください。'
    // The request fails as a whole with no per-color detail: roll every color
    // of the request back to the confirmed values (design 2-5); colors with
    // changes not yet sent keep their intent.
    const keep = new Set(desired.value.filter((c) => !sentColors.includes(c)))
    for (const c of sentColors) if (confirmed.value.includes(c)) keep.add(c)
    desired.value = LABEL_COLORS.filter((c) => keep.has(c))
    return // no automatic retry of a failed change; the next tap restarts
  } finally {
    sending.value = false
  }
  scheduleSend() // a diff queued while the request was in flight
}

// Resync from the panel's receipt when idle: a content save returns a view
// whose labels are the server truth. Pending (unsent / failed) intent is
// never clobbered.
watch(
  () => props.receipt.labels,
  (labels) => {
    if (sending.value) return
    if (desired.value.join() !== confirmed.value.join()) return
    const next = labelColorsOf(labels)
    if (next.join() !== desired.value.join()) {
      confirmed.value = next
      desired.value = next
    }
  },
)

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null
})
</script>

<template>
  <div
    class="label-picker"
    data-test="label-picker"
  >
    <LabelDots :labels="canEdit ? currentLabels : (receipt.labels ?? [])" />
    <PopoverPanel
      v-if="canEdit"
      :open="open"
      variant="anchored"
      label="ラベルの選択"
      class="label-picker-pop"
      @update:open="onOpenChange"
    >
      <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
        <button
          ref="addBtnEl"
          type="button"
          class="label-add-btn"
          :aria-expanded="expanded"
          :aria-controls="controls"
          aria-label="ラベルを付ける・外す"
          :disabled="editing"
          data-test="label-add"
        >
          <AppIcon
            name="tag-plus"
            :size="16"
          />
          <span
            v-if="error && !open"
            class="label-add-badge"
            aria-hidden="true"
          />
          <span
            v-if="error && !open"
            class="sr-only"
          >ラベルの変更に失敗しています</span>
        </button>
      </template>
      <p
        v-if="error"
        class="label-error"
        role="alert"
        data-test="label-error"
      >
        {{ error }}
      </p>
      <LabelToggleGroup
        group-label="ラベル"
        :selected="desired"
        :definitions="definitions"
        :disabled="editing"
        @toggle="toggle"
      />
    </PopoverPanel>
  </div>
</template>
