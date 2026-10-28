<script setup lang="ts">
// view=stats (spec §10, §11-2): totals card with the previous-period comparison,
// one chart per section by `chart` kind, notes, report / period switch through
// summarize_spending (callTool) and a fullscreen toggle. The applied label
// filter (filters.label_colors, TASK-17) shows as a chip and survives both
// switches because the re-run carries the envelope's filters.
import { computed, ref, watch } from 'vue'
import type { PeriodPreset, ReportKind, StatsEnvelope, StatsFilters, StatsRow, StatsSection } from '@/shared/types'
import type { LabelColor } from '@/shared/labels'
import LabelChip from '@/shared/components/LabelChip.vue'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import BarHChart from '@/shared/components/charts/BarHChart.vue'
import BarVChart from '@/shared/components/charts/BarVChart.vue'
import LineChart from '@/shared/components/charts/LineChart.vue'
import ShareBar from '@/shared/components/charts/ShareBar.vue'
import type { ChartDatum } from '@/shared/components/charts/types'
import { stackedOf } from '@/shared/lib/stackedBars'
import { formatIsoDateJa } from '@/shared/format'
import { labelIndexOf } from '@/shared/labels'
import LedgerBadge from '../components/LedgerBadge.vue'
import { useWidgetStore } from '../stores/widget'

const props = defineProps<{ envelope: StatsEnvelope }>()
const store = useWidgetStore()

type Option<T extends string> = { value: T; label: string }

const REPORTS: Option<ReportKind>[] = [
  { value: 'monthly_overview', label: '月の概要' },
  { value: 'by_category', label: 'カテゴリ別' },
  { value: 'by_store', label: '店別' },
  { value: 'monthly_trend', label: '月別推移' },
  { value: 'by_payment_method', label: '支払方法別' },
  { value: 'item_price_history', label: '品目の単価推移' },
]
const PRESETS: Option<PeriodPreset>[] = [
  { value: 'this_month', label: '今月' },
  { value: 'last_month', label: '先月' },
  { value: 'last_3_months', label: '直近3か月' },
  { value: 'last_6_months', label: '直近6か月' },
  { value: 'last_12_months', label: '直近12か月' },
  { value: 'this_year', label: '今年' },
  { value: 'last_year', label: '昨年' },
]

const report = computed<ReportKind>(() => props.envelope.report ?? 'monthly_overview')
const preset = ref<PeriodPreset | ''>('')
/** item_price_history needs filters.item_query; it is only switchable while the filter is known. */
const reportOptions = computed(() =>
  REPORTS.filter((r) => r.value !== 'item_price_history' || (report.value === 'item_price_history' && props.envelope.filters?.item_query)),
)
const periodSwitchable = computed(() => report.value !== 'item_price_history' || Boolean(props.envelope.filters?.item_query))

/**
 * Label filter of the current envelope (TASK-17), carried into period /
 * report re-runs. The backend echoes the applied filters on every response;
 * a new response without a label filter means the filter was explicitly
 * cleared (or never applied), so nothing carries over from older responses
 * and the user's latest context wins.
 */
const carriedLabelColors = ref<LabelColor[]>([])
watch(
  () => props.envelope.filters?.label_colors,
  (colors) => {
    carriedLabelColors.value = colors ? [...colors] : []
  },
  { immediate: true },
)

/** Label filter of the current envelope, for the chip. */
const labelFilter = computed(() => {
  const colors = props.envelope.filters?.label_colors
  return colors && colors.length > 0 ? colors : carriedLabelColors.value.length > 0 ? [...carriedLabelColors.value] : null
})

// TASK-116 (design §3-3-2): each row's series key rides the datum (the
// bar_h / stacked_bar rows paint seriesColor(key), null included) and the
// bar_v bars stack the composition off `_meta.trend_matrix` — stackedOf
// (shared) assembles the segments, matched to the section rows by index
// (both are the range's months, zero-filled ascending); a count mismatch
// drops the segments (the single-rect fallback draws).
function rowsToData(section: StatsSection): ChartDatum[] {
  const bars = section.chart === 'bar_v' ? store.trendMatrix : null
  const matrix = bars && stackedOf(bars)
  const useSegs = matrix !== null && matrix !== undefined && matrix.length === section.rows.length
  return section.rows.map((r: StatsRow, i: number) => {
    const base =
      section.chart === 'scatter_line'
        ? { label: formatIsoDateJa(r.labels[0] ?? ''), sub: r.labels[1] ?? null, value: r.value }
        : { label: r.labels.join(' / '), value: r.value }
    return {
      ...base,
      key: r.keys[0],
      ...(useSegs ? { segments: matrix![i]!.segments } : {}),
    }
  })
}

/** Envelope filters plus the carried label filter, for a period re-run. */
function runFilters(): StatsFilters | null {
  const merged: StatsFilters = { ...(props.envelope.filters ?? {}) }
  if (carriedLabelColors.value.length > 0) merged.label_colors = [...carriedLabelColors.value]
  return Object.keys(merged).length > 0 ? merged : null
}

/** Label-only filters for a report switch (report-bound filters stay behind). */
function labelOnlyFilters(): StatsFilters | null {
  return carriedLabelColors.value.length > 0 ? { label_colors: [...carriedLabelColors.value] } : null
}

async function onReport(e: Event) {
  const next = (e.target as HTMLSelectElement).value as ReportKind
  preset.value = ''
  await store.loadStats(next, null, next === report.value ? runFilters() : labelOnlyFilters())
}

async function onPeriod(e: Event) {
  const next = (e.target as HTMLSelectElement).value as PeriodPreset | ''
  preset.value = next
  await store.loadStats(report.value, next ? { preset: next } : null, runFilters())
}
</script>

<template>
  <article
    class="bb-screen"
    data-test="stats-screen"
  >
    <LedgerBadge :ledger="envelope.ledger" />
    <div class="bb-controls">
      <label class="bb-field">
        <span>集計</span>
        <select
          :value="report"
          :disabled="store.loading"
          data-test="report-select"
          @change="onReport"
        >
          <option
            v-for="o in reportOptions"
            :key="o.value"
            :value="o.value"
          >{{ o.label }}</option>
        </select>
      </label>
      <label class="bb-field">
        <span>期間</span>
        <select
          :value="preset"
          :disabled="store.loading || !periodSwitchable"
          data-test="period-select"
          @change="onPeriod"
        >
          <option value="">{{ envelope.period_resolved.label }}</option>
          <option
            v-for="o in PRESETS"
            :key="o.value"
            :value="o.value"
          >{{ o.label }}</option>
        </select>
      </label>
      <button
        type="button"
        class="bb-btn bb-btn--ghost"
        data-test="fullscreen-button"
        @click="store.toggleFullscreen()"
      >
        {{ store.displayMode === 'fullscreen' ? '戻す' : '全画面' }}
      </button>
    </div>

    <section
      class="bb-card"
      data-test="totals-card"
    >
      <p
        v-if="labelFilter"
        class="bb-chip"
        data-test="label-filter-chip"
      >
        ラベル<LabelChip
          v-for="color in labelFilter"
          :key="color"
          size="sm"
          :label="{ color, title: null }"
          :index="labelIndexOf(color)"
        />
      </p>
      <p class="bb-muted">
        {{ envelope.period_resolved.label }}<template v-if="envelope.filters?.item_query">
          ・ {{ envelope.filters.item_query }}
        </template>
      </p>
      <p class="bb-card__value">
        <MoneyAmount :value="envelope.totals.value" />
      </p>
      <p class="bb-muted bb-small">
        {{ envelope.totals.receipts }}件
      </p>
    </section>

    <section
      v-for="s in envelope.sections"
      :key="s.id"
      class="bb-section"
      :data-section="s.id"
      :data-chart="s.chart"
    >
      <h3 class="bb-subtitle">
        {{ s.title }}
      </h3>
      <BarHChart
        v-if="s.chart === 'bar_h'"
        :data="rowsToData(s)"
      />
      <BarVChart
        v-else-if="s.chart === 'bar_v'"
        :data="rowsToData(s)"
      />
      <LineChart
        v-else-if="s.chart === 'line' || s.chart === 'scatter_line'"
        :data="rowsToData(s)"
        :points="s.chart === 'scatter_line'"
      />
      <ShareBar
        v-else-if="s.chart === 'stacked_bar'"
        :data="rowsToData(s)"
      />
      <table
        v-else
        class="bb-table"
      >
        <tbody>
          <tr
            v-for="(r, i) in s.rows"
            :key="i"
          >
            <th scope="row">
              {{ r.labels.join(' / ') }}
            </th>
            <td><MoneyAmount :value="r.value" /></td>
          </tr>
        </tbody>
      </table>
      <p
        v-if="s.truncated_rows"
        class="bb-muted bb-small"
      >
        ほか{{ s.truncated_rows }}件は「その他」に含みます
      </p>
    </section>

    <ul
      v-if="envelope.notes.length > 0"
      class="bb-notes"
    >
      <li
        v-for="(n, i) in envelope.notes"
        :key="i"
      >
        {{ n }}
      </li>
    </ul>
  </article>
</template>
