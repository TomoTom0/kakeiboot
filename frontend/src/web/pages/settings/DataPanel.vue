<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppIcon, { type IconName } from '../../components/AppIcon.vue'

// Data tab: links into the manage screens. The screens themselves keep their
// existing URLs and route names; this tab (and its active state on the
// manage routes) is the way back.
interface ManageLink {
  to: string
  key: string
  label: string
  desc: string
  icon: IconName
}

const LINKS: ManageLink[] = [
  {
    to: '/settings/categories',
    key: 'categories',
    label: 'カテゴリ',
    desc: '品目・店カテゴリの追加・改名・移動・アーカイブ',
    icon: 'tag',
  },
  { to: '/settings/stores', key: 'stores', label: '店', desc: '店名・種別の変更と統合', icon: 'store' },
  { to: '/settings/labels', key: 'labels', label: 'ラベルの管理', desc: 'ラベルの名前を付ける', icon: 'tag' },
]
</script>

<template>
  <section class="card">
    <h2>データの管理</h2>
    <ul class="settings-manage-links">
      <li
        v-for="l in LINKS"
        :key="l.key"
      >
        <RouterLink
          :to="l.to"
          class="settings-manage-link"
          :data-test="`settings-data-${l.key}`"
        >
          <AppIcon :name="l.icon" />
          <span class="settings-manage-link-text">
            <strong>{{ l.label }}</strong>
            <span class="muted small">{{ l.desc }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>
  </section>
</template>
