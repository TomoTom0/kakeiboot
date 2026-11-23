<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import { formatLabelQuery } from '@/shared/labels'
import { barScale } from '@/shared/lib/stackedBars'
import { useDataApi, type AnalysisResult, type StatsRow } from '../api/data'
import BrowseToolbar from '../components/BrowseToolbar.vue'
import ContentSwap from '../components/ContentSwap.vue'
import DashSkeleton from '../components/DashSkeleton.vue'
import PeriodHeader from '../components/PeriodHeader.vue'
import PageMenu, { type PageMenuItem } from '../components/PageMenu.vue'
import RankedList from '../components/RankedList.vue'
import TrendWindow from '../components/TrendWindow.vue'
import { errorMessage, formatYen } from '../composables/format'
import { useLedger } from '../composables/ledger'
import { firstString } from '../composables/receiptContext'
import { currentTrendKey } from '../composables/trend'
import { usePageReady } from '../composables/usePageReady'
import { useTrendWindow } from '../composables/trendWindow'
import { usePeriodStore } from '../stores/period'
import { useSessionStore } from '../stores/session'

// Category list (read-only, TASK-89 redesign, the compare side removed): the
// period header (the whole-ledger totals), the stacked trend (this axis) and
// the full-category ranking — every real row (limit = stats_max_rows), the
// composition as the inline bar and the muted "ほか n件・計xx円" rest row
// folding the tail. A row press drills into /axes/category/<topId>
// (未分類 into the uncategorized carve-out); editing lives in
// /settings/categories behind the "..." menu. The legacy ?category= deep
// link resolution is gone (TASK-89: no redirect compatibility).
const api = useDataApi()
const route = useRoute()
const router = useRouter()
const period = usePeriodStore()
const session = useSessionStore()
const { markReady } = usePageReady()
// the deep-linked period / labels keys arrive through the shell-level URL
// sync (TASK-124 D2) before this page sets up

const analysis = ref<AnalysisResult | null>(null)
const error = ref('')
const loading = ref(false)

// TASK-146 §3: the pane's committed key (bumped at the load commit). TASK-161
// §2 (web-common.period-move-voice): the key drops the PERIOD range — a
// period step never remounts the pane (periodMove is gone)
const committedKey = ref('')

// the trend's movable window (TASK-104): the composable owns the trend
// fetch and the stacked assembly
const win = useTrendWindow({ axis: () => 'category', onError: (m) => (error.value = m ?? '') })

let seq = 0
let committedLedger: number | null = null
async function load(id?: number): Promise<void> {
  const l = id ?? ledgerId.value
  if (l === null || !period.valid) return
  const n = ++seq
  // a ledger switch is a context change, not a refetch: the previous
  // ledger's content leaves NOW and the skeleton covers this load.
  // Same-ledger refetches (a period move, a filter change) instead keep
  // their content in place at full opacity until the commit — no dim
  if (committedLedger !== null && l !== committedLedger) {
    analysis.value = null
  }
  loading.value = true
  error.value = ''
  const labels = period.labelQuery ? { label_colors: period.labelQuery } : {}
  try {
    const a = await api.getAnalysis(l, { axis: 'category', metric: 'amount', ...period.query(), ...labels, limit: 50 })
    if (n !== seq) return
    analysis.value = a
    committedLedger = l
    committedKey.value = `${l}|${period.mode}|${period.labelQuery?.join(',') ?? ''}`
  } catch (e) {
    if (n === seq) error.value = errorMessage(e)
  } finally {
    if (n === seq) {
      loading.value = false
      markReady()
    }
  }
}

const ledgerId = useLedger((id) => load(id))
watch([() => period.range, () => period.labelQuery], () => void load())

// The manage entry lives behind the "..." page menu (TASK-45 §2-4); the
// create entry ("大分類を追加" deep-links the manage screen's top add row)
// stays editor-only.
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

const totals = computed(() => analysis.value?.totals ?? null)

/** the full ranking: every real row (amount desc) + the rest row */
const rows = computed<StatsRow[]>(() => {
  const res = analysis.value
  if (!res) return []
  const sorted = [...res.rows].sort((a, b) => b.amount - a.amount)
  const out: StatsRow[] = sorted.map((r) => ({
    keys: [r.key],
    labels: [r.label],
    value: r.amount,
    share: r.share ?? undefined,
    top_items: r.top_items,
  }))
  if (res.truncated_rows > 0) {
    // the folded tail's amount: the period total minus the shown rows (the
    // value cell is money, not the row count — REVIEW-13 M-1)
    const restAmount = totals.value ? totals.value.amount - sorted.reduce((a, r) => a + r.amount, 0) : 0
    out.push({
      keys: [null],
      labels: [`ほか ${res.truncated_rows}件・計${formatYen(restAmount)}`],
      value: restAmount,
      share: undefined,
    })
  }
  return out
})

// TASK-129 (web-common.bar-scale): the screen's ONE absolute scale — the max
// over the ranking rows' values (each row bar's outer amount). The trend
// bars join this aggregation at TASK-126.
const screenScale = computed(() => barScale(Math.max(0, ...rows.value.map((r) => r.value))))

const trendCurrent = computed(() =>
  currentTrendKey(win.granularity.value, period.mode, win.window.value[0], win.window.value[1], period.month),
)
function onTrendSelect(key: string): void {
  if (win.granularity.value === 'day') {
    void router.push({
      path: '/receipts',
      query: { from: key, to: key, ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}) },
    })
    return
  }
  if (win.granularity.value === 'week') period.setWeek(key)
  else period.setMonth(key)
}

/** A ranking row's destination: keys[0] builds /axes/category/<topId>; the
 *  未分類 aggregate takes the carve-out; the rest row stays non-link. */
function rowTo(row: StatsRow): RouteLocationRaw | null {
  const id = row.keys[0]
  const query = {
    ...period.urlQuery,
    ...(period.labelColors.length ? { labels: formatLabelQuery(period.labelColors) } : {}),
  }
  if (typeof id === 'number') return { path: `/axes/category/${id}`, query }
  if (row.labels[0] === '未分類') return { path: '/axes/category/uncategorized', query }
  return null
}
</script>

<template>
  <div class="view-page">
    <BrowseToolbar>
      <template #menu>
        <PageMenu
          ariaLabel="その他の操作"
          :items="menuItems"
        />
      </template>
    </BrowseToolbar>

    <p
      v-if="error"
      class="msg msg-error"
      role="alert"
      data-test="error"
    >
      {{ error }}
    </p>

    <!-- the axis detail's unknown-id redirect lands here with ?missing= -->
    <p
      v-if="firstString(route.query.missing)"
      class="msg msg-error"
      role="alert"
      data-test="missing"
    >
      指定されたカテゴリは見つかりません
    </p>

    <Transition name="handover" type="transition">
    <div
      v-if="analysis && totals"
      key="data"
      class="view-stack"
    >
      <!-- TASK-146 §3: the content transition fires at the load commit.
           TASK-161 §2: a period move renders in place (dir stays 'swap') -->
      <ContentSwap :swap-key="committedKey">
        <div class="content-pane">
          <PeriodHeader
            :label="period.label"
            :total="totals.amount"
            :swap-key="committedKey"
          />

          <div class="dash-cols">
            <div class="col-main">
              <section
                class="zone"
                data-test="trend-card"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    支出の推移
                  </h2>
                </div>
                <TrendWindow
                  v-if="win.result.value"
                  :stacked="win.stacked.value"
                  :granularity="win.granularity.value"
                  :span="win.window.value"
                  :current="trendCurrent"
                  :nav="win.active.value"
                  :can-prev="win.canPrev.value"
                  :can-next="win.canNext.value"
                  :window-key="win.windowKey.value"
                  :slide="win.slide.value"
                  @prev="win.prev"
                  @next="win.next"
                  @select="onTrendSelect"
                  @finish-slide="win.finishSlide"
                />
              </section>
            </div>

            <div class="col-side">
              <section
                class="zone zone--list"
                data-test="ranking"
              >
                <div class="zone-head">
                  <h2 class="zone-title">
                    カテゴリ別
                  </h2>
                </div>
                <p
                  v-if="rows.length === 0"
                  class="muted empty"
                >
                  この期間の記録はありません。
                </p>
                <RankedList
                  v-else
                  :rows="rows"
                  :to="rowTo"
                  axis="category"
                  :scale="screenScale"
                />
              </section>
            </div>
          </div>
        </div>
      </ContentSwap>
    </div>
    <DashSkeleton v-else-if="loading" key="skeleton" />
    </Transition>
  </div>
</template>
