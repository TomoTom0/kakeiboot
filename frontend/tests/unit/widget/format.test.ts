import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { formatIsoDateJa, formatYen, isSafeImageUrl } from '@/shared/format'
import MoneyAmount from '@/shared/components/MoneyAmount.vue'
import ImageWithBoxes from '@/shared/components/ImageWithBoxes.vue'

describe('money format', () => {
  it('[covers:widget.money-format] ja-JP grouping, signed negatives with the negative class', () => {
    expect(formatYen(1234567)).toBe('1,234,567円')
    expect(formatYen(-50)).toBe('-50円')
    expect(formatYen(null)).toBe('-')
    const neg = mount(MoneyAmount, { props: { value: -50 } })
    expect(neg.text()).toBe('-50円')
    expect(neg.classes()).toContain('bb-money--neg')
    const pos = mount(MoneyAmount, { props: { value: 100 } })
    expect(pos.classes()).not.toContain('bb-money--neg')
  })
})

describe('image URL validation', () => {
  it('[covers:widget.image-url-prefix-validation] accepts only <origin>/media/img/<token>', () => {
    expect(isSafeImageUrl('https://h.example/media/img/abc_DEF-1')).toBe(true)
    expect(isSafeImageUrl('http://localhost:40280/media/img/a')).toBe(true)
    for (const bad of [
      'javascript:alert(1)',
      'https://h.example/other/x',
      'https://h.example/media/img/../x',
      'https://h.example/media/img/a?x=1',
      'https://h.example/media/img/a#f',
      'https://u:p@h.example/media/img/a',
      'http://h.example/media/img/a',
      'https://h.example/media/img/',
      'data:image/png;base64,AAAA',
      '/media/img/a',
      42,
      null,
    ]) {
      expect(isSafeImageUrl(bad), String(bad)).toBe(false)
    }
    expect(isSafeImageUrl('https://h.example/media/img/a', 'https://h.example')).toBe(true)
    expect(isSafeImageUrl('https://evil.example/media/img/a', 'https://h.example')).toBe(false)
  })

  it('[covers:widget.image-url-prefix-validation] ImageWithBoxes does not render an img for a rejected URL', () => {
    const bad = mount(ImageWithBoxes, { props: { url: 'https://h.example/other/x' } })
    expect(bad.find('img').exists()).toBe(false)
    expect(bad.text()).toContain('画像を表示できません')
    const good = mount(ImageWithBoxes, { props: { url: 'https://h.example/media/img/tok' } })
    expect(good.find('img').attributes('src')).toBe('https://h.example/media/img/tok')
    expect(good.find('img').attributes('loading')).toBe('lazy')
  })
})

describe('ISO date label format', () => {
  it('[covers:widget.stats-scatter-axis-ends] strict YYYY-MM-DD only, raw fallback', () => {
    expect(formatIsoDateJa('2026-08-02')).toBe('2026年8月2日')
    expect(formatIsoDateJa('2026-01-01')).toBe('2026年1月1日')
    expect(formatIsoDateJa('8/2')).toBe('8/2')
    expect(formatIsoDateJa('')).toBe('')
    expect(formatIsoDateJa('2026-8-2')).toBe('2026-8-2')
    expect(formatIsoDateJa('2026-08-02T00:00:00')).toBe('2026-08-02T00:00:00')
  })
})
