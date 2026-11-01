<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import UsageDocument from '../components/usage/UsageDocument.vue'
import { usageTopics } from 'virtual:usage-docs'

// One page for every /usage/:topic (TASK-141, TASK-135 §2-3): the route slug
// picks the docs/usage document and the common UsageDocument renders it. The
// corpus drives the content — this page only adds the way back to the list.
// An unknown slug (hand-typed URL) leaves the way-back link alone; the section
// title and shell stay identical to the rest of /usage.
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
  </section>
</template>
