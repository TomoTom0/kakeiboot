<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router'
import AppIcon, { type IconName } from '../components/AppIcon.vue'

// Settings layout (TASK-36, reworked after the real-device feedback): four
// horizontal tabs — general / auth / data / others — full width, scrolling
// sideways on narrow screens (styles.css). Each tab is a route under
// /settings; /settings redirects to the general tab. The manage screens
// (categories / stores / labels) keep their own URLs and light the data tab
// as the way back. Logout lives only in the top-right account menu.
const route = useRoute()

interface SettingsTab {
  name: string
  to: string
  key: string
  label: string
  icon: IconName
}

const TABS: SettingsTab[] = [
  { name: 'settings-general', to: '/settings/general', key: 'general', label: '一般', icon: 'user' },
  { name: 'settings-auth', to: '/settings/auth', key: 'auth', label: '認証', icon: 'key' },
  { name: 'settings-data', to: '/settings/data', key: 'data', label: 'データ', icon: 'tag' },
  { name: 'settings-others', to: '/settings/others', key: 'others', label: 'その他', icon: 'help' },
]

// The active class is decided by the exact route name: the URL-similarity
// based router-link-active classes can light up across sibling panels. The
// manage screens belong to the data tab (their way back).
const isActive = (t: SettingsTab) =>
  route.name === t.name || (t.key === 'data' && String(route.name ?? '').startsWith('manage-'))
</script>

<template>
  <div class="settings-layout">
    <nav
      class="tabs settings-tabs"
      aria-label="設定メニュー"
      data-test="settings-nav"
    >
      <RouterLink
        v-for="t in TABS"
        :key="t.name"
        :to="t.to"
        class="tab"
        :class="{ active: isActive(t) }"
        :aria-current="isActive(t) ? 'page' : undefined"
        :data-test="`settings-tab-${t.key}`"
      >
        <AppIcon :name="t.icon" /><span>{{ t.label }}</span>
      </RouterLink>
    </nav>
    <RouterView v-slot="{ Component }">
      <Transition
        name="page"
        mode="out-in"
      >
        <component
          :is="Component"
          :key="route.name"
        />
      </Transition>
    </RouterView>
  </div>
</template>
