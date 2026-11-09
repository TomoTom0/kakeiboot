<script setup lang="ts">
import { computed, ref, useAttrs, useId } from 'vue'
import { usePopover } from '../composables/popover'
import { prefersReducedMotion } from '../composables/reducedMotion'

// PopoverPanel (TASK-27 §4): the shared non-modal role=dialog popover for
// forms and toggles (PopoverMenu keeps role=menu for real menus). The
// trigger slot receives aria-expanded / aria-controls and v-binds them onto
// its own button; the panel takes its aria-label from `label` (required),
// opens below the trigger and lands the focus on [data-autofocus] (or the
// first focusable element). variant="sheet-narrow" turns into a bottom
// sheet at 480px and below. TASK-146 §3 #15: the open/close is an appear
// fade (the page vocabulary) on the panel and the scrim — one Transition
// here covers every popover use; the role / focus / outside / Escape
// contracts are unchanged.
const props = withDefaults(
  defineProps<{ variant?: 'anchored' | 'sheet-narrow'; label: string }>(),
  { variant: 'anchored' },
)

const open = defineModel<boolean>('open', { default: false })

const rootEl = ref<HTMLElement | null>(null)
const triggerWrap = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

const panelId = useId()

// the narrow-screen class appears only while a sheet-narrow panel is open
// at 480px or below (re-checked on every open)
const narrow = ref(false)
const isSheet = computed(() => props.variant === 'sheet-narrow')

function focusPanel(): void {
  const panel = panelEl.value
  if (!panel) return
  const target =
    panel.querySelector<HTMLElement>('[data-autofocus]') ??
    panel.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  target?.focus()
}

const { toggle, close } = usePopover({
  open,
  rootEl,
  triggerEl: triggerWrap,
  panelEl,
  onOpened() {
    narrow.value = isSheet.value && window.matchMedia('(max-width: 480px)').matches
    focusPanel()
  },
})

// data-test and friends go to the dialog; class goes to the wrapper.
const attrs = useAttrs()
const hostClass = computed(() => (typeof attrs.class === 'string' && attrs.class !== '' ? attrs.class : null))
const panelAttrs = computed(() => {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attrs)) if (k !== 'class') rest[k] = v
  return rest
})

defineOptions({ inheritAttrs: false })

// reduced motion skips the fade classes entirely (an instant swap; the
// stylesheet repeats the guard) — web-common.overlay-transition
const motion = computed(() => !prefersReducedMotion())
</script>

<template>
  <div
    ref="rootEl"
    class="popover-host"
    :class="[`popover-${variant}`, hostClass]"
  >
    <div
      ref="triggerWrap"
      class="popover-trigger"
      @click="toggle"
    >
      <slot
        name="trigger"
        v-bind="{ 'aria-expanded': open, 'aria-controls': panelId }"
      />
    </div>
    <Transition
      name="page"
      appear
      :css="motion"
    >
      <div
        v-if="open && narrow"
        class="popover-scrim"
        aria-hidden="true"
        @click="close"
      />
    </Transition>
    <Transition
      name="page"
      appear
      :css="motion"
    >
      <div
        v-if="open"
        :id="panelId"
        ref="panelEl"
        class="popover-dialog"
        :class="{ 'is-narrow': narrow }"
        role="dialog"
        :aria-label="label"
        v-bind="panelAttrs"
      >
        <slot />
      </div>
    </Transition>
  </div>
</template>
