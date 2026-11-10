<script setup lang="ts">
// The widget's item list (spec §11-7), riding the SHARED .items token — the
// same classes the web's table.items reference (TASK-170 W-3: one definition
// point in shared/styles/row-grammar.css; the structure implementations
// stay two, table and list). One line per item: the name with the category
// INLINE after it (muted 0.78rem; unknown keeps the warning color; the
// history note and the quantity ride the same line) and the .num amount at
// the right. The 明細合計 block sits ABOVE the folding list and carries the
// envelope's FULL total — the folded rows count in too (never the visible
// partial sum). Shows at most `limit` rows with a "show more" button (spec
// §11-3); the rows enter through the bb-appear grammar (TASK-170 W-9).
import { computed, ref } from 'vue'
import MoneyAmount from './MoneyAmount.vue'

export type ItemRow = {
  key: number
  name: string
  amount: number
  category: string | null
  /** 'unknown' is drawn with the warning color (spec §11-2). */
  categoryStatus?: 'ok' | 'unknown' | 'history' | null
  discount?: boolean
  selectable?: boolean
  detail?: string | null
}

const props = withDefaults(
  defineProps<{
    rows: ItemRow[]
    limit?: number
    selected?: number | null
    /** the envelope's items_total — the FULL sum of every line, folded or not */
    itemsTotal?: number | null
  }>(),
  { limit: 8, selected: null, itemsTotal: null },
)
const emit = defineEmits<{ (e: 'select', key: number): void }>()

const expanded = ref(false)
const visible = computed(() => (expanded.value ? props.rows : props.rows.slice(0, props.limit)))
const hidden = computed(() => props.rows.length - visible.value.length)

function categoryText(r: ItemRow) {
  if (r.categoryStatus === 'unknown') return `${r.category ?? '未分類'}（未知のカテゴリ）`
  if (r.categoryStatus === 'history') return `${r.category ?? '未分類'}（履歴から推定）`
  return r.category ?? '未分類'
}
</script>

<template>
  <p
    v-if="itemsTotal !== null"
    class="items-total"
    data-test="items-total"
  >
    <span class="items-total-label">明細合計</span>
    <span class="num"><MoneyAmount :value="itemsTotal" /></span>
  </p>
  <ul class="items">
    <TransitionGroup name="bb-appear">
      <li
        v-for="r in visible"
        :key="r.key"
        :class="{ 'item--selected': selected === r.key }"
        :data-line="r.key"
      >
        <button
          type="button"
          class="item-btn"
          :disabled="!r.selectable"
          @click="emit('select', r.key)"
        >
          <span class="item-line">
            <span class="item-name">{{ r.name }}</span>
            <span
              class="item-cat"
              :class="{ 'item-cat--unknown': r.categoryStatus === 'unknown' }"
            >{{ categoryText(r) }}<template v-if="r.detail"> ・ {{ r.detail }}</template></span>
          </span>
          <span class="num"><MoneyAmount :value="r.amount" /></span>
        </button>
      </li>
    </TransitionGroup>
  </ul>
  <button
    v-if="hidden > 0"
    type="button"
    class="bb-link"
    @click="expanded = true"
  >
    さらに表示（{{ hidden }}行）
  </button>
</template>
