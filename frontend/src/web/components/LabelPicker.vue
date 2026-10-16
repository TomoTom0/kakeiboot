<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import LabelDots from '@/shared/components/LabelDots.vue'
import { LABEL_COLORS, LABEL_NAME, labelColorsOf, labelText, type Label, type LabelColor } from '@/shared/labels'
import { useDataApi, type ReceiptView } from '../api/data'
import { useLabelsStore } from '../stores/labels'

// Label picker in the ReceiptPanel labels slot (TASK-17): five immediate
// toggles on the viewing panel. The display always shows `desired` (the
// user's intent); sends are serialized per receipt (one request at a time,
// consecutive taps compose into a single diff) and a macrotask debounce
// keeps taps issued in quick succession on one request. A response updates
// `confirmed` only (never `desired`) and is written back through
// applyReceipt with the panel's latest receipt, so a content edit saved
// while a label request is in flight keeps its revision (labels never bump
// it). While editing the form the toggles are disabled; the request in
// flight and the queued diff still run to completion.
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

const confirmed = ref<LabelColor[]>(labelColorsOf(props.receipt.labels))
const desired = ref<LabelColor[]>(labelColorsOf(props.receipt.labels))
const sending = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

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

function toggle(c: LabelColor): void {
  if (!props.canEdit || props.editing) return
  desired.value = desired.value.includes(c) ? desired.value.filter((x) => x !== c) : [...desired.value, c]
  error.value = ''
  scheduleSend()
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
    <template v-if="canEdit">
      <span
        class="label-picker-controls"
        role="group"
        aria-label="ラベル"
      >
        <button
          v-for="c in LABEL_COLORS"
          :key="c"
          type="button"
          class="label-toggle"
          :class="[`label-${c}`, { on: desired.includes(c) }]"
          :aria-pressed="desired.includes(c)"
          :aria-label="labelText({ color: c, title: titleOf(c) })"
          :disabled="editing"
          :data-test="`label-toggle-${c}`"
          @click="toggle(c)"
        >{{ LABEL_NAME[c] }}<span
          v-if="titleOf(c)"
          class="label-toggle-title"
        >{{ titleOf(c) }}</span></button>
      </span>
      <LabelDots
        :labels="currentLabels"
        compact
      />
      <RouterLink
        to="/settings/labels"
        class="label-edit-link"
        data-test="label-edit-link"
      >
        タイトルを編集
      </RouterLink>
      <p
        v-if="error"
        class="label-error"
        role="alert"
        data-test="label-error"
      >
        {{ error }}
      </p>
    </template>
    <LabelDots
      v-else
      :labels="receipt.labels ?? []"
    />
  </div>
</template>
