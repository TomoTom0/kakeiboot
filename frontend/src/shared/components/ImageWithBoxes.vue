<script setup lang="ts">
// Receipt image with an approximate bbox highlight (spec §11-5). The URL must
// already be validated by the caller; it is checked again here so a bad value
// never reaches <img :src>. The overlay uses normalized coordinates in a
// 0..1 viewBox, so only numbers are bound (spec §11-6).
import { computed, ref } from 'vue'
import type { BBox } from '@/shared/types'
import { isSafeImageUrl } from '@/shared/format'

const props = withDefaults(
  defineProps<{
    url: string | null
    width?: number | null
    height?: number | null
    bbox?: BBox | null
    alt?: string
    allowedOrigin?: string | null
  }>(),
  { width: null, height: null, bbox: null, alt: 'レシート画像', allowedOrigin: null },
)
const emit = defineEmits<{ (e: 'load-error'): void }>()

const failed = ref(false)
const safeUrl = computed(() => (isSafeImageUrl(props.url, props.allowedOrigin) ? props.url : null))
const box = computed(() => {
  const b = props.bbox
  if (!b || b.some((n) => !Number.isFinite(n))) return null
  const [x, y, w, h] = b.map((n) => Math.min(1, Math.max(0, n))) as BBox
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) }
})
const ratio = computed(() => (props.width && props.height ? props.height / props.width : null))

function onError() {
  failed.value = true
  emit('load-error')
}
function onLoad() {
  failed.value = false
}
defineExpose({ reset: () => (failed.value = false) })
</script>

<template>
  <div
    v-if="safeUrl"
    class="bb-img"
    :style="ratio ? { aspectRatio: `${1 / ratio}` } : undefined"
  >
    <img
      :src="safeUrl"
      :alt="alt"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="onError"
      @load="onLoad"
    >
    <svg
      v-if="box && !failed"
      class="bb-img__overlay"
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect
        class="bb-img__box"
        :x="box.x"
        :y="box.y"
        :width="box.w"
        :height="box.h"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <p
      v-if="failed"
      class="bb-img__failed"
    >
      画像を表示できません
    </p>
  </div>
  <p
    v-else
    class="bb-img__failed"
  >
    画像を表示できません
  </p>
</template>

<style scoped>
.bb-img {
  position: relative;
  width: 100%;
  max-width: 480px;
}
.bb-img img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
}
.bb-img__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.bb-img__box {
  fill: var(--bb-accent-soft);
  stroke: var(--bb-accent);
  stroke-width: 2;
}
.bb-img__failed {
  color: var(--bb-muted);
  font-size: 0.85rem;
}
</style>
