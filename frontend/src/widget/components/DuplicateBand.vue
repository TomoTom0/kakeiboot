<script setup lang="ts">
// "重複の可能性: 下書き #x / レシート #y" band (spec §6, §11-2). Built from
// possible_duplicates and duplicate_* warnings of the approval result. It never
// disables the approve button.
import { computed } from 'vue'
import type { PossibleDuplicate, Warning } from '@/shared/types'

const props = withDefaults(defineProps<{ duplicates?: PossibleDuplicate[]; warnings?: Warning[] }>(), {
  duplicates: () => [],
  warnings: () => [],
})

const DUP_CODES = new Set(['duplicate_file', 'duplicate_image', 'duplicate_content'])

const targets = computed(() => {
  const seen = new Set<string>()
  const out: { kind: 'draft' | 'receipt'; id: number; ledger: string | null }[] = []
  const add = (kind: 'draft' | 'receipt', id: number, ledger: string | null) => {
    const k = `${kind}:${id}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ kind, id, ledger })
  }
  for (const d of props.duplicates) add(d.kind, d.id, d.ledger?.name ?? null)
  for (const w of props.warnings) {
    if (!DUP_CODES.has(w.code)) continue
    const kind = w.detail?.kind
    const id = w.detail?.id
    if ((kind === 'draft' || kind === 'receipt') && typeof id === 'number') add(kind, id, null)
  }
  return out
})
const generic = computed(() => targets.value.length === 0 && props.warnings.some((w) => DUP_CODES.has(w.code)))
</script>

<template>
  <div
    v-if="targets.length > 0 || generic"
    class="bb-band bb-band--warn"
    role="status"
    data-test="duplicate-band"
  >
    <span>重複の可能性: </span>
    <template
      v-for="(t, i) in targets"
      :key="`${t.kind}:${t.id}`"
    >
      <span v-if="i > 0"> / </span>
      <span>{{ t.kind === 'draft' ? '下書き' : 'レシート' }} #{{ t.id }}</span>
      <span
        v-if="t.ledger"
        class="bb-muted"
      >（{{ t.ledger }}）</span>
    </template>
    <span v-if="generic">同じ内容の登録があります</span>
  </div>
</template>
