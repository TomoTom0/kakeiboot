<script setup lang="ts">
import { ref } from 'vue'
import LabelChip from '@/shared/components/LabelChip.vue'
import { labelAriaName, labelIndexOf, type Label, type LabelColor } from '@/shared/labels'

// The five fixed labels as toggle chips (TASK-26 2-2), shared by the
// receipt picker popover and the filter popover. Each label is an
// aria-pressed button (spoken name = labelAriaName) wrapping a LabelChip
// that carries the selected ring / check; the tap target is 44px tall
// around a 32px chip. ArrowLeft / ArrowRight rove the focus through the
// buttons; `testKey` prefixes the data-test names so the picker
// (label-toggle-<c>) and the filter (label-filter-<c>) stay distinct.
withDefaults(
  defineProps<{
    selected: LabelColor[]
    definitions: Label[]
    groupLabel: string
    disabled?: boolean
    testKey?: string
  }>(),
  { disabled: false, testKey: 'label-toggle' },
)
const emit = defineEmits<{ toggle: [color: LabelColor] }>()

const rootEl = ref<HTMLElement | null>(null)

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
  const all = rootEl.value?.querySelectorAll<HTMLButtonElement>('button')
  const buttons = all ? Array.from(all).filter((b) => !b.disabled) : []
  if (buttons.length === 0) return
  e.preventDefault()
  const idx = buttons.findIndex((b) => b === document.activeElement)
  if (idx === -1) {
    buttons[0]!.focus()
    return
  }
  const step = e.key === 'ArrowRight' ? 1 : buttons.length - 1
  buttons[(idx + step) % buttons.length]!.focus()
}
</script>

<template>
  <div
    ref="rootEl"
    class="label-toggle-group"
    role="group"
    :aria-label="groupLabel"
    @keydown="onKeydown"
  >
    <button
      v-for="l in definitions"
      :key="l.color"
      type="button"
      class="label-toggle"
      :aria-pressed="selected.includes(l.color)"
      :aria-label="labelAriaName(l, labelIndexOf(l.color))"
      :disabled="disabled"
      :data-test="`${testKey}-${l.color}`"
      @click="emit('toggle', l.color)"
    >
      <LabelChip
        :label="l"
        :index="labelIndexOf(l.color)"
        :selected="selected.includes(l.color)"
      />
    </button>
  </div>
</template>
