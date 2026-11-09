<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import UsageDocument from '../components/usage/UsageDocument.vue'
import { usageTopics } from 'virtual:usage-docs'

// One page for every /usage/:topic (TASK-141, TASK-135 §2-3): the route slug
// picks the docs/usage document and the common UsageDocument renders it. The
// corpus drives the content — this page only adds the way back to the list.
// An unknown slug (hand-typed URL, TASK-171 / PR#4 review) keeps the section
// title and shell identical and pairs the way-back link with the empty note
// in the house vocabulary (データ名 + はありません。 — no explanatory labels).
const props = defineProps<{ slug: string }>()

const topic = computed(() => usageTopics.find((t) => t.slug === props.slug))
</script>

<template>
  <section class="card">
    <RouterLink
      to="/usage"
      class="small muted"
    >
      使い方へ戻る
    </RouterLink>
    <UsageDocument
      v-if="topic"
      :topic="topic"
    />
    <p
      v-else
      class="empty-state"
      data-test="empty"
    >
      このトピックはありません。
    </p>
  </section>
</template>
