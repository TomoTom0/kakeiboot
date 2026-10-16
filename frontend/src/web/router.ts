import { createRouter, type RouterHistory, type RouteRecordRaw } from 'vue-router'
import type { Pinia } from 'pinia'
import { useSessionStore } from './stores/session'

// Screens. `public` routes render without a session: the login / register
// screens are pre-login and the consent screen sends a 401 to
// /login?req=<R> itself (spec_auth.md 4-2).
export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./pages/LoginPage.vue'), meta: { public: true } },
  { path: '/register', name: 'register', component: () => import('./pages/RegisterPage.vue'), meta: { public: true } },
  { path: '/oauth/consent', name: 'consent', component: () => import('./pages/ConsentPage.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('./pages/HomePage.vue') },
  { path: '/settings', name: 'settings', component: () => import('./pages/SettingsPage.vue') },
  { path: '/settings/categories', name: 'manage-categories', component: () => import('./pages/ManageCategoriesPage.vue') },
  { path: '/settings/stores', name: 'manage-stores', component: () => import('./pages/ManageStoresPage.vue') },
  { path: '/settings/labels', name: 'manage-labels', component: () => import('./pages/ManageLabelsPage.vue') },
  { path: '/apps', name: 'apps', component: () => import('./pages/AppsPage.vue') },
  { path: '/categories', name: 'categories', component: () => import('./pages/CategoriesPage.vue') },
  { path: '/stores', name: 'stores', component: () => import('./pages/StoresPage.vue') },
  { path: '/receipts', name: 'receipts', component: () => import('./pages/ReceiptsPage.vue') },
  {
    path: '/receipts/:id(\\d+)',
    name: 'receipt',
    component: () => import('./pages/ReceiptDetailPage.vue'),
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
