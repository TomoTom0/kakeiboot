<script setup lang="ts">
import { computed } from 'vue'

// Line icons (24px grid, stroke = currentColor) drawn inline so the web
// screens need no icon font or package. Shapes follow the common
// outline-icon conventions (round caps / joins, 1.75 stroke).
const PATHS = {
  home: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5'],
  receipt: [
    'M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z',
    'M9 8h6',
    'M9 12h6',
    'M9 16h3',
  ],
  tag: [
    'M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z',
    'M7.5 7.5h.01',
  ],
  'tag-plus': [
    'M3 13V6a2 2 0 0 1 2-2h6l8 8-7 7z',
    'M18 3v4',
    'M16 5h4',
  ],
  store: [
    'M3 9l1.5-5h15L21 9',
    'M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0',
    'M5 11v9h14v-9',
    'M10 20v-5h4v5',
  ],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  link: [
    'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7',
    'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  ],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  dots: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.3-4.3'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  'chart': ['M3 3v18h18', 'M7 15l4-4 3 3 5-6'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  user: ['M20 21a8 8 0 0 0-16 0', 'M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z'],
  'user-plus': [
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    'M20 8v6',
    'M17 11h6',
  ],
  key: [
    'M15.5 7.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z',
    'M12 11v10',
    'M12 16h3',
    'M12 19h2',
  ],
  check: ['M20 6 9 17l-5-5'],
  lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  chat: ['M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'],
  help: [
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    'M9.6 9.2a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8v.4',
    'M12 17h.01',
  ],
  image: ['M3 5h18v14H3z', 'M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 19'],
  leaf: [
    'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z',
    'M2 21c0-3 1.9-5.4 5.1-6',
  ],
} as const

export type IconName = keyof typeof PATHS

const props = withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 20 })
const paths = computed(() => PATHS[props.name])
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path
      v-for="(d, i) in paths"
      :key="i"
      :d="d"
    />
  </svg>
</template>
