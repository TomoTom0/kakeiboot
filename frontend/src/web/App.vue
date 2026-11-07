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
import {
  direction,
  isWithinAppHistory,
  navKind,
  pushToParent,
  recordHistoryBoundary,
  setHistoryBoundaryToCurrent,
} from './composables/navDirection'
import { useBrowsingUrlSync } from './composables/useBrowsingUrlSync'
import {
  markReady,
  notifyPageEntered,
  PAGE_READY_KEY,
  resetPageData,
  resetPageReady,
} from './composables/usePageReady'
import { usePeriodStore } from './stores/period'
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
const period = usePeriodStore()
const showShell = computed(() => !route.meta.public && session.me !== null)

// The shell-start history boundary (TASK-164 §2-4): everything behind the
// current window.history.state.position is out of the app's own history — a
// reload or a direct link never digs past it with the ‹.
recordHistoryBoundary()

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
// account screens stay in the top-right account menu as well. TASK-164 §1:
// home left the array — its affordances (the tabbar home tab, the brand, the
// sidebar home link) are plain links sharing onHomePress below, whose press
// on the home route resets the period instead of navigating. The tab count
// still covers all four tabs.
const NAV: { to: string; name: SectionName }[] = [
  { to: '/receipts', name: 'receipts' },
  { to: '/categories', name: 'categories' },
  { to: '/stores', name: 'stores' },
]
const TAB_COUNT = NAV.length + 1

/** Section of the current route, from route.meta (TASK-74 §4-2): the detail
 * routes and /search carry their own section and manage-* inherits 'settings'
 * from the /settings parent record. Routes without a section (the public
 * screens) read as '' — they render outside the shell anyway. */
const section = computed<SectionName | ''>(() => {
  const s = route.meta.section
  return typeof s === 'string' && s in SECTION_TITLES ? (s as SectionName) : ''
})
const ledgerScoped = computed(() => route.meta.ledgerScoped === true)

// The shell-level URL sync of the browsing state (TASK-124 D2): the period
// mode keys and labels= of the `meta.browsingSync` routes live in the URL,
// imported on every navigation that carries them and written back as a
// guarded replace — one place for all the browsing pages.
useBrowsingUrlSync()

// --- the topbar ‹: the browsing history back + the tabbar-外 climb ----------------
// Two readings of one affordance, same placement and grammar (right after
// the brand, icon-only). The BROWSING side (home / receipts / categories /
// stores / the axes / search — the browsingSync routes, TASK-164 §2-4)
// reads ‹ as "undo the last view move": the press is a router.back() over
// the app's own history (the same entries the device back walks), bounded
// by the shell-start position; at the boundary the axes and /search climb
// to a statically derived parent instead, and the four root screens (no
// parent of their own) hide the ‹ entirely. The tabbar-外 TEN screens
// (TASK-124 D3 — search left them for the browsing side) keep the parentTo
// push: no period change happens there, so "one view move back" and "climb
// to the parent" barely differ and the guaranteed parent landing stays.
const TOPBAR_BACK: Record<string, { to: string; label: string }> = {
  'settings-general': { to: '/', label: 'ホーム' },
  'settings-auth': { to: '/', label: 'ホーム' },
  'settings-data': { to: '/', label: 'ホーム' },
  'settings-others': { to: '/', label: 'ホーム' },
  'manage-categories': { to: '/settings/data', label: 'データ' },
  'manage-stores': { to: '/settings/data', label: 'データ' },
  'manage-labels': { to: '/settings/data', label: 'データ' },
  apps: { to: '/settings', label: '設定' },
  usage: { to: '/settings/others', label: 'その他' },
  'usage-topic': { to: '/settings/others', label: 'その他' },
}

/** The browsing side's static fallback parent (TASK-164 §2-4), derived from
 *  the path structure alone — the page's own view resolution never runs for
 *  a fallback (it only fires on a boundary arrival: a direct link, a
 *  reload), and the section list is a good enough landing. The four root
 *  screens answer null: no fallback exists, the ‹ hides at the boundary. */
function browsingFallbackParent(path: string): string | null {
  if (path === '/search') return '/'
  if (path.startsWith('/axes/category/')) return '/categories'
  if (path.startsWith('/axes/store/')) return '/stores'
  if (path.startsWith('/axes/item/') || path.startsWith('/axes/label/') || path.startsWith('/axes/payment/')) {
    return '/'
  }
  return null
}

interface TopbarBackTarget {
  /** the full aria-label text (「戻る」 / 「〈親名〉へ戻る」) */
  label: string
  /** the browsing side rides router.back(); the rest push the parent */
  browsing: boolean
  to?: string
}
const topbarBack = computed<TopbarBackTarget | null>(() => {
  if (route.meta.browsingSync === true) {
    // within the app's own history the back is real; at the boundary only
    // the screens with a fallback parent keep the ‹
    if (isWithinAppHistory() || browsingFallbackParent(route.path) !== null) {
      return { label: '戻る', browsing: true }
    }
    return null
  }
  const name = route.name
  if (typeof name !== 'string') return null
  const parent = TOPBAR_BACK[name]
  return parent ? { label: `${parent.label}へ戻る`, browsing: false, to: parent.to } : null
})

// the browsing press: one press = one entry. The in-flight guard swallows a
// second press until the press's navigation lands, so a burst of presses
// never walks several entries at one boundary reading — for the back it
// releases on afterEach, for the fallback climb on the push's own settle.
const backInFlight = ref(false)
function goTopbarBack(): void {
  const back = topbarBack.value
  if (!back) return
  if (back.browsing) {
    if (backInFlight.value) return
    if (isWithinAppHistory()) {
      backInFlight.value = true
      router.back()
      return
    }
    const parent = browsingFallbackParent(route.path)
    if (parent === null) return
    // the fallback climb (a push with the back slide). Locked like the back,
    // and the boundary moves to the landing position ONLY when THIS push
    // actually lands (review REVIEW-12 #1): a cancelled push — a burst
    // superseded by another navigation — resolves as a NavigationFailure
    // and must not consume the boundary move, or the stale boundary would
    // let the next ‹ walk straight back into the screen this climb just
    // left (§2-4 comparison (iii)'s ping-pong, resurrected)
    backInFlight.value = true
    void pushToParent(router, parent)
      .then((failure) => {
        if (!failure) setHistoryBoundaryToCurrent()
      })
      .catch(() => {})
      .finally(() => {
        backInFlight.value = false
      })
    return
  }
  if (back.to !== undefined) void pushToParent(router, back.to)
}
// the back's own navigation landed — release the guard (the fallback climb
// releases on its push's settle instead; the boundary move is NOT handled
// here: it belongs to the climb's landing alone)
const removeBackAfterEach = router.afterEach(() => {
  backInFlight.value = false
})
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
  removeBackAfterEach()
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

// --- home affordances (TASK-164 §1) --------------------------------------------
// The three home entry points (the tabbar home tab, the brand logo, the
// sidebar home link) are plain links sharing this one press handler. Off
// home it is the ordinary keys-less navigation (the shared period rides
// along). ON the home route the press is the "back to base" gesture instead:
// the period returns to the default (the press-time current month, month
// mode) with NO navigation at all — the write-back paints the new keys onto
// the URL as a replace. A same-path press never fires the navKey watcher
// above, so the handler closes the drawer itself.
function onHomePress(e: MouseEvent): void {
  // a modified or non-primary press falls through to the browser's own link
  // handling (a new tab etc.) — the same guards a RouterLink applies
  if (e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.defaultPrevented || e.button !== 0) return
  e.preventDefault()
  if (route.name === 'home') {
    period.resetToDefault()
    closeDrawer()
    return
  }
  void router.push('/')
}

// --- shell page transition (TASK-74 §4-3) --------------------------------------
// The shell RouterView slides by the navigation direction: forward enters
// from the right, back from the left. A 'none' direction is not a motionless
// one since TASK-146 §3 #2: a push/pop that cannot settle a direction (the
// same-depth tab switches, the depth-less routes — /settings, apps, usage,
// manage-*) fades through the page vocabulary, and only a replace (the
// feed's scrolling id rewrite, a chip ×, a period change — history-free
// display-maintaining operations) skips the CSS machinery entirely. The key
// is the first path segment: the feed rewrites its URL while scrolling
// without remounting, the settings tabs all share 'settings' (so the shell
// never remounts and their inner fade lives on), and only a real component
// change (list -> detail) swaps — same key, different component still
// transitions.
const transitionName = computed(() => {
  if (direction.value === 'forward') return 'slide-forward'
  if (direction.value === 'back') return 'slide-back'
  return navKind.value === 'push' || navKind.value === 'pop' ? 'page' : ''
})
const pageKey = computed(() => route.path.split('/')[1] ?? '')
function onAfterEnter(): void {
  notifyPageEntered()
}
// pages report their data load through this (usePageReady); the parked scroll
// restore of a pop waits for it alongside the finished enter
provide(PAGE_READY_KEY, { markReady })
// a path change re-arms the page-ready gates for the incoming view: a new
// first segment swaps the page (both gates — its enter refires), while a
// same-segment path change (an axis → its cross axis, the list → the feed)
// keeps the page mounted — no enter fires there, so only the data gate
// re-arms and the view's reload markReady releases the parked restore.
// Without this the restore of a non-remounting pop would wait for an enter
// that never comes and die at the give-up (REVIEW-12 #5's gap); the park
// itself also re-checks once on the next task (usePageReady) for the
// markReady-beats-the-park ordering.
watch(
  () => route.path,
  (path, prev) => {
    if ((path.split('/')[1] ?? '') !== (prev.split('/')[1] ?? '')) resetPageReady()
    else resetPageData()
  },
)

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
        <!-- TASK-164 §1: one of the three home affordances — a plain link
             sharing onHomePress, whose press on the home route resets the
             period instead of navigating -->
        <a
          href="/"
          class="brand topbar-brand"
          @click="onHomePress"
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
        </a>
        <!-- the topbar ‹: the browsing history back (TASK-164 §2-4) or the
             tabbar-外 climb (TASK-124 D3) — right after the brand, right
             before the title, never next to the menu button. Icon-only; the
             semantics live in the aria-label alone -->
        <button
          v-if="topbarBack"
          type="button"
          class="icon-btn topbar-back"
          :aria-label="topbarBack.label"
          data-test="topbar-back"
          @click="goTopbarBack"
        >
          <AppIcon
            name="chevron-left"
            :size="22"
          />
        </button>
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
            <!-- TASK-164 §1: the home affordance of the sidebar — a plain
                 link sharing onHomePress (its home-route press resets the
                 period and closes the drawer instead of navigating) -->
            <a
              href="/"
              class="side-link"
              :class="{ active: section === 'home' }"
              :aria-current="route.name === 'home' ? 'page' : undefined"
              data-test="nav-home"
              @click="onHomePress"
            >
              <AppIcon :name="SECTION_TITLES.home.icon" />
              <span>{{ SECTION_TITLES.home.title }}</span>
            </a>
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
          aria-hidden="true"
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
                appear
                @after-enter="onAfterEnter"
                @after-appear="onAfterEnter"
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
        :style="{ '--tab-count': String(TAB_COUNT) }"
        :inert="drawerModal || undefined"
      >
        <!-- TASK-164 §1: the home affordance of the tabbar — a plain link
             sharing onHomePress (its home-route press resets the period
             instead of navigating) -->
        <a
          href="/"
          class="tab-link"
          :class="{ active: section === 'home' }"
          :aria-current="route.name === 'home' ? 'page' : undefined"
          @click="onHomePress"
        >
          <AppIcon
            :name="SECTION_TITLES.home.icon"
            :size="22"
          />
          <span>{{ SECTION_TITLES.home.title }}</span>
        </a>
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
