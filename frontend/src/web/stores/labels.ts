import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Label, LabelColor } from '@/shared/labels'
import { LABEL_COLORS } from '@/shared/labels'
import { useDataApi } from '../api/data'
import { useSessionStore } from './session'

// Label definitions (title per color) of the selected ledger (TASK-17).
// Definitions are ledger-wide and change rarely; this store caches them per
// ledger so the picker / filter / manage screens share one fetch. Titles are
// cosmetic: failures are swallowed and the color-name-only fallback is used.
export const useLabelsStore = defineStore('web-labels', () => {
  const session = useSessionStore()
  const byLedger = ref(new Map<number, Label[]>())
  const loading = new Map<number, Promise<void>>()

  async function load(ledgerId: number): Promise<void> {
    if (byLedger.value.has(ledgerId)) return
    let p = loading.get(ledgerId)
    if (!p) {
      p = (async () => {
        try {
          const res = await useDataApi().listLabels(ledgerId)
          byLedger.value.set(ledgerId, res.labels)
        } catch {
          // keep the color-name-only fallback
        } finally {
          loading.delete(ledgerId)
        }
      })()
      loading.set(ledgerId, p)
    }
    await p
  }

  /** Definitions of a ledger in display order (color-only until loaded). */
  function definitions(ledgerId: number): Label[] {
    return cached(ledgerId) ?? LABEL_COLORS.map((color) => ({ color, title: null }))
  }

  /** The fetched definitions of a ledger, or null until the fetch settles
   * (no fallback). Screens that must not mistake the color-only fallback for
   * the real definitions (the manage screen input seeding) use this. */
  function cached(ledgerId: number): Label[] | null {
    return byLedger.value.get(ledgerId) ?? null
  }

  /** Apply a saved title to the cache (the manage screen saves through the API). */
  function rename(ledgerId: number, color: LabelColor, title: string | null): void {
    const cached = byLedger.value.get(ledgerId)
    if (!cached) return
    byLedger.value.set(
      ledgerId,
      cached.map((l) => (l.color === color ? { color, title } : l)),
    )
  }

  // Load the definitions of the selected ledger now and on every switch.
  watch(
    () => session.selectedLedgerId,
    (id) => {
      if (id !== null) void load(id)
    },
    { immediate: true },
  )

  const selected = computed(() => definitions(session.selectedLedgerId ?? -1))

  return { load, definitions, cached, rename, selected }
})
