<script setup lang="ts">
// Collapsible receipt image (spec §11-7: folded by default, tap to expand;
// bbox only for the tapped line). Expired / failed URLs are re-issued once via
// refresh_widget_images (spec §11-5).
import { computed, ref } from 'vue'
import type { BBox } from '@/shared/types'
import ImageWithBoxes from '@/shared/components/ImageWithBoxes.vue'
import { useWidgetStore } from '../stores/widget'
import { MEDIA_ORIGIN } from '../config'

const props = defineProps<{ kind: 'draft' | 'receipt'; id: number; bbox: BBox | null }>()
const store = useWidgetStore()
const open = ref(false)
const refreshed = ref(false)
const failed = ref(false)

const image = computed(() => store.imageFor(props.kind, props.id))

async function refresh() {
  if (refreshed.value) {
    failed.value = true
    return
  }
  refreshed.value = true
  const ok = await store.refreshImages([{ kind: props.kind, id: props.id }])
  if (!ok) failed.value = true
}

async function toggle() {
  open.value = !open.value
  if (open.value && image.value && Date.parse(image.value.expires_at) <= Date.now()) await refresh()
  else if (open.value && !image.value) await refresh()
}
</script>

<template>
  <section class="bb-section">
    <button
      type="button"
      class="bb-btn bb-btn--ghost"
      :aria-expanded="open"
      data-test="image-toggle"
      @click="toggle"
    >
      {{ open ? '画像を閉じる' : '画像を表示' }}
    </button>
    <div v-if="open">
      <ImageWithBoxes
        v-if="image && !failed"
        :key="image.url"
        :url="image.url"
        :width="image.width"
        :height="image.height"
        :bbox="bbox"
        :allowed-origin="MEDIA_ORIGIN"
        @load-error="refresh"
      />
      <p
        v-else
        class="bb-muted"
      >
        画像を表示できません
      </p>
      <p
        v-if="!bbox"
        class="bb-muted bb-small"
      >
        明細をタップすると画像上のおおよその位置を表示します
      </p>
    </div>
  </section>
</template>
