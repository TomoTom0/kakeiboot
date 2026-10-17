import { computed, watch } from 'vue'
import { useSessionStore } from '../stores/session'

/** Selected ledger id for the data screens; `onChange` runs now and on switch. */
export function useLedger(onChange: (ledgerId: number) => void | Promise<void>) {
  const session = useSessionStore()
  const ledgerId = computed(() => session.selectedLedgerId)
  watch(
    ledgerId,
    (id) => {
      if (id !== null) void onChange(id)
    },
    { immediate: true },
  )
  return ledgerId
}
