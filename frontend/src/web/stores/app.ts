import { defineStore } from 'pinia'
import { ref } from 'vue'

// Web entry store (API driven). Holds the app name for aria / page-title use
// (the brand mark itself is BrandLogo.vue, TASK-16 item 4).
export const useWebAppStore = defineStore('web-app', () => {
  const title = ref('kakeiboot')
  return { title }
})
