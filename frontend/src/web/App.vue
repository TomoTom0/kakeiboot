<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { authApi } from './api/auth'
import AppIcon from './components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'
import LedgerSwitcher from './components/LedgerSwitcher.vue'
import PopoverMenu from './components/PopoverMenu.vue'
import StepUpDialog from './components/StepUpDialog.vue'
import { useSessionStore } from './stores/session'

// App shell (TASK-27 §3): a full-width sticky topbar, and below it a
// sidebar — a fixed overlay at every width (TASK-33 real-device review:
// the desktop grid-column fold is gone), open by default on desktop
// (>= 900px) or a modal drawer opening under the topbar on mobile. The top
// bar carries the brand logo, the page title, the ledger switcher and the
// top-right account menu (settings / connected apps / usage / logout), and
// an icon tab bar sits at the bottom on mobile.
// Public screens (login / register / consent) render without the shell.
const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const showShell = computed(() => !route.meta.public && session.me !== null)

// Single source of the section labels and their icons (TASK-35): the page
// title and the nav / account-menu items all read from here.
const SECTION_TITLES = {
  home: { title: 'ホーム', icon: 'home' },
  receipts: { title: 'レシート', icon: 'receipt' },
  categories: { title: 'カテゴリ', icon: 'tag' },
  stores: { title: '店', icon: 'store' },
  settings: { title: '設定', icon: 'settings' },
  apps: { title: '接続中のアプリ', icon: 'link' },
  usage: { title: '使い方', icon: 'help' },
} as const
type SectionName = keyof typeof SECTION_TITLES
// Main navigation: to / name only — labels and icons come from SECTION_TITLES.
// Account screens (settings / connected apps) live in the top-right account
// menu, not here.
const NAV: { to: string; name: SectionName }[] = [
  { to: '/', name: 'home' },
  { to: '/receipts', name: 'receipts' },
  { to: '/categories', name: 'categories' },
  { to: '/stores', name: 'stores' },
]

/** Section of the current route (the receipt detail belongs to receipts). */
const section = computed(() => {
  const name = String(route.name ?? '')
  if (name === 'receipt') return 'receipts'
  if (route.path.startsWith('/settings')) return 'settings'
  // usage-* subpages (e.g. /usage/connect) share the usage section, like
  // manage-* collapses into settings
  if (name.startsWith('usage-')) return 'usage'
  return name
})
const ledgerScoped = computed(
  () =>
    ['home', 'receipts', 'categories', 'stores'].includes(section.value) ||
    String(route.name ?? '').startsWith('manage-'),
)
const pageTitle = computed(() => SECTION_TITLES[section.value as SectionName]?.title ?? '')
const pageIcon = computed(() => SECTION_TITLES[section.value as SectionName]?.icon)

// The selected ledger paints the top bar band and the switcher chip.
const ledgerColor = computed(() => session.selectedLedger?.color ?? 'teal')
const shellStyle = computed(() =>
  ledgerScoped.value ? { '--ledger-current': `var(--ledger-${ledgerColor.value})` } : undefined,
)

const initial = computed(() => Array.from(session.me?.display_name ?? '?')[0] ?? '?')

// --- nav toggle (top-left menu button, TASK-27 §3-3 + TASK-33 overlay) -----------
// One button, visible at every width, toggling one sidebar state. The
// sidebar is a fixed overlay at every width (TASK-33 real-device review):
// at 900px+ it starts open and slides over the main column — no scrim, the
// main column stays interactive and never moves or reflows. Below 900px it
// is the modal drawer as before (scrim / inert / focus / scroll lock). The
// open/closed choice itself survives viewport changes in both directions.
const desktopQuery = window.matchMedia('(min-width: 900px)')
const isDesktop = ref(desktopQuery.matches)
const drawerOpen = ref(desktopQuery.matches)
// Only the narrow-width open drawer is modal: the scrim, inert, scroll lock
// and focus handling key on this, not on the bare open state.
const drawerModal = computed(() => drawerOpen.value && !isDesktop.value)
// While the drawer is modal the background feed must not react to arrow
// keys: inert takes the background out of tab order, but key events from
// the focused sidebar still bubble to window, so the state is shared down
// (ReceiptDetailPage) by ref.
provide('drawer-modal', drawerModal)
const menuBtnEl = ref<HTMLButtonElement | null>(null)
const sidebarEl = ref<HTMLElement | null>(null)

async function openDrawer(): Promise<void> {
  if (drawerOpen.value) return
  drawerOpen.value = true
  if (isDesktop.value) return
  await nextTick()
  // the focus lands on the current section's link, or the first one
  const side = sidebarEl.value
  const target =
    side?.querySelector<HTMLElement>('.side-link.active') ?? side?.querySelector<HTMLElement>('.side-link')
  target?.focus()
}

function closeDrawer(): void {
  // a no-op at 900px+: the desktop overlay closes only via the menu button
  // (navigation and Escape leave it open)
  if (!drawerModal.value) return
  drawerOpen.value = false
  menuBtnEl.value?.focus()
}

function toggleMenu(): void {
  // desktop: the plain slide toggle, no modal side effects
  if (isDesktop.value) {
    drawerOpen.value = !drawerOpen.value
    return
  }
  if (drawerOpen.value) closeDrawer()
  else void openDrawer()
}

// while the drawer is modal the background does not scroll
watch(drawerModal, (v) => document.documentElement.classList.toggle('drawer-lock', v))

// crossing 900px keeps the open/closed choice; only the modal effects
// (scrim / inert / drawer-lock) follow the width
function onDesktopCross(e: MediaQueryListEvent): void {
  isDesktop.value = e.matches
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
    // Confirm the navigation to the public screen first and clear the
    // session after: the shell swap and the page swap land in the same
    // frame instead of the shell vanishing while the old screen lingers
    // (TASK-39 A-3).
    try {
      await router.replace('/login')
    } finally {
      session.clear()
    }
  }
}
</script>

<template>
  <!-- The shell / public branch swap itself is a transition too (TASK-39
       real-device follow-up): login -> home flips the v-if, which the inner
       RouterView transitions never see. Both branch roots are single elements
       (div.shell / main.public), so the same page fade covers the swap. -->
  <Transition
    name="page"
    mode="out-in"
  >
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
          @click="toggleMenu"
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
          <AppIcon
            v-if="pageIcon"
            :name="pageIcon"
            :size="20"
          />
          <span class="topbar-title-text">{{ pageTitle }}</span>
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
              </div>
              <RouterLink
                to="/settings"
                class="menu-item"
                role="menuitem"
                :aria-current="section === 'settings' ? 'page' : undefined"
                @click="close"
              >
                <AppIcon :name="SECTION_TITLES.settings.icon" />{{ SECTION_TITLES.settings.title }}
              </RouterLink>
              <RouterLink
                to="/apps"
                class="menu-item"
                role="menuitem"
                :aria-current="section === 'apps' ? 'page' : undefined"
                @click="close"
              >
                <AppIcon :name="SECTION_TITLES.apps.icon" />{{ SECTION_TITLES.apps.title }}
              </RouterLink>
              <RouterLink
                to="/usage"
                class="menu-item"
                role="menuitem"
                :aria-current="section === 'usage' ? 'page' : undefined"
                data-test="menu-usage"
                @click="close"
              >
                <AppIcon :name="SECTION_TITLES.usage.icon" />{{ SECTION_TITLES.usage.title }}
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
              <AppIcon :name="SECTION_TITLES[n.name].icon" />
              <span>{{ SECTION_TITLES[n.name].title }}</span>
            </RouterLink>
          </nav>
          <div class="sidebar-foot">
            <div class="side-user">
              <span class="avatar">{{ initial }}</span>
              <span class="side-user-text">
                <strong>{{ session.me.display_name }}</strong>
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
          :inert="drawerModal || undefined"
        >
          <main class="app-main">
            <RouterView v-slot="{ Component }">
              <Transition
                name="page"
                mode="out-in"
              >
                <component :is="Component" />
              </Transition>
            </RouterView>
          </main>
        </div>
      </div>

      <nav
        class="tabbar"
        aria-label="タブ"
        data-test="tabbar"
        :style="{ '--tab-count': String(NAV.length) }"
        :inert="drawerModal || undefined"
      >
        <RouterLink
          v-for="t in NAV"
          :key="t.name"
          :to="t.to"
          class="tab-link"
          :class="{ active: section === t.name }"
        >
          <AppIcon
            :name="SECTION_TITLES[t.name].icon"
            :size="22"
          />
          <span>{{ SECTION_TITLES[t.name].title }}</span>
        </RouterLink>
      </nav>
      <StepUpDialog />
    </div>

    <main
      v-else
      class="public app-main"
    >
      <RouterView v-slot="{ Component }">
        <Transition
          name="page"
          mode="out-in"
        >
          <component :is="Component" />
        </Transition>
      </RouterView>
      <StepUpDialog />
    </main>
  </Transition>
</template>
