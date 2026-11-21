<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authApi, type ShareAcceptResult, type ShareInfo } from '../api/auth'
import { ApiError } from '../api/http'
import { errorMessage, formatDate } from '../composables/format'
import { useSessionStore } from '../stores/session'
import AppIcon from '../components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'

// Share-ticket landing (/share): joining a ledger is membership only —
// it never creates an account (share design D-T1 / section 4). The token
// is read once, stashed in this tab's sessionStorage, and removed from
// the URL with a history replace; afterwards it travels in POST bodies
// only. Opening / info never consume the ticket: only the explicit
// [この家計簿を追加する] press (accept) does, so the original URL stays the canonical
// way back in — a closed tab just reopens it.
const SHARE_TOKEN_KEY = 'kb_share_token'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const queryToken = typeof route.query.token === 'string' ? route.query.token : ''
if (queryToken) sessionStorage.setItem(SHARE_TOKEN_KEY, queryToken)
const token = queryToken || sessionStorage.getItem(SHARE_TOKEN_KEY) || ''

// The role is a plain label on a badge: editor -> 編集 / viewer -> 閲覧のみ.
const ROLE_LABEL: Record<string, string> = { editor: '編集', viewer: '閲覧のみ' }

// First character of a display name, for the avatar circle of the
// "joining as" row (same initial-letter grammar as .avatar).
function initialOf(name: string): string {
  return [...name][0] ?? ''
}

const info = ref<ShareInfo | null>(null)
const result = ref<ShareAcceptResult | null>(null)
const loading = ref(true)
const noToken = ref(false)
const invalid = ref(false)
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  if ('token' in route.query) await router.replace({ path: '/share', query: {} })
  if (!token) {
    noToken.value = true
    loading.value = false
    return
  }
  try {
    info.value = await authApi.shareInfo(token)
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_token') invalid.value = true
    else error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
})

async function accept(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    result.value = await authApi.shareAccept(token)
    // Joined (or already a member): the ticket is consumed, so the stash
    // goes too, and the session reloads so the shell lists the ledger.
    sessionStorage.removeItem(SHARE_TOKEN_KEY)
    await session.loadMe()
  } catch (e) {
    if (e instanceof ApiError && e.code === 'invalid_token') {
      invalid.value = true
    } else if (e instanceof ApiError && e.status === 401 && info.value) {
      // The session expired between info and accept: fall back to the
      // login branch (the ticket is untouched and stays stashed).
      info.value = { ...info.value, session: null }
      error.value = errorMessage(e)
    } else {
      error.value = errorMessage(e)
    }
  } finally {
    busy.value = false
  }
}

async function goLogin(): Promise<void> {
  // The token stays in sessionStorage; LoginPage sends a successful
  // login back to /share when the stash is present.
  await router.push('/login')
}

async function goHome(): Promise<void> {
  await router.replace('/')
}
</script>

<template>
  <section class="auth share-auth">
    <div class="auth-logo">
      <BrandLogo
        variant="full"
        :height="34"
      />
    </div>
    <h1
      v-if="info"
      class="share-title"
    >
      <span data-test="issuer">{{ info.issuer_display_name }}</span> さんが<span class="share-nowrap">家計簿</span>を共有しました
    </h1>
    <h1
      v-else
      class="share-title"
    >
      家計簿の共有
    </h1>
    <div class="card auth-card">
      <p v-if="loading">
        読み込んでいます...
      </p>
      <p
        v-else-if="noToken"
        class="msg msg-error"
        data-test="no-token"
      >
        共有 URL が確認できませんので、元の共有 URL から開き直してください。
      </p>
      <p
        v-else-if="invalid"
        class="msg msg-error"
        data-test="invalid"
      >
        共有 URL が無効か、期限切れか、使用済みです。
      </p>
      <div
        v-else-if="result"
        class="share-done"
        data-test="done"
      >
        <span
          class="share-done-mark"
          aria-hidden="true"
        ><AppIcon
          name="check"
          :size="30"
        /></span>
        <p v-if="result.outcome === 'joined'">
          家計簿『<strong>{{ result.ledger.name }}</strong>』を追加しました。
        </p>
        <p
          v-else
          data-test="already-member"
        >
          家計簿『<strong>{{ result.ledger.name }}</strong>』は追加済みです。
        </p>
        <button
          class="btn btn-primary btn-block"
          data-test="go-home"
          @click="goHome"
        >
          ホームへ
        </button>
      </div>
      <div
        v-else-if="info"
        data-test="share-info"
      >
        <div class="share-ledger">
          <span class="share-ledger-visual">
            <span
              class="share-ledger-mark"
              aria-hidden="true"
            ><AppIcon
              name="book"
              :size="28"
            /></span>
            <span
              class="share-role"
              data-test="role"
            >{{ ROLE_LABEL[info.role] ?? info.role }}</span>
          </span>
          <strong
            class="share-ledger-name"
            data-test="ledger-name"
          >{{ info.ledger_name }}</strong>
        </div>
        <template v-if="info.already_member">
          <p data-test="already-member">
            この家計簿は追加済みです。
          </p>
          <button
            class="btn btn-primary btn-block"
            data-test="go-home"
            @click="goHome"
          >
            ホームへ
          </button>
        </template>
        <div
          v-else
          class="share-actions"
        >
          <div class="share-slot">
            <p
              v-if="info.session"
              class="share-join-as"
              data-test="join-as"
            >
              <span
                class="avatar share-join-as-avatar"
                aria-hidden="true"
              >{{ initialOf(info.session.display_name) }}</span>
              <span class="share-join-as-name">{{ info.session.display_name }}</span>
              <span class="muted small">ログイン中</span>
            </p>
            <button
              v-else
              class="btn btn-primary btn-block"
              data-test="login"
              @click="goLogin"
            >
              ログインする
            </button>
          </div>
          <button
            v-if="info.session"
            class="btn btn-primary btn-block"
            :disabled="busy"
            data-test="accept"
            @click="accept"
          >
            この家計簿を追加する
          </button>
          <button
            v-else
            class="btn btn-primary btn-block share-waiting"
            disabled
            data-test="accept-waiting"
          >
            この家計簿を追加する
          </button>
        </div>
        <p
          class="auth-note share-expiry"
          data-test="expires"
        >
          {{ formatDate(info.expires_at) }} まで有効
        </p>
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
