<script setup lang="ts">
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import AppIcon from './AppIcon.vue'
import { pushToParent } from '../composables/navDirection'

// The detail pages' heading row (TASK-74 §4-5): ‹ (a push to the parent
// route — not router.back(), so a direct link can still climb), the kind
// label (with the parent's name beside it on a subcategory page), the name,
// the total at the right end and the "..." menu slot. The ‹ sets the
// one-shot back intent right before its push so the slide plays backwards
// even though the history position moves forward (§3-2) — the press itself
// is the shared pushToParent (TASK-124 D3 lifted it so the topbar ‹ keeps
// the same semantics).
const props = defineProps<{
  kindLabel: string
  title: string
  total?: string
  sub?: string
  parentTo: RouteLocationRaw
  backLabel: string
  parent?: string
}>()

const router = useRouter()

function goBack(): void {
  pushToParent(router, props.parentTo)
}
</script>

<template>
  <div class="page-head">
    <button
      type="button"
      class="page-back"
      :aria-label="`${backLabel}へ戻る`"
      data-test="page-back"
      @click="goBack"
    >
      <AppIcon
        name="chevron-left"
        :size="22"
      />
    </button>
    <p class="page-head-kind">
      <span
        v-if="parent"
        class="page-head-parent"
      >{{ parent }}</span>{{ kindLabel }}
    </p>
    <h2 class="page-head-title">
      {{ title }}
    </h2>
    <span
      v-if="total"
      class="page-head-total"
      data-test="total"
    >{{ total }}</span>
    <slot name="menu" />
  </div>
  <p
    v-if="sub"
    class="page-head-sub muted small"
  >
    {{ sub }}
  </p>
</template>
