<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon, { type IconName } from '../../components/AppIcon.vue'
import { useDataApi } from '../../api/data'
import { ApiError } from '../../api/http'
import { errorMessage } from '../../composables/format'
import { useSessionStore } from '../../stores/session'

// Data tab: links into the manage screens (the screens themselves keep their
// existing URLs; this tab is the way back) and the TASK-58 data card — export
// one own ledger as a JSON file, import an export file as a fresh ledger.
// This is the user-facing data takeout / restore path, not the operator
// backup (docs/deploy.md): role checks are the backend's (any membership can
// export — the same data the read APIs already show; import needs a session).
const session = useSessionStore()
const api = useDataApi()

interface ManageLink {
  to: string
  key: string
  label: string
  desc: string
  icon: IconName
}

const LINKS: ManageLink[] = [
  {
    to: '/settings/categories',
    key: 'categories',
    label: 'カテゴリ',
    desc: '品目・店カテゴリの追加・改名・移動・アーカイブ',
    icon: 'tag',
  },
  { to: '/settings/stores', key: 'stores', label: '店', desc: '店名・種別の変更と統合', icon: 'store' },
  { to: '/settings/labels', key: 'labels', label: 'ラベルの管理', desc: 'ラベルの名前を付ける', icon: 'tag' },
]

// --- export ---------------------------------------------------------------

const ledgers = computed(() => session.me?.ledgers ?? [])
const exportId = ref<number | null>(null)
const exportBusy = ref(false)
const exportMsg = ref<{ role: 'status' | 'alert'; text: string } | null>(null)

// keep a valid selection when the membership list changes (post-import me
// refresh): fall back to the first own ledger
const exportTarget = computed({
  get: () =>
    exportId.value !== null && ledgers.value.some((l) => l.id === exportId.value)
      ? exportId.value
      : (ledgers.value[0]?.id ?? null),
  set: (v: number | null) => {
    exportId.value = v
  },
})

/** kakeiboot-<name>-<YYYYMMDD-HHmm>.json (JST stamp; name filesystem-safe). */
function downloadName(ledgerName: string, now = new Date()): string {
  const safe = ledgerName.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'ledger'
  const jst = new Date(now.getTime() + 9 * 3_600_000)
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${jst.getUTCFullYear()}${p(jst.getUTCMonth() + 1)}${p(jst.getUTCDate())}-${p(jst.getUTCHours())}${p(jst.getUTCMinutes())}`
  return `kakeiboot-${safe}-${stamp}.json`
}

async function runExport(): Promise<void> {
  const id = exportTarget.value
  if (id === null || exportBusy.value) return
  exportBusy.value = true
  exportMsg.value = null
  try {
    const blob = await api.exportLedger(id)
    const name = ledgers.value.find((l) => l.id === id)?.name ?? 'ledger'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = downloadName(name)
    a.click()
    URL.revokeObjectURL(url)
    exportMsg.value = { role: 'status', text: '書き出しました。ダウンロードされたファイルを保存してください。' }
  } catch (e) {
    exportMsg.value = {
      role: 'alert',
      text:
        e instanceof ApiError && e.code === 'export_too_large'
          ? 'データが大きすぎて書き出せませんでした。画像が多い場合は家計簿を分けるか、運用者に相談してください。'
          : errorMessage(e),
    }
  } finally {
    exportBusy.value = false
  }
}

// --- import ---------------------------------------------------------------

const importFile = ref<File | null>(null)
const importBusy = ref(false)
const importMsg = ref<{ role: 'status' | 'alert'; text: string } | null>(null)
const importInput = ref<HTMLInputElement | null>(null)

function onFileChange(e: Event): void {
  importFile.value = (e.target as HTMLInputElement).files?.[0] ?? null
  importMsg.value = null
}

function importErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'import_invalid') {
    return 'ファイル形式が正しくありません（kakeibootの書き出しファイルを選んでください）。'
  }
  if (e instanceof ApiError && (e.code === 'import_too_large' || e.code === 'http_413')) {
    return 'データが大きすぎます。分割するか運用者に相談してください。'
  }
  return errorMessage(e)
}

async function runImport(): Promise<void> {
  const file = importFile.value
  if (file === null || importBusy.value) return
  importBusy.value = true
  importMsg.value = null
  try {
    let payload: unknown
    try {
      payload = JSON.parse(await file.text())
    } catch {
      payload = null
    }
    const res = await api.importLedger(payload)
    // a fresh me fetch carries the new membership to the ledger switcher
    await session.loadMe()
    importMsg.value = {
      role: 'status',
      text: `${res.ledger.name}を取り込みました（${res.counts.receipts}件のレシート）。上部の家計簿切替から選べます。`,
    }
    importFile.value = null
    if (importInput.value) importInput.value.value = ''
  } catch (e) {
    importMsg.value = { role: 'alert', text: importErrorText(e) }
  } finally {
    importBusy.value = false
  }
}
</script>

<template>
  <div class="settings-panel">
    <section class="card">
      <h2>データの管理</h2>
      <ul class="settings-manage-links">
        <li
          v-for="l in LINKS"
          :key="l.key"
        >
          <RouterLink
            :to="l.to"
            class="settings-manage-link"
            :data-test="`settings-data-${l.key}`"
          >
            <AppIcon :name="l.icon" />
            <span class="settings-manage-link-text">
              <strong>{{ l.label }}</strong>
              <span class="muted small">{{ l.desc }}</span>
            </span>
          </RouterLink>
        </li>
      </ul>
    </section>

    <section
      class="card"
      data-test="data-io"
    >
      <h2>データの書き出し・取り込み</h2>
      <p class="muted small">
        家計簿1冊をファイルに書き出し、別の環境や削除前のバックアップから取り込めます。取り込みは常に新しい家計簿として復元します（今ある家計簿には影響しません）。
      </p>
      <div class="io-row">
        <h3>書き出し</h3>
        <div class="io-form">
          <label class="io-field">
            <span>家計簿</span>
            <select
              v-model.number="exportTarget"
              data-test="export-ledger"
              :disabled="exportBusy || ledgers.length === 0"
            >
              <option
                v-for="l in ledgers"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select>
          </label>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="exportBusy || exportTarget === null"
            data-test="export-run"
            @click="runExport"
          >
            {{ exportBusy ? '書き出し中…' : '書き出す' }}
          </button>
        </div>
        <p
          v-if="exportMsg"
          class="msg"
          :class="exportMsg.role === 'alert' ? 'msg-error' : 'msg-info'"
          :role="exportMsg.role"
          data-test="export-msg"
        >
          {{ exportMsg.text }}
        </p>
      </div>
      <div class="io-row">
        <h3>取り込み</h3>
        <div class="io-form">
          <label class="io-field">
            <span>書き出しファイル</span>
            <input
              ref="importInput"
              type="file"
              accept="application/json,.json"
              data-test="import-file"
              :disabled="importBusy"
              @change="onFileChange"
            >
          </label>
          <button
            class="btn"
            type="button"
            :disabled="importBusy || importFile === null"
            data-test="import-run"
            @click="runImport"
          >
            {{ importBusy ? '取り込み中…' : '取り込む' }}
          </button>
        </div>
        <p
          v-if="importMsg"
          class="msg"
          :class="importMsg.role === 'alert' ? 'msg-error' : 'msg-info'"
          :role="importMsg.role"
          data-test="import-msg"
        >
          {{ importMsg.text }}
        </p>
      </div>
    </section>
  </div>
</template>
