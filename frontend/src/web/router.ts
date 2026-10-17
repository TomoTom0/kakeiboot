import { createRouter, type RouterHistory, type RouteRecordRaw } from 'vue-router'
import type { Pinia } from 'pinia'
import { useSessionStore } from './stores/session'

// Screens. `public` routes render without a session: the login / register
// screens are pre-login and the consent screen sends a 401 to
// /login?req=<R> itself (spec_auth.md 4-2). All components are imported
// synchronously (TASK-39 B): the pages are small enough that the extra
// chunks only bought a first-visit delay on every navigation.
import AppsPage from './pages/AppsPage.vue'
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
import SettingsPage from './pages/SettingsPage.vue'
import StoresPage from './pages/StoresPage.vue'
import UsageConnectPage from './pages/UsageConnectPage.vue'
import UsagePage from './pages/UsagePage.vue'
import AuthPanel from './pages/settings/AuthPanel.vue'
import DataPanel from './pages/settings/DataPanel.vue'
import GeneralPanel from './pages/settings/GeneralPanel.vue'
import OthersPanel from './pages/settings/OthersPanel.vue'

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginPage, meta: { public: true } },
  { path: '/register', name: 'register', component: RegisterPage, meta: { public: true } },
  { path: '/oauth/consent', name: 'consent', component: ConsentPage, meta: { public: true } },
  { path: '/', name: 'home', component: HomePage },
  // /settings is a nested parent: the horizontal tab strip renders once and
  // the child panel is the route content. Four tabs after the real-device
  // feedback (general / auth / data / others); /settings itself redirects to
  // the general tab. The manage screens keep their URL and route names (deep
  // links and the view-screen manage links stay intact) and light the data
  // tab as their way back.
  {
    path: '/settings',
    component: SettingsPage,
    children: [
      { path: '', redirect: '/settings/general' },
      { path: 'general', name: 'settings-general', component: GeneralPanel },
      { path: 'auth', name: 'settings-auth', component: AuthPanel },
      { path: 'data', name: 'settings-data', component: DataPanel },
      { path: 'others', name: 'settings-others', component: OthersPanel },
      { path: 'categories', name: 'manage-categories', component: ManageCategoriesPage },
      { path: 'stores', name: 'manage-stores', component: ManageStoresPage },
      { path: 'labels', name: 'manage-labels', component: ManageLabelsPage },
    ],
  },
  { path: '/apps', name: 'apps', component: AppsPage },
  // Usage pages (TASK-37): no meta.public — they sit behind the session
  // guard like the rest of the app screens.
  { path: '/usage', name: 'usage', component: UsagePage },
  { path: '/usage/connect', name: 'usage-connect', component: UsageConnectPage },
  { path: '/categories', name: 'categories', component: CategoriesPage },
  { path: '/stores', name: 'stores', component: StoresPage },
  { path: '/receipts', name: 'receipts', component: ReceiptsPage },
  {
    path: '/receipts/:id(\\d+)',
    name: 'receipt',
    component: ReceiptDetailPage,
    props: (r) => ({ id: Number(r.params.id) }),
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export function createAppRouter(history: RouterHistory, pinia: Pinia) {
  const router = createRouter({ history, routes })
  router.beforeEach(async (to) => {
    if (to.meta.public) return true
    const session = useSessionStore(pinia)
    if (session.me) return true
    return (await session.loadMe()) ? true : { path: '/login' }
  })
  return router
}
