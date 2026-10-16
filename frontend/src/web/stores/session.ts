import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { authApi, type Me } from '../api/auth'

// Web session state (API driven): the logged-in user from GET /api/auth/me,
// the ledger the data screens work on (local choice; spec_auth.md 6 keeps
// the web side independent from the MCP grant selection), and the step-up
// dialog request (spec_auth.md 2-6).
export const useSessionStore = defineStore('web-session', () => {
  const me = ref<Me | null>(null)
  const selectedLedgerId = ref<number | null>(null)
  const stepUpOpen = ref(false)
  let stepUpWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []

  const selectedLedger = computed(
    () => me.value?.ledgers.find((l) => l.id === selectedLedgerId.value) ?? null,
  )
  const selectedLedgerColor = computed(() => selectedLedger.value?.color ?? null)

  function setMe(value: Me): void {
    me.value = value
    // Keep the current choice while it is still a membership; otherwise fall
    // back to the default ledger, then to the first membership (TASK-16).
    if (value.ledgers.some((l) => l.id === selectedLedgerId.value)) return
    selectedLedgerId.value =
      (value.default_ledger_id !== null &&
      value.ledgers.some((l) => l.id === value.default_ledger_id)
        ? value.default_ledger_id
        : value.ledgers[0]?.id) ?? null
  }

  /** Load the user; false when there is no valid session. */
  async function loadMe(): Promise<boolean> {
    try {
      setMe(await authApi.me({ authOptional: true }))
      return true
    } catch {
      me.value = null
      return false
    }
  }

  function clear(): void {
    me.value = null
  }

  /** Open the step-up dialog; resolves after a successful re-auth. */
  function requestStepUp(): Promise<void> {
    stepUpOpen.value = true
    return new Promise<void>((resolve, reject) => {
      stepUpWaiters.push({ resolve, reject })
    })
  }

  function finishStepUp(ok: boolean): void {
    const waiters = stepUpWaiters
    stepUpWaiters = []
    stepUpOpen.value = false
    for (const w of waiters) {
      if (ok) w.resolve()
      else w.reject(new Error('step-up cancelled'))
    }
  }

  return {
    me,
    selectedLedgerId,
    selectedLedger,
    selectedLedgerColor,
    stepUpOpen,
    setMe,
    loadMe,
    clear,
    requestStepUp,
    finishStepUp,
  }
})
