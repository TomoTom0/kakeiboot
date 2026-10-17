import pluginVue from 'eslint-plugin-vue'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    rules: {
      // XSS: never render HTML strings (spec_mcp-tools.md widget XSS rules).
      'vue/no-v-html': 'error',
      // PageMenu (TASK-45) takes an `ariaLabel` prop; vue-tsc does not resolve
      // a kebab-case `aria-label` attribute onto a declared prop, so the
      // binding stays camelCase and the hyphenation rule skips it.
      'vue/attribute-hyphenation': ['warn', 'always', { ignore: ['ariaLabel'] }],
    },
  },
)
