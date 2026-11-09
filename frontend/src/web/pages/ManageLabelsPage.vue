<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { labelAriaName, LABEL_COLORS, MAX_LABEL_TITLE_CHARS, type LabelColor } from '@/shared/labels'
import LabelChip from '@/shared/components/LabelChip.vue'
import { useDataApi } from '../api/data'
import { charCount, errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { useLabelsStore } from '../stores/labels'
import { useSessionStore } from '../stores/session'
import AppIcon from '../components/AppIcon.vue'
import IconButton from '../components/IconButton.vue'

// Label management (TASK-17, redesigned in TASK-26 2-5, /settings/labels):
// the five labels as a plain list of LabelChips (no color names, no
// "unnamed" text — an untitled label is just its color chip). Pressing a
// row turns that row alone into the editor (chip + name input + save /
// cancel; Enter saves, Escape cancels); only one row edits at a time and
// pressing another row with unsaved input is blocked once with a notice
// before the switch discards it. An empty save returns the label to
// untitled. Viewers see the chips read-only (rows are not pressable).
const api = useDataApi()
const session = useSessionStore()
const labelsStore = useLabelsStore()

const rootEl = ref<HTMLElement | null>(null)
const rowError = ref<Partial<Record<LabelColor, string>>>({})
const savedAt = ref<Partial<Record<LabelColor, string>>>({})
const editingColor = ref<LabelColor | null>(null)
const draftTitle = ref('')
// one-time guard: pressing another row with unsaved input first shows the
// notice; the next press goes through (discarding the draft)
const blocked = ref(false)

const ledgerId = useLedger((id) => void labelsStore.load(id))
const rows = computed(() => labelsStore.definitions(ledgerId.value ?? -1))
const titleOf = (c: LabelColor): string | null => rows.value.find((l) => l.color === c)?.title ?? null
const indexOf = (c: LabelColor): number => LABEL_COLORS.indexOf(c)
const ariaName = (c: LabelColor): string => labelAriaName({ color: c, title: titleOf(c) }, indexOf(c))

// Rows stay read-only until the real definitions arrive: pressing a row
// before that would seed the input from the color-only fallback and saving
// could clear an existing name unnoticed.
const loaded = computed(() => labelsStore.cached(ledgerId.value ?? -1) !== null)

// Name editing needs editor or above in this ledger; viewers stay read-only.
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})

function isDirty(): boolean {
  const c = editingColor.value
  if (c === null) return false
  return draftTitle.value !== (titleOf(c) ?? '')
}

function beginEdit(c: LabelColor): void {
  if (!canEdit.value || !loaded.value || editingColor.value === c) return
  if (isDirty() && !blocked.value) {
    blocked.value = true
    return
  }
  editingColor.value = c
  draftTitle.value = titleOf(c) ?? ''
  blocked.value = false
  rowError.value[c] = ''
  void nextTick(() => {
    rootEl.value?.querySelector<HTMLInputElement>(`[data-test="label-title-${c}"]`)?.focus()
  })
}

function endEdit(): void {
  const c = editingColor.value
  editingColor.value = null
  blocked.value = false
  if (c === null) return
  void nextTick(() => {
    rootEl.value?.querySelector<HTMLButtonElement>(`[data-test="label-edit-${c}"]`)?.focus()
  })
}

async function save(c: LabelColor): Promise<void> {
  if (ledgerId.value === null) return
  const l = ledgerId.value
  const title = draftTitle.value.trim()
  rowError.value[c] = ''
  savedAt.value[c] = ''
  if (charCount(title) > MAX_LABEL_TITLE_CHARS) {
    rowError.value[c] = `名前は${MAX_LABEL_TITLE_CHARS}文字以内で入力してください。`
    return
  }
  try {
    await api.updateLabelTitle(l, c, { title: title === '' ? null : title })
    labelsStore.rename(l, c, title === '' ? null : title)
    savedAt.value[c] = '保存しました。'
    endEdit()
  } catch (e) {
    rowError.value[c] = errorMessage(e)
  }
}
</script>

<template>
  <div class="view-page">
    <section
      ref="rootEl"
      class="card"
    >
      <h2>ラベル</h2>
      <p class="muted small">
        レシートに付けるラベルです（家計簿ごとに5個）。名前は任意で、家計簿の全員で共有されます。
      </p>
      <ul class="rows label-rows">
        <li
          v-for="l in rows"
          :key="l.color"
          class="row label-row"
          :data-test="`label-row-${l.color}`"
        >
          <button
            v-if="canEdit && editingColor !== l.color"
            type="button"
            class="label-row-btn"
            :aria-label="`${ariaName(l.color)}の名前を変更`"
            :disabled="!loaded"
            :data-test="`label-edit-${l.color}`"
            @click="beginEdit(l.color)"
          >
            <LabelChip
              :label="l"
              :index="indexOf(l.color)"
            />
            <AppIcon
              class="label-row-pencil"
              name="pencil"
              :size="16"
            />
          </button>
          <!-- TASK-146 §3 #20: the inline editor swap appears / vanishes
               through the shared bb-appear grammar (the row's own chips and
               buttons keep their layout — .row-editor is the shared flex
               wrapper) -->
          <Transition name="bb-appear">
            <div
              v-if="editingColor === l.color"
              class="row-editor"
            >
              <LabelChip
                :label="l"
                :index="indexOf(l.color)"
              />
              <input
                v-model="draftTitle"
                type="text"
                :aria-label="`${ariaName(l.color)}の名前`"
                :data-test="`label-title-${l.color}`"
                @keydown.enter.prevent="save(l.color)"
                @keydown.esc.prevent="endEdit"
              >
              <IconButton
                icon="check"
                label="保存"
                variant="primary"
                :test="`label-save-${l.color}`"
                @click="save(l.color)"
              />
              <IconButton
                icon="close"
                label="やめる"
                :test="`label-cancel-${l.color}`"
                @click="endEdit"
              />
            </div>
          </Transition>
          <LabelChip
            v-if="!canEdit && editingColor !== l.color"
            :label="l"
            :index="indexOf(l.color)"
          />
          <p
            v-if="editingColor === l.color && blocked"
            class="msg msg-error small label-unsaved"
            role="alert"
            data-test="label-unsaved"
          >
            保存されていません
          </p>
          <p
            v-if="rowError[l.color]"
            class="msg msg-error small"
            role="alert"
            :data-test="`label-error-${l.color}`"
          >
            {{ rowError[l.color] }}
          </p>
          <p
            v-else-if="savedAt[l.color]"
            class="msg msg-info small"
            role="status"
          >
            {{ savedAt[l.color] }}
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
