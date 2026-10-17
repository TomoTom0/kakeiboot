<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppIcon from '../components/AppIcon.vue'

// Usage top (TASK-37): a short lead and the topic list. Topics are row links
// (the rows / link-row house style); adding one is one more list entry plus
// its /usage/<topic> route.
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
      <li class="row">
        <RouterLink
          to="/usage/connect"
          class="link-row"
          data-test="topic-connect"
        >
          <AppIcon name="link" />
          <span class="row-main">
            ChatGPTに接続
            <span class="muted small block">レシートを会話で記録するための最初の接続設定（約2分）</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
