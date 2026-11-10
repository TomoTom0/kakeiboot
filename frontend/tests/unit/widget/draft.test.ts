import { describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { DraftItem, StatsEnvelope } from '@/shared/types'
import ItemTable from '@/shared/components/ItemTable.vue'
import BarHChart from '@/shared/components/charts/BarHChart.vue'
import LedgerBadge from '@/widget/components/LedgerBadge.vue'
import { draftEnvelope, draftMeta, mockImageUrl, receiptEnvelope, receiptMeta, sampleDraft, statsEnvelope } from '@/widget/fixtures'
import { paymentLabel } from '@/shared/format'
import { fakeHost, mountWidget, result } from './helpers'

describe('draft screen', () => {
  it('[covers:widget.duplicate-band] lists duplicates from possible_duplicates and duplicate_* warnings', async () => {
    const env = {
      ...draftEnvelope(),
      warnings: [
        { code: 'duplicate_image', message: 'x', detail: { kind: 'draft' as const, id: 5 } },
        { code: 'duplicate_content', message: 'x', detail: { kind: 'receipt' as const, id: 88 } },
        { code: 'total_mismatch', message: '差額 10円', detail: { diff: 10 } },
      ],
    }
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: env }))
    const band = wrapper.find('[data-test="duplicate-band"]')
    expect(band.text()).toContain('重複の可能性')
    expect(band.text().match(/レシート #88/g)).toHaveLength(1)
    expect(band.text()).toContain('下書き #5')
    expect(band.text()).not.toContain('差額')
    expect(wrapper.find('[data-test="approve-button"]').attributes('disabled')).toBeUndefined()

    const clean = await mountWidget(fakeHost({ toolOutput: draftEnvelope({ possible_duplicates: [] }) }))
    expect(clean.wrapper.find('[data-test="duplicate-band"]').exists()).toBe(false)
  })

  it('[covers:widget.unknown-category-warn] unknown categories use the warning class (inline on the name line)', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftEnvelope() }))
    const line4 = wrapper.find('[data-line="4"] .item-cat')
    expect(line4.classes()).toContain('item-cat--unknown')
    const line5 = wrapper.find('[data-line="5"] .item-cat')
    expect(line5.text()).toContain('履歴から推定')
    expect(line5.classes()).not.toContain('item-cat--unknown')
    // TASK-170 W-3: the category rides INLINE after the name — one line per
    // item, the old standalone second line is gone
    for (const n of [4, 5]) {
      const name = wrapper.find(`[data-line="${n}"] .item-name`)
      const cat = wrapper.find(`[data-line="${n}"] .item-cat`)
      expect(name.exists(), `line ${n} name`).toBe(true)
      expect(cat.element.parentElement, `line ${n} the category shares the name line container`).toBe(name.element.parentElement)
    }
  })

  it('[covers:widget.image-unavailable-display] shows the server display text and no image', async () => {
    for (const image of [
      { status: 'unavailable' as const, reason: 'chat_upload', display: '画像なし' },
      { status: 'unavailable' as const, reason: 'fetch_interrupted', display: '画像を処理中' },
    ]) {
      const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftEnvelope({ image }), meta: draftMeta() }))
      expect(wrapper.find('[data-test="image-display"]').text()).toBe(image.display)
      expect(wrapper.find('[data-test="image-toggle"]').exists()).toBe(false)
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.text()).not.toContain('アップロード')
    }
  })

  it('[covers:widget.bbox-overlay-on-row-tap] collapsed image, bbox only for the tapped line', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftEnvelope(), meta: draftMeta() }))
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.find('[data-test="image-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('img').attributes('src')).toBe(mockImageUrl('draft12token'))
    expect(wrapper.find('rect.bb-img__box').exists()).toBe(false)
    await wrapper.find('[data-line="2"] button').trigger('click')
    const rect = wrapper.find('rect.bb-img__box')
    expect([rect.attributes('x'), rect.attributes('y'), rect.attributes('width'), rect.attributes('height')]).toEqual(['0.1', '0.36', '0.8', '0.05'])
    expect(wrapper.find('svg.bb-img__overlay').attributes('viewBox')).toBe('0 0 1 1')
    await wrapper.find('[data-line="2"] button').trigger('click')
    expect(wrapper.find('rect.bb-img__box').exists()).toBe(false)
    expect(wrapper.find('[data-line="4"] button').attributes('disabled')).toBeDefined()
  })

  it('[covers:widget.image-refresh-on-error] re-issues the URL once via refresh_widget_images', async () => {
    const fresh = mockImageUrl('draft12fresh')
    const host = fakeHost({
      toolOutput: draftEnvelope(),
      meta: draftMeta(),
      callTool: async () =>
        result({ view: 'images', ledger: null }, { meta: { images: { 'draft:12': { url: fresh, expires_at: '2099-01-01T00:00:00+09:00', width: 600, height: 1200 } } } }),
    })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="image-toggle"]').trigger('click')
    await wrapper.find('img').trigger('error')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledTimes(1)
    expect(host.callTool).toHaveBeenCalledWith('refresh_widget_images', { refs: [{ kind: 'draft', id: 12 }] })
    expect(wrapper.find('img').attributes('src')).toBe(fresh)
    await wrapper.find('img').trigger('error')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('画像を表示できません')
  })

  it('[covers:widget.image-refresh-on-error] expired URL is refreshed when the image is opened', async () => {
    const meta = { images: { draft_image: { url: mockImageUrl('old'), expires_at: '2000-01-01T00:00:00+09:00', width: 1, height: 2 } } }
    const host = fakeHost({ toolOutput: draftEnvelope(), meta, callTool: async () => result(null, { isError: true }) })
    const { wrapper } = await mountWidget(host)
    await wrapper.find('[data-test="image-toggle"]').trigger('click')
    await flushPromises()
    expect(host.callTool).toHaveBeenCalledWith('refresh_widget_images', { refs: [{ kind: 'draft', id: 12 }] })
    expect(wrapper.text()).toContain('画像を表示できません')
  })

  it('[covers:widget.xss-text-rendering] HTML in user strings is rendered as text', async () => {
    const IMG = '<img src=x onerror=alert(1)>'
    const SCRIPT = '<script>alert(1)</script>'
    const items: DraftItem[] = [
      { line_no: 1, name: IMG, amount: 100, category: SCRIPT },
      { line_no: 2, name: SCRIPT, amount: 200, category: null },
    ]
    const env = draftEnvelope({ payload: { ...sampleDraft().payload, store_name: IMG, note: SCRIPT, items } })
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: env }))
    expect(wrapper.text()).toContain(IMG)
    expect(wrapper.text()).toContain(SCRIPT)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.findAll('img').filter((i) => i.attributes('onerror') !== undefined)).toHaveLength(0)

    const stats: StatsEnvelope = statsEnvelope('by_store')
    // TASK-161 §6-2 (web-browse.trend-axis-minimal): the fixed labelChars
    // prop is gone — the truncation is width-based (the label column's
    // viewBox units by the estimated glyph width). The 26-char label cannot
    // fit the column: it truncates in JS with a trailing … and still renders
    // as a text node (the XSS purpose of this assertion keeps)
    const chart = mount(BarHChart, { props: { data: [{ label: SCRIPT, value: 1 }] } })
    const label = chart.find('text.bb-chart__label').element.textContent ?? ''
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(SCRIPT.length)
    expect(chart.find('script').exists()).toBe(false)
    const s = await mountWidget(fakeHost({ toolOutput: { ...stats, sections: [{ ...stats.sections[0]!, rows: [{ keys: [1], labels: [IMG], value: 5 }] }] } }))
    expect(s.wrapper.findAll('img')).toHaveLength(0)
    expect(s.wrapper.find('text.bb-chart__label').element.textContent).toContain('<img')
  })

  it('[covers:widget.items-show-more] at most 8 lines until "show more"; the total is the FULL sum while folded', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ key: i + 1, name: `品${i + 1}`, amount: 100, category: null }))
    const w = mount(ItemTable, { props: { rows, itemsTotal: 2000 } })
    expect(w.findAll('li')).toHaveLength(8)
    const more = w.find('button.bb-link')
    expect(more.text()).toBe('さらに表示（3行）')
    // TASK-170 W-3: itemsTotal carries the envelope's items_total — the
    // folded rows count in too (2000, NOT the visible 8 × 100 partial sum),
    // and the total row is outside the folding list
    const total = w.find('[data-test="items-total"]')
    expect(total.exists()).toBe(true)
    expect(total.classes()).toContain('items-total')
    expect(total.text()).toContain('明細合計')
    expect(total.text()).toContain('2,000円')
    expect(total.element.closest('ul')).toBeNull()
    await more.trigger('click')
    expect(w.findAll('li')).toHaveLength(11)
    expect(w.find('button.bb-link').exists()).toBe(false)
    expect(w.find('[data-test="items-total"]').text()).toContain('2,000円')
    const few = mount(ItemTable, { props: { rows: rows.slice(0, 8) } })
    expect(few.find('button.bb-link').exists()).toBe(false)
  })

  it('[covers:widget.receipt-detail-item-tiers] 明細は3層: 品目行（name+inline category+w600 num）< 明細合計 < 頭部合計（.receipt-total 最強）', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftEnvelope() }))
    // the list rides the SHARED .items token (the same class the web table
    // references); each item's amount is the .num token (w600 tabular in CSS)
    const list = wrapper.find('[data-test="draft-screen"] ul.items')
    expect(list.exists()).toBe(true)
    // review指摘2: the name and the inline category share ONE wrappable
    // container (.item-line) so a long category wraps instead of pushing
    // the amount out of the row
    expect(wrapper.find('[data-line="1"] .item-name').element.parentElement?.classList.contains('item-line')).toBe(true)
    const first = wrapper.find('[data-line="1"]')
    expect(first.find('.item-name').text()).toBe('牛乳')
    expect(first.find('.num').exists()).toBe(true)
    expect(first.find('.num').text()).toBe('248円')
    // the 明細合計 row sits outside the folding list: label + the envelope's
    // items_total (1,280円 — all five lines including the discount)
    const total = wrapper.find('[data-test="draft-screen"] [data-test="items-total"]')
    expect(total.classes()).toContain('items-total')
    expect(total.text()).toContain('明細合計')
    expect(total.text()).toContain('1,280円')
    // the head total is the strongest tier (.receipt-total: 0.85rem label +
    // 1.9rem w700 value — pinned by the shared style static check) and rides
    // the head MAIN row (TASK-175: the total never takes a row of its own)
    const head = wrapper.find('[data-test="draft-screen"] .receipt-total')
    expect(head.exists()).toBe(true)
    expect(head.text()).toContain('合計')
    expect(head.text()).toContain('1,280円')
    expect(head.element.closest('.receipt-mainrow')).not.toBeNull()
  })

  it('[covers:widget.receipt-meta-removed] 頭部の運用meta行（#N/rev N）は無く・文脈+LabelChipは副行の2要素構成（頭部2行構成の回帰確認）', async () => {
    const draft = await mountWidget(
      fakeHost({ toolOutput: draftEnvelope({ possible_duplicates: [], labels: [{ color: 'red', title: '旅行' }] }) }),
    )
    const dtext = draft.wrapper.find('[data-test="draft-screen"]').text()
    expect(dtext).not.toContain('下書き #')
    expect(dtext).not.toContain('レシート #')
    expect(dtext).not.toContain('rev')
    expect(draft.wrapper.find('.bb-labels').exists()).toBe(false)

    const receipt = await mountWidget(fakeHost({ toolOutput: receiptEnvelope() }))
    const rtext = receipt.wrapper.find('[data-test="receipt-screen"]').text()
    expect(rtext).not.toContain('レシート #')
    expect(rtext).not.toContain('rev')
    expect(receipt.wrapper.find('.bb-labels').exists()).toBe(false)

    // TASK-175: the head is the two-row grammar — the SUB row's ONE context
    // element (date + payment + store category, display-only) plus the
    // right-edge host carrying the chips
    const subCases: ReadonlyArray<[VueWrapper, string]> = [
      [draft.wrapper, paymentLabel('credit_card')],
      [receipt.wrapper, paymentLabel('cash')],
    ]
    for (const [w, payment] of subCases) {
      const sub = w.find('.receipt-header .receipt-sub')
      expect(sub.exists(), `the sub row carrying ${payment}`).toBe(true)
      const ctx = sub.find('.receipt-sub-context')
      expect(ctx.text()).toMatch(/2026-10-1[12]/)
      expect(ctx.text()).toContain(payment)
      expect(ctx.text()).toContain('スーパー')
      expect(ctx.find('.label-chip').exists()).toBe(false)
      expect(sub.find('.receipt-sub-end .label-chip').exists()).toBe(true)
    }
  })

  it('[covers:widget.receipt-head-grammar] 頭部はReceiptHeader共通2行構成（主行=店名ellipsis+合計右端・副行=文脈+LabelChip右端）・bb-head語彙不在・長店名はtitle属性', async () => {
    const draft = await mountWidget(
      fakeHost({ toolOutput: draftEnvelope({ labels: [{ color: 'red', title: '旅行' }] }) }),
    )
    const receipt = await mountWidget(fakeHost({ toolOutput: receiptEnvelope() }))
    // explicitly-typed tuples (no as const — TASK-175 review #3)
    const headCases: ReadonlyArray<[VueWrapper, string, string]> = [
      [draft.wrapper, '[data-test="draft-screen"]', 'draft'],
      [receipt.wrapper, '[data-test="receipt-screen"]', 'receipt'],
    ]
    for (const [w, screen, name] of headCases) {
      const header = w.find(`${screen} .receipt-header`)
      expect(header.exists(), `${name} .receipt-header`).toBe(true)
      const main = header.find('.receipt-mainrow')
      expect(main.exists(), `${name} main row`).toBe(true)
      // widget has NO actions (display-only: no edit button on the row)
      expect(main.find('button').exists(), `${name} no actions`).toBe(false)
      // the store name rides its own ellipsis span; the total rides the
      // MAIN row (never a line of its own)
      const titleName = main.find('.receipt-title-name')
      expect(titleName.exists(), `${name} .receipt-title-name`).toBe(true)
      expect(titleName.text(), `${name} store name`).not.toBe('')
      const total = main.find('.receipt-total')
      expect(total.exists(), `${name} total on the main row`).toBe(true)
      expect(total.text()).toContain('合計')
      // the sub row: context + the right-edge chip host
      const sub = header.find('.receipt-sub')
      expect(sub.find('.receipt-sub-context').exists(), `${name} context`).toBe(true)
      expect(sub.find('.receipt-sub-end').exists(), `${name} sub-end`).toBe(true)
      // the old widget head vocabulary is gone from the DOM
      expect(w.find(`${screen} .bb-head`).exists(), `${name} .bb-head gone`).toBe(false)
      expect(w.find(`${screen} .bb-title`).exists(), `${name} .bb-title gone`).toBe(false)
    }
    // the draft's chips ride the sub row's right-edge host
    expect(draft.wrapper.find('[data-test="draft-screen"] .receipt-sub-end .label-chip').exists()).toBe(true)

    // a delimiter-free long store name ellipsizes inside .receipt-title-name
    // with the full name on the title attribute (overflow-wrap: anywhere is
    // gone — the head never grows a third line)
    const long = await mountWidget(
      fakeHost({ toolOutput: draftEnvelope({ payload: { ...sampleDraft().payload, store_name: 'SuperLongStoreNameWithoutAnySpaces1234567890' } }) }),
    )
    const longName = long.wrapper.find('[data-test="draft-screen"] .receipt-title-name')
    expect(longName.exists()).toBe(true)
    expect(longName.attributes('title')).toBe('SuperLongStoreNameWithoutAnySpaces1234567890')
  })

  it('[covers:widget.note-display] note は .receipt-note 語彙で明細表直下に表示（空は何も無い）', async () => {
    const withNote = await mountWidget(
      fakeHost({ toolOutput: draftEnvelope({ payload: { ...sampleDraft().payload, note: '2枚目のレシート' } }) }),
    )
    const note = withNote.wrapper.find('[data-test="draft-screen"] .receipt-note')
    expect(note.exists()).toBe(true)
    expect(note.text()).toBe('2枚目のレシート')
    // one block right under the item table
    expect(note.element.previousElementSibling?.tagName).toBe('UL')
    expect(note.element.closest('ul')).toBeNull()

    const receiptNote = await mountWidget(fakeHost({ toolOutput: receiptEnvelope() }))
    const rnote = receiptNote.wrapper.find('[data-test="receipt-screen"] .receipt-note')
    expect(rnote.exists()).toBe(true)
    expect(rnote.text()).toBe('特売日')

    // note null (or empty) renders nothing
    const plain = await mountWidget(fakeHost({ toolOutput: draftEnvelope() }))
    expect(plain.wrapper.find('.receipt-note').exists()).toBe(false)
    expect(plain.wrapper.find('.bb-note').exists()).toBe(false)
  })

  it('[covers:widget.ledger-badge] ledger name with one-off / draft notes', () => {
    const active = mount(LedgerBadge, { props: { ledger: { id: 1, name: '我が家', source: 'active' } } })
    expect(active.text()).toContain('我が家')
    expect(active.text()).not.toMatch(/一時指定|確定先/)
    expect(mount(LedgerBadge, { props: { ledger: { id: 2, name: '実家', source: 'explicit' } } }).text()).toContain('一時指定')
    expect(mount(LedgerBadge, { props: { ledger: { id: 1, name: '我が家', source: 'draft' } } }).text()).toContain('確定先')
    expect(mount(LedgerBadge, { props: { ledger: null } }).find('[data-test="ledger-badge"]').exists()).toBe(false)
  })
})

describe('receipt screen', () => {
  it('[covers:widget.receipt-detail-deleted] deleted band, no image, no operations', async () => {
    const del = await mountWidget(fakeHost({ toolOutput: receiptEnvelope(88, true), meta: receiptMeta() }))
    expect(del.wrapper.find('[data-test="deleted-band"]').text()).toContain('90日以内なら復元できます')
    expect(del.wrapper.find('[data-test="image-toggle"]').exists()).toBe(false)
    expect(del.wrapper.find('[data-test="approve-button"]').exists()).toBe(false)
    const live = await mountWidget(fakeHost({ toolOutput: receiptEnvelope(88, false), meta: receiptMeta() }))
    expect(live.wrapper.find('[data-test="deleted-band"]').exists()).toBe(false)
    expect(live.wrapper.find('[data-test="image-toggle"]').exists()).toBe(true)
    expect(live.wrapper.find('[data-test="approve-button"]').exists()).toBe(false)
    // TASK-170: the head's運用meta行（レシート #N）is gone — the store name
    // proves the live receipt rendered
    expect(live.wrapper.text()).toContain('スーパーみどり')
    expect(live.wrapper.text()).not.toContain('レシート #')
  })
})
