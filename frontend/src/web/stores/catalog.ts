import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { Catalog, CategoryKind, CategoryNode } from '../api/data'
import { useDataApi } from '../api/data'
import { useSessionStore } from './session'

// Catalog trees of the selected ledger (TASK-74 §4-4): one getCatalog(l,
// false) per ledger, cached and shared by the screens that turn category
// paths into route ids and back (stats `category` takes a path; the
// hierarchy routes take ids). The cache is dropped when the ledger changes
// and when a navigation leaves /settings (the manage screens may have
// renamed / moved / archived nodes — the router registers that hook).
// MCP-side edits stay undetected: the fetch only happens on a cold cache,
// so a stale path can 400 on the stats call — accepted, the page's error
// message shows it and a reload recovers.
export const useCatalogStore = defineStore('web-catalog', () => {
  const session = useSessionStore()
  const byLedger = ref(new Map<number, Catalog>())
  const loading = new Map<number, Promise<void>>()

  /** Fetch the selected ledger's catalog once (active categories only). */
  async function load(): Promise<void> {
    const id = session.selectedLedgerId
    if (id === null) return
    if (byLedger.value.has(id)) return
    let p = loading.get(id)
    if (!p) {
      p = (async () => {
        try {
          byLedger.value.set(id, await useDataApi().getCatalog(id, false))
        } finally {
          loading.delete(id)
        }
      })()
      loading.set(id, p)
    }
    await p
  }

  function trees(kind: CategoryKind): CategoryNode[] {
    const id = session.selectedLedgerId
    const catalog = id !== null ? byLedger.value.get(id) : undefined
    return (catalog?.[kind === 'item' ? 'item_categories' : 'store_categories']) ?? []
  }

  /** Depth-first over the forest; the first non-null visit result wins. */
  function search<T>(
    kind: CategoryKind,
    visit: (node: CategoryNode, parent: CategoryNode | null) => T | null,
  ): T | null {
    const descend = (nodes: CategoryNode[], parent: CategoryNode | null): T | null => {
      for (const n of nodes) {
        const hit = visit(n, parent) ?? descend(n.children, n)
        if (hit !== null) return hit
      }
      return null
    }
    return descend(trees(kind), null)
  }

  function nodeById(kind: CategoryKind, id: number): CategoryNode | null {
    return search(kind, (n) => (n.id === id ? n : null))
  }

  /** "大分類/小分類" — the parent names joined with `/` (a top: its name). */
  function pathOf(kind: CategoryKind, id: number): string | null {
    return search(kind, (n, p) => (n.id === id ? (p ? `${p.name}/${n.name}` : n.name) : null))
  }

  function parentIdOf(kind: CategoryKind, id: number): number | null {
    // a top's parent is null — the same "miss" value, which only makes the
    // scan continue and return null in the end
    return search(kind, (n, p) => (n.id === id ? (p?.id ?? null) : null))
  }

  function childrenOf(kind: CategoryKind, id: number): CategoryNode[] {
    return nodeById(kind, id)?.children ?? []
  }

  /** Path ("大分類" or "大分類/小分類") → node; null when any segment misses. */
  function resolve(kind: CategoryKind, path: string): CategoryNode | null {
    let nodes = trees(kind)
    let node: CategoryNode | null = null
    for (const part of path.split('/')) {
      node = nodes.find((n) => n.name === part) ?? null
      if (!node) return null
      nodes = node.children
    }
    return node
  }

  /** Drop the cached catalogs (manual; the ledger switch and the settings
   * exit hook call this on their own). In-flight loads are dropped too: a
   * promise that resolves after this must not pass its pre-invalidate fetch
   * off as the cache — the next load() starts a fresh one instead of
   * awaiting (and adopting) the stale one. */
  function invalidate(): void {
    byLedger.value.clear()
    loading.clear()
  }

  // a ledger switch must not serve the previous ledger's tree
  watch(
    () => session.selectedLedgerId,
    () => byLedger.value.clear(),
  )

  return { load, trees, nodeById, pathOf, resolve, parentIdOf, childrenOf, invalidate }
})
