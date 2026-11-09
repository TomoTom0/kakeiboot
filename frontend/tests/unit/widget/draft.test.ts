import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { DraftItem, StatsEnvelope } from '@/shared/types'
import ItemTable from '@/shared/components/ItemTable.vue'
import BarHChart from '@/shared/components/charts/BarHChart.vue'
import LedgerBadge from '@/widget/components/LedgerBadge.vue'
import { draftEnvelope, draftMeta, mockImageUrl, receiptEnvelope, receiptMeta, sampleDraft, statsEnvelope } from '@/widget/fixtures'
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

  it('[covers:widget.unknown-category-warn] unknown categories use the warning class', async () => {
    const { wrapper } = await mountWidget(fakeHost({ toolOutput: draftEnvelope() }))
    const line4 = wrapper.find('[data-line="4"] .bb-items__cat')
    expect(line4.classes()).toContain('bb-items__cat--unknown')
    const line5 = wrapper.find('[data-line="5"] .bb-items__cat')
    expect(line5.text()).toContain('履歴から推定')
    expect(line5.classes()).not.toContain('bb-items__cat--unknown')
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

  it('[covers:widget.items-show-more] at most 8 lines until "show more"', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ key: i + 1, name: `品${i + 1}`, amount: 100, category: null }))
    const w = mount(ItemTable, { props: { rows } })
    expect(w.findAll('li')).toHaveLength(8)
    const more = w.find('button.bb-link')
    expect(more.text()).toBe('さらに表示（3行）')
    await more.trigger('click')
    expect(w.findAll('li')).toHaveLength(11)
    expect(w.find('button.bb-link').exists()).toBe(false)
    const few = mount(ItemTable, { props: { rows: rows.slice(0, 8) } })
    expect(few.find('button.bb-link').exists()).toBe(false)
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
    expect(live.wrapper.text()).toContain('レシート #88')
  })
})
