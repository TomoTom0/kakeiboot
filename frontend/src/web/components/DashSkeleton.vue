<script setup lang="ts">
// Loading placeholder for the dash-grid screens (TASK-39 D): the same grid
// silhouette as the loaded dashboard (kpi + side card + two wide rows),
// flat single-color blocks — no shimmer, no per-item motion. Decorative
// blocks are aria-hidden; the screen-reader text carries the loading state.
</script>

<template>
  <div
    class="dash-grid skeleton"
    aria-hidden="true"
    data-test="loading"
  >
    <p class="sr-only">
      読み込んでいます...
    </p>
    <section class="card">
      <span class="sk sk-label" />
      <span class="sk sk-value" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </section>
    <section class="card">
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
    <section class="card wide">
      <span class="sk sk-label" />
      <span class="sk sk-line" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </section>
    <section class="card">
      <span class="sk sk-label" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </section>
    <section class="card wide">
      <span class="sk sk-label" />
      <span class="sk sk-line" />
      <span class="sk sk-line short" />
    </section>
  </div>
</template>
