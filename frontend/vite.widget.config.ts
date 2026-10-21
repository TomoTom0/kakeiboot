// The widget build pass (TASK-50, spec_mcp-tools.md 11-1): ChatGPT loads the
// widget template as one ui:// resource and cannot resolve /assets/*
// references, so the widget entry is built alone here (a single chunk via
// codeSplitting:false — the bundler only allows it with one entry, which is
// why the web pass in vite.config.ts builds web.html only) and its JS/CSS are
// inlined into widget.html by the inline-widget-html plugin. emptyOutDir
// stays false so the output of the preceding web pass survives; `pnpm build`
// runs this pass right after `vite build`.
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import base from './vite.config'
import { inlineWidgetHtml } from './src/build/inline-widget-html'

const basePlugins = (Array.isArray(base.plugins) ? base.plugins : [base.plugins]).filter(
  Boolean,
) as Plugin[]

export default defineConfig({
  ...base,
  plugins: [...basePlugins, inlineWidgetHtml()],
  build: {
    ...base.build,
    emptyOutDir: false,
    rollupOptions: {
      ...base.build?.rollupOptions,
      input: { widget: fileURLToPath(new URL('./widget.html', import.meta.url)) },
      output: { codeSplitting: false },
    },
  },
})
