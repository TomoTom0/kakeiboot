<script setup lang="ts">

// The detail pages' heading row (TASK-74 §4-5): the kind label (with the
// parent's name beside it on a subcategory page), the name, the total at the
// right end and the "..." menu slot. The ‹ the row used to carry is gone
// (TASK-164 §2-4/§2-6): the topbar ‹ took the axis back over as a history
// back, and the heading row stays a heading — the page's live-query carry
// (TASK-145 D2-2) died with it.
defineProps<{
  kindLabel: string
  title: string
  total?: string
  sub?: string
  parent?: string
}>()
</script>

<template>
  <div class="page-head">
    <p class="page-head-kind">
      <span
        v-if="parent"
        class="page-head-parent"
      >{{ parent }}</span>{{ kindLabel }}
    </p>
    <h2 class="page-head-title">
      {{ title }}
    </h2>
    <span
      v-if="total"
      class="page-head-total"
      data-test="total"
    >{{ total }}</span>
    <slot name="menu" />
  </div>
  <p
    v-if="sub"
    class="page-head-sub muted small"
  >
    {{ sub }}
  </p>
</template>
