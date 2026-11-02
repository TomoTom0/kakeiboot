// Shell-level URL sync of the browsing state (TASK-124 design D2): the
// period mode keys (month= / week= / year= / from&to — the mode key is the
// truth, from/to a derived value, D2-4) and labels= ride the URL on the
// routes marked `meta.browsingSync` (the browsing five + /search), in both
// directions, from one place in App.vue so the pages keep only their
// re-query watches.
//
// Import (URL -> store, D2-1/D2-2): fires on EVERY navigation (route watch,
// pops included — a browser back lands on the entry's final URL and the
// store follows it), but ONLY while the URL actually carries the keys: a
// keys-less entry (tabbar, first paint, a bare deep link, the ‹ push) keeps
// the store's current value — the shared "画面間で共有" behavior — and the
// write-back below puts it on the URL at once instead of resetting it.
//
// Write-back (store -> URL, D2-6): every write is a router.replace (no
// history entry, navKind 'replace' → no slide, no scroll) behind a diff
// guard — the keys the composable owns are only written when the URL's
// current values differ from the store, so an import that agrees with the
// store and the echo of our own replace never issue another navigation.
// /search writes the period keys only while scope=period (D1 — with
// scope=all the period never affects the results) and drops a stray
// inflow's period keys on the first write-back (TASK-145 D1-2 — the rule
// holds on both write sides: never written, never kept).
//
// The feed (/receipts/:id) is outside both directions by construction: its
// routes carry no `browsingSync` (D2-3 — reusing meta.filters would sweep it
// in), so its CONTEXT_FIELDS URL stays the truth and the store keeps the
// list's period. /receipts' filter sync writes only the filter keys and
// from/to (D2-5), never the mode keys or labels — those belong here.
import { watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { formatLabelQuery, parseLabelQuery } from '@/shared/labels'
import { firstString } from './receiptContext'
import { usePeriodStore } from '../stores/period'

/** The period keys this composable owns. */
const PERIOD_KEYS = ['month', 'week', 'year', 'from', 'to'] as const

/** A query value as the URL comparison form: the first string, null when the
 *  key is absent (arrays keep their head — the write side never emits one). */
function queryText(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null
  return typeof v === 'string' ? v : null
}

/** True when every owned key of `next` already matches `current` (the diff
 *  guard of D2-6 — comparing only the keys this composable writes, so an
 *  unrelated key change never reads as a diff). */
function ownedKeysMatch(next: LocationQueryRaw, current: LocationQueryRaw, keys: readonly string[]): boolean {
  return keys.every((k) => queryText(next[k]) === queryText(current[k]))
}

export function useBrowsingUrlSync(): void {
  const route = useRoute()
  const router = useRouter()
  const period = usePeriodStore()

  /** The sync target (D2-3): routes opted in via meta.browsingSync — the
   *  feed and every non-browsing screen answer false structurally. */
  function isTarget(): boolean {
    return route.meta.browsingSync === true
  }

  /** /search carries the period keys only while scope=period (D1). */
  function writesPeriod(): boolean {
    return route.name !== 'search' || firstString(route.query.scope) === 'period'
  }

  function writeBack(): void {
    if (!isTarget()) return
    const next: LocationQueryRaw = { ...route.query }
    const owned: string[] = ['labels']
    const writes = writesPeriod()
    if (writes) {
      // swap the whole mode-key set on every target route alike: the new
      // mode's key only, every other mode's key dropped (month= never
      // lingers next to year=, and a from/to pair the /receipts filter sync
      // wrote for an earlier period does not survive a period change — the
      // URL stays self-consistent, the mode key is the truth, D2-4)
      for (const k of PERIOD_KEYS) delete next[k]
      Object.assign(next, period.urlQuery)
      owned.push(...PERIOD_KEYS)
    } else {
      // /search with scope=all never writes the period keys — and never
      // keeps them either (TASK-145 D1-2): a stray inflow that carries them
      // (an old bookmark, a shared /search?month= link) is stripped at the
      // first write-back, so the rule holds on both write sides
      for (const k of PERIOD_KEYS) delete next[k]
    }
    delete next.labels
    if (period.labelColors.length > 0) next.labels = formatLabelQuery(period.labelColors)
    // diff guard: an import that agrees with the URL, or the echo of our own
    // replace, stops here — no navigation is issued. The guard compares the
    // owned keys only, and on the strip side above the period keys are not
    // owned — so a PERIOD_KEY the current URL still holds counts as a diff
    // on its own: with no labels diff the deletion alone would read as "no
    // diff" and the stale bookmark shape would survive (review MED1)
    const strayPeriodKeys = !writes && PERIOD_KEYS.some((k) => k in route.query)
    if (ownedKeysMatch(next, route.query, owned) && !strayPeriodKeys) return
    void router.replace({ query: next })
  }

  // Import on every navigation of a target route (immediate: the initial
  // mount lands here too — the pages set up after this, so the store is
  // already in the URL's shape when they read it)
  watch(
    () => route.fullPath,
    () => {
      if (!isTarget()) return
      if (PERIOD_KEYS.some((k) => k in route.query)) period.fromQuery(route.query)
      if ('labels' in route.query) {
        const url = parseLabelQuery(firstString(route.query.labels) ?? '')
        // an identical selection is not re-imported: setLabelColors always
        // assigns a fresh array, which would flip labelQuery's identity and
        // re-run the pages' load() on our own write-back's echo (a keys-less
        // entry write-back doubles the fetch of every screen otherwise)
        if (url.join(',') !== period.labelColors.join(',')) period.setLabelColors(url)
      }
      // a keys-less entry keeps the store and rides the URL at once (D2-1);
      // an entry that imported agrees and the guard skips the write
      writeBack()
    },
    { immediate: true },
  )

  // The store moved (the period chip, a trend bar press, the label dialog):
  // put the owned keys on the URL — a replace, so the history keeps the
  // screen entries and the browser back returns per entry (D2-2)
  watch(
    [
      () => period.mode,
      () => period.month,
      () => period.week,
      () => period.year,
      () => period.from,
      () => period.to,
      () => period.labelColors,
    ],
    () => writeBack(),
  )
}
