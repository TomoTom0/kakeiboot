<script setup lang="ts">
// F1: the connection-flow overview diagram of /usage/connect (TASK-37), an
// inline SVG like the charts (no v-html). Four panels on one wide viewBox:
// register the URL -> log in and allow in the browser -> back in the
// service -> send receipts. The <text> is limited to the panel titles
// (<= 6 chars) so
// the glyphs stay readable at the 390px phone width: the figure renders at
// ~316px there (card padding), so a 28-unit font lands around 11-12px. The
// explanations live in the step bodies and the figcaption, not inside the
// SVG. Dark mode follows via the CSS variables (styles.css .usage-flow-*).
</script>

<template>
  <svg
    viewBox="0 0 760 210"
    class="usage-flow"
    role="img"
    aria-label="接続の流れ: サービスにURLを登録し、ブラウザでログインと許可を行い、サービスでレシートを送って記録する"
    data-test="connect-flow"
  >
    <!-- panel 1: phone with a link glyph (register the URL in the service) -->
    <g transform="translate(8 8)">
      <rect
        x="0"
        y="0"
        width="172"
        height="194"
        rx="14"
        class="usage-flow-panel"
      />
      <rect
        x="58"
        y="22"
        width="56"
        height="104"
        rx="9"
        class="usage-flow-glyph"
      />
      <g
        transform="translate(67 62) scale(1.6)"
        class="usage-flow-glyph"
      >
        <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
        <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
      </g>
      <text
        x="86"
        y="176"
        class="usage-flow-title"
      >URL登録</text>
    </g>

    <!-- panel 2: browser window with a check (log in and allow) -->
    <g transform="translate(198 8)">
      <rect
        x="0"
        y="0"
        width="172"
        height="194"
        rx="14"
        class="usage-flow-panel"
      />
      <rect
        x="40"
        y="28"
        width="92"
        height="92"
        rx="8"
        class="usage-flow-glyph"
      />
      <line
        x1="40"
        y1="50"
        x2="132"
        y2="50"
        class="usage-flow-glyph"
      />
      <circle
        cx="51"
        cy="39"
        r="2.5"
        class="usage-flow-dot"
      />
      <circle
        cx="62"
        cy="39"
        r="2.5"
        class="usage-flow-dot"
      />
      <circle
        cx="73"
        cy="39"
        r="2.5"
        class="usage-flow-dot"
      />
      <g
        transform="translate(62 58) scale(2)"
        class="usage-flow-accent"
      >
        <path d="M20 6 9 17l-5-5" />
      </g>
      <text
        x="86"
        y="176"
        class="usage-flow-title"
      >ログイン許可</text>
    </g>

    <!-- panel 3: done (a circled check back in the service) -->
    <g transform="translate(388 8)">
      <rect
        x="0"
        y="0"
        width="172"
        height="194"
        rx="14"
        class="usage-flow-panel"
      />
      <circle
        cx="86"
        cy="78"
        r="44"
        class="usage-flow-glyph"
      />
      <g
        transform="translate(62 54) scale(2)"
        class="usage-flow-accent"
      >
        <path d="M20 6 9 17l-5-5" />
      </g>
      <text
        x="86"
        y="176"
        class="usage-flow-title"
      >接続完了</text>
    </g>

    <!-- panel 4: a receipt and bars (send receipts in the chat) -->
    <g transform="translate(578 8)">
      <rect
        x="0"
        y="0"
        width="172"
        height="194"
        rx="14"
        class="usage-flow-panel"
      />
      <g
        transform="translate(42 54) scale(2)"
        class="usage-flow-glyph"
      >
        <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z" />
        <path d="M9 8h6" />
        <path d="M9 12h6" />
        <path d="M9 16h3" />
      </g>
      <rect
        x="106"
        y="94"
        width="10"
        height="20"
        rx="2"
        class="usage-flow-bar"
      />
      <rect
        x="122"
        y="84"
        width="10"
        height="30"
        rx="2"
        class="usage-flow-bar"
      />
      <rect
        x="138"
        y="76"
        width="10"
        height="38"
        rx="2"
        class="usage-flow-bar"
      />
      <text
        x="86"
        y="176"
        class="usage-flow-title"
      >レシート送信</text>
    </g>

    <!-- flow arrows between the panels -->
    <g class="usage-flow-arrow">
      <path d="M188 105l7 7-7 7" />
      <path d="M378 105l7 7-7 7" />
      <path d="M568 105l7 7-7 7" />
    </g>
  </svg>
</template>
