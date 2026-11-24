import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { LabelColor } from '@/shared/labels'
import type { AnalysisQuery } from '../api/data'
import { jstMonth, jstToday, monthEnd, monthLabel, shiftDate, shiftMonth, shortDate, weekStart } from '../composables/period'
import { useSessionStore } from './session'

export interface PeriodOperation {
  operationId: number
  cause: 'user' | 'import' | 'system'
  keys: Record<string, string>
  labels: LabelColor[]
}

export type PeriodMode = 'month' | 'week' | 'year' | 'range'

/** Issue #9: how long a home entry may be away from the last period
 * activity and still inherit the standing period ("ごく短時間" — a quick
 * hop to another screen and back). Beyond this window the home screen
 * starts from the current month instead of resurrecting the old period.
 * Defined here, next to the activity clock it is compared against; the
 * browsing URL sync is its only consumer. */
export const HOME_FRESH_WINDOW_MS = 10 * 60 * 1000

// The period the dashboard-style screens (home / receipts / categories /
// stores) look at. Shared so switching screens keeps the same period. TASK-17 adds
// the label filter as a second shared dimension: Home / Categories / Stores
// read it from here (they carry no filter URL of their own), while the
// receipts list and the feed use the URL query "labels" as the source of
// truth (the list syncs both ways, design 2-5 L3).
export const usePeriodStore = defineStore('web-period', () => {
  const session = useSessionStore()
  const thisMonth = jstMonth()
  const mode = ref<PeriodMode>('month')
  const month = ref(thisMonth)
  const week = ref(weekStart(jstToday())) // TASK-53: the selected week's Monday
  const year = ref(Number(thisMonth.slice(0, 4)))
  const from = ref(`${thisMonth}-01`)
  const to = ref(monthEnd(thisMonth))

  // --- label filter (TASK-17) -------------------------------------------------
  const labelColors = ref<LabelColor[]>([])
  /** set once the filter has been used or reset: [] is then sent explicitly */
  const labelDirty = ref(false)
  /**
   * Label part of a stats query. undefined while the filter has never been
   * used (the key is omitted entirely), an explicit [] after a reset so the
   * dashboards re-query with "no label filter".
   */
  const labelQuery = computed<LabelColor[] | undefined>(() =>
    labelDirty.value || labelColors.value.length > 0 ? [...labelColors.value] : undefined,
  )

  function setLabelColors(colors: LabelColor[]): void {
    const before = stateKey()
    try {
      labelColors.value = [...colors]
      labelDirty.value = true
    } finally {
      notify(before, 'system')
    }
  }

  // Labels belong to a ledger: switching the book resets the shared filter.
  // The initial selection (null -> id) is not a switch.
  // flush: 'sync' makes the reset land BEFORE the pages' useLedger watchers
  // reload — their relative scheduler order is not guaranteed (it depends on
  // the component-tree uid allocation, and the reset ran after the reload
  // once App.vue gained one more wrapper component: TASK-39 branch
  // transition), which sent the stale label filter to the new ledger.
  watch(
    () => session.selectedLedgerId,
    (_id, prev) => {
      if (prev === null || prev === undefined) return
      setLabelColors([])
    },
    { flush: 'sync' },
  )

  /** Inclusive date range of the selected period. */
  const range = computed<[string, string]>(() => {
    if (mode.value === 'month') return [`${month.value}-01`, monthEnd(month.value)]
    if (mode.value === 'week') return [week.value, shiftDate(week.value, 6)]
    if (mode.value === 'year') return [`${year.value}-01-01`, `${year.value}-12-31`]
    return [from.value, to.value]
  })

  const label = computed(() => {
    if (mode.value === 'month') return monthLabel(month.value)
    if (mode.value === 'week') {
      const [y, m, d] = week.value.split('-').map(Number) as [number, number, number]
      return `${y}年${m}月${d}日の週`
    }
    if (mode.value === 'year') return `${year.value}年`
    return `${from.value.replaceAll('-', '/')} 〜 ${to.value.replaceAll('-', '/')}`
  })

  /**
   * Narrow-band label for the topbar period chip (TASK-44 §11-4): "10月" /
   * "26年" / "10/3〜" (the from date only). A plain string — which width band
   * shows it is a CSS media-query concern, not a store one.
   */
  const labelShort = computed(() => {
    if (mode.value === 'month') return `${Number(month.value.slice(5))}月`
    if (mode.value === 'week') return `${shortDate(week.value)}週`
    if (mode.value === 'year') return `${String(year.value).slice(2)}年`
    return `${shortDate(from.value)}〜`
  })

  // --- committed display snapshot -----------------------------------------
  // The display surfaces (the pages' period headers, the topbar chip, the
  // trend's current-month highlight) show the period the DISPLAYED data
  // belongs to, never the working period: a step press moves the working
  // period at once, and a label that runs ahead of its data reads as the
  // wrong month's numbers under the new month's name. Pages call
  // commitLabel() at their load commit (the same instant their data and
  // committedKey land); until the first commit the live values show.
  const committedSnapshot = ref<{ label: string; labelShort: string; month: string; periodKey: string; mode: PeriodMode; anchor: string } | null>(null)
  // the travel direction of the latest period commit (+1 toward the
  // future, -1 toward the past, 0 when the anchors are not comparable —
  // a mode switch or a range): the arrival animation slides from the
  // side the user stepped toward
  const commitDirection = ref(0)
  // A period commit changes the screen as ONE animated arrival (the
  // user's verdict, 2026-11-24: the change must be animated — a silent
  // hard cut feels broken — and the animation must carry the finished
  // state, never a half-changed one: no label ahead of its data, no old
  // rows inside the new list, no number counting over from the previous
  // period). committedEpoch bumps ONLY when a commit changes the period
  // itself; value displays key their instant-landing off it, so inside
  // the arriving state every value is already final. commitMotion rides
  // the same commits as the suppression window: while it is up, every
  // per-element transition inside the view's blocks is suppressed, and
  // App.vue drives the one arrival animation (Web Animations API) off
  // the epoch bump, so the commit has exactly one motion.
  const committedEpoch = ref(0)
  const commitMotion = ref(false)
  let motionTimer: ReturnType<typeof setTimeout> | undefined
  function commitLabel(): void {
    const periodKey = JSON.stringify(urlQuery.value)
    const prev = committedSnapshot.value
    const periodChanged = prev !== null && prev.periodKey !== periodKey
    const anchor = mode.value === 'month' ? month.value : mode.value === 'week' ? week.value : mode.value === 'year' ? year.value : ''
    commitDirection.value =
      periodChanged && prev !== null && prev.mode === mode.value && prev.anchor !== '' && anchor !== '' && prev.anchor !== anchor
        ? anchor > prev.anchor ? 1 : -1
        : 0
    committedSnapshot.value = { label: label.value, labelShort: labelShort.value, month: month.value, periodKey, mode: mode.value, anchor }
    if (periodChanged) {
      committedEpoch.value++
      commitMotion.value = true
      clearTimeout(motionTimer)
      motionTimer = setTimeout(() => { commitMotion.value = false }, 280)
    }
  }
  const committedLabel = computed(() => committedSnapshot.value?.label ?? label.value)
  const committedLabelShort = computed(() => committedSnapshot.value?.labelShort ?? labelShort.value)
  const committedMonth = computed(() => committedSnapshot.value?.month ?? month.value)

  const valid = computed(() => mode.value !== 'range' || (!!from.value && !!to.value && from.value <= to.value))

  /** Period part of an analysis query for the ranked endpoints. */
  function query(): AnalysisQuery {
    const base: AnalysisQuery =
      mode.value === 'month'
        ? { month: month.value }
        : mode.value === 'week'
          ? { from: week.value, to: shiftDate(week.value, 6) }
          : mode.value === 'year'
            ? { year: year.value }
            : { from: from.value, to: to.value }
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  /** A window of N months back from the selected month (default 11 = a
   *  12-month window), or the year / range itself in the other modes. */
  function trendQuery(back = 11): AnalysisQuery {
    const base: AnalysisQuery =
      mode.value === 'month'
        ? { from: `${shiftMonth(month.value, -back)}-01`, to: monthEnd(month.value) }
        : query() // week / year / range: the selected period itself
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  /** URL query form of the period for links (month= / year= / from=&to=). */
  const urlQuery = computed((): Record<string, string> => {
    const base: Record<string, string> =
      mode.value === 'month'
        ? { month: month.value }
        : mode.value === 'week'
          ? { week: week.value }
          : mode.value === 'year'
            ? { year: String(year.value) }
            : { from: from.value, to: to.value }
    return base
  })

  // TASK-146 §1: the current-period cap is gone — month / week step into
  // the future freely (a future period renders the existing empty
  // vocabulary). The only bound left is the backend's Year 1900..=9999
  // acceptance (domain resolve_period), so the year clamps at both ends —
  // canNext / canPrev are the step pair's symmetric disable sources (review
  // PR#4 #2: the year floor used to no-op the ‹ press silently with no
  // disabled state on the button); the range mode never shows the step UI
  // at all.
  const canNext = computed(() => (mode.value === 'year' ? year.value < 9999 : true))
  const canPrev = computed(() => (mode.value === 'year' ? year.value > 1900 : true))

  // Issue #9: the last time the period actually changed (a notified
  // operation — user / import / system — or the store's creation). The
  // browsing URL sync reads it on a home entry: a period left untouched
  // for longer than HOME_FRESH_WINDOW_MS is stale state, not a choice to
  // carry back into the home screen. In-memory only, never persisted.
  const lastActivityAt = ref(Date.now())

  // Notify only after a complete public operation, never during apply*.
  let operationId = 0
  const subscribers = new Set<(operation: PeriodOperation) => void>()
  function subscribeOperations(fn: (operation: PeriodOperation) => void): () => void {
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }
  function stateKey(): string {
    return JSON.stringify([urlQuery.value, labelColors.value])
  }
  function notify(before: string, cause: PeriodOperation['cause']): void {
    if (before === stateKey()) return
    lastActivityAt.value = Date.now()
    const operation: PeriodOperation = {
      operationId: ++operationId, cause,
      keys: { ...urlQuery.value }, labels: [...labelColors.value],
    }
    Object.freeze(operation.keys)
    Object.freeze(operation.labels)
    Object.freeze(operation)
    for (const fn of subscribers) fn(operation)
  }

  function applyMonth(m: string): void {
    mode.value = 'month'
    month.value = m
  }

  function applyWeek(w: string): void {
    mode.value = 'week'
    week.value = weekStart(w)
  }

  function applyMode(m: PeriodMode): void {
    mode.value = m
  }

  function applyRange(f: string, t: string): void {
    mode.value = 'range'
    from.value = f
    to.value = t
  }

  function step(delta: number): void {
    const before = stateKey()
    try {
      if (mode.value === 'month') {
        const next = shiftMonth(month.value, delta)
        if (next !== month.value) {
          applyMonth(next)
        }
      } else if (mode.value === 'week') {
        const next = shiftDate(week.value, delta * 7)
        if (next !== week.value) {
          applyWeek(next)
        }
      } else if (mode.value === 'year') {
        const next = Math.min(Math.max(year.value + delta, 1900), 9999)
        if (next !== year.value) {
          applyMode('year')
          year.value = next
        }
      }
    } finally {
      notify(before, 'user')
    }
  }

  /** Jump to a month (e.g. a bar of the trend chart). The no-op is the
   *  month already selected IN month mode — a same-month jump from another
   *  mode (a monthly bar pressed while the year / range view is up) still
   *  re-modes and counts as a user change (review REVIEW-12 #2: the jump
   *  must not silently swallow the mode switch). */
  function setMonth(m: string): void {
    const before = stateKey()
    try {
      if (mode.value === 'month' && month.value === m) return
      applyMonth(m)
    } finally {
      notify(before, 'user')
    }
  }

  /** Jump to a week (a weekly trend bar's press; TASK-53). The no-op is the
   *  week already selected IN week mode — a same-Monday jump from another
   *  mode still switches the mode over (a weekly bar press re-modes). */
  function setWeek(w: string): void {
    const before = stateKey()
    try {
      const monday = weekStart(w)
      if (mode.value === 'week' && week.value === monday) return
      applyWeek(w)
    } finally {
      notify(before, 'user')
    }
  }

  /** Switch the period mode (the picker's tab; TASK-164 §2-2-1 — the tab used
   *  to write `period.mode` directly, which the write-back cannot tell from a
   *  system write). */
  function setMode(m: PeriodMode): void {
    const before = stateKey()
    try {
      if (mode.value === m) return
      applyMode(m)
    } finally {
      notify(before, 'user')
    }
  }

  /** Commit the Custom range form's dates (TASK-164 §2-2-1 — same replacement
   *  of the picker's direct from/to writes). Invalid input — or re-committing
   *  the selected range — is a no-op. */
  function setRange(f: string, t: string): void {
    const before = stateKey()
    try {
      if (!f || !t || f > t) return
      if (mode.value === 'range' && from.value === f && to.value === t) return
      applyRange(f, t)
    } finally {
      notify(before, 'user')
    }
  }

  /** TASK-164 §1-2: back to the default period (month mode, the current
   *  month) — the home-route re-press of a home affordance lands here. Every
   *  dimension is recomputed from the JST date of the call: `thisMonth` is a
   *  store-creation constant, so a session that crossed a month boundary
   *  still lands on the new current month. The label dimension is not part
   *  of the reset (B1: the selection rides along), and no navigation fires —
   *  the URL follows through the regular write-back (a replace, §1-3: this
   *  is an internal API and never marks its write as a user one). */
  function resetToDefault(): void {
    const before = stateKey()
    try {
      const m = jstMonth()
      mode.value = 'month'
      month.value = m
      week.value = weekStart(jstToday())
      year.value = Number(m.slice(0, 4))
      from.value = `${m}-01`
      to.value = monthEnd(m)
    } finally {
      notify(before, 'system')
    }
  }

  /** Import normalized period keys from a link as one operation. */
  function fromQuery(q: Record<string, unknown>): void {
    const before = stateKey()
    try {
      const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
      const m = s(q.month)
      const w = s(q.week)
      const y = s(q.year)
      if (m && /^\d{4}-\d{2}$/.test(m)) applyMonth(m)
      else if (w && /^\d{4}-\d{2}-\d{2}$/.test(w) && !Number.isNaN(Date.parse(w))) applyWeek(w)
      else if (y && /^\d{4}$/.test(y)) {
        applyMode('year')
        year.value = Number(y)
      } else if (s(q.from) && s(q.to)) {
        applyRange(s(q.from)!, s(q.to)!)
      }
    } finally {
      notify(before, 'import')
    }
  }

  return {
    thisMonth,
    mode,
    month,
    week,
    year,
    from,
    to,
    labelColors,
    labelDirty,
    labelQuery,
    setLabelColors,
    range,
    label,
    labelShort,
    commitLabel,
    committedEpoch,
    commitMotion,
    commitDirection,
    committedLabel,
    committedLabelShort,
    committedMonth,
    valid,
    query,
    trendQuery,
    urlQuery,
    canNext,
    canPrev,
    lastActivityAt,
    subscribeOperations,
    step,
    setMonth,
    setWeek,
    setMode,
    setRange,
    resetToDefault,
    fromQuery,
  }
})
