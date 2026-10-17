import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { LabelColor } from '@/shared/labels'
import type { StatsQuery } from '../api/data'
import { jstMonth, monthEnd, monthLabel, shiftMonth } from '../composables/period'
import { useSessionStore } from './session'

export type PeriodMode = 'month' | 'year' | 'range'

// The period the dashboard-style screens (receipts / categories / stores)
// look at. Shared so switching screens keeps the same period. TASK-17 adds
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
    if (mode.value === 'year') return [`${year.value}-01-01`, `${year.value}-12-31`]
    return [from.value, to.value]
  })

  const label = computed(() => {
    if (mode.value === 'month') return monthLabel(month.value)
    if (mode.value === 'year') return `${year.value}年`
    return `${from.value.replaceAll('-', '/')} 〜 ${to.value.replaceAll('-', '/')}`
  })

  /** "前月" / "前年" / null (custom ranges have no comparison label). */
  const compareLabel = computed(() => (mode.value === 'month' ? '前月' : mode.value === 'year' ? '前年' : '前期間'))

  const valid = computed(() => mode.value !== 'range' || (!!from.value && !!to.value && from.value <= to.value))

  /** Period part of a stats query for ranked reports. */
  function query(): StatsQuery {
    const base: StatsQuery =
      mode.value === 'month'
        ? { month: month.value }
        : mode.value === 'year'
          ? { year: year.value }
          : { from: from.value, to: to.value }
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  /** Monthly trend window: 12 months up to the selected month, the year, or the range. */
  function trendQuery(): StatsQuery {
    const base: StatsQuery =
      mode.value === 'month'
        ? { from: `${shiftMonth(month.value, -11)}-01`, to: monthEnd(month.value) }
        : query()
    return { ...base, ...(labelQuery.value ? { label_colors: labelQuery.value } : {}) }
  }

  const canNext = computed(() =>
    mode.value === 'month' ? month.value < thisMonth : mode.value === 'year' ? year.value < thisYear : false,
  )

  function step(delta: number): void {
    if (mode.value === 'month') {
      const next = shiftMonth(month.value, delta)
      if (next <= thisMonth) month.value = next
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

  /** Apply ?month= / ?year= / ?from=&to= from a link. */
  function fromQuery(q: Record<string, unknown>): void {
    const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    const m = s(q.month)
    const y = s(q.year)
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m)
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
    year,
    from,
    to,
    labelColors,
    labelQuery,
    setLabelColors,
    range,
    label,
    compareLabel,
    valid,
    query,
    trendQuery,
    canNext,
    step,
    setMonth,
    fromQuery,
  }
})
