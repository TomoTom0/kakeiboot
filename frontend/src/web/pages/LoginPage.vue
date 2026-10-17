<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authApi } from '../api/auth'
import { ApiError } from '../api/http'
import { getPasskey, isCancel, type AssertionJson } from '../api/webauthn'
import { errorMessage } from '../composables/format'
import { isFramed } from '../composables/frame'
import { useSessionStore } from '../stores/session'
import AppIcon from '../components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'

// Passkey login (spec_auth.md 2-4): a modal "login with passkey" button.
// During an OAuth flow the plain `req` is kept here and only used to go to
// /oauth/consent?req=<R>.
const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const req = typeof route.query.req === 'string' && route.query.req ? route.query.req : undefined
const framed = isFramed()
const busy = ref(false)
const error = ref('')

async function finish(credential: AssertionJson): Promise<void> {
  const res = await authApi.loginFinish(credential)
  if (res.next === 'consent' && req) {
    // The consent screen is public: no shell, no session state needed.
    session.clear()
    await router.replace({ path: '/oauth/consent', query: { req } })
    return
  }
  // Settle the session BEFORE navigating (TASK-39 A-2): the shell and the
  // route flip in the same frame, and the router guard sees session.me and
  // skips its own /me round trip.
  await session.loadMe()
  await router.replace('/')
}

function showError(e: unknown): void {
  error.value =
    e instanceof ApiError && e.status === 401
      ? 'ログインできませんでした。このパスキーは登録されていないか、利用できない状態です。'
      : errorMessage(e)
}

async function loginWithButton(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    const rcr = await authApi.loginStart(req)
    const credential = await getPasskey(rcr)
    await finish(credential)
  } catch (e) {
    if (!isCancel(e)) showError(e)
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
        name="key"
        :size="48"
      />
    </div>
    <h1>パスキーでログイン</h1>
    <p
      v-if="framed"
      class="msg msg-error"
      data-test="framed"
    >
      この画面は埋め込み表示では利用できません。ブラウザで直接開いてください。
    </p>
    <template v-else>
      <p
        v-if="req"
        class="auth-lead"
      >
        ChatGPT との接続を続けるにはログインしてください。
      </p>
      <p
        v-else
        class="auth-lead"
      >
        この端末のパスキーで、パスワードなしでログインできます。
      </p>
      <button
        class="btn btn-primary btn-block"
        :disabled="busy"
        data-test="login"
        @click="loginWithButton"
      >
        <AppIcon name="key" />パスキーでログイン
      </button>
      <p
        v-if="error"
        class="msg msg-error"
        role="alert"
        data-test="error"
      >
        {{ error }}
      </p>
      <div class="features">
        <span class="features-icon"><AppIcon
          name="lock"
          :size="24"
        /></span>
        <ul>
          <li>
            <AppIcon
              name="check"
              :size="16"
            />パスワード不要
          </li>
          <li>
            <AppIcon
              name="check"
              :size="16"
            />顔・指紋認証でかんたん
          </li>
          <li>
            <AppIcon
              name="check"
              :size="16"
            />なりすましに強い
          </li>
        </ul>
      </div>
      <p class="auth-note">
        アカウントの作成は、届いた招待 URL から行えます。
      </p>
    </template>
  </section>
</template>
