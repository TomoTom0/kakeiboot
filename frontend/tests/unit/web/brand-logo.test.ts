// BrandLogo (TASK-27 §1, L2): a decorative SVG mark (rounded frame + leaf)
// plus the wordmark as real HTML text — full shows "kakeiboot", compact
// "kb" by default; the `word` prop overrides the text (the topbar full logo
// passes word="Kakei"). The hand-drawn stroke letterforms (letterPath) are
// gone; the mark takes its colors from CSS classes, not SVG attributes.
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BrandLogo from '@/shared/components/BrandLogo.vue'

/** Attribute values of `el` and every descendant. */
function allAttrValues(el: Element): string[] {
  return [el, ...el.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.value))
}

describe('BrandLogo', () => {
  it('[covers:web-shell.brand-logo-variants] ルート span が role=img・aria-label、単語は HTML テキスト、装飾マーク SVG に var() と線字形は無い', () => {
    const mounted = new Map<string, ReturnType<typeof mount>>()
    for (const { variant, word } of [
      { variant: 'full', word: 'kakeiboot' },
      { variant: 'compact', word: 'kb' },
    ] as const) {
      const w = mount(BrandLogo, { props: { variant } })
      mounted.set(variant, w)

      // the root span carries the accessible name and the variant class
      const root = w.find('.logo')
      expect(root.exists(), `${variant}: root span`).toBe(true)
      expect(root.attributes('role')).toBe('img')
      expect(root.attributes('aria-label')).toBe('kakeiboot')
      expect(root.classes()).toContain(`logo-${variant}`)

      // the wordmark is visible HTML text, hidden from the a11y tree
      const wordEl = w.find('.logo-word')
      expect(wordEl.exists(), `${variant}: .logo-word`).toBe(true)
      expect(wordEl.attributes('aria-hidden')).toBe('true')
      expect(wordEl.text()).toBe(word)

      // the mark svg is decorative and free of var() in its attributes
      const svg = w.find('svg')
      expect(svg.exists(), `${variant}: svg`).toBe(true)
      expect(svg.attributes('aria-hidden')).toBe('true')
      expect(allAttrValues(svg.element).some((v) => v.includes('var(')), `${variant}: var( in svg attrs`).toBe(false)
    }

    // one shared mark: identical svg for both variants, so it cannot hold
    // the variant-specific stroke letterforms (letterPath is gone)
    expect(mounted.get('full')!.find('svg').element.outerHTML).toBe(mounted.get('compact')!.find('svg').element.outerHTML)

    // "mark" is no longer a variant: it renders nothing
    expect(mount(BrandLogo, { props: { variant: 'mark' as never } }).find('.logo').exists()).toBe(false)
  })

  it('[covers:web-shell.brand-logo-variants] word prop が wordmark のテキストを上書きする', () => {
    const w = mount(BrandLogo, { props: { variant: 'full', word: 'Kakei' } })
    expect(w.find('.logo-word').text()).toBe('Kakei')
    // the override only changes the visible word, not the accessible name
    expect(w.find('.logo').attributes('aria-label')).toBe('kakeiboot')
  })
})
