import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

describe('eslint config', () => {
  it('rejects v-html (vue/no-v-html is an error)', async () => {
    const eslint = new ESLint({ cwd: process.cwd() })
    const [result] = await eslint.lintText(
      '<script setup lang="ts">\nconst s = "x"\n</script>\n\n<template>\n  <div v-html="s" />\n</template>\n',
      { filePath: 'src/shared/components/Probe.vue' },
    )
    const ids = (result?.messages ?? []).map((m) => m.ruleId)
    expect(ids).toContain('vue/no-v-html')
  }, 60_000) // loading the typed eslint config takes >5s while cargo builds in parallel (mise run verify)
})
