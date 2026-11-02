<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppIcon from '../../components/AppIcon.vue'

// Others tab: the usage pages (TASK-37) are the only entry for now; more
// topics join as rows here.
</script>

<template>
  <section class="card">
    <h2>その他</h2>
    <RouterLink
      to="/usage"
      class="settings-manage-link"
      data-test="settings-others-usage"
    >
      <AppIcon name="help" />
      <span class="settings-manage-link-text">
        <strong>使い方</strong>
        <span class="muted small">接続の手順と使い方のトピック一覧</span>
      </span>
    </RouterLink>
  </section>
</template>
