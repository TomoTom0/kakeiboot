<script setup lang="ts">
import AppIcon, { type IconName } from './AppIcon.vue'

// Icon-only action button (TASK-47): the row-level secondary actions, the
// inline row editors' confirm pair and the issue/add submits render as a
// 44px square glyph with no visible text. `label` is both the accessible
// name (aria-label) and the hover tooltip (title); destructive and primary
// actions pick a variant. The wording rules that keep text buttons (the
// destructive confirm step, form/dialog primaries, tabs) live in the
// TASK-47 design §1-2 — this component is only for the icon side.
withDefaults(
  defineProps<{
    icon: IconName
    label: string
    variant?: 'default' | 'primary' | 'danger'
    type?: 'button' | 'submit'
    disabled?: boolean
    /** data-test of the button; callers keep their existing hooks */
    test?: string
  }>(),
  { variant: 'default', type: 'button', disabled: false, test: undefined },
)
</script>

<template>
  <button
    :type="type"
    class="ibtn"
    :class="variant !== 'default' ? variant : undefined"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    :data-test="test"
  >
    <AppIcon :name="icon" />
  </button>
</template>
