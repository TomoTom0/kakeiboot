import type { Router } from 'vue-router'
import { configureHttp } from './api/http'
import { useSessionStore } from './stores/session'
import type { Pinia } from 'pinia'

// Wire the fetch wrapper hooks to the app: an expired session returns to
// the login screen, a step-up request opens the re-auth dialog.
export function installHttpHooks(router: Router, pinia: Pinia): void {
  const session = useSessionStore(pinia)
  configureHttp({
    onUnauthorized: () => {
      session.clear()
      if (!router.currentRoute.value.meta.public) void router.replace({ path: '/login' })
    },
    onReauthRequired: () => session.requestStepUp(),
  })
}
