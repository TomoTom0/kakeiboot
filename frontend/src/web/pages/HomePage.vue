<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { formatLabelQuery, type LabelColor } from '@/shared/labels'
import { useDataApi, type ReceiptSummary, type StatsResult } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import LabelFilter from '../components/LabelFilter.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { jstMonth, jstToday, monthEnd as lastDay, monthLabel, shiftMonth, shortDate } from '../composables/period'
import { usePeriodStore } from '../stores/period'

// Dashboard: the month's spending at a glance (GET /api/ledgers/{l}/summary,
// the same monthly_overview aggregation as summarize_spending) plus the
// month's latest receipts. Months are JST calendar months. The label filter
// (TASK-17) is shared with the other dashboards through the period store.
const api = useDataApi()
const period = usePeriodStore()

const thisMonth = jstMonth(new Date())
const month = ref(thisMonth)
const summary = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const loading = ref(false)
const error = ref('')

async function load(ledgerId: number | null): Promise<void> {
  if (ledgerId === null) return
  loading.value = true
  error.value = ''
  const m = month.value
  try {
    const [s, r] = await Promise.all([
      api.getStats(ledgerId, { report: 'monthly_overview', month: m, ...(period.labelQuery ? { label_colors: period.labelQuery } : {}) }),
      api.listReceipts(ledgerId, { from: `${m}-01`, to: lastDay(m), limit: 5, ...(period.labelQuery ? { label_colors: period.labelQuery } : {}) }),
    ])
    if (m !== month.value) return
    summary.value = s
    recent.value = r.receipts
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}

const ledgerId = useLedger((id) => load(id))

function go(delta: number): void {
  const next = shiftMonth(month.value, delta)
  if (next > thisMonth) return
  month.value = next
  void load(ledgerId.value)
}

function onLabelFilter(colors: LabelColor[]): void {
  period.setLabelColors(colors)
  void load(ledgerId.value)
}

const totals = computed(() => summary.value?.totals ?? null)
const section = (id: string) => summary.value?.sections.find((s) => s.id === id)?.rows ?? []

/** Spending change vs. the previous month: more spending is the warning side. */
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
  const days =
    month.value === thisMonth
      ? Number(jstToday().slice(8, 10))
      : Number(lastDay(month.value).slice(8))
  return Math.round(t.value / Math.max(days, 1))
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

const trend = computed(() => {
  const rows = section('trend')
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows.map((r) => {
    const key = String(r.keys[0] ?? r.labels[0] ?? '')
    return {
      key,
      label: `${Number(key.slice(5))}月`,
      value: r.value,
      height: Math.round((r.value / max) * 100),
      current: key === month.value,
    }
  })
})

const stores = computed(() => {
  const rows = section('stores')
  const max = Math.max(...rows.map((r) => r.value), 1)
  return rows.map((r) => ({ label: r.labels[0] ?? '店不明', value: r.value, width: Math.round((r.value / max) * 100) }))
})

</script>

<template>
  <div class="dashboard">
    <div class="page-toolbar">
      <div class="month-switch">
        <button
          class="icon-btn"
          aria-label="前の月"
          data-test="month-prev"
          @click="go(-1)"
        >
          <AppIcon name="chevron-left" />
        </button>
        <strong data-test="month">{{ monthLabel(month) }}</strong>
        <button
          class="icon-btn"
          aria-label="次の月"
          data-test="month-next"
          :disabled="month >= thisMonth"
          @click="go(1)"
        >
          <AppIcon name="chevron-right" />
        </button>
      </div>
      <LabelFilter
        :model-value="period.labelColors"
        @update:model-value="onLabelFilter"
      />
    </div>

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
        <span class="label">{{ month === thisMonth ? '今月の支出' : `${monthLabel(month)}の支出` }}</span>
        <strong
          class="kpi-value"
          data-test="total"
        >{{ formatYen(totals.value) }}</strong>
        <span
          v-if="diff"
          class="chip"
          :class="`chip-${diff.tone}`"
          data-test="diff"
        >前月比 {{ diff.text }}{{ diff.pct }}</span>
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
            <dt>前月</dt>
            <dd>{{ formatYen(totals.compare_value) }}</dd>
          </div>
        </dl>
      </section>

      <section
        class="card trend"
        data-test="trend"
      >
        <h2>直近6か月の推移</h2>
        <div class="bars">
          <div
            v-for="t in trend"
            :key="t.key"
            class="bar-col"
            :class="{ current: t.current }"
            :title="`${t.label} ${formatYen(t.value)}`"
          >
            <span class="bar-val">{{ t.value ? Math.round(t.value / 1000) + 'k' : '' }}</span>
            <span
              class="bar"
              :style="{ height: `${Math.max(t.height, 2)}%` }"
            />
            <span class="bar-label">{{ t.label }}</span>
          </div>
        </div>
      </section>

      <section
        class="card breakdown"
        data-test="breakdown"
      >
        <div class="card-head">
          <h2>支出の内訳</h2>
          <RouterLink
            :to="{ path: '/categories', query: { month } }"
            class="more"
          >
            カテゴリ別に見る
          </RouterLink>
        </div>
        <p
          v-if="categories.length === 0"
          class="muted empty"
        >
          この月の記録はまだありません。
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
                v-bind="c.label === 'その他' ? {} : { to: { path: '/categories', query: { month, category: c.label } } }"
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
            :to="{ path: '/stores', query: { month } }"
            class="more"
          >
            店別に見る
          </RouterLink>
        </div>
        <p
          v-if="stores.length === 0"
          class="muted empty"
        >
          この月の記録はまだありません。
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
              :to="{ path: '/stores', query: { month, store: s.label } }"
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
            :to="{ path: '/receipts', query: { month } }"
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
              :to="{ path: `/receipts/${r.receipt_id}`, query: { from: `${month}-01`, to: lastDay(month), ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) } }"
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
    <p
      v-else-if="loading"
      class="muted"
    >
      読み込んでいます...
    </p>
  </div>
</template>
