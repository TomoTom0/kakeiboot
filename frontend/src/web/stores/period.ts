import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { LabelColor } from '@/shared/labels'
import type { StatsQuery } from '../api/data'
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
  const thisYear = Number(thisMonth.slice(0, 4))
  const mode = ref<PeriodMode>('month')
  const month = ref(thisMonth)
  const week = ref(weekStart(jstToday())) // TASK-53: the selected week's Monday
  const year = ref(thisYear)
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

  /** "前月" / "前年" / null (custom ranges have no comparison label). */
  const compareLabel = computed(() =>
    mode.value === 'month' ? '前月' : mode.value === 'week' ? '前週' : mode.value === 'year' ? '前年' : '前期間',
  )

  const valid = computed(() => mode.value !== 'range' || (!!from.value && !!to.value && from.value <= to.value))

  /** Period part of a stats query for ranked reports. */
  function query(): StatsQuery {
    const base: StatsQuery =
      mode.value === 'month'
        ? { month: month.value }
        : mode.value === 'week'
          ? { from: week.value, to: shiftDate(week.value, 6) }
          : mode.value === 'year'
            ? { year: year.value }
            : { from: from.value, to: to.value }
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  /** Monthly trend window: N months back from the selected month (default 11
   *  = a 12-month window; Home passes 5 for its 6-month window), or the year /
   *  range itself in the other modes. */
  function trendQuery(back = 11): StatsQuery {
    const base: StatsQuery =
      mode.value === 'month'
        ? { from: `${shiftMonth(month.value, -back)}-01`, to: monthEnd(month.value) }
        : query() // week / year / range: the selected period itself
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  /** URL query form of the period for links (month= / year= / from=&to=). */
  const urlQuery = computed((): Record<string, string> =>
    mode.value === 'month'
      ? { month: month.value }
      : mode.value === 'week'
        ? { week: week.value }
        : mode.value === 'year'
          ? { year: String(year.value) }
          : { from: from.value, to: to.value },
  )

  const thisWeek = weekStart(jstToday())
  const canNext = computed(() =>
    mode.value === 'month'
      ? month.value < thisMonth
      : mode.value === 'week'
        ? week.value < thisWeek
        : mode.value === 'year'
          ? year.value < thisYear
          : false,
  )

  function step(delta: number): void {
    if (mode.value === 'month') {
      const next = shiftMonth(month.value, delta)
      if (next <= thisMonth) month.value = next
    } else if (mode.value === 'week') {
      const next = shiftDate(week.value, delta * 7)
      if (next <= thisWeek) week.value = next
    } else if (mode.value === 'year') {
      const next = year.value + delta
      if (next <= thisYear) year.value = next
    }
  }

  /** Jump to a month (e.g. a bar of the trend chart). */
  function setMonth(m: string): void {
    mode.value = 'month'
    month.value = m
  }

  /** Jump to a week (a weekly trend bar's press; TASK-53). */
  function setWeek(w: string): void {
    mode.value = 'week'
    week.value = weekStart(w)
  }

  /** Apply ?month= / ?year= / ?from=&to= from a link. */
  function fromQuery(q: Record<string, unknown>): void {
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const m = s(q.month)
    const w = s(q.week)
    const y = s(q.year)
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m)
    else if (w && /^\d{4}-\d{2}-\d{2}$/.test(w) && !Number.isNaN(Date.parse(w))) setWeek(w)
    else if (y && /^\d{4}$/.test(y)) {
      mode.value = 'year'
      year.value = Number(y)
    } else if (s(q.from) && s(q.to)) {
      mode.value = 'range'
      from.value = s(q.from)!
      to.value = s(q.to)!
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
    labelQuery,
    setLabelColors,
    range,
    label,
    labelShort,
    compareLabel,
    valid,
    query,
    trendQuery,
    urlQuery,
    canNext,
    step,
    setMonth,
    setWeek,
    fromQuery,
  }
})
