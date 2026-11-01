// The build-time corpus served by usageDocsPlugin() (src/build/usage-docs.ts):
// the docs/usage topics with their transformed documents. The plugin generates
// the module source; this declares its shape for the app-side imports.
declare module 'virtual:usage-docs' {
  import type { UsageTopic } from './usage-docs'
  export const usageTopics: UsageTopic[]
}
