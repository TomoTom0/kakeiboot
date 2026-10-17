<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type ReceiptSummary, type StatsResult } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import DonutChart from '../components/DonutChart.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { shortDate } from '../composables/period'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

// Category dashboard (read-only): spending by top-level category for the
// period, its trend, and for a selected category its sub-category breakdown,
// monthly trend and latest receipts. Editing lives in /settings/categories.
// The period and label filters moved to the topbar center bar (TASK-44
// §11): they ride on the period store (period.query / trendQuery already
// carry label_colors) and this page re-queries through the watches below.
const api = useDataApi()
const route = useRoute()
const period = usePeriodStore()
const session = useSessionStore()
period.fromQuery(route.query)

const initial = typeof route.query.category === 'string' && route.query.category ? route.query.category : null
const selected = ref<string | null>(initial)
const overall = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const detail = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const error = ref('')
const loading = ref(false)

let seq = 0
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  const sel = selected.value
  loading.value = true
  error.value = ''
  try {
    const [f, t] = period.range
    // the trend query goes first so the primary by_category call (the one
    // carrying the selected month/year key) is the load's last stats call
    const [tr, o, d, r] = await Promise.all([
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(), ...(sel ? { category: sel } : {}) }),
      api.getStats(l, { report: 'by_category', ...period.query() }),
      sel && sel !== '未分類'
        ? api.getStats(l, { report: 'by_category', ...period.query(), category: sel })
        : Promise.resolve(null),
      sel
        ? api.listReceipts(l, {
            from: f,
            to: t,
            category: sel,
            limit: 5,
            ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
          })
        : Promise.resolve(null),
    ])
    if (n !== seq) return
    overall.value = o
    trend.value = tr
    detail.value = d
    recent.value = r?.receipts ?? []
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) loading.value = false
  }
}

const ledgerId = useLedger((id) => load(id))
watch([() => period.range, () => period.labelQuery, selected], () => void load())

// The manage entry lives behind the "..." page menu (TASK-45 §2-4): no
// standalone manage link on a read-only dashboard. TASK-40 rev2 §2-4 adds
// the create entry ("大分類を追加" deep-links the manage screen's top add
// row); viewers get the manage link only — creation stays editor-only.
const canEdit = computed(() => {
  const role = session.me?.ledgers.find((l) => l.id === ledgerId.value)?.role
  return role === 'owner' || role === 'editor'
})
const menuItems = computed<PageMenuItem[]>(() => {
  const items: PageMenuItem[] = [
    { to: '/settings/categories?kind=item', label: 'カテゴリを管理', icon: 'tag', test: 'manage-link' },
  ]
  if (canEdit.value) {
    items.push({ to: '/settings/categories?kind=item&new=top', label: '大分類を追加', icon: 'plus', test: 'add-top-link' })
  }
  return items
})

const rows = computed(() => overall.value?.sections[0]?.rows ?? [])
const totals = computed(() => overall.value?.totals ?? null)
const selectedRow = computed(() => rows.value.find((r) => r.labels[0] === selected.value) ?? null)
const subRows = computed(() => detail.value?.sections[0]?.rows ?? [])

function select(label: string): void {
  selected.value = selected.value === label ? null : label
}

function receiptsLink(category: string) {
  const [from, to] = period.range
  return { path: '/receipts', query: { from, to, category } }
}

/** Per-receipt feed links carry this screen's period + filter as context. */
const recentQuery = computed(() => {
  const [from, to] = period.range
  return {
    from,
    to,
    ...(selected.value ? { category: selected.value } : {}),
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
})

function diffText(d: number | null | undefined): string {
  if (d === null || d === undefined || d === 0) return '±0円'
  return `${d > 0 ? '+' : '−'}${formatYen(Math.abs(d))}`
}
</script>

<template>
  <div class="view-page">
    <PageMenu
      ariaLabel="その他の操作"
      :items="menuItems"
    />

    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <div
      v-if="overall && totals"
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
          v-if="totals.diff !== null"
          class="chip"
          :class="totals.diff > 0 ? 'chip-up' : totals.diff < 0 ? 'chip-down' : ''"
        >{{ period.compareLabel }}比 {{ diffText(totals.diff) }}</span>
        <dl class="kpi-sub">
          <div>
            <dt>カテゴリ数</dt>
            <dd>{{ rows.length }}</dd>
          </div>
          <div>
            <dt>最多</dt>
            <dd
              :class="{ 'clamp-2': !!rows[0]?.labels[0] }"
              :title="rows[0]?.labels[0] ?? undefined"
            >
              {{ rows[0]?.labels[0] ?? '-' }}
            </dd>
          </div>
          <div>
            <dt>レシート</dt>
            <dd>{{ totals.receipts }} 件</dd>
          </div>
        </dl>
      </section>

      <section
        class="card"
        data-test="trend-card"
      >
        <h2>{{ selected ? `${selected}の推移` : '支出の推移' }}</h2>
        <TrendBars
          v-if="trend"
          :rows="trend.sections[0]?.rows ?? []"
          :current="period.mode === 'month' ? period.month : null"
          @select="period.setMonth"
        />
      </section>

      <section
        class="card wide"
        data-test="breakdown"
      >
        <h2>カテゴリ別</h2>
        <p
          v-if="rows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <div
          v-else
          class="donut-wrap"
        >
          <DonutChart
            :rows="rows"
            :total="totals.value"
          />
          <RankedList
            :rows="rows"
            :selected="selected"
            :compare-label="period.compareLabel"
            :inert="['その他']"
            colors
            @select="select"
          />
        </div>
        <p
          v-if="rows.length && !selected"
          class="muted small hint"
        >
          カテゴリを選ぶと内訳と推移を表示します。
        </p>
      </section>

      <section
        v-if="selected"
        class="card wide"
        data-test="detail"
      >
        <div class="card-head">
          <h2>{{ selected }}</h2>
          <button
            class="link-btn"
            data-test="clear-selection"
            @click="selected = null"
          >
            選択を解除
          </button>
        </div>
        <p
          v-if="selectedRow"
          class="detail-kpi"
        >
          <strong class="amount">{{ formatYen(selectedRow.value) }}</strong>
          <span class="muted small">全体の {{ Math.round((selectedRow.share ?? 0) * 100) }}% ・ {{ period.compareLabel }}から {{ diffText(selectedRow.diff) }}</span>
        </p>
        <template v-if="subRows.length">
          <h3>内訳</h3>
          <ul
            class="sub-rows"
            data-test="sub-rows"
          >
            <li
              v-for="r in subRows"
              :key="r.labels[0]"
            >
              <RouterLink
                :to="receiptsLink(r.labels[0] ?? selected)"
                class="sub-row"
              >
                <span>{{ (r.labels[0] ?? '').split('/').pop() }}</span>
                <span class="muted small">{{ Math.round((r.share ?? 0) * 100) }}%</span>
                <span class="amount">{{ formatYen(r.value) }}</span>
              </RouterLink>
            </li>
          </ul>
        </template>
        <div class="card-head">
          <h3>最近のレシート</h3>
          <RouterLink
            :to="receiptsLink(selected)"
            class="more"
            data-test="detail-receipts"
          >
            すべて見る
          </RouterLink>
        </div>
        <ul class="recent-list">
          <li
            v-for="r in recent"
            :key="r.receipt_id"
          >
            <RouterLink
              :to="{ path: `/receipts/${r.receipt_id}`, query: recentQuery }"
              class="recent-row"
            >
              <span class="recent-date">{{ shortDate(r.purchased_on) }}</span>
              <span class="recent-icon"><AppIcon
                name="receipt"
                :size="18"
              /></span>
              <span class="recent-main"><span class="recent-store">{{ r.store_name ?? '店名なし' }}</span></span>
              <span class="amount">{{ formatYen(r.amount) }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
