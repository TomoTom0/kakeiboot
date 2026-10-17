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
      if (router.currentRoute.value.meta.public) {
        session.clear()
        return
      }
      // Navigate first, clear after (TASK-39 A-3): the route flip and the
      // shell removal render in the same frame. A failed navigation (guard
      // abort) still clears the now-invalid session.
      void router
        .replace({ path: '/login' })
        .catch(() => {})
        .finally(() => session.clear())
    },
    onReauthRequired: () => session.requestStepUp(),
  })
}
