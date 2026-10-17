<script setup lang="ts">
import { computed, ref } from 'vue'
import { labelAriaList, type Label, type LabelColor } from '@/shared/labels'
import { useLabelsStore } from '../stores/labels'
import { useSessionStore } from '../stores/session'
import AppIcon from './AppIcon.vue'
import LabelToggleGroup from './LabelToggleGroup.vue'
import PopoverPanel from './PopoverPanel.vue'

// Label filter (TASK-17, reshaped in TASK-26 2-4): one toolbar button that
// never takes a row of its own. Unselected it reads "ラベル" (the compact
// prop drops the word for icon-only toolbars); with a selection it shows
// the chosen labels as 6px color dots and an accent border, no words. The
// popover carries the same five-label toggle group as the picker plus a
// clear button; every change emits v-model (LabelColor[]) immediately.
const props = withDefaults(defineProps<{ modelValue: LabelColor[]; compact?: boolean }>(), {
  compact: false,
})
const emit = defineEmits<{ 'update:modelValue': [colors: LabelColor[]] }>()

const session = useSessionStore()
const labelsStore = useLabelsStore()
const open = ref(false)

const definitions = computed<Label[]>(() => labelsStore.definitions(session.selectedLedgerId ?? -1))

const selectedLabels = computed<Label[]>(() =>
  props.modelValue.map((c) => definitions.value.find((l) => l.color === c) ?? { color: c, title: null }),
)
const ariaLabel = computed(() =>
  props.modelValue.length === 0
    ? 'ラベルで絞り込み'
    : `ラベルで絞り込み: ${labelAriaList(selectedLabels.value)}`,
)

function toggle(c: LabelColor): void {
  emit(
    'update:modelValue',
    props.modelValue.includes(c) ? props.modelValue.filter((x) => x !== c) : [...props.modelValue, c],
  )
}

function clear(): void {
  emit('update:modelValue', [])
}
</script>

<template>
  <PopoverPanel
    v-model:open="open"
    variant="anchored"
    label="ラベルで絞り込み"
    class="label-filter"
    data-test="label-filter"
  >
    <template #trigger="{ 'aria-expanded': expanded, 'aria-controls': controls }">
      <button
        type="button"
        class="label-filter-btn"
        :class="{ active: modelValue.length > 0, compact }"
        :aria-expanded="expanded"
        :aria-controls="controls"
        :aria-label="ariaLabel"
        data-test="label-filter-button"
      >
        <AppIcon
          name="tag"
          :size="16"
        />
        <span
          v-if="modelValue.length === 0 && !compact"
          class="label-filter-word"
        >ラベル</span>
        <span
          v-if="modelValue.length > 0"
          class="label-filter-dots"
          aria-hidden="true"
        >
          <span
            v-for="c in modelValue"
            :key="c"
            class="label-filter-dot"
            :class="`label-${c}`"
          />
        </span>
      </button>
    </template>
    <LabelToggleGroup
      group-label="ラベルで絞り込み"
      :selected="modelValue"
      :definitions="definitions"
      test-key="label-filter"
      @toggle="toggle"
    />
    <div class="label-filter-foot">
      <button
        type="button"
        class="label-clear-btn"
        :disabled="modelValue.length === 0"
        data-test="label-filter-clear"
        @click="clear"
      >
        解除
      </button>
    </div>
  </PopoverPanel>
</template>
