<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { LabelColor } from '@/shared/labels'
import { LABEL_COLORS, LABEL_NAME, MAX_LABEL_TITLE_CHARS } from '@/shared/labels'
import { useDataApi } from '../api/data'
import { charCount, errorMessage } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { useLabelsStore } from '../stores/labels'
import { useSessionStore } from '../stores/session'

// Label management (TASK-17, /settings/labels): the five fixed color rows
// with an optional title each (1..MAX_LABEL_TITLE_CHARS chars, empty = color
// only). Viewers see the rows read-only. Titles are shared by the whole ledger.
const api = useDataApi()
const session = useSessionStore()
const labelsStore = useLabelsStore()

const drafts = reactive<Record<LabelColor, string>>({ red: '', yellow: '', green: '', blue: '', purple: '' })
const rowError = reactive<Record<LabelColor, string>>({ red: '', yellow: '', green: '', blue: '', purple: '' })
const savedAt = reactive<Record<LabelColor, string>>({ red: '', yellow: '', green: '', blue: '', purple: '' })

const ledgerId = useLedger((id) => void labelsStore.load(id))
const rows = computed(() => labelsStore.definitions(ledgerId.value ?? -1))
const titleOf = (c: LabelColor): string | null => rows.value.find((l) => l.color === c)?.title ?? null

// Seed the inputs from the fetched definitions once. Only the real cache
// seeds (not the color-only fallback `definitions` returns before the fetch
// settles), so a direct visit shows the existing titles in the inputs
// instead of empty ones that would clear the title on save.
const seeded = ref(false)
watch(
  () => labelsStore.cached(ledgerId.value ?? -1),
  (defs) => {
    if (seeded.value || defs === null) return
    seeded.value = true
    for (const l of defs) drafts[l.color] = l.title ?? ''
  },
  { immediate: true },
)

// Title editing needs editor or above in this ledger; viewers stay read-only.
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})

async function save(color: LabelColor): Promise<void> {
  if (ledgerId.value === null) return
  const l = ledgerId.value
  const title = drafts[color].trim()
  rowError[color] = ''
  savedAt[color] = ''
  if (charCount(title) > MAX_LABEL_TITLE_CHARS) {
    rowError[color] = `タイトルは${MAX_LABEL_TITLE_CHARS}文字以内で入力してください。`
    return
  }
  try {
    await api.updateLabelTitle(l, color, { title: title === '' ? null : title })
    labelsStore.rename(l, color, title === '' ? null : title)
    savedAt[color] = '保存しました。'
  } catch (e) {
    rowError[color] = errorMessage(e)
  }
}
</script>

<template>
  <div class="view-page">
    <section class="card">
      <h2>ラベル</h2>
      <p class="muted small">
        レシートに付けられる色ラベルです。タイトルは付けなくても使えます。タイトルは家計簿の全員で共有されます。
      </p>
      <ul class="rows label-rows">
        <li
          v-for="c in LABEL_COLORS"
          :key="c"
          class="row label-row"
          :data-test="`label-row-${c}`"
        >
          <span
            class="label-dot label-dot-lg"
            :class="`label-${c}`"
            aria-hidden="true"
          />
          <div class="row-main">
            <strong>{{ LABEL_NAME[c] }}</strong>
            <span class="muted small">{{ titleOf(c) ?? 'タイトルなし' }}</span>
            <template v-if="canEdit">
              <input
                v-model="drafts[c]"
                type="text"
                :aria-label="`${LABEL_NAME[c]}のタイトル`"
                :data-test="`label-title-${c}`"
              >
              <button
                class="btn btn-small"
                :data-test="`label-save-${c}`"
                @click="save(c)"
              >
                保存
              </button>
            </template>
          </div>
          <p
            v-if="rowError[c]"
            class="msg msg-error small"
            role="alert"
            :data-test="`label-error-${c}`"
          >
            {{ rowError[c] }}
          </p>
          <p
            v-else-if="savedAt[c]"
            class="msg msg-info small"
          >
            {{ savedAt[c] }}
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>
