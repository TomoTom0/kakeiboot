<script setup lang="ts">
// TASK-175 H-9 (design: tmp/tasks/tm-175/design_receipt-header-layout.md v3
// §1): the receipt head's ONE shared component — the same two-row grammar
// on every surface (the web ReceiptPanel, the widget Receipt/Draft screens).
// The MAIN row is the list-row composition at detail sizes (the name flexes
// and alone ellipsizes, the total keeps its width with the label riding
// INLINE ahead of the 1.9rem w700 value, the actions sit at the row's far
// right edge); the SUB row is ONE context element plus the right-edge host.
// Slots carry the surface differences (links vs plain text, the pencil, the
// picker vs chips); the grammar — rows, tokens, vocabulary — lives here and
// in shared/styles/row-grammar.css alone.
defineSlots<{
  title(): unknown
  total(): unknown
  actions?(): unknown
  'total-diff'?(): unknown
  context(): unknown
  'sub-end'(): unknown
}>()
</script>

<template>
  <header class="receipt-header">
    <div class="receipt-mainrow">
      <h2
        class="receipt-title"
        tabindex="-1"
      >
        <slot name="title" />
      </h2>
      <span class="receipt-total">
        <span class="receipt-total__label">合計</span>
        <strong
          class="receipt-total__value"
          data-test="total"
        ><slot name="total" /></strong>
      </span>
      <slot name="actions" />
    </div>
    <!-- H-4: the total_diff warn line rides directly under the MAIN row
         (right-aligned — it belongs to the total), rendered only when the
         surface passes one; without it the sub row follows at once -->
    <slot name="total-diff" />
    <p class="receipt-sub">
      <span class="receipt-sub-context"><slot name="context" /></span>
      <span class="receipt-sub-end"><slot name="sub-end" /></span>
    </p>
  </header>
</template>
