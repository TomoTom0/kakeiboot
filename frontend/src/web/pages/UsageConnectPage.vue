<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import consentPng from '../assets/usage/consent.png'
import loginPng from '../assets/usage/login.png'
import AppIcon from '../components/AppIcon.vue'
import ConnectFlow from '../components/usage/ConnectFlow.vue'
import UsageFigure from '../components/usage/UsageFigure.vue'

// ChatGPT connection walkthrough (TASK-37): the three-step MCP registration
// with figures. The connection URL is generated at runtime from
// location.origin so dev / stg / prod all show their own origin (the frontend
// is served from the same origin as /mcp). The permission wording is a
// verbatim copy of the backend scope_description so the explanation reads
// against the consent screenshot (F5). The ChatGPT-side figures (F2/F6) are
// placeholders until the real-device check supplies the screenshots.
// TASK-48: the copy success is the button's own icon swap (copy → check with
// a pop, .copy-btn.is-done) — no text row joins the URL box, so the box keeps
// its height; the spoken confirmation is the sr-only status beside it.
const url = `${location.origin}/mcp`
const copied = ref(false)
const copyFailed = ref(false)
let restoreTimer: ReturnType<typeof setTimeout> | undefined

const copyLabel = computed(() => (copied.value ? 'コピーしました' : 'URL をコピー'))

async function copyUrl(): Promise<void> {
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(url)
    copied.value = true
    clearTimeout(restoreTimer)
    restoreTimer = setTimeout(() => {
      copied.value = false
    }, 3000)
  } catch {
    copied.value = false
    copyFailed.value = true
  }
}

onUnmounted(() => clearTimeout(restoreTimer))
</script>

<template>
  <div>
    <section class="card">
      <RouterLink
        to="/usage"
        class="small muted"
      >
        使い方へ戻る
      </RouterLink>
      <p class="lead">
        ChatGPT に kakeiboot を接続すると、会話にレシートの写真を貼るだけで家計簿に記録できます。最初に一度だけ接続が必要です。
      </p>
      <figure class="usage-fig">
        <ConnectFlow />
        <figcaption>接続の流れ: URLの登録、ブラウザでのログインと許可をへて、ChatGPT の会話でレシートを送れるようになります</figcaption>
      </figure>
      <ol class="usage-steps">
        <li data-test="step-1">
          <h2>ChatGPT に接続URLを登録する</h2>
          <p>
            ChatGPT の設定からコネクタ（MCP）の追加画面を開き、下の URL を入力します。スマホの ChatGPT アプリでも同じ手順で接続できます。
          </p>
          <div
            class="usage-url"
            data-test="connect-url-box"
          >
            <code
              class="break"
              data-test="connect-url"
            >{{ url }}</code>
            <button
              type="button"
              class="ibtn copy-btn"
              :class="{ 'is-done': copied }"
              :aria-label="copyLabel"
              :title="copyLabel"
              data-test="copy-url"
              @click="copyUrl"
            >
              <AppIcon
                :name="copied ? 'check' : 'copy'"
                :size="18"
              />
            </button>
            <span
              v-if="copied"
              class="sr-only"
              role="status"
              data-test="copy-done"
            >コピーしました</span>
            <p
              v-if="copyFailed"
              class="msg msg-error"
            >
              コピーできませんでした。URL を選択してコピーしてください。
            </p>
          </div>
          <UsageFigure
            id="fig-chatgpt-add"
            caption="ChatGPT のコネクタ（MCP）追加画面"
            note="ここには ChatGPT のコネクタ（MCP）追加画面とURL入力箇所のスクリーンショットを表示します（実機確認後に差し替え）"
          />
        </li>
        <li data-test="step-2">
          <h2>ログインして接続を許可する</h2>
          <p>
            URL を入力すると、ChatGPT がブラウザでこのアプリの画面を開きます。未ログインならパスキーでログインし、表示された内容を確認して「許可」を押します。
          </p>
          <h3>許可する内容</h3>
          <ul class="list muted small">
            <li>家計簿の参照（レシートや下書きの検索・閲覧、集計、カテゴリや店の一覧の表示）<span class="small">（ledger.read）</span></li>
            <li>家計簿の変更（レシートの作成・修正・確定・削除、カテゴリや店の管理）<span class="small">（ledger.write）</span></li>
            <li>最初の接続先の家計簿（接続後に ChatGPT から切り替え可能）</li>
          </ul>
          <p class="muted small">
            接続のたびに（再接続時も）毎回この許可画面が出ます。
          </p>
          <UsageFigure
            id="fig-login"
            caption="ログイン画面（パスキーでログインする）"
            :src="loginPng"
            alt="kakeiboot のログイン画面。パスキーでログインするボタンが表示されている"
          />
          <UsageFigure
            id="fig-consent"
            caption="接続の許可画面（許可する内容を確認して「許可」を押す）"
            :src="consentPng"
            alt="kakeiboot の接続の許可画面。ChatGPT が求める許可内容と許可・拒否ボタンが表示されている"
          />
        </li>
        <li data-test="step-3">
          <h2>ChatGPT でレシートを送る</h2>
          <p>
            ChatGPT に戻ると接続完了です。レシートの写真を貼って「これを登録して」のように送ると、読み取った内容の確認が会話に表示されるので、問題なければ承認してください。家計簿に記録されます。
          </p>
          <UsageFigure
            id="fig-conversation"
            caption="ChatGPT の会話でレシートを送る例"
            note="ここには ChatGPT の会話でレシートの写真を送り、内容の確認を承認する様子のスクリーンショットを表示します（実機確認後に差し替え）"
          />
        </li>
      </ol>
    </section>
    <section class="card">
      <h2>接続の管理と有効期限</h2>
      <dl class="kv">
        <dt>有効期限</dt>
        <dd>90日ごとに接続が切れます。切れたら同じ手順で再接続してください。</dd>
        <dt>管理と解除</dt>
        <dd>
          <RouterLink to="/apps">
            接続中のアプリ
          </RouterLink>で接続の解除や、接続先の家計簿の切替ができます。
        </dd>
        <dt>家計簿の切替</dt>
        <dd>会話で「家計簿を ○○ に切り替えて」と頼んでも切り替えられます。</dd>
        <dt>トラブル時</dt>
        <dd>「この接続要求は無効か期限切れです」と出たら、ChatGPT 側の操作からもう一度やり直してください。</dd>
      </dl>
    </section>
  </div>
</template>
