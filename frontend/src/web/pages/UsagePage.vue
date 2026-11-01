<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'
import { usageTopics } from 'virtual:usage-docs'

// Usage top (TASK-37, reworked by TASK-141): the topic list generated from the
// docs/usage frontmatter (order-ascending) — adding a topic is one more
// usage_<topic>.md file (TASK-135 §2-3). Rows keep the rows / link-row house
// style (link icon + row-main, the former single-row layout); the ChatGPT
// connection topic keeps its /usage/connect URL.
</script>

<template>
  <section class="card">
    <p class="lead">
      kakeiboot は、レシートの写真を ChatGPT に送るだけで記録できる家計簿です。この画面では、使い始めの手順と操作の説明をまとめています。
    </p>
    <h2>トピック</h2>
    <ul
      class="rows"
      data-test="usage-topics"
    >
      <li
        v-for="t in usageTopics"
        :key="t.slug"
        class="row"
      >
        <RouterLink
          :to="`/usage/${t.slug}`"
          class="link-row"
          :data-test="t.slug === 'connect' ? 'topic-connect' : undefined"
        >
          <AppIcon name="link" />
          <span class="row-main">
            {{ t.title }}
            <span class="muted small block">{{ t.summary }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
