import { createRouter, type RouterHistory, type RouteRecordRaw } from 'vue-router'
import type { Pinia } from 'pinia'
import { navKind, pendingRestore, updateDirection } from './composables/navDirection'
import { useCatalogStore } from './stores/catalog'
import { useSessionStore } from './stores/session'

// Route meta drives the shell (TASK-74 §4-2): `section` picks the topbar
// title / nav active / ledger color band, `depth` is the hierarchy depth of
// the browsing routes (unset on manage / public screens — the depth
// comparisons of the transition direction never match and those navigations
// stay direction-less), `ledgerScoped` shows the ledger switcher.
// `browsingSync` (TASK-124 D2-3) marks the routes whose period mode keys and
// labels= the shell-level URL sync composable keeps in the URL — its own
// flag, NOT a reuse of `filters`, so the feed (/receipts/:id, filters: true)
// cannot be swept into the sync: its URL is the CONTEXT_FIELDS context and
// importing from/to would re-mode the store away from the list's period.
declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean
    filters?: boolean
    browsingSync?: boolean
    section?: string
    depth?: number
    ledgerScoped?: boolean
  }
}

// Screens. `public` routes render without a session: the login / register
// screens are pre-login and the consent screen sends a 401 to
// /login?req=<R> itself (spec_auth.md 4-2). All components are imported
// synchronously (TASK-39 B): the pages are small enough that the extra
// chunks only bought a first-visit delay on every navigation.
import AppsPage from './pages/AppsPage.vue'
import AxisDetailPage from './pages/AxisDetailPage.vue'
import CategoriesPage from './pages/CategoriesPage.vue'
import ConsentPage from './pages/ConsentPage.vue'
import HomePage from './pages/HomePage.vue'
import LoginPage from './pages/LoginPage.vue'
import ManageCategoriesPage from './pages/ManageCategoriesPage.vue'
import ManageLabelsPage from './pages/ManageLabelsPage.vue'
import ManageStoresPage from './pages/ManageStoresPage.vue'
import ReceiptDetailPage from './pages/ReceiptDetailPage.vue'
import ReceiptsPage from './pages/ReceiptsPage.vue'
import RegisterPage from './pages/RegisterPage.vue'
import SearchPage from './pages/SearchPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import StoresPage from './pages/StoresPage.vue'
import UsagePage from './pages/UsagePage.vue'
import UsageTopicPage from './pages/UsageTopicPage.vue'
import AuthPanel from './pages/settings/AuthPanel.vue'
import DataPanel from './pages/settings/DataPanel.vue'
import GeneralPanel from './pages/settings/GeneralPanel.vue'
import OthersPanel from './pages/settings/OthersPanel.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginPage, meta: { public: true } },
  { path: '/register', name: 'register', component: RegisterPage, meta: { public: true } },
  { path: '/oauth/consent', name: 'consent', component: ConsentPage, meta: { public: true } },
  // `filters` marks the browsing routes that carry the topbar center filter
  // bar (TASK-44 §11-3): set explicitly on the enumerated view routes — not
  // shared with the ledgerScoped notion — so manage-* / apps / usage and the
  // public screens never get it.
  { path: '/', name: 'home', component: HomePage, meta: { filters: true, browsingSync: true, section: 'home', depth: 1, ledgerScoped: true } },
  // /settings is a nested parent: the horizontal tab strip renders once and
  // the child panel is the route content. Four tabs after the real-device
  // feedback (general / auth / data / others); /settings itself redirects to
  // the general tab. The manage screens keep their URL and route names (deep
  // links and the view-screen manage links stay intact) and light the data
  // tab as their way back. The whole tree shares the settings section
  // (TASK-74 §4-2); only manage-* adds the ledger scope (its data is
  // ledger-bound, the plain settings tabs are not).
  {
    path: '/settings',
    component: SettingsPage,
    meta: { section: 'settings' },
    children: [
      { path: '', redirect: '/settings/general' },
      { path: 'general', name: 'settings-general', component: GeneralPanel },
      { path: 'auth', name: 'settings-auth', component: AuthPanel },
      { path: 'data', name: 'settings-data', component: DataPanel },
      { path: 'others', name: 'settings-others', component: OthersPanel },
      { path: 'categories', name: 'manage-categories', component: ManageCategoriesPage, meta: { ledgerScoped: true } },
      { path: 'stores', name: 'manage-stores', component: ManageStoresPage, meta: { ledgerScoped: true } },
      { path: 'labels', name: 'manage-labels', component: ManageLabelsPage, meta: { ledgerScoped: true } },
    ],
  },
  { path: '/apps', name: 'apps', component: AppsPage, meta: { section: 'apps' } },
  // Usage pages (TASK-37, reworked by TASK-141): /usage lists the topics, one
  // dynamic route renders every topic from the build-time-ingested docs/usage
  // corpus — adding a topic is a file, not a route (TASK-135 §2-3). The
  // existing /usage/connect URL resolves through this route. No meta.public:
  // they sit behind the session guard like the rest of the app screens.
  { path: '/usage', name: 'usage', component: UsagePage, meta: { section: 'usage' } },
  { path: '/usage/:topic', name: 'usage-topic', component: UsageTopicPage, meta: { section: 'usage' }, props: (r) => ({ slug: String(r.params.topic) }) },
  { path: '/categories', name: 'categories', component: CategoriesPage, meta: { filters: true, browsingSync: true, section: 'categories', depth: 1, ledgerScoped: true } },
  { path: '/stores', name: 'stores', component: StoresPage, meta: { filters: true, browsingSync: true, section: 'stores', depth: 1, ledgerScoped: true } },
  // The axis detail pages (TASK-89 §3): one component serves the five axes —
  // the category hierarchy (static uncategorized first so it never matches
  // :top), the store by id, and the name-keyed item / label / payment axes.
  // ids in the path keep the depth a static route property; the sections
  // reuse categories / stores so the sidebar / tabbar active stays aligned.
  // The legacy /categories/:top and /stores/:id detail URLs are gone (the
  // redirect compatibility was dropped by design) — an unknown path falls
  // through to the catch-all redirect to /.
  { path: '/axes/category/uncategorized', name: 'axis-category-uncategorized', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'categories', depth: 2, ledgerScoped: true } },
  { path: '/axes/category/:top(\\d+)', name: 'axis-category', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'categories', depth: 2, ledgerScoped: true } },
  { path: '/axes/category/:top(\\d+)/:sub(\\d+)', name: 'axis-subcategory', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'categories', depth: 3, ledgerScoped: true } },
  { path: '/axes/store/:id(\\d+)', name: 'axis-store', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'stores', depth: 2, ledgerScoped: true } },
  // the name-keyed axes have no list screens of their own — they light the
  // home section
  { path: '/axes/item/:name', name: 'axis-item', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'home', depth: 2, ledgerScoped: true } },
  { path: '/axes/label/:color', name: 'axis-label', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'home', depth: 2, ledgerScoped: true } },
  { path: '/axes/payment/:method', name: 'axis-payment', component: AxisDetailPage, meta: { filters: true, browsingSync: true, section: 'home', depth: 2, ledgerScoped: true } },
  { path: '/receipts', name: 'receipts', component: ReceiptsPage, meta: { filters: true, browsingSync: true, section: 'receipts', depth: 1, ledgerScoped: true } },
  {
    path: '/receipts/:id(\\d+)',
    name: 'receipt',
    component: ReceiptDetailPage,
    meta: { filters: true, section: 'receipts', depth: 2, ledgerScoped: true },
    props: (r) => ({ id: Number(r.params.id) }),
  },
  // /search (TASK-41): the URL (q / tab / scope + the shared period and
  // labels keys) restores the results; the topbar search chip leads here.
  // browsingSync rides too (TASK-124 D2): labels= always, the period keys
  // only while scope=period (the composable checks the scope itself)
  { path: '/search', name: 'search', component: SearchPage, meta: { filters: true, browsingSync: true, section: 'search', depth: 1, ledgerScoped: true } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export function createAppRouter(history: RouterHistory, pinia: Pinia) {
  const router = createRouter({
    history,
    routes,
    // A push to another page starts at the top; a pop parks its saved
    // position for the page-ready gates (after-enter + markReady) to release
    // (TASK-74 §4-3) — restoring here would land before the incoming page
    // has rendered its data and the position would drift. A replace (the
    // history position unchanged: the feed's scrolling id rewrite, a chip ×,
    // a period change, /search's debounce) and a same-pageKey navigation
    // (the first path segment — the page stays mounted: /categories/1/5 →
    // /categories/1, the list → the feed, which self-positions at its anchor
    // panel) must not touch the scroll at all: scrolling to the top on every
    // replace yanked the continuous feed back to its start (D28 §4-3 rule 1:
    // replace → none). navKind lands before this runs — scrollBehavior is
    // deferred to the next tick, after afterEach has compared the positions.
    scrollBehavior(to, from, savedPosition) {
      if (savedPosition) {
        pendingRestore.value = savedPosition.top
        return false
      }
      if (navKind.value === 'replace') return false
      if ((to.path.split('/')[1] ?? '') === (from.path.split('/')[1] ?? '')) return false
      return { top: 0 }
    },
  })
  router.beforeEach(async (to) => {
    if (to.meta.public) return true
    const session = useSessionStore(pinia)
    if (session.me) return true
    return (await session.loadMe()) ? true : { path: '/login' }
  })
  // the direction lands before the DOM patch of the same tick, so the
  // transition name is already the new navigation's when the pages swap
  router.afterEach((to, from, failure) => updateDirection(to, from, failure))
  // leaving the manage screens drops the catalog cache (TASK-74 §4-4): the
  // manage screens may have renamed / moved / archived nodes, so the next
  // catalog access refetches. Navigations within /settings keep it.
  router.afterEach((to, from) => {
    if (from.path.startsWith('/settings') && !to.path.startsWith('/settings')) {
      useCatalogStore(pinia).invalidate()
    }
  })
  return router
}
