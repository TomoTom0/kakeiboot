<script setup lang="ts">
import { computed } from 'vue'
import { LABEL_COLORS, LABEL_NAME, labelText, type LabelColor } from '@/shared/labels'
import { useLabelsStore } from '../stores/labels'
import { useSessionStore } from '../stores/session'

// Label filter toggles (TASK-17): OR over the selected colors (aria-pressed
// buttons, the color name — and the title when one is set — as the visible
// text). v-model holds the LabelColor[] selection.
const props = defineProps<{ modelValue: LabelColor[] }>()
const emit = defineEmits<{ 'update:modelValue': [colors: LabelColor[]] }>()

const session = useSessionStore()
const labelsStore = useLabelsStore()
const definitions = computed(() => labelsStore.definitions(session.selectedLedgerId ?? -1))
const titleOf = (c: LabelColor): string | null => definitions.value.find((l) => l.color === c)?.title ?? null

function toggle(c: LabelColor): void {
  emit(
    'update:modelValue',
    props.modelValue.includes(c) ? props.modelValue.filter((x) => x !== c) : [...props.modelValue, c],
  )
}
</script>

<template>
  <span
    class="label-filter"
    role="group"
    aria-label="ラベルで絞り込み"
  >
    <button
      v-for="c in LABEL_COLORS"
      :key="c"
      type="button"
      class="label-toggle label-toggle-sm"
      :class="[`label-${c}`, { on: modelValue.includes(c) }]"
      :aria-pressed="modelValue.includes(c)"
      :aria-label="labelText({ color: c, title: titleOf(c) })"
      :data-test="`label-filter-${c}`"
      @click="toggle(c)"
    >{{ LABEL_NAME[c] }}<span
      v-if="titleOf(c)"
      class="label-toggle-title"
    >{{ titleOf(c) }}</span></button>
  </span>
</template>
