<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { authApi } from './api/auth'
import AppIcon, { type IconName } from './components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'
import LedgerSwitcher from './components/LedgerSwitcher.vue'
import PopoverMenu from './components/PopoverMenu.vue'
import StepUpDialog from './components/StepUpDialog.vue'
import { useSessionStore } from './stores/session'

// App shell (TASK-27 §3): a full-width sticky topbar, and below it a
// sidebar that is always present on desktop (>= 900px) or a drawer opening
// under the topbar on mobile, toggled by the same top-left menu button.
// The top bar carries the brand logo, the page title, the ledger switcher
// and the top-right account menu (settings / connected apps / logout), and
// an icon tab bar sits at the bottom on mobile. Public screens (login /
// register / consent) render without the shell.
const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const showShell = computed(() => !route.meta.public && session.me !== null)

interface NavItem {
  to: string
  name: string
  label: string
  icon: IconName
}
// Main navigation: the four data sections. Account screens (settings /
// connected apps) live in the top-right account menu, not here.
const NAV: NavItem[] = [
  { to: '/', name: 'home', label: 'ホーム', icon: 'home' },
  { to: '/receipts', name: 'receipts', label: 'レシート', icon: 'receipt' },
  { to: '/categories', name: 'categories', label: 'カテゴリ', icon: 'tag' },
  { to: '/stores', name: 'stores', label: '店', icon: 'store' },
]
const SECTION_TITLES: Record<string, string> = {
  home: 'ホーム',
  receipts: 'レシート',
  categories: 'カテゴリ',
  stores: '店',
  settings: '設定',
  apps: '接続中のアプリ',
}

/** Section of the current route (the receipt detail belongs to receipts). */
const section = computed(() => {
  const name = String(route.name ?? '')
  if (name === 'receipt') return 'receipts'
  if (name.startsWith('manage-')) return 'settings'
  return name
})
const ledgerScoped = computed(
  () =>
    ['home', 'receipts', 'categories', 'stores'].includes(section.value) ||
    String(route.name ?? '').startsWith('manage-'),
)
const pageTitle = computed(() => SECTION_TITLES[section.value] ?? '')

// The selected ledger paints the top bar band and the switcher chip.
const ledgerColor = computed(() => session.selectedLedger?.color ?? 'teal')
const shellStyle = computed(() =>
  ledgerScoped.value ? { '--ledger-current': `var(--ledger-${ledgerColor.value})` } : undefined,
)

const initial = computed(() => Array.from(session.me?.display_name ?? '?')[0] ?? '?')

// --- drawer (top-left menu button, TASK-27 §3-3) -------------------------------
// One button both opens and closes: it stays visible on the topbar (the
// drawer opens *below* the topbar, never over it) and toggles its label
// and icon. The sidebar heading (brand link + close button) is gone; the
// sidebar is nav + user display only.
const drawerOpen = ref(false)
// While the drawer is open the background feed must not react to arrow keys:
// inert takes the background out of tab order, but key events from the
// focused sidebar still bubble to window, so the state is shared down
// (ReceiptDetailPage) by ref.
provide('drawer-open', drawerOpen)
const menuBtnEl = ref<HTMLButtonElement | null>(null)
const sidebarEl = ref<HTMLElement | null>(null)

async function openDrawer(): Promise<void> {
  if (drawerOpen.value) return
  drawerOpen.value = true
  await nextTick()
  // the focus lands on the current section's link, or the first one
  const side = sidebarEl.value
  const target =
    side?.querySelector<HTMLElement>('.side-link.active') ?? side?.querySelector<HTMLElement>('.side-link')
  target?.focus()
}

function closeDrawer(): void {
  if (!drawerOpen.value) return
  drawerOpen.value = false
  menuBtnEl.value?.focus()
}

function toggleDrawer(): void {
  if (drawerOpen.value) closeDrawer()
  else void openDrawer()
}

// while the drawer is open the background does not scroll
watch(drawerOpen, (v) => document.documentElement.classList.toggle('drawer-lock', v))

// crossing into desktop (>= 900px) closes the drawer: the sidebar becomes
// permanent and the menu button disappears
const desktopQuery = window.matchMedia('(min-width: 900px)')
function onDesktopCross(e: MediaQueryListEvent): void {
  if (e.matches) closeDrawer()
}
onMounted(() => desktopQuery.addEventListener('change', onDesktopCross))
onUnmounted(() => {
  desktopQuery.removeEventListener('change', onDesktopCross)
  document.documentElement.classList.remove('drawer-lock')
})

// --- account menu (top-right) --------------------------------------------------
const accountOpen = ref(false)

// Close the drawer and the menus on real navigation only: the receipt feed
// rewrites its URL while scrolling (id / query changes within the route),
// which must not close anything.
const navKey = computed(() => (route.name === 'receipt' ? 'receipt' : route.path))
watch(navKey, () => {
  // closeDrawer() (not just the flag) so the focus returns to the menu
  // button: the drawer link that navigated is unmounting
  closeDrawer()
  accountOpen.value = false
})

async function logout(): Promise<void> {
  accountOpen.value = false
  try {
    await authApi.logout()
  } finally {
    session.clear()
    await router.replace('/login')
  }
}
</script>

<template>
  <div
    v-if="showShell && session.me"
    class="shell"
    :class="{ 'drawer-open': drawerOpen }"
    :style="shellStyle"
  >
    <header
      class="topbar"
      :class="{ 'ledger-scoped': ledgerScoped }"
      @keydown.escape="closeDrawer"
    >
      <button
        ref="menuBtnEl"
        class="icon-btn menu-btn"
        :aria-expanded="drawerOpen"
        aria-controls="app-sidebar"
        :aria-label="drawerOpen ? 'メニューを閉じる' : 'メニューを開く'"
        data-test="menu-button"
        @click="toggleDrawer"
      >
        <AppIcon :name="drawerOpen ? 'close' : 'menu'" />
      </button>
      <RouterLink
        to="/"
        class="brand topbar-brand"
      >
        <BrandLogo
          variant="full"
          word="Kakei"
          class="topbar-logo topbar-logo-full"
        />
        <BrandLogo
          variant="compact"
          class="topbar-logo topbar-logo-compact"
        />
      </RouterLink>
      <h1
        v-if="section !== 'home'"
        class="topbar-title"
      >
        {{ pageTitle }}
      </h1>
      <div class="topbar-actions">
        <LedgerSwitcher v-if="ledgerScoped" />
        <PopoverMenu
          v-model:open="accountOpen"
          class="account-menu"
          data-test="account-menu"
        >
          <template #trigger="{ open }">
            <button
              type="button"
              class="avatar-btn"
              :aria-expanded="open"
              aria-haspopup="menu"
              aria-label="アカウントメニュー"
              data-test="account-button"
            >
              <span class="avatar">{{ initial }}</span>
              <AppIcon
                name="chevron-down"
                :size="14"
                class="avatar-chevron"
              />
            </button>
          </template>
          <template #default="{ close }">
            <div class="menu-head">
              <strong>{{ session.me.display_name }}</strong>
              <span class="muted small">{{ session.me.account_number }}</span>
            </div>
            <RouterLink
              to="/settings"
              class="menu-item"
              role="menuitem"
              :aria-current="section === 'settings' ? 'page' : undefined"
              @click="close"
            >
              <AppIcon name="settings" />設定
            </RouterLink>
            <RouterLink
              to="/apps"
              class="menu-item"
              role="menuitem"
              :aria-current="section === 'apps' ? 'page' : undefined"
              @click="close"
            >
              <AppIcon name="link" />接続中のアプリ
            </RouterLink>
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              data-test="menu-logout"
              @click="logout"
            >
              <AppIcon name="logout" />ログアウト
            </button>
          </template>
        </PopoverMenu>
      </div>
    </header>

    <div class="shell-body">
      <aside
        id="app-sidebar"
        ref="sidebarEl"
        class="sidebar"
        data-test="sidebar"
        @keydown.escape="closeDrawer"
      >
        <nav
          class="side-nav"
          aria-label="メインメニュー"
        >
          <RouterLink
            v-for="n in NAV"
            :key="n.name"
            :to="n.to"
            class="side-link"
            :class="{ active: section === n.name }"
            :data-test="`nav-${n.name}`"
          >
            <AppIcon :name="n.icon" />
            <span>{{ n.label }}</span>
          </RouterLink>
        </nav>
        <div class="sidebar-foot">
          <div class="side-user">
            <span class="avatar">{{ initial }}</span>
            <span class="side-user-text">
              <strong>{{ session.me.display_name }}</strong>
              <span class="muted small">{{ session.me.account_number }}</span>
            </span>
          </div>
        </div>
      </aside>
      <div
        class="scrim"
        @click="closeDrawer"
      />
      <div
        class="main-col"
        :inert="drawerOpen || undefined"
      >
        <main class="app-main">
          <RouterView />
        </main>
      </div>
    </div>

    <nav
      class="tabbar"
      aria-label="タブ"
      data-test="tabbar"
      :style="{ '--tab-count': String(NAV.length) }"
      :inert="drawerOpen || undefined"
    >
      <RouterLink
        v-for="t in NAV"
        :key="t.name"
        :to="t.to"
        class="tab-link"
        :class="{ active: section === t.name }"
      >
        <AppIcon
          :name="t.icon"
          :size="22"
        />
        <span>{{ t.label }}</span>
      </RouterLink>
    </nav>
    <StepUpDialog />
  </div>

  <main
    v-else
    class="public app-main"
  >
    <RouterView />
    <StepUpDialog />
  </main>
</template>
