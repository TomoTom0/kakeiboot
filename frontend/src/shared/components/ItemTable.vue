<script setup lang="ts">
// Mobile line list: "name / amount" on the first row, category on the second
// (spec §11-7). Shows at most `limit` rows with a "show more" button (spec §11-3).
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

const props = withDefaults(defineProps<{ rows: ItemRow[]; limit?: number; selected?: number | null }>(), {
  limit: 8,
  selected: null,
})
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
  <ul class="bb-items">
    <li
      v-for="r in visible"
      :key="r.key"
      class="bb-items__row"
      :class="{ 'bb-items__row--selected': selected === r.key, 'bb-items__row--discount': r.discount }"
      :data-line="r.key"
    >
      <button
        type="button"
        class="bb-items__btn"
        :disabled="!r.selectable"
        @click="emit('select', r.key)"
      >
        <span class="bb-items__main">
          <span class="bb-items__name">{{ r.name }}</span>
          <MoneyAmount :value="r.amount" />
        </span>
        <span
          class="bb-items__cat"
          :class="{ 'bb-items__cat--unknown': r.categoryStatus === 'unknown' }"
        >{{ categoryText(r) }}<template v-if="r.detail"> ・ {{ r.detail }}</template></span>
      </button>
    </li>
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

<style scoped>
.bb-items {
  list-style: none;
  margin: 0;
  padding: 0;
}
.bb-items__row {
  border-bottom: 1px solid var(--bb-border);
}
.bb-items__row--selected {
  background: var(--bb-accent-soft);
}
.bb-items__btn {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 6px 4px;
  cursor: pointer;
}
.bb-items__btn:disabled {
  cursor: default;
}
.bb-items__btn:focus-visible {
  outline: 2px solid var(--bb-accent);
}
.bb-items__main {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.bb-items__name {
  overflow-wrap: anywhere;
}
.bb-items__row--discount .bb-items__name {
  padding-left: 1em;
}
.bb-items__cat {
  display: block;
  font-size: 0.8rem;
  color: var(--bb-muted);
}
.bb-items__cat--unknown {
  color: var(--bb-warn);
  font-weight: 600;
}
</style>
