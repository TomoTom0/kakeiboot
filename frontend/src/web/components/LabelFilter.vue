<script setup lang="ts">
import { computed } from 'vue'
import { labelAriaList, type Label, type LabelColor } from '@/shared/labels'
import { useLabelsStore } from '../stores/labels'
import { useSessionStore } from '../stores/session'
import AppIcon from './AppIcon.vue'
import LabelToggleGroup from './LabelToggleGroup.vue'
import PopoverPanel from './PopoverPanel.vue'

// Label filter (TASK-17, reshaped in TASK-26 2-4, topbar size in TASK-44
// §11-3/11-6): one button that never takes a row of its own. In the default
// toolbar size it reads "ラベル" when unselected (the compact prop drops the
// word); with a selection it shows the chosen labels as 6px color dots and an
// accent border, no words. size="topbar" (the topbar center filter bar) is
// the 44px-square chip: icon only when unselected, the dots alone at 520px
// and below while selected (the icon rides along at 521px+; a media query
// swaps them). The popover carries the same five-label toggle group as the
// picker plus a clear button; every change emits v-model (LabelColor[])
// immediately.
const props = withDefaults(
  defineProps<{ modelValue: LabelColor[]; compact?: boolean; size?: 'default' | 'topbar' }>(),
  { compact: false, size: 'default' },
)
const emit = defineEmits<{ 'update:modelValue': [colors: LabelColor[]] }>()

const session = useSessionStore()
const labelsStore = useLabelsStore()
// optional open model: the topbar embedding binds it so a route navigation
// can close the dialog (the bar itself survives the page swap); unbound it
// stays a local state
const open = defineModel<boolean>('open')
const topbar = computed(() => props.size === 'topbar')

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
        :class="[topbar ? 'filter-chip-btn topbar-label-chip' : 'label-filter-btn', { active: modelValue.length > 0, compact: compact && !topbar }]"
        :aria-expanded="expanded"
        :aria-controls="controls"
        :aria-label="ariaLabel"
        :data-test="topbar ? 'filter-labels' : 'label-filter-button'"
      >
        <span
          v-if="topbar"
          class="label-chip-icon"
        ><AppIcon
          name="tag"
          :size="16"
        /></span>
        <AppIcon
          v-else
          name="tag"
          :size="16"
        />
        <span
          v-if="modelValue.length === 0 && !compact && !topbar"
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
