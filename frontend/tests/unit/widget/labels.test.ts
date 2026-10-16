// Widget label display (TASK-17): color dots on the receipt / receipt_list
// views and the applied label filter chip on the stats view. The widget has
// no labeling controls (conversation-only via label_receipts).
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ReportKind, StatsFilters } from '@/shared/types'
import { receiptEnvelope, receiptListEnvelope, statsEnvelope } from '@/widget/fixtures'
import { fakeHost, mountWidget, result } from './helpers'

const RED = { color: 'red', title: '旅行' }

describe('widget labels', () => {
  it('[covers:widget.receipt-labels] receipt はヘッダに LabelDots、receipt_list の行は compact、付け外しの操作は無い', async () => {
    // receipt detail: header dots with the title
    const env = {
      ...receiptEnvelope(88),
      receipt: { ...receiptEnvelope(88).receipt, labels: [RED] },
    }
    const detail = await mountWidget(fakeHost({ toolOutput: env as never }))
    const dot = detail.wrapper.find('[data-test="receipt-screen"] [data-test="label-dot"]')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('aria-label')).toBe('赤: 旅行')

    // receipt list: compact dots per row, nothing on unlabeled rows, no controls
    const list = receiptListEnvelope()
    ;(list.receipts[0] as unknown as { labels: unknown[] }).labels = [RED]
    const rows = await mountWidget(fakeHost({ toolOutput: list as never }))
    expect(rows.wrapper.find('[data-receipt="88"] [data-test="label-dot"]').exists()).toBe(true)
    expect(rows.wrapper.find('[data-receipt="90"] [data-test="label-dot"]').exists()).toBe(false)
    for (const screen of [detail.wrapper, rows.wrapper]) {
      expect(screen.find('[data-test="label-toggle-red"]').exists()).toBe(false)
      expect(screen.find('button[aria-pressed]').exists()).toBe(false)
    }
  })

  it('[covers:widget.stats-label-filter] filters.label_colors のチップを表示し、期間・report 切替の再 callTool で label_colors が保たれる', async () => {
    const env = {
      ...statsEnvelope('monthly_overview'),
      filters: { label_colors: ['red', 'blue'] },
    }
    // the re-run response echoes the applied filters, like the backend does
    const host = fakeHost({
      toolOutput: env as never,
      callTool: async (_n, a) => {
        const args = a as { report: ReportKind; filters?: StatsFilters }
        return result({ ...statsEnvelope(args.report, '2026年9月'), filters: args.filters ?? null })
      },
    })
    const { wrapper } = await mountWidget(host)
    const chip = wrapper.find('[data-test="label-filter-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('ラベル: 赤・青')

    // a period switch re-runs summarize_spending carrying the filter
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith(
      'summarize_spending',
      expect.objectContaining({ filters: { label_colors: ['red', 'blue'] } }),
    )
    // a report switch keeps it too
    await wrapper.find('[data-test="report-select"]').setValue('by_store')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith(
      'summarize_spending',
      expect.objectContaining({ filters: { label_colors: ['red', 'blue'] } }),
    )

    // no chip when the envelope carries no label filter
    const plain = await mountWidget(fakeHost({ toolOutput: statsEnvelope('monthly_overview') }))
    expect(plain.wrapper.find('[data-test="label-filter-chip"]').exists()).toBe(false)
  })

  it('[covers:widget.stats-label-filter] 絞り込み無しの新応答の後はラベル絞り込みを再適用しない', async () => {
    const env = {
      ...statsEnvelope('monthly_overview'),
      filters: { label_colors: ['red', 'blue'] },
    }
    // a host that does not echo the filters back (filter cleared in the
    // conversation): the old label context must not be reapplied afterwards
    const host = fakeHost({
      toolOutput: env as never,
      callTool: async (_n, a) =>
        result(statsEnvelope((a as { report: ReportKind }).report, '2026年9月')),
    })
    const { wrapper } = await mountWidget(host)
    expect(wrapper.find('[data-test="label-filter-chip"]').exists()).toBe(true)
    // the first switch still carries the initial envelope's label filter
    await wrapper.find('[data-test="period-select"]').setValue('last_month')
    await flushPromises()
    expect(host.callTool).toHaveBeenLastCalledWith(
      'summarize_spending',
      expect.objectContaining({ filters: { label_colors: ['red', 'blue'] } }),
    )
    // the response carries no filters: the chip disappears and the next
    // switch does not reapply the old label filter
    expect(wrapper.find('[data-test="label-filter-chip"]').exists()).toBe(false)
    await wrapper.find('[data-test="report-select"]').setValue('by_store')
    await flushPromises()
    const args = host.callTool.mock.lastCall?.[1] as Record<string, unknown> | undefined
    expect(args?.filters).toBeUndefined()
    expect(wrapper.find('[data-test="label-filter-chip"]').exists()).toBe(false)
  })
})
