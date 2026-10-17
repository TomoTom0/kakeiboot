<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authApi, type RegisterInfo } from '../api/auth'
import { ApiError } from '../api/http'
import { createPasskey, isCancel } from '../api/webauthn'
import { charCount, errorMessage } from '../composables/format'
import { useSessionStore } from '../stores/session'
import AppIcon from '../components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'

// Registration landing for setup / invite / register / recovery URLs
// (spec_auth.md 2-1, 2-3, 3-2). The token is read once, removed from the
// URL with a history replace, and only sent in POST bodies afterwards.
const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const token = typeof route.query.token === 'string' ? route.query.token : ''

const info = ref<RegisterInfo | null>(null)
const loading = ref(true)
const invalid = ref(false)
const error = ref('')
const busy = ref(false)
const displayName = ref('')
const label = ref('')
const useInvitedDefault = ref(true)

const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', editor: '編集', viewer: '閲覧のみ' }
const title = computed(() =>
  info.value?.kind === 'recovery' ? 'パスキーの再登録' : 'アカウント登録',
)

onMounted(async () => {
  if ('token' in route.query) await router.replace({ path: '/register', query: {} })
  if (!token) {
    invalid.value = true
    loading.value = false
    return
  }
  try {
    info.value = await authApi.registerInfo(token)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_token') invalid.value = true
    else error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

async function submit(): Promise<void> {
  if (!info.value) return
  error.value = ''
  const name = displayName.value.trim()
  if (info.value.needs_display_name && (name === '' || charCount(name) > 100)) {
    error.value = '表示名は1〜100文字で入力してください。'
    return
  }
  if (charCount(label.value.trim()) > 100) {
    error.value = 'パスキーの名前は100文字以内で入力してください。'
    return
  }
  busy.value = true
  try {
    const ccr = await authApi.registerStart(token, info.value.needs_display_name ? name : undefined)
    const credential = await createPasskey(ccr)
    await authApi.registerFinish({
      credential,
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(info.value.kind === 'invite' ? { use_invited_ledger_as_default: useInvitedDefault.value } : {}),
    })
    // Settle the session BEFORE navigating so the shell mounts together with
    // the home route (TASK-39 A-2; login/finish response has no user).
    await session.loadMe()
    await router.replace('/')
  } catch (e) {
    error.value = isCancel(e) ? 'パスキーの作成が完了しませんでした。もう一度お試しください。' : errorMessage(e)
  } finally {
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
    <p class="auth-tagline">
      レシートを送るだけの家計簿
    </p>
    <div class="auth-hero">
      <AppIcon
        :name="info?.kind === 'recovery' ? 'key' : 'user'"
        :size="48"
      />
    </div>
    <h1>{{ title }}</h1>
    <p v-if="loading">
      確認しています...
    </p>
    <p
      v-else-if="invalid"
      class="msg msg-error"
      data-test="invalid"
    >
      登録用 URL が無効か、期限切れか、使用済みです。発行した人に新しい URL を依頼してください。
    </p>
    <form
      v-else-if="info"
      class="form"
      @submit.prevent="submit"
    >
      <p v-if="info.kind === 'setup' || info.kind === 'register'">
        新しいアカウントと、あなた専用の家計簿を作成します。
      </p>
      <div
        v-if="info.kind === 'invite'"
        data-test="invite-info"
      >
        <p>
          家計簿「{{ info.ledger_name }}」に{{ ROLE_LABEL[info.role ?? ''] ?? info.role }}の権限で招待されています。あなた専用の家計簿も作成されます。
        </p>
        <label class="check">
          <input
            v-model="useInvitedDefault"
            type="checkbox"
            data-test="use-invited-default"
          >
          「{{ info.ledger_name }}」を web 画面の既定の家計簿にする
        </label>
      </div>
      <p
        v-if="info.kind === 'recovery'"
        data-test="recovery-info"
      >
        「{{ info.user_display_name }}」さんのアカウントに新しいパスキーを追加します。登録が完了すると、ログイン中の他の端末はログアウトされます。
      </p>
      <label
        v-if="info.needs_display_name"
        class="field"
      >
        <span>表示名（100文字まで）</span>
        <input
          v-model="displayName"
          type="text"
          autocomplete="nickname"
          data-test="display-name"
        >
      </label>
      <label class="field">
        <span>このパスキーの名前（任意。例: iPhone）</span>
        <input
          v-model="label"
          type="text"
          data-test="label"
        >
      </label>
      <button
        class="btn btn-primary btn-block"
        type="submit"
        :disabled="busy"
        data-test="register"
      >
        <AppIcon name="key" />パスキーを作成して登録
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
  </section>
</template>
