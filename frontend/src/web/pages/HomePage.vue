<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type ReceiptSummary, type StatsResult } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { periodDays, shortDate } from '../composables/period'
import { usePeriodStore } from '../stores/period'

// Dashboard: the selected period's spending at a glance (GET
// /api/ledgers/{l}/stats monthly_overview — the same aggregation as
// summarize_spending — plus its own monthly_trend call for the bars) and the
// period's latest receipts. The period lives in the shared period store and
// follows all of its modes (TASK-66: month / year / range — the KPI, the
// trend window and the recent list all read period.range); it moves through
// the topbar period chip's dialog and the trend bars below, is shared with
// the other screens, and this page re-queries through watch(period.range).
// The label filter (TASK-17) is the same shared dimension
// (watch(period.labelQuery)).
const api = useDataApi()
const period = usePeriodStore()

const summary = ref<StatsResult | null>(null)
const trendResult = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const loading = ref(false)
const error = ref('')

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  loading.value = true
  error.value = ''
  const [from, to] = period.range
  try {
    // the trend call rides first so the primary monthly_overview is the
    // load's last stats call (the Categories ordering); its month window is
    // Home's own 6-month one (trendQuery(5)) — the year / range modes use
    // the selected period itself
    const [tr, s, r] = await Promise.all([
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(5) }),
      api.getStats(l, { report: 'monthly_overview', ...period.query() }),
      api.listReceipts(l, { from, to, limit: 5, ...(period.labelQuery ? { label_colors: period.labelQuery } : {}) }),
    ])
    if (n !== seq) return
    summary.value = s
    trendResult.value = tr
    recent.value = r.receipts
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) loading.value = false
  }
}

const ledgerId = useLedger((id) => load(id))
// the period / label filters move from the topbar center bar (TASK-44 §11):
// the same watch(period.range) path the other dashboards use, plus the
// shared label dimension — one array watch so a change that moves both (a
// ledger switch resetting the labels) fetches once
watch([() => period.range, () => period.labelQuery], () => void load())

const totals = computed(() => summary.value?.totals ?? null)
const section = (id: string) => summary.value?.sections.find((s) => s.id === id)?.rows ?? []

/** Spending change vs. the previous period: more spending is the warning side. */
const diff = computed(() => {
  const t = totals.value
  if (!t || t.diff === null || t.compare_value === null) return null
  return {
    text: `${t.diff > 0 ? '+' : t.diff < 0 ? '−' : '±'}${formatYen(Math.abs(t.diff))}`,
    pct: t.diff_pct === null ? '' : `（${t.diff_pct > 0 ? '+' : ''}${t.diff_pct}%）`,
    tone: t.diff > 0 ? 'up' : t.diff < 0 ? 'down' : 'flat',
  }
})

const perDay = computed(() => {
  const t = totals.value
  if (!t) return null
  const [from, to] = period.range
  return Math.round(t.value / periodDays(from, to))
})

// Category donut: top 5 + "その他". Colors are shared by the ring and the
// legend (same index).
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c-rest)']
const categories = computed(() => {
  const rows = section('categories')
  const top = rows.slice(0, 5).map((r) => ({ label: r.labels[0] ?? '未分類', value: r.value }))
  const rest = rows.slice(5).reduce((a, r) => a + r.value, 0)
  if (rest > 0) top.push({ label: 'その他', value: rest })
  const total = top.reduce((a, r) => a + r.value, 0)
  return top.map((r, i) => ({ ...r, color: PALETTE[i]!, share: total ? r.value / total : 0 }))
})
const R = 52
const CIRC = 2 * Math.PI * R
const arcs = computed(() => {
  let offset = 0
  return categories.value.map((c) => {
    const len = c.share * CIRC
    const arc = { color: c.color, dash: `${Math.max(len - 2, 0)} ${CIRC}`, offset: -offset }
    offset += len
    return arc
  })
})

const stores = computed(() => {
  const rows = section('stores')
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows.map((r) => ({ label: r.labels[0] ?? '店不明', value: r.value, width: Math.round((r.value / max) * 100) }))
})

/** Per-receipt feed links carry this screen's period + filter as context. */
const recentQuery = computed(() => {
  const [from, to] = period.range
  return { from, to, ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) }
})

</script>

<template>
  <div class="dashboard">
    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <div
      v-if="summary && totals"
      class="dash-grid"
      :class="{ loading }"
    >
      <section
        class="card kpi"
        data-test="kpi"
      >
        <span class="label">{{ period.label }}の支出</span>
        <strong
          class="kpi-value"
          data-test="total"
        >{{ formatYen(totals.value) }}</strong>
        <span
          v-if="diff"
          class="chip"
          :class="`chip-${diff.tone}`"
          data-test="diff"
        >{{ period.compareLabel }}比 {{ diff.text }}{{ diff.pct }}</span>
        <dl class="kpi-sub">
          <div>
            <dt>レシート</dt>
            <dd data-test="receipt-count">
              {{ totals.receipts }} 件
            </dd>
          </div>
          <div>
            <dt>1日あたり</dt>
            <dd>{{ formatYen(perDay) }}</dd>
          </div>
          <div>
            <dt>{{ period.compareLabel }}</dt>
            <dd>{{ formatYen(totals.compare_value) }}</dd>
          </div>
        </dl>
      </section>

      <section
        class="card trend"
        data-test="trend-card"
      >
        <h2>支出の推移</h2>
        <!-- a bar press moves the shared store (the topbar period chip
             follows at once, TASK-44 §11-5) -->
        <TrendBars
          v-if="trendResult"
          :rows="trendResult.sections[0]?.rows ?? []"
          :current="period.mode === 'month' ? period.month : null"
          @select="period.setMonth"
        />
      </section>

      <section
        class="card breakdown"
        data-test="breakdown"
      >
        <div class="card-head">
          <h2>支出の内訳</h2>
          <RouterLink
            :to="{ path: '/categories', query: { ...period.urlQuery } }"
            class="more"
          >
            カテゴリ別に見る
          </RouterLink>
        </div>
        <p
          v-if="categories.length === 0"
          class="muted empty"
        >
          この期間の記録はまだありません。
        </p>
        <div
          v-else
          class="donut-wrap"
        >
          <svg
            class="donut"
            viewBox="0 0 140 140"
            role="img"
            :aria-label="`支出の内訳 合計${formatYen(totals.value)}`"
          >
            <circle
              cx="70"
              cy="70"
              :r="R"
              class="donut-track"
            />
            <circle
              v-for="(a, i) in arcs"
              :key="i"
              cx="70"
              cy="70"
              :r="R"
              fill="none"
              :stroke="a.color"
              stroke-width="18"
              :stroke-dasharray="a.dash"
              :stroke-dashoffset="a.offset"
              transform="rotate(-90 70 70)"
            />
            <text
              x="70"
              y="64"
              class="donut-caption"
            >支出</text>
            <text
              x="70"
              y="84"
              class="donut-total"
            >{{ totals.value.toLocaleString('ja-JP') }}</text>
          </svg>
          <ul
            class="legend"
            data-test="categories"
          >
            <li
              v-for="c in categories"
              :key="c.label"
            >
              <component
                :is="c.label === 'その他' ? 'span' : RouterLink"
                class="legend-row"
                v-bind="c.label === 'その他' ? {} : { to: { path: '/categories', query: { ...period.urlQuery, category: c.label } } }"
              >
                <span
                  class="dot"
                  :style="{ background: c.color }"
                />
                <span class="legend-label">{{ c.label }}</span>
                <span class="legend-share muted">{{ Math.round(c.share * 100) }}%</span>
                <span class="amount">{{ formatYen(c.value) }}</span>
              </component>
            </li>
          </ul>
        </div>
      </section>

      <section
        class="card stores"
        data-test="stores"
      >
        <div class="card-head">
          <h2>よく使う店</h2>
          <RouterLink
            :to="{ path: '/stores', query: { ...period.urlQuery } }"
            class="more"
          >
            店別に見る
          </RouterLink>
        </div>
        <p
          v-if="stores.length === 0"
          class="muted empty"
        >
          この期間の記録はまだありません。
        </p>
        <ul
          v-else
          class="rank"
        >
          <li
            v-for="s in stores"
            :key="s.label"
          >
            <RouterLink
              :to="{ path: '/stores', query: { ...period.urlQuery, store: s.label } }"
              class="rank-link"
            >
              <div class="rank-head">
                <span>{{ s.label }}</span>
                <span class="amount">{{ formatYen(s.value) }}</span>
              </div>
              <span class="meter"><span :style="{ width: `${s.width}%` }" /></span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section
        class="card recent"
        data-test="recent"
      >
        <div class="card-head">
          <h2>最近のレシート</h2>
          <RouterLink
            :to="{ path: '/receipts', query: { ...period.urlQuery } }"
            class="more"
          >
            すべて見る
          </RouterLink>
        </div>
        <div
          v-if="recent.length === 0"
          class="empty-state"
        >
          <AppIcon
            name="chat"
            :size="28"
          />
          <p>ChatGPT でレシートの写真を送ると、ここに記録されます。</p>
        </div>
        <ul
          v-else
          class="recent-list"
        >
          <li
            v-for="r in recent"
            :key="r.receipt_id"
          >
            <RouterLink
              :to="{ path: `/receipts/${r.receipt_id}`, query: recentQuery }"
              class="recent-row"
              :data-test="`recent-${r.receipt_id}`"
            >
              <span class="recent-date">{{ shortDate(r.purchased_on) }}</span>
              <span class="recent-icon"><AppIcon
                :name="r.has_image ? 'image' : 'receipt'"
                :size="18"
              /></span>
              <span class="recent-main">
                <span class="recent-store">{{ r.store_name ?? '店名なし' }}</span>
                <span class="muted small">{{ r.item_count }} 品目</span>
              </span>
              <span class="amount">{{ formatYen(r.amount) }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
