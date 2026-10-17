<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { oauthApi, type Grant } from '../api/auth'
import { errorMessage, formatDateTime } from '../composables/format'
import { useSessionStore } from '../stores/session'

// Connected apps (spec_auth.md 4-11, 6-1, 6-2): grant list with the
// selected ledger of each connection, revocation, and the ledger switch.
const session = useSessionStore()
const grants = ref<Grant[]>([])
const loading = ref(true)
const error = ref('')
const info = ref('')
const busy = ref(false)
const revokingId = ref<number | null>(null)
const switchTo = ref<Record<number, number | null>>({})

const SCOPE_LABEL: Record<string, string> = {
  'ledger.read': '家計簿の閲覧',
  'ledger.write': '家計簿の記録・編集',
}

function scopeText(scope: string): string {
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => SCOPE_LABEL[s] ?? s)
    .join('、')
}

async function reload(): Promise<void> {
  try {
    grants.value = await oauthApi.listGrants()
    switchTo.value = Object.fromEntries(grants.value.map((g) => [g.id, g.active_ledger_id]))
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

onMounted(reload)

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  info.value = ''
  try {
    await task()
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function revoke(id: number): Promise<void> {
  return run(async () => {
    await oauthApi.revokeGrant(id)
    revokingId.value = null
    grants.value = grants.value.filter((g) => g.id !== id)
    info.value = '接続を解除しました。'
  })
}

function switchLedger(g: Grant): Promise<void> {
  return run(async () => {
    const target = switchTo.value[g.id]
    if (target === null || target === undefined) return
    const res = await oauthApi.switchActiveLedger(g.id, target)
    g.active_ledger_id = res.ledger.id
    g.active_ledger_name = res.ledger.name
    info.value = `接続先の家計簿を「${res.ledger.name}」に切り替えました。`
  })
}
</script>

<template>
  <section class="card">
    <p class="muted small">
      ChatGPT などから kakeiboot に接続している一覧です。家計簿の切替はその接続でのみ有効で、web 画面の表示には影響しません。
    </p>
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
    <div
      v-if="loading"
      class="card skeleton"
      aria-hidden="true"
      data-test="loading"
    >
      <p class="sr-only">
        読み込んでいます...
      </p>
      <span class="sk sk-label" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </div>
    <p
      v-else-if="grants.length === 0"
      data-test="empty"
    >
      接続中のアプリはありません。
    </p>
    <RouterLink
      v-if="!loading && grants.length === 0"
      to="/usage/connect"
      class="more"
      data-test="usage-link"
    >
      ChatGPTとの接続方法を見る
    </RouterLink>
    <ul
      v-else
      class="rows"
    >
      <li
        v-for="g in grants"
        :key="g.id"
        class="row column"
        :data-test="`grant-${g.id}`"
      >
        <div>
          <strong>{{ g.client_display }}</strong>
          <span class="muted small block break">{{ g.client_id }}</span>
        </div>
        <dl class="kv">
          <dt>許可</dt>
          <dd>{{ scopeText(g.scope) }}</dd>
          <dt>選択中の家計簿</dt>
          <dd data-test="active-ledger">
            {{ g.active_ledger_name ?? '未選択' }}
          </dd>
          <dt>接続日時</dt>
          <dd>{{ formatDateTime(g.created_at) }}</dd>
          <dt>最終利用</dt>
          <dd>{{ formatDateTime(g.last_used_at) }}</dd>
        </dl>
        <div class="inline-form">
          <select
            v-model="switchTo[g.id]"
            aria-label="切り替え先の家計簿"
            data-test="switch-select"
          >
            <option
              :value="null"
              disabled
            >
              家計簿を選択
            </option>
            <option
              v-for="l in session.me?.ledgers ?? []"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </select>
          <button
            class="btn"
            :disabled="busy"
            data-test="switch"
            @click="switchLedger(g)"
          >
            切り替え
          </button>
        </div>
        <div class="actions">
          <template v-if="revokingId === g.id">
            <span class="small">この接続を解除しますか？ ChatGPT から再度接続するまで利用できなくなります。</span>
            <button
              class="btn btn-danger"
              :disabled="busy"
              data-test="revoke-confirm"
              @click="revoke(g.id)"
            >
              解除する
            </button>
            <button
              class="btn"
              @click="revokingId = null"
            >
              やめる
            </button>
          </template>
          <button
            v-else
            class="btn"
            data-test="revoke"
            @click="revokingId = g.id"
          >
            接続を解除
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>
