<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { authApi } from './api/auth'
import AppIcon from './components/AppIcon.vue'
import BrandLogo from '@/shared/components/BrandLogo.vue'
import LedgerSwitcher from './components/LedgerSwitcher.vue'
import PopoverMenu from './components/PopoverMenu.vue'
import StepUpDialog from './components/StepUpDialog.vue'
import TopbarFilterBar from './components/TopbarFilterBar.vue'
import { direction } from './composables/navDirection'
import { markReady, notifyPageEntered, PAGE_READY_KEY, resetPageReady } from './composables/usePageReady'
import { useSessionStore } from './stores/session'

// App shell (TASK-27 §3): a full-width sticky topbar, and below it a
// sidebar — a fixed overlay at every width (TASK-33 real-device review:
// the desktop grid-column fold is gone), closed by default with an
// always-on scrim (TASK-89; the old 900px+ default-open is gone), gaining
// modal-drawer behavior (inert/focus/scroll lock) only under 900px. The top
// bar carries the brand logo, the page title, the center filter bar
// (TASK-44 §11: period / search chips on the browsing routes) and the
// top-right account menu (settings / connected apps / usage / logout; on
// the ledger-scoped routes the ledger switcher rides it as a radio section,
// TASK-101), and an icon tab bar sits at the bottom on mobile.
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
  search: { title: '検索', icon: 'search' },
  settings: { title: '設定', icon: 'settings' },
  apps: { title: '接続中のアプリ', icon: 'link' },
  usage: { title: '使い方', icon: 'help' },
} as const
type SectionName = keyof typeof SECTION_TITLES
// Main navigation: to / name only — labels and icons come from SECTION_TITLES.
// The four data sections feed the sidebar nav and the mobile tabbar; settings
// joins the sidebar alone in a separated second group (TASK-56) and the
// account screens stay in the top-right account menu as well.
const NAV: { to: string; name: SectionName }[] = [
  { to: '/', name: 'home' },
  { to: '/receipts', name: 'receipts' },
  { to: '/categories', name: 'categories' },
  { to: '/stores', name: 'stores' },
]

/** Section of the current route, from route.meta (TASK-74 §4-2): the detail
 * routes and /search carry their own section and manage-* inherits 'settings'
 * from the /settings parent record. Routes without a section (the public
 * screens) read as '' — they render outside the shell anyway. */
const section = computed<SectionName | ''>(() => {
  const s = route.meta.section
  return typeof s === 'string' && s in SECTION_TITLES ? (s as SectionName) : ''
})
const ledgerScoped = computed(() => route.meta.ledgerScoped === true)
// The topbar center filter bar (TASK-44 §11-3/11-6): only on the browsing
// routes that opted in via route.meta.filters, and only while the user can
// actually view a ledger (no membership -> no shared filters to show).
const showFilters = computed(
  () => route.meta.filters === true && (session.me?.ledgers.length ?? 0) > 0,
)
const pageTitle = computed(() => (section.value === '' ? '' : SECTION_TITLES[section.value].title))
const pageIcon = computed(() => (section.value === '' ? undefined : SECTION_TITLES[section.value].icon))

// The selected ledger paints the top bar band (its chip now rides the
// account menu's radio rows, TASK-101).
const ledgerColor = computed(() => session.selectedLedger?.color ?? 'teal')
const shellStyle = computed(() =>
  ledgerScoped.value ? { '--ledger-current': `var(--ledger-${ledgerColor.value})` } : undefined,
)

const initial = computed(() => Array.from(session.me?.display_name ?? '?')[0] ?? '?')

// --- nav toggle (top-left menu button, TASK-27 §3-3 + TASK-33 overlay) -----------
// One button, visible at every width, toggling one sidebar state. The
// sidebar is a fixed overlay at every width, starting closed (TASK-86/89):
// the old 900px+ default-open is gone. While open, the full-width scrim
// covers everything below the topbar at every width, so the main column is
// NOT clickable (an outside tap on the scrim closes the drawer) — only the
// modal effects (inert / focus / scroll lock) stay narrow-width; the desktop
// open overlay skips them. The open/closed choice survives viewport changes.
const desktopQuery = window.matchMedia('(min-width: 900px)')
const isDesktop = ref(desktopQuery.matches)
const drawerOpen = ref(false)
// Only the narrow-width open drawer is modal: the inert, scroll lock
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
  // TASK-89: the drawer closes at every width — an outside tap, Escape and
  // navigation all close the desktop overlay too. The focus return stays a
  // modal concern (the desktop overlay never moved the focus).
  if (!drawerOpen.value) return
  const wasModal = drawerModal.value
  drawerOpen.value = false
  if (wasModal) menuBtnEl.value?.focus()
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

// --- shell page transition (TASK-74 §4-3) --------------------------------------
// The shell RouterView slides by the navigation direction: forward enters
// from the right, back from the left, and a 'none' direction (tab switches,
// every replace) skips the CSS machinery entirely. The key is the first path
// segment: the feed rewrites its URL while scrolling without remounting, the
// settings tabs all share 'settings' (so the shell never remounts and their
// inner fade lives on), and only a real component change (list -> detail)
// swaps — same key, different component still transitions.
const transitionName = computed(() =>
  direction.value === 'forward' ? 'slide-forward' : direction.value === 'back' ? 'slide-back' : '',
)
const pageKey = computed(() => route.path.split('/')[1] ?? '')
function onAfterEnter(): void {
  notifyPageEntered()
}
// pages report their data load through this (usePageReady); the parked scroll
// restore of a pop waits for it alongside the finished enter
provide(PAGE_READY_KEY, { markReady })
watch(pageKey, () => resetPageReady())

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
          <!-- TASK-52: the glyph points where the panel goes — the sidebar
               sits at the left edge, so open shows a left chevron (a close X
               read as a second hamburger); closed is the menu again -->
          <AppIcon :name="drawerOpen ? 'chevron-left' : 'menu'" />
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
        <!-- the center filter bar (TASK-44 §11): right after the title, in
             front of the actions; it owns the margin-left:auto push -->
        <TopbarFilterBar v-if="showFilters" />
        <div class="topbar-actions">
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
              <!-- TASK-101: the ledger switcher rides the account menu as a
                   radio section on the ledger-scoped routes, separated from
                   the four plain items by a border-top rule (the menu head
                   keeps its own border-bottom) -->
              <LedgerSwitcher
                v-if="ledgerScoped"
                @select="close"
              />
              <hr
                v-if="ledgerScoped"
                class="menu-separator"
                aria-hidden="true"
              >
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
            <!-- TASK-56: settings rides in a separated second group under the
                 data nav (the tabbar keeps the four data sections; the
                 account-menu entry stays as the second way in) -->
            <div class="side-nav-secondary">
              <RouterLink
                to="/settings"
                class="side-link"
                :class="{ active: section === 'settings' }"
                data-test="nav-settings"
              >
                <AppIcon :name="SECTION_TITLES.settings.icon" />
                <span>{{ SECTION_TITLES.settings.title }}</span>
              </RouterLink>
            </div>
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
              <!-- direction-based since TASK-74: no mode (both pages move at
                   once) and :css off for a 'none' direction, so replaces and
                   tab swaps swap instantly with no transition classes -->
              <Transition
                :name="transitionName"
                :css="transitionName !== ''"
                @after-enter="onAfterEnter"
              >
                <component
                  :is="Component"
                  :key="pageKey"
                />
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
