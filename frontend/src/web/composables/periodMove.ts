// The content transition's direction (TASK-146 §3): one composable watching
// the shared period store — flush:'sync' so the value is settled before the
// pages' own watchers reload — deriving the single direction value the
// ContentSwap panes receive. A mode change has no order to move along
// ('swap'); a range move compares the ISO from dates (dictionary order =
// chronological); everything else (a label change, a ledger switch, a
// same-range refetch) swaps through the fade vocabulary. The pages feed this
// into ContentSwap's `dir`; the pane itself fires only at the load commit
// (the swapKey discipline), so this value just names the move's shape.
// Review MED1: the direction serves exactly ONE commit. The composable is
// bound to the page's committedKey and consumes the value when that key
// bumps (post flush — after the pane's commit render captured the
// vocabulary), so a later page-local filter commit (a commit with no period
// move: a listQuery context, a search condition) crosses through the fade
// instead of replaying a stale slide. The derivation is never touched: the
// next step re-derives its direction along the pressed way as before.
import { ref, watch, type Ref } from 'vue'
import { usePeriodStore } from '../stores/period'

export type PeriodMoveDir = 'forward' | 'back' | 'swap'

export interface PeriodMove {
  /** the direction of the latest UNCONSUMED period change; 'swap' before
   *  any move (the first commit appears, it never slides) and again after
   *  every commit — one bump of the bound committedKey spends one move */
  dir: Ref<PeriodMoveDir>
}

export function usePeriodMove(committedKey: Ref<string>): PeriodMove {
  const period = usePeriodStore()
  const dir = ref<PeriodMoveDir>('swap')
  let prevMode = period.mode
  let prevFrom = period.range[0]
  watch(
    // labelQuery rides along so a range-preserving change (a label switch,
    // a ledger switch resetting the labels) still settles as 'swap'
    () => [period.mode, period.range[0], period.labelQuery] as const,
    ([mode, from]) => {
      if (mode !== prevMode) dir.value = 'swap'
      else if (from > prevFrom) dir.value = 'forward'
      else if (from < prevFrom) dir.value = 'back'
      else dir.value = 'swap'
      prevMode = mode
      prevFrom = from
    },
    { flush: 'sync' },
  )
  // the consumption: the load commit (the committedKey bump) spends the
  // direction. 'post' is load-bearing — the reset must land only after the
  // flush's render jobs, where the pane captured the vocabulary; a sync or
  // pre watcher would strip the direction before the commit render reads it
  watch(
    committedKey,
    () => {
      dir.value = 'swap'
    },
    { flush: 'post' },
  )
  return { dir }
}
