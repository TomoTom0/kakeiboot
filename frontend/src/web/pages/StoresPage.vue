<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { useDataApi, type ReceiptSummary, type StatsResult, type StoreRow } from '../api/data'
import AppIcon from '../components/AppIcon.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendBars from '../components/TrendBars.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { shortDate } from '../composables/period'
import { usePeriodStore } from '../stores/period'

// Store dashboard (read-only): spending by store for the period and, for a
// selected store, its monthly trend, what was bought there (categories) and
// its latest receipts. Renames / merges live in /settings/stores. The period
// and label filters moved to the topbar center bar (TASK-44 §11): they ride
// on the period store (period.query / trendQuery already carry label_colors)
// and this page re-queries through the watches below.
const api = useDataApi()
const route = useRoute()
const period = usePeriodStore()
period.fromQuery(route.query)

const selected = ref<string | null>(
  typeof route.query.store === 'string' && route.query.store ? route.query.store : null,
)
const overall = ref<StatsResult | null>(null)
const trend = ref<StatsResult | null>(null)
const cats = ref<StatsResult | null>(null)
const recent = ref<ReceiptSummary[]>([])
const master = ref<StoreRow[]>([])
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
    const [o, tr, c, r, m] = await Promise.all([
      api.getStats(l, { report: 'by_store', ...period.query() }),
      api.getStats(l, { report: 'monthly_trend', ...period.trendQuery(), ...(sel ? { store: sel } : {}) }),
      sel ? api.getStats(l, { report: 'by_category', ...period.query(), store: sel }) : Promise.resolve(null),
      sel
        ? api.listReceipts(l, {
            from: f,
            to: t,
            store: sel,
            limit: 5,
            ...(period.labelQuery ? { label_colors: period.labelQuery } : {}),
          })
        : Promise.resolve(null),
      sel ? api.listStores(l, sel) : Promise.resolve([]),
    ])
    if (n !== seq) return
    overall.value = o
    trend.value = tr
    cats.value = c
    recent.value = r?.receipts ?? []
    master.value = m
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) loading.value = false
  }
}

const ledgerId = useLedger((id) => load(id))
watch([() => period.range, () => period.labelQuery, selected], () => void load())

// The manage entry lives behind the "..." page menu (TASK-45 §2-4): no
// standalone manage link on a read-only dashboard.
const menuItems: PageMenuItem[] = [
  { to: '/settings/stores', label: '店を管理', icon: 'store', test: 'manage-link' },
]

const rows = computed(() => overall.value?.sections[0]?.rows ?? [])
const totals = computed(() => overall.value?.totals ?? null)
const selectedRow = computed(() => rows.value.find((r) => r.labels[0] === selected.value) ?? null)
const info = computed(() => master.value.find((s) => s.name === selected.value) ?? null)

function select(label: string): void {
  selected.value = selected.value === label ? null : label
}

function receiptsLink(store: string) {
  const [from, to] = period.range
  return { path: '/receipts', query: { from, to, store } }
}

/** Per-receipt feed links carry this screen's period + filter as context. */
const recentQuery = computed(() => {
  const [from, to] = period.range
  return {
    from,
    to,
    ...(selected.value ? { store: selected.value } : {}),
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
            <dt>利用した店</dt>
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
        data-test="ranking"
      >
        <h2>店別</h2>
        <p
          v-if="rows.length === 0"
          class="muted empty"
        >
          この期間の記録はありません。
        </p>
        <RankedList
          v-else
          :rows="rows"
          :selected="selected"
          :compare-label="period.compareLabel"
          :inert="['その他', '店不明']"
          @select="select"
        />
        <p
          v-if="rows.length && !selected"
          class="muted small hint"
        >
          店を選ぶと、推移・買ったもの・レシートを表示します。
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
        <p class="detail-kpi">
          <strong
            v-if="selectedRow"
            class="amount"
          >{{ formatYen(selectedRow.value) }}</strong>
          <span class="muted small">
            <template v-if="info">{{ info.category ?? '種別なし' }} ・ これまで {{ info.receipt_count }} 件 ・ 最終 {{ info.last_purchased_on ?? '-' }}</template>
          </span>
        </p>
        <template v-if="cats && (cats.sections[0]?.rows.length ?? 0) > 0">
          <h3>買ったもの</h3>
          <ul
            class="sub-rows"
            data-test="store-categories"
          >
            <li
              v-for="r in cats.sections[0]!.rows"
              :key="r.labels[0]"
            >
              <span class="sub-row">
                <span>{{ r.labels[0] }}</span>
                <span class="muted small">{{ Math.round((r.share ?? 0) * 100) }}%</span>
                <span class="amount">{{ formatYen(r.value) }}</span>
              </span>
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
              <span class="recent-main"><span class="recent-store">{{ r.item_count }} 品目</span></span>
              <span class="amount">{{ formatYen(r.amount) }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
    <DashSkeleton v-else-if="loading" />
  </div>
</template>
