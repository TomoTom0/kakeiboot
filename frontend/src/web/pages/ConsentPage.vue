<script setup lang="ts">
import AppIcon from '../components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { oauthApi, type ConsentInfo } from '../api/auth'
import { ApiError } from '../api/http'
import { errorMessage } from '../composables/format'
import { isFramed } from '../composables/frame'
import { externalNav } from '../composables/navigate'

// OAuth consent (spec_auth.md 4-2, 4-6): shown every time; the fixed client
// name with the client_id URL, scope descriptions, the first ledger the
// connection will use, the user, and allow / deny.
const route = useRoute()
const router = useRouter()
const req = typeof route.query.req === 'string' ? route.query.req : ''
const framed = isFramed()
const info = ref<ConsentInfo | null>(null)
const loading = ref(true)
const expired = ref(false)
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  if (framed) {
    loading.value = false
    return
  }
  if (!req) {
    expired.value = true
    loading.value = false
    return
  }
  try {
    info.value = await oauthApi.consentInfo(req)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await router.replace({ path: '/login', query: { req } })
      return
    }
    if (e instanceof ApiError && e.status === 404) expired.value = true
    else error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

async function decide(decision: 'allow' | 'deny'): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const res = await oauthApi.decision(req, decision)
    externalNav.assign(res.redirect_to)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await router.replace({ path: '/login', query: { req } })
      return
    }
    error.value = errorMessage(e)
    busy.value = false
  }
}
</script>

<template>
  <section class="auth">
    <div class="auth-logo">
      <BrandLogo
        variant="full"
        :height="34"
      />
    </div>
    <div class="auth-hero auth-hero-sm">
      <AppIcon
        name="link"
        :size="40"
      />
    </div>
    <h1>接続の許可</h1>
    <div class="card auth-card">
      <p
        v-if="framed"
        class="msg msg-error"
        data-test="framed"
      >
        この画面は埋め込み表示では利用できません。ブラウザで直接開いてください。
      </p>
      <p v-else-if="loading">
        読み込んでいます...
      </p>
      <p
        v-else-if="expired"
        class="msg msg-error"
        data-test="expired"
      >
        この接続要求は無効か期限切れです。もう一度接続してください。
      </p>
      <div
        v-else-if="info"
        data-test="consent"
      >
        <p class="lead">
          <strong data-test="client-display">{{ info.client_display }}</strong> が kakeiboot への接続を求めています。
        </p>
        <p
          class="muted small break"
          data-test="client-id"
        >
          {{ info.client_id }}
        </p>
        <h2>許可する内容</h2>
        <ul
          class="list"
          data-test="scopes"
        >
          <li
            v-for="s in info.scopes"
            :key="s.name"
          >
            {{ s.description }} <span class="muted small">({{ s.name }})</span>
          </li>
        </ul>
        <dl class="kv">
          <dt>最初の接続先の家計簿</dt>
          <dd data-test="ledger-name">
            <span
              v-if="info.ledger_color"
              class="ledger-chip"
              :style="{ background: `var(--ledger-${info.ledger_color})` }"
            ><AppIcon
              name="book"
              :size="14"
            /></span>{{ info.ledger_name ?? '未選択' }}
          </dd>
          <dt>ログイン中のユーザー</dt>
          <dd data-test="user-display-name">
            {{ info.user_display_name }}
          </dd>
        </dl>
        <p
          class="muted small"
          data-test="ledger-note"
        >
          接続後に {{ info.client_display }} から家計簿を切り替えられます。
        </p>
        <div class="actions actions-fill">
          <button
            class="btn"
            :disabled="busy"
            data-test="deny"
            @click="decide('deny')"
          >
            拒否
          </button>
          <button
            class="btn btn-primary"
            :disabled="busy"
            data-test="allow"
            @click="decide('allow')"
          >
            許可
          </button>
        </div>
      </div>
      <p
        v-if="error"
        class="msg msg-error"
        role="alert"
        data-test="error"
      >
        {{ error }}
      </p>
    </div>
  </section>
</template>
