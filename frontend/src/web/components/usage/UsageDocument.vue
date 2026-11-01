<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import AppIcon from '../AppIcon.vue'
import ConnectFlow from './ConnectFlow.vue'
import UsageFigure from './UsageFigure.vue'
import type { UsagePart, UsageTopic } from '@/build/usage-docs'

// Common document renderer of every /usage/:topic (TASK-141, TASK-135 §2-3):
// one component serves the whole docs/usage corpus. `html` parts are the
// build-time output of transformUsageMarkdown (raw HTML is disabled there and
// the external-link attributes are added at transform), so the v-html below
// only ever receives generated markup. The widget placements map to the
// existing parts: the connect-url box + copy control (TASK-37/47/48 — the copy
// success is the button's own icon swap, no text row joins the URL box; the
// spoken confirmation is the sr-only status beside it), the flow diagram
// figure (ConnectFlow) and the screenshot figures (UsageFigure, dashed
// placeholder until the asset is captured).
defineProps<{ topic: UsageTopic }>()

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

// part type guards (no casts; the discriminant is `kind`)
type HtmlPart = Extract<UsagePart, { kind: 'html' }>
type ConnectUrlPart = Extract<UsagePart, { kind: 'connect-url' }>
type ConnectFlowPart = Extract<UsagePart, { kind: 'connect-flow' }>
type FigurePendingPart = Extract<UsagePart, { kind: 'figure-pending' }>

function isHtml(p: UsagePart): p is HtmlPart {
  return p.kind === 'html'
}
function isConnectUrl(p: UsagePart): p is ConnectUrlPart {
  return p.kind === 'connect-url'
}
function isConnectFlow(p: UsagePart): p is ConnectFlowPart {
  return p.kind === 'connect-flow'
}
function isFigurePending(p: UsagePart): p is FigurePendingPart {
  return p.kind === 'figure-pending'
}
</script>

<template>
  <div class="usage-doc">
    <template
      v-for="(part, i) in topic.doc.parts"
      :key="i"
    >
      <!-- (build-time-generated markup: raw html is disabled in the transform
        and the external-link attributes are added there as well) -->
      <!-- eslint-disable-next-line vue/no-v-html, vue/max-attributes-per-line -->
      <div v-if="isHtml(part)" class="usage-doc-html" v-html="part.html" />
      <div
        v-else-if="isConnectUrl(part)"
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
      <figure
        v-else-if="isConnectFlow(part)"
        class="usage-fig"
      >
        <ConnectFlow />
        <figcaption>{{ part.caption }}</figcaption>
      </figure>
      <UsageFigure
        v-else-if="isFigurePending(part)"
        :id="part.id"
        :caption="part.caption"
        :note="part.note"
      />
      <UsageFigure
        v-else
        :caption="part.caption"
        :src="part.src"
        :alt="part.alt"
      />
    </template>
  </div>
</template>
