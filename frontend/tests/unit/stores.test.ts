import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWebAppStore } from '@/web/stores/app'
import { useWidgetStore } from '@/widget/stores/widget'

describe('entry stores', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('web and widget stores are independent', () => {
    const web = useWebAppStore()
    const widget = useWidgetStore()
    web.title = 'changed'
    expect(widget.title).toBe('kakeiboot widget')
  })
})
