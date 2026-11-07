import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { LabelColor } from '@/shared/labels'
import type { AnalysisQuery } from '../api/data'
import { jstMonth, jstToday, monthEnd, monthLabel, shiftDate, shiftMonth, shortDate, weekStart } from '../composables/period'
import { useSessionStore } from './session'

export type PeriodMode = 'month' | 'week' | 'year' | 'range'

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
    labelColors.value = [...colors]
    labelDirty.value = true
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
      labelColors.value = []
      labelDirty.value = true
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
  // acceptance (domain resolve_period), so the year clamps at both ends;
  // the range mode never shows the step UI at all.
  const canNext = computed(() => (mode.value === 'year' ? year.value < 9999 : true))

  // --- the user / internal API split (TASK-164 §2-2-1) ---------------------------
  // The write-back's push/replace discrimination rides a one-shot flag: only a
  // USER period change (a step, a mode tab, a range form, a jump) may stack a
  // history entry, every system write (a URL import, a keys-less completion,
  // the reset) stays a replace. The user APIs below raise the flag ONLY on a
  // real value change (residue rule 1: the period watch never fires on a
  // same-value re-selection, so a flag raised there would stand around for a
  // later system write to consume); the internal apply* APIs CLEAR a standing
  // flag at their start (residue rule 2: an import or a reset never inherits
  // an earlier user marking). The third residue rule (discard on an
  // off-target-screen navigation) lives in useBrowsingUrlSync.
  const nextWrite = ref<'user' | 'system'>('system')

  function applyMonth(m: string): void {
    nextWrite.value = 'system'
    mode.value = 'month'
    month.value = m
  }

  function applyWeek(w: string): void {
    nextWrite.value = 'system'
    mode.value = 'week'
    week.value = weekStart(w)
  }

  function applyMode(m: PeriodMode): void {
    nextWrite.value = 'system'
    mode.value = m
  }

  function applyRange(f: string, t: string): void {
    nextWrite.value = 'system'
    mode.value = 'range'
    from.value = f
    to.value = t
  }

  function step(delta: number): void {
    if (mode.value === 'month') {
      const next = shiftMonth(month.value, delta)
      if (next !== month.value) {
        applyMonth(next)
        nextWrite.value = 'user'
      }
    } else if (mode.value === 'week') {
      const next = shiftDate(week.value, delta * 7)
      if (next !== week.value) {
        applyWeek(next)
        nextWrite.value = 'user'
      }
    } else if (mode.value === 'year') {
      const next = Math.min(Math.max(year.value + delta, 1900), 9999)
      if (next !== year.value) {
        applyMode('year')
        year.value = next
        nextWrite.value = 'user'
      }
    }
  }

  /** Jump to a month (e.g. a bar of the trend chart). The no-op is the
   *  month already selected IN month mode — a same-month jump from another
   *  mode (a monthly bar pressed while the year / range view is up) still
   *  re-modes and counts as a user change (review REVIEW-12 #2: the jump
   *  must not silently swallow the mode switch). */
  function setMonth(m: string): void {
    if (mode.value === 'month' && month.value === m) return
    applyMonth(m)
    nextWrite.value = 'user'
  }

  /** Jump to a week (a weekly trend bar's press; TASK-53). The no-op is the
   *  week already selected IN week mode — a same-Monday jump from another
   *  mode still switches the mode over (a weekly bar press re-modes). */
  function setWeek(w: string): void {
    const monday = weekStart(w)
    if (mode.value === 'week' && week.value === monday) return
    applyWeek(w)
    nextWrite.value = 'user'
  }

  /** Switch the period mode (the picker's tab; TASK-164 §2-2-1 — the tab used
   *  to write `period.mode` directly, which the write-back cannot tell from a
   *  system write). */
  function setMode(m: PeriodMode): void {
    if (mode.value === m) return
    applyMode(m)
    nextWrite.value = 'user'
  }

  /** Commit the Custom range form's dates (TASK-164 §2-2-1 — same replacement
   *  of the picker's direct from/to writes). Invalid input — or re-committing
   *  the selected range — is a no-op. */
  function setRange(f: string, t: string): void {
    if (!f || !t || f > t) return
    if (mode.value === 'range' && from.value === f && to.value === t) return
    applyRange(f, t)
    nextWrite.value = 'user'
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
    nextWrite.value = 'system'
    const m = jstMonth()
    mode.value = 'month'
    month.value = m
    week.value = weekStart(jstToday())
    year.value = Number(m.slice(0, 4))
    from.value = `${m}-01`
    to.value = monthEnd(m)
  }

  /** Apply ?month= / ?year= / ?from=&to= from a link. Internal side only
   *  (TASK-164 §2-2-1): the URL import must never raise the user flag —
   *  fromQuery rides the apply* APIs, which also clear any standing one. */
  function fromQuery(q: Record<string, unknown>): void {
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
    valid,
    query,
    trendQuery,
    urlQuery,
    canNext,
    nextWrite,
    step,
    setMonth,
    setWeek,
    setMode,
    setRange,
    resetToDefault,
    fromQuery,
  }
})
