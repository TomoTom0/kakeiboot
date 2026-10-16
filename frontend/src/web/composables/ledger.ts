import { computed, watch } from 'vue'
import type { LedgerColor } from '../api/auth'
import { useSessionStore } from '../stores/session'

// Ledger display colors (TASK-16 item 3): a 6-color palette assigned per
// user (ledger_members.color). Keys deliberately avoid the label palette of
// TASK-17 (red / yellow / green / blue / purple); the shape differs too
// (rounded chip + book icon, never a dot).
export const LEDGER_COLOR_NAMES: Record<LedgerColor, string> = {
  teal: 'ティール',
  orange: 'オレンジ',
  pink: 'ピンク',
  brown: 'ブラウン',
  slate: 'スレート',
  graphite: 'グラファイト',
}

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
