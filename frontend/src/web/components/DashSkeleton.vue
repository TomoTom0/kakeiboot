<script setup lang="ts">
// Loading placeholder for the dashboard screens (TASK-39 D, TASK-89 /
// TASK-105: the reading screens are a zone stack): the same silhouette as
// the loaded page (headline block + trend bars + ruled rows), flat
// single-color blocks. The reveal timing and the pulse live in the
// .skeleton CSS: the blocks stay invisible for a load's first 250ms (a
// fast load never shows them) and then fade in and breathe until the
// content commits. Decorative blocks are aria-hidden; the screen-reader
// text carries the loading state.
</script>

<template>
  <div
    class="view-stack skeleton"
    aria-hidden="true"
    data-test="loading"
  >
    <p class="sr-only">
      読み込んでいます...
    </p>
    <section class="zone">
      <span class="sk sk-label" />
      <span class="sk sk-value" />
      <span class="sk sk-line" />
    </section>
    <section class="zone">
      <span class="sk sk-label" />
      <div class="sk sk-bars">
        <span
          v-for="i in 5"
          :key="i"
          class="sk sk-bar"
          :style="{ height: `${[40, 65, 50, 80, 30][i - 1]}%` }"
        />
      </div>
    </section>
    <section class="zone">
      <span class="sk sk-label" />
      <span class="sk sk-line" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </section>
  </div>
</template>
