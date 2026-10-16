<script setup lang="ts">
import { computed } from 'vue'

// Brand logo (TASK-27 §1, L2): a decorative SVG mark (rounded frame + leaf)
// plus the wordmark as real HTML text — full shows "kakeiboot", compact
// "kb" — so the letters read at any size and font. The `word` prop
// overrides the default text (the topbar full logo passes "Kakei"; the
// login-screen logo keeps the full app name). The variants share one
// identical mark; its colors come from CSS classes (.logo-mark-bg /
// .logo-mark-leaf), not SVG presentation attributes (a standalone file or
// an attribute-only context could not resolve CSS variables).
export type LogoVariant = 'full' | 'compact'

const props = withDefaults(
  defineProps<{ variant?: LogoVariant; height?: number; word?: string }>(),
  {
    variant: 'full',
    height: 26,
    word: undefined,
  },
)

const WORD: Record<LogoVariant, string> = { full: 'kakeiboot', compact: 'kb' }
// full rides at ~0.62 of the mark height; compact stays smaller beside it
const FONT_RATIO: Record<LogoVariant, number> = { full: 0.62, compact: 0.5 }

// an unknown variant renders nothing (the old "mark" variant is gone)
const known = computed(() => props.variant in WORD)
const word = computed(() => props.word ?? WORD[props.variant as LogoVariant] ?? '')
const fontSize = computed(() =>
  Math.round(props.height * (FONT_RATIO[props.variant as LogoVariant] ?? 0.62)),
)
</script>

<template>
  <span
    v-if="known"
    :class="`logo logo-${variant}`"
    role="img"
    aria-label="kakeiboot"
  >
    <svg
      aria-hidden="true"
      :width="height"
      :height="height"
      viewBox="0 0 24 24"
    >
      <rect
        class="logo-mark-bg"
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="6.5"
        stroke-width="1.5"
      />
      <g
        class="logo-mark-leaf"
        transform="translate(3.36 3.36) scale(0.72)"
        fill="none"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z" />
        <path d="M2 21c0-3 1.9-5.4 5.1-6" />
      </g>
    </svg>
    <span
      class="logo-word"
      aria-hidden="true"
      :style="{ fontSize: `${fontSize}px` }"
    >{{ word }}</span>
  </span>
</template>
