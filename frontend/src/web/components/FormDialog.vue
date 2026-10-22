<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

// Small modal form dialog (TASK-46, spec_mcp-tools.md 12): the settings
// auth-tab issue / add flows moved off standing inline forms into this
// dialog. The trigger slot holds the opening button (the caller owns the
// open state through v-model:open and any prefill); a press on the backdrop
// or Escape closes, the focus lands on the first field ([data-autofocus],
// else the first focusable element) on open and returns to the trigger on
// close. The visual frame (.dialog-backdrop / .dialog) is the StepUpDialog
// recipe, the focus handling the usePopover recipe.
defineProps<{
  /** accessible name of the dialog (aria-label) */
  label: string
  /** data-test of the dialog element (e.g. invite-dialog) */
  test?: string
}>()

const open = defineModel<boolean>('open', { default: false })

const triggerWrap = ref<HTMLElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusTrigger(): void {
  const wrap = triggerWrap.value
  const target =
    wrap?.querySelector<HTMLElement>(
      'button, [role="button"], a[href], input, select, textarea',
    ) ?? wrap
  target?.focus()
}

function close(): void {
  if (!open.value) return
  open.value = false
  focusTrigger()
}

watch(open, (value, wasOpen) => {
  if (value) {
    void nextTick(() => {
      const el = dialogRef.value
      const target =
        el?.querySelector<HTMLElement>('[data-autofocus]') ??
        el?.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
    })
    return
  }
  // closed by the caller writing the model directly (a successful submit,
  // やめる) as well: give the focus back to the trigger the same way. The
  // focus waits for the next paint because this watcher runs pre-render —
  // the trigger may still carry a stale disabled in the DOM (the issue
  // flows flip busy off in the same flush), and focus() on a disabled
  // button is silently ignored
  if (wasOpen) void nextTick(() => focusTrigger())
})
</script>

<template>
  <div class="form-dialog-host">
    <div
      ref="triggerWrap"
      class="form-dialog-trigger"
    >
      <slot name="trigger" />
    </div>
    <div
      v-if="open"
      class="dialog-backdrop"
      @click.self="close"
    >
      <div
        ref="dialogRef"
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="label"
        :data-test="test"
        @keydown.esc.prevent="close"
      >
        <slot />
      </div>
    </div>
  </div>
</template>
