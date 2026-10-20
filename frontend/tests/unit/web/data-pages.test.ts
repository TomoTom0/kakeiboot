import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDataApi, type DataApi } from '@/web/api/data'
import { createMockDataApi } from '@/web/api/data/mock'
import { ApiError } from '@/web/api/http'
import { ME, cleanup, mockFetch, mountApp, settle } from './helpers'

let api: DataApi

beforeEach(() => {
  // the mock ledger's receipts are in 2026-10; "today" is 2026-10-15 JST
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T03:00:00Z'))
  api = createMockDataApi()
  setDataApi(api)
  mockFetch({ 'GET /api/auth/me': { body: ME } })
  // the category fold state persists in sessionStorage across mounts
  // (TASK-40 §1-3): keep every test's session clean
  sessionStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  setDataApi(null)
  cleanup()
  sessionStorage.clear()
})

type W = Awaited<ReturnType<typeof mountApp>>['wrapper']

/**
 * Row selector by category id (TASK-40 §2-2): `cat-<id>`. The old path form
 * (`cat-食費/外食`) changed its value on every rename / move, so rows — like
 * the fold state — are keyed by the stable id.
 */
const sel = (id: number) => `[data-test="cat-${id}"]`

/** Category ids of ledger 1 keyed by path ("食費" / "食費/外食"), from the current mock state. */
async function catIds(includeArchived = false): Promise<Map<string, number>> {
  const c = await api.getCatalog(1, includeArchived)
  const m = new Map<string, number>()
  for (const roots of [c.item_categories, c.store_categories]) {
    for (const r of roots) {
      m.set(r.name, r.id)
      for (const ch of r.children) m.set(`${r.name}/${ch.name}`, ch.id)
    }
  }
  return m
}

/**
 * Open the row's trailing "..." (RowMenu) and pick its item — the only entry
 * to row operations now (TASK-40 §2-2): menu-rename / menu-move /
 * menu-archive / menu-unarchive (stores: menu-edit).
 */
async function rowAction(wrapper: W, row: string, triggerTest: string, action: string): Promise<void> {
  const trigger = wrapper.find(`${row} [data-test="${triggerTest}"]`)
  expect(trigger.exists(), triggerTest).toBe(true)
  await trigger.trigger('click')
  await settle()
  const item = wrapper.find(`[role="menu"] [data-test="${action}"]`)
  expect(item.exists(), action).toBe(true)
  await item.trigger('click')
  await settle()
}

const catAction = (wrapper: W, id: number, action: string) => rowAction(wrapper, sel(id), `row-menu-${id}`, action)
const storeAction = (wrapper: W, id: number, action: string) =>
  rowAction(wrapper, `[data-test="store-${id}"]`, `row-menu-${id}`, action)

/** A labeled button inside a row (the editor's 保存 / やめる, an add row's 作成).
 * TASK-47 made these icon-only: the label rides as aria-label. */
function rowButton(wrapper: W, row: string, label: string) {
  const btn = wrapper.find(row).findAll('button').find((b) => b.attributes('aria-label') === label)
  expect(btn, `${label} in ${row}`).toBeTruthy()
  return btn!
}

/** Pick the row editor's move-target option shown as `label` ("大分類にする" / "日用品 の下へ"). */
async function chooseMoveTarget(wrapper: W, id: number, label: string): Promise<void> {
  const select = wrapper.find(`${sel(id)} select[aria-label="移動先"]`)
  expect(select.exists(), '移動先 select').toBe(true)
  const opt = select.findAll('option').find((o) => o.text() === label)
  expect(opt, `option ${label}`).toBeTruthy()
  await select.setValue(opt!.element.value)
}

describe('CategoriesPage', () => {
  it('[covers:web-categories.create-and-tree] 大分類は折り畳みグループ・小分類は子ブロックの行、作成は見出しとヘッダの+だけ', async () => {
    const manage = vi.spyOn(api, 'manageCategory')
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const { wrapper } = await mountApp('/settings/categories')

    // the list is structured per top category: a group (li.cat-group) with a
    // .cat-head, its children in a ul.cat-children block of li rows
    const food = wrapper.find(sel(foodId))
    expect(food.exists()).toBe(true)
    expect(food.classes()).toContain('cat-group')
    expect(food.find('.cat-head').exists()).toBe(true)
    const children = food.find('ul.cat-children')
    expect(children.exists()).toBe(true)
    const childTexts = children.findAll('li').map((li) => li.text())
    expect(childTexts.some((t) => t.includes('食料品'))).toBe(true)
    expect(childTexts.some((t) => t.includes('外食'))).toBe(true)

    // no path-typing create form anymore (D3): the parent always follows
    // from where the "+" was pressed
    expect(wrapper.find('[data-test="new-path"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="create-form"]').exists()).toBe(false)

    // a top category is created from the card heading's "+" as a div.add-row
    // placed just before the list (ul.rows keeps only li.cat-group children)
    await wrapper.find('[data-test="add-top"]').trigger('click')
    await settle()
    const list = wrapper.find('[data-test="categories"]')
    expect(list.element.previousElementSibling?.classList.contains('add-row')).toBe(true)
    const groups = list.findAll(':scope > *')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) expect(g.classes()).toContain('cat-group')
    const topInput = wrapper.find('div.add-row input')
    expect(topInput.exists()).toBe(true)
    await topInput.setValue('外食費')
    await topInput.trigger('keydown.enter')
    await settle()
    expect(manage).toHaveBeenCalledWith(1, { kind: 'item', action: 'create', category: '外食費' })
    const after = await catIds()
    const newGroup = wrapper.find(sel(after.get('外食費')!))
    expect(newGroup.classes()).toContain('cat-group')
    expect(wrapper.find('div.add-row').exists()).toBe(false)

    // a child is created from the group header's "+" as a li.add-row at the
    // end of that group's children
    await wrapper.find(`[data-test="add-child-${foodId}"]`).trigger('click')
    await settle()
    const childRow = () => wrapper.find(`${sel(foodId)} li.add-row`)
    expect(childRow().exists()).toBe(true)
    await childRow().find('input').setValue('おやつ')
    await rowButton(wrapper, `${sel(foodId)} li.add-row`, '作成').trigger('click')
    await settle()
    expect(manage).toHaveBeenLastCalledWith(1, { kind: 'item', action: 'create', category: '食費/おやつ' })
    expect(wrapper.find(`${sel(foodId)} ul.cat-children`).text()).toContain('おやつ')

    // the store-kind tab shows the store categories instead
    await wrapper.find('[data-test="kind-store"]').trigger('click')
    await settle()
    expect(wrapper.find(sel(ids.get('コンビニ')!)).exists()).toBe(true)
    expect(wrapper.find(sel(foodId)).exists()).toBe(false)
  })

  it('[covers:web-manage.category-create-structural] 追加行のEnter/Escape・空はdisabled・/はAPIを呼ばず拒否・同名は入力保持・折り畳み済みヘッダの+は展開してから開く', async () => {
    const manage = vi.spyOn(api, 'manageCategory')
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const { wrapper } = await mountApp('/settings/categories')
    const addTop = wrapper.find('[data-test="add-top"]')
    expect(addTop.exists(), 'add-top').toBe(true)
    expect(addTop.attributes('aria-label')).toBe('大分類を追加')
    const addChild = wrapper.find(`[data-test="add-child-${foodId}"]`)
    expect(addChild.exists(), `add-child-${foodId}`).toBe(true)
    expect(addChild.attributes('aria-label')).toBe('食費に小分類を追加')

    // the create button stays disabled while the input is empty
    await wrapper.find(`[data-test="add-child-${foodId}"]`).trigger('click')
    await settle()
    const childRow = () => wrapper.find(`${sel(foodId)} li.add-row`)
    const createBtn = () => rowButton(wrapper, `${sel(foodId)} li.add-row`, '作成')
    expect(createBtn().attributes('disabled')).toBeDefined()

    // a name containing "/" is rejected by save-time validation without
    // calling the API; the add row and the input stay
    await childRow().find('input').setValue('あ/い')
    await createBtn().trigger('click')
    await settle()
    expect(manage).not.toHaveBeenCalled()
    const status = childRow().find('.row-status')
    expect(status.attributes('role')).toBe('alert')
    expect(status.text()).toContain('/ は使えません')
    expect((childRow().find('input').element as HTMLInputElement).value).toBe('あ/い')

    // an existing name (created:false) keeps the row and input as info
    await childRow().find('input').setValue('食料品')
    await createBtn().trigger('click')
    await settle()
    expect(manage).toHaveBeenCalledWith(1, { kind: 'item', action: 'create', category: '食費/食料品' })
    const info = childRow().find('.row-status')
    expect(info.attributes('role')).toBe('status')
    expect(info.text()).toContain('すでにあります')
    expect((childRow().find('input').element as HTMLInputElement).value).toBe('食料品')

    // Escape closes the add row like the row editor
    await childRow().find('input').trigger('keydown.esc')
    await settle()
    expect(childRow().exists()).toBe(false)

    // the "+" of a folded group expands it first, then opens the add row
    const chev = wrapper.find(`${sel(foodId)} [data-test="fold"]`)
    expect(chev.exists(), 'fold chevron').toBe(true)
    await chev.trigger('click')
    await settle()
    expect(wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(false)
    await wrapper.find(`[data-test="add-child-${foodId}"]`).trigger('click')
    await settle()
    expect(wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(true)
    expect(childRow().exists()).toBe(true)
  })

  it('[covers:web-categories.rename-move-archive] 改名+移動は1シーケンス（moveは新pathで）・部分失敗は再取得後にeditor開いたまま基準path更新・アーカイブは即時・削除なし', async () => {
    // a conflicting child under 日用品 makes the move below fail with 409
    // name_conflict (the mock's real behavior — no forced rejection needed)
    await api.manageCategory(1, { kind: 'item', action: 'create', category: '日用品/外食費' })
    const manage = vi.spyOn(api, 'manageCategory')
    const ids = await catIds()
    const outId = ids.get('食費/外食')!
    const { wrapper } = await mountApp('/settings/categories')

    // rename + move in one save: the move goes out on the renamed path
    await catAction(wrapper, outId, 'menu-rename')
    await wrapper.find(`${sel(outId)} input[aria-label="新しい名前"]`).setValue('外食費')
    await chooseMoveTarget(wrapper, outId, '日用品 の下へ')
    await rowButton(wrapper, sel(outId), '保存').trigger('click')
    await settle()
    expect(manage).toHaveBeenNthCalledWith(1, 1, { kind: 'item', action: 'rename', category: '食費/外食', new_name: '外食費' })
    expect(manage).toHaveBeenNthCalledWith(2, 1, { kind: 'item', action: 'move', category: '食費/外食費', new_parent: '日用品' })

    // partial failure (move 409): the refetched list shows the rename, the
    // editor stays open with its inputs, and the error sits on the row
    let row = wrapper.find(sel(outId))
    expect(row.find('input[aria-label="新しい名前"]').exists()).toBe(true)
    expect((row.find('input[aria-label="新しい名前"]').element as HTMLInputElement).value).toBe('外食費')
    expect(row.text()).toContain('外食費')
    const err = row.find('.row-status')
    expect(err.attributes('role')).toBe('alert')
    expect(err.text()).toContain('同じ名前のカテゴリが既にあります')

    // re-saving only the failed move goes to the refetched (renamed) path —
    // the stale basis would 404 here
    manage.mockClear()
    await chooseMoveTarget(wrapper, outId, '交通費 の下へ')
    await rowButton(wrapper, sel(outId), '保存').trigger('click')
    await settle()
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(1, { kind: 'item', action: 'move', category: '食費/外食費', new_parent: '交通費' })
    row = wrapper.find(sel(outId))
    expect(row.find('.row-status').attributes('role')).toBe('status')
    expect(row.find('.row-status').text()).toContain('を更新しました')
    expect(wrapper.find(`${sel(ids.get('交通費')!)} ul.cat-children`).text()).toContain('外食費')

    // archive runs immediately from the menu (no editor) and refetches
    const getCatalog = vi.spyOn(api, 'getCatalog')
    const loads = getCatalog.mock.calls.length
    manage.mockClear()
    await catAction(wrapper, outId, 'menu-archive')
    expect(manage).toHaveBeenLastCalledWith(1, { kind: 'item', action: 'archive', category: '交通費/外食費' })
    expect(getCatalog.mock.calls.length).toBeGreaterThan(loads)
    expect(wrapper.find(sel(outId)).exists()).toBe(false)

    // a group header's editor saves the rename alone (its menu has no move)
    manage.mockClear()
    const transId = ids.get('交通費')!
    await catAction(wrapper, transId, 'menu-rename')
    await wrapper.find(`${sel(transId)} input[aria-label="新しい名前"]`).setValue('交通')
    await rowButton(wrapper, sel(transId), '保存').trigger('click')
    await settle()
    expect(manage).toHaveBeenCalledTimes(1)
    expect(manage).toHaveBeenCalledWith(1, { kind: 'item', action: 'rename', category: '交通費', new_name: '交通' })

    // no deletion anywhere (categories are only archived)
    expect(wrapper.findAll('button').some((b) => b.text() === '削除')).toBe(false)
  })

  it('[covers:web-manage.row-editor] ⋯は唯一の行操作入口・1行だけeditor・未保存の切替は1回止め・Enter/Escape・アーカイブ失敗は行内status・viewerは⋯と+を押せない', async () => {
    const manage = vi.spyOn(api, 'manageCategory')
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const subId = ids.get('食費/食料品')!
    const outId = ids.get('食費/外食')!
    const { wrapper } = await mountApp('/settings/categories', { attach: true })

    // no per-row operation buttons are lined up; the trailing "..." is the
    // only entry (archive / unarchive live behind it too)
    for (const b of wrapper.findAll('[data-test="categories"] button')) {
      expect(['改名', '移動', 'アーカイブ', '戻す', '編集', '削除'], `row button "${b.text()}"`).not.toContain(b.text())
    }

    // a child's "..." holds 3 items, a group header's holds 2 (no move)
    const outTrigger = wrapper.find(`${sel(outId)} [data-test="row-menu-${outId}"]`)
    expect(outTrigger.attributes('aria-haspopup')).toBe('menu')
    expect(outTrigger.attributes('aria-label')).toBe('外食の操作')
    expect(outTrigger.classes()).toContain('row-action-btn')
    await outTrigger.trigger('click')
    await settle()
    let items = wrapper.findAll('[role="menu"] [role="menuitem"]')
    expect(items.map((i) => i.text())).toEqual(['名前を変更', '移動先を変更', 'アーカイブする'])
    await outTrigger.trigger('click')
    await settle()
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    await wrapper.find(`${sel(foodId)} [data-test="row-menu-${foodId}"]`).trigger('click')
    await settle()
    items = wrapper.findAll('[role="menu"] [role="menuitem"]')
    expect(items.map((i) => i.text())).toEqual(['名前を変更', 'アーカイブする'])
    await wrapper.find(`${sel(foodId)} [data-test="row-menu-${foodId}"]`).trigger('click')
    await settle()

    // "名前を変更" turns just that row into the editor, focus on the name
    // input (past the menu's trigger-return)
    await catAction(wrapper, outId, 'menu-rename')
    const input = () => wrapper.find(`${sel(outId)} input[aria-label="新しい名前"]`)
    expect(input().exists()).toBe(true)
    expect((input().element as HTMLInputElement).value).toBe('外食')
    expect(document.activeElement).toBe(input().element)
    expect(wrapper.find(`${sel(subId)} input[aria-label="新しい名前"]`).exists()).toBe(false)

    // nothing changed: Enter closes the editor without calling the API
    manage.mockClear()
    await input().trigger('keydown.enter')
    await settle()
    expect(manage).not.toHaveBeenCalled()
    expect(input().exists()).toBe(false)

    // an unsaved change blocks switching to another row's editor — once
    await catAction(wrapper, outId, 'menu-rename')
    await input().setValue('外食費')
    await catAction(wrapper, subId, 'menu-rename')
    expect(input().exists()).toBe(true)
    expect(wrapper.find(`${sel(subId)} input[aria-label="新しい名前"]`).exists()).toBe(false)
    const unsaved = wrapper.find(`${sel(outId)} .row-status`)
    expect(unsaved.attributes('role')).toBe('alert')
    expect(unsaved.text()).toContain('保存されていません')
    // picking the same item of the same row's "..." again does switch
    await catAction(wrapper, subId, 'menu-rename')
    expect(wrapper.find(`${sel(subId)} input[aria-label="新しい名前"]`).exists()).toBe(true)
    expect(input().exists()).toBe(false)

    // Escape gives up without saving
    manage.mockClear()
    await wrapper.find(`${sel(subId)} input[aria-label="新しい名前"]`).trigger('keydown.esc')
    await settle()
    expect(wrapper.find(`${sel(subId)} input[aria-label="新しい名前"]`).exists()).toBe(false)
    expect(manage).not.toHaveBeenCalled()

    // a failing immediate archive surfaces on that row's inline status
    // (no editor involved)
    const real = api.manageCategory.bind(api)
    manage.mockImplementation(async (ledgerId: number, input: Parameters<DataApi['manageCategory']>[1]) => {
      if (input.action === 'archive') throw new ApiError(409, 'name_conflict')
      return real(ledgerId, input)
    })
    await catAction(wrapper, outId, 'menu-archive')
    const failed = wrapper.find(sel(outId))
    expect(failed.find('input[aria-label="新しい名前"]').exists()).toBe(false)
    expect(failed.find('.row-status').attributes('role')).toBe('alert')

    // a viewer (role below editor) cannot press the "..." or the "+" buttons
    // (rendered but disabled)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] } } })
    const viewer = await mountApp('/settings/categories')
    expect(viewer.wrapper.find(`${sel(outId)} [data-test="row-menu-${outId}"]`).attributes('disabled')).toBeDefined()
    expect(viewer.wrapper.find('[data-test="add-top"]').attributes('disabled')).toBeDefined()
    expect(viewer.wrapper.find(`[data-test="add-child-${foodId}"]`).attributes('disabled')).toBeDefined()
  }, 15_000)

  it('[covers:web-manage.category-group-fold] chevronで開閉し折り畳み中は子数表示・bb-cat-foldにledger×kindで保持し再mountで復元・editor展開中はchevron無効', async () => {
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const { wrapper } = await mountApp('/settings/categories')

    const chev = () => {
      const b = wrapper.find(`${sel(foodId)} [data-test="fold"]`)
      expect(b.exists(), 'fold chevron').toBe(true)
      return b
    }
    expect(chev().classes()).toContain('row-action-btn')
    expect(chev().attributes('aria-expanded')).toBe('true')
    expect(chev().attributes('aria-controls')).toBeTruthy()
    expect(chev().attributes('aria-label')).toContain('食費の子カテゴリ 2 件を閉じる')
    expect(wrapper.find(`${sel(foodId)} .cat-count`).exists()).toBe(false)

    await chev().trigger('click')
    await settle()
    expect(chev().attributes('aria-expanded')).toBe('false')
    expect(chev().attributes('aria-label')).toContain('食費の子カテゴリ 2 件を開く')
    expect(wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(false)
    const count = wrapper.find(`${sel(foodId)} .cat-count`)
    expect(count.text()).toBe('(2)')
    expect(count.attributes('aria-hidden')).toBe('true')
    expect(JSON.parse(sessionStorage.getItem('bb-cat-fold')!)).toEqual({ '1:item': [foodId] })

    // a fresh mount restores the fold from sessionStorage
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const again = await mountApp('/settings/categories')
    expect(again.wrapper.find(`${sel(foodId)} [data-test="fold"]`).attributes('aria-expanded')).toBe('false')
    expect(again.wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(false)

    // the store-kind tab keeps its own key
    await again.wrapper.find('[data-test="kind-store"]').trigger('click')
    await settle()
    const superId = ids.get('スーパー')!
    await again.wrapper.find(`${sel(superId)} [data-test="fold"]`).trigger('click')
    await settle()
    expect(JSON.parse(sessionStorage.getItem('bb-cat-fold')!)).toEqual({ '1:item': [foodId], '1:store': [superId] })
    await again.wrapper.find('[data-test="kind-item"]').trigger('click')
    await settle()
    expect(again.wrapper.find(`${sel(foodId)} [data-test="fold"]`).attributes('aria-expanded')).toBe('false')

    // while the group header's editor is open, the chevron is disabled
    await catAction(again.wrapper, foodId, 'menu-rename')
    expect(again.wrapper.find(`${sel(foodId)} [data-test="fold"]`).attributes('disabled')).toBeDefined()

    // another ledger reads its own (empty) key: default all-open
    const { useSessionStore } = await import('@/web/stores/session')
    useSessionStore(again.pinia).selectedLedgerId = 2
    await settle()
    expect(again.wrapper.find(`${sel(foodId)} [data-test="fold"]`).attributes('aria-expanded')).toBe('true')
  })

  it('[covers:web-manage.focus-query] ?focus=は親を展開しその行のeditorを開いてqueryから除く・解決できないidはtab切替も自動ONもせず無視', async () => {
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const outId = ids.get('食費/外食')!

    // with the parent folded in sessionStorage, focus expands it and opens
    // the row editor focused on the name input
    sessionStorage.setItem('bb-cat-fold', JSON.stringify({ '1:item': [foodId] }))
    const { wrapper, router } = await mountApp(`/settings/categories?kind=item&focus=${outId}`, { attach: true })
    const input = wrapper.find(`${sel(outId)} input[aria-label="新しい名前"]`)
    expect(input.exists()).toBe(true)
    expect(wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(true)
    expect(document.activeElement).toBe(input.element)
    expect(router.currentRoute.value.query.focus).toBeUndefined()
    expect(router.currentRoute.value.query.kind).toBe('item')
    cleanup()

    // unresolvable ids — another kind's category, an archived one hidden
    // with showArchived off, a nonexistent id — do nothing but clear the
    // query (no tab switch, no auto show-archived, no editor)
    const cases: [string, string][] = [
      ['別kindのid', String(ids.get('スーパー'))],
      ['非表示のアーカイブ済みid', String(ids.get('趣味'))],
      ['実在しないid', '999'],
    ]
    for (const [label, bad] of cases) {
      mockFetch({ 'GET /api/auth/me': { body: ME } })
      sessionStorage.setItem('bb-cat-fold', JSON.stringify({ '1:item': [foodId] }))
      const w = await mountApp(`/settings/categories?kind=item&focus=${bad}`)
      expect(w.wrapper.find('[data-test="kind-item"]').classes(), label).toContain('active')
      expect(w.wrapper.find('[data-test="show-archived"]').attributes('aria-pressed'), label).toBe('false')
      expect(w.wrapper.find(`${sel(foodId)} ul.cat-children`).exists(), label).toBe(false)
      expect(w.wrapper.findAll('input[aria-label="新しい名前"]').length, label).toBe(0)
      expect(w.router.currentRoute.value.query.focus, label).toBeUndefined()
      cleanup()
    }

    // focus rides with kind= for the store tab (the linkers always pair them)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const st = await mountApp(`/settings/categories?kind=store&focus=${ids.get('コンビニ')}`)
    expect(st.wrapper.find(`${sel(ids.get('コンビニ')!)} input[aria-label="新しい名前"]`).exists()).toBe(true)
  })

  it('[covers:web-manage.create-query] ?kind=はtab選択のURL化（tab操作はreplace）・tab切替でeditorを閉じる・?new=はtop/親idを受け入れ不在idは無視', async () => {
    const ids = await catIds()
    const foodId = ids.get('食費')!
    const outId = ids.get('食費/外食')!

    // kind is read on mount; tab presses rewrite the query via replace
    const a = await mountApp('/settings/categories?kind=store')
    expect(a.wrapper.find('[data-test="kind-store"]').classes()).toContain('active')
    expect(a.wrapper.find(sel(ids.get('コンビニ')!)).exists()).toBe(true)
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const b = await mountApp('/settings/categories?kind=xx')
    expect(b.wrapper.find('[data-test="kind-item"]').classes()).toContain('active')
    await b.wrapper.find('[data-test="kind-store"]').trigger('click')
    await settle()
    expect(b.router.currentRoute.value.query.kind).toBe('store')
    await b.wrapper.find('[data-test="kind-item"]').trigger('click')
    await settle()
    expect(b.router.currentRoute.value.query.kind).toBe('item')

    // a tab switch is a context switch: the open editor closes and the
    // unsaved input is discarded without the one-time guard
    await catAction(b.wrapper, outId, 'menu-rename')
    await b.wrapper.find(`${sel(outId)} input[aria-label="新しい名前"]`).setValue('未保存の変更')
    await b.wrapper.find('[data-test="kind-store"]').trigger('click')
    await settle()
    expect(b.wrapper.text()).not.toContain('保存されていません')
    await b.wrapper.find('[data-test="kind-item"]').trigger('click')
    await settle()
    expect(b.wrapper.find(`${sel(outId)} input[aria-label="新しい名前"]`).exists()).toBe(false)
    cleanup()

    // new=top opens the top add row at the head of the list, focused
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const c = await mountApp('/settings/categories?kind=item&new=top', { attach: true })
    const topInput = c.wrapper.find('div.add-row input')
    expect(topInput.exists()).toBe(true)
    expect(document.activeElement).toBe(topInput.element)
    expect(c.router.currentRoute.value.query.new).toBeUndefined()
    expect(c.router.currentRoute.value.query.kind).toBe('item')
    cleanup()

    // new=<大分類id> expands the (folded) parent and opens the child add row
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    sessionStorage.setItem('bb-cat-fold', JSON.stringify({ '1:item': [foodId] }))
    const d = await mountApp(`/settings/categories?kind=item&new=${foodId}`, { attach: true })
    expect(d.wrapper.find(`${sel(foodId)} ul.cat-children`).exists()).toBe(true)
    const childInput = d.wrapper.find(`${sel(foodId)} li.add-row input`)
    expect(childInput.exists()).toBe(true)
    expect(document.activeElement).toBe(childInput.element)
    expect(d.router.currentRoute.value.query.new).toBeUndefined()
    cleanup()

    // an unresolvable new opens nothing; only the query is cleared
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const e = await mountApp('/settings/categories?kind=item&new=999')
    expect(e.wrapper.find('div.add-row').exists()).toBe(false)
    expect(e.wrapper.findAll('li.add-row').length).toBe(0)
    expect(e.router.currentRoute.value.query.new).toBeUndefined()
  })

  it('[covers:web-categories.archived-hidden-by-default] アーカイブ済みは既定で非表示・aria-pressedのtext buttonでbadge付き表示・⋯は「アーカイブから戻す」に切替', async () => {
    const ids = await catIds(true)
    const funId = ids.get('趣味')!
    const { wrapper } = await mountApp('/settings/categories')
    expect(wrapper.find(sel(funId)).exists()).toBe(false)

    // the toggle is a small text button (aria-pressed), not a checkbox
    const toggle = wrapper.find('[data-test="show-archived"]')
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    await toggle.trigger('click')
    await settle()
    expect(toggle.attributes('aria-pressed')).toBe('true')
    expect(toggle.text()).toBe('アーカイブ済みを隠す')

    // the archived group shows in place with a badge, and its "..." offers
    // unarchive instead of archive
    const row = wrapper.find(sel(funId))
    expect(row.text()).toContain('アーカイブ済み')
    await row.find(`[data-test="row-menu-${funId}"]`).trigger('click')
    await settle()
    const items = wrapper.findAll('[role="menu"] [role="menuitem"]')
    expect(items.map((i) => i.text())).toEqual(['名前を変更', 'アーカイブから戻す'])
    await wrapper.find('[role="menu"] [data-test="menu-unarchive"]').trigger('click')
    await settle()

    // unarchived, it is visible in the default view again
    expect(wrapper.find(sel(funId)).exists()).toBe(true)
  })
})

describe('StoresPage', () => {
  it('[covers:web-manage.editor-icon-actions] 行editorの保存/やめる・追加行の作成・検索は icon-only（aria-label+title・svg）で keyboard 経路は不変', async () => {
    const listStores = vi.spyOn(api, 'listStores')
    const { wrapper } = await mountApp('/settings/stores')

    // the search submit is an icon-only search button
    const search = wrapper.find('form.inline-form button[type="submit"]')
    expect(search.text()).toBe('')
    expect(search.attributes('aria-label')).toBe('検索')
    expect(search.attributes('title')).toBe('検索')
    expect(search.find('svg').html()).toContain('M11 18a7 7 0 1 0') // the "search" glyph
    await wrapper.find('[data-test="query"]').setValue('エー')
    await wrapper.find('form.inline-form').trigger('submit')
    await settle()
    expect(listStores).toHaveBeenCalledWith(1, 'エー')

    // the row editor's pair is icon-only: check (primary) + close
    await storeAction(wrapper, 2, 'menu-edit')
    const save = wrapper.find('[data-test="store-2"] [data-test="edit-save"]')
    expect(save.text()).toBe('')
    expect(save.attributes('aria-label')).toBe('保存')
    expect(save.attributes('title')).toBe('保存')
    expect(save.classes()).toContain('primary')
    expect(save.find('svg').exists()).toBe(true)
    const cancel = wrapper.find('[data-test="store-2"] button:not([data-test])')
    expect(cancel.text()).toBe('')
    expect(cancel.attributes('aria-label')).toBe('やめる')
    // Enter saves through the input (unchanged), Escape gives up
    await wrapper.find('[data-test="store-2"] input[aria-label="店名"]').setValue('エーマート駅前')
    await wrapper.find('[data-test="store-2"] input[aria-label="店名"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(wrapper.find('[data-test="store-2"] input[aria-label="店名"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="store-2"] [data-test="store-name"]').text()).toBe('エーマート駅前')
    cleanup()

    // the categories add row: 作成 (check, primary) / やめる (close)
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const cats = await mountApp('/settings/categories')
    await cats.wrapper.find('[data-test="add-top"]').trigger('click')
    await settle()
    const create = cats.wrapper.find('.add-row button:not([data-test])')
    expect(create.text()).toBe('')
    expect(create.attributes('aria-label')).toBe('作成')
    expect(create.classes()).toContain('primary')
    expect(cats.wrapper.findAll('.add-row button').some((b) => b.attributes('aria-label') === 'やめる')).toBe(true)
    // the empty add row keeps 作成 disabled (unchanged rule)
    expect(create.attributes('disabled')).toBeDefined()
  })

  it('[covers:web-stores.update-store][covers:web-manage.row-editor] 行末⋯→「編集」でその行だけeditor・未保存の切替は1回止め・注記は行内status・viewerは⋯無効', async () => {
    const update = vi.spyOn(api, 'updateStore')
    const { wrapper } = await mountApp('/settings/stores')

    // the per-row 編集 button is gone; the "..." menu (編集 only) is the entry
    expect(wrapper.find('[data-test="store-2"] [data-test="edit"]').exists()).toBe(false)
    const editor = () => wrapper.find('[data-test="store-2"]')
    await storeAction(wrapper, 2, 'menu-edit')
    const nameInput = () => editor().find('input[aria-label="店名"]')
    const catSelect = () => editor().find('select[aria-label="店カテゴリ"]')
    expect(nameInput().exists()).toBe(true)
    expect((nameInput().element as HTMLInputElement).value).toBe('エーマート')
    expect(wrapper.find('[data-test="store-1"] input[aria-label="店名"]').exists()).toBe(false)

    // an unsaved change blocks switching rows once, then the same pick switches
    await nameInput().setValue('エーマート駅前')
    await storeAction(wrapper, 1, 'menu-edit')
    expect(nameInput().exists()).toBe(true)
    const unsaved = editor().find('.row-status')
    expect(unsaved.attributes('role')).toBe('alert')
    expect(unsaved.text()).toContain('保存されていません')
    await storeAction(wrapper, 1, 'menu-edit')
    expect(wrapper.find('[data-test="store-1"] input[aria-label="店名"]').exists()).toBe(true)
    expect(nameInput().exists()).toBe(false)

    // Escape gives up; the save posts name + category in one call and the
    // past-reflection note lands on the row's inline status
    update.mockClear()
    await wrapper.find('[data-test="store-1"] input[aria-label="店名"]').trigger('keydown.esc')
    await settle()
    expect(update).not.toHaveBeenCalled()
    await storeAction(wrapper, 2, 'menu-edit')
    await nameInput().setValue('エーマート駅前')
    const opt = catSelect().findAll('option').find((o) => o.text() === 'スーパー')!
    await catSelect().setValue(opt.element.value)
    await rowButton(wrapper, '[data-test="store-2"]', '保存').trigger('click')
    await settle()
    expect(update).toHaveBeenCalledWith(1, 2, { name: 'エーマート駅前', category: 'スーパー' })
    expect(wrapper.find('[data-test="store-2"] [data-test="store-name"]').text()).toBe('エーマート駅前')
    const status = wrapper.find('[data-test="store-2"] .row-status')
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toContain('過去のレシートの集計にも反映')

    // a viewer cannot even open the "..." menu (rendered but disabled)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: { ...ME, ledgers: [{ ...ME.ledgers[0]!, role: 'viewer' as const }] } } })
    const viewer = await mountApp('/settings/stores')
    expect(viewer.wrapper.find('[data-test="store-2"] [data-test="row-menu-2"]').attributes('disabled')).toBeDefined()
  })

  it('[covers:web-stores.merge-requires-confirm] 確認後にだけ統合し、件数が移る', async () => {
    const merge = vi.spyOn(api, 'mergeStores')
    const { wrapper } = await mountApp('/settings/stores')
    await wrapper.find('[data-test="merge-source"]').setValue(2)
    await wrapper.find('[data-test="merge-target"]').setValue(1)
    await wrapper.find('[data-test="merge-review"]').trigger('click')
    await settle()
    const panel = wrapper.find('[data-test="merge-confirm-panel"]').text()
    expect(panel).toContain('エーマート')
    expect(panel).toContain('レシート 1 件')
    expect(panel).toContain('元に戻せません')
    expect(merge).not.toHaveBeenCalled()
    await wrapper.find('[data-test="merge-confirm"]').trigger('click')
    await settle()
    expect(merge).toHaveBeenCalledWith(1, 2, 1)
    expect(wrapper.find('[data-test="store-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="store-1"] [data-test="receipt-count"]').text()).toBe('2')
  })

  it('[covers:web-stores.merge-same-store-rejected] 同じ店どうしは確認に進めない', async () => {
    const { wrapper } = await mountApp('/settings/stores')
    await wrapper.find('[data-test="merge-source"]').setValue(1)
    await wrapper.find('[data-test="merge-target"]').setValue(1)
    await wrapper.find('[data-test="merge-review"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-test="error"]').text()).toContain('同じ店')
    expect(wrapper.find('[data-test="merge-confirm-panel"]').exists()).toBe(false)
  })
})

describe('Receipts', () => {
  /** The feed panel of one receipt (data-test values repeat across panels). */
  const panel = (w: W, id: number) => w.find(`[data-test="receipt-panel-${id}"]`)

  it('[covers:web-receipts.list-and-detail] 一覧（件数・合計）から文脈付きリンクで詳細の Feed へ', async () => {
    const { wrapper, router } = await mountApp('/receipts?store=Aマート')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('レシート 1件')
    expect(wrapper.find('[data-test="summary"]').text()).toContain('400円')
    expect(wrapper.find('[data-test="receipt-101"]').text()).toContain('Aマート')
    // the row link carries the list context (period + filters)
    const href = wrapper.find('[data-test="receipt-101"] a').attributes('href')!
    const u = new URL(href, 'http://localhost')
    expect(u.pathname).toBe('/receipts/101')
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: '2026-10-01', to: '2026-10-31', store: 'Aマート' })
    await wrapper.find('[data-test="receipt-101"] a').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/receipts/101')
    expect(router.currentRoute.value.query).toEqual({ from: '2026-10-01', to: '2026-10-31', store: 'Aマート' })
    const p = panel(wrapper, 101)
    expect(p.exists()).toBe(true)
    expect(p.find('[data-test="items"]').text()).toContain('牛乳')
    expect(p.find('[data-test="items-total"]').text()).toContain('400円')
    // the item category is a link into the hierarchy page (TASK-74 §4-8)
    const cat = p.find('[data-test="item-cat-1001"]')
    expect(cat.element.tagName).toBe('A')
    expect(cat.attributes('href')).toBe('/categories/1/2?month=2026-10')
  })

  it('[covers:web-receipts.update-with-revision] 表示中の revision 付きで保存し版が進む', async () => {
    const update = vi.spyOn(api, 'updateReceipt')
    const { wrapper } = await mountApp('/receipts/101')
    const p = panel(wrapper, 101)
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('特売')
    await p.find('[data-test="f-item-0"] [data-test="f-item-amount"]').setValue(250)
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    expect(update).toHaveBeenCalledWith(1, 101, {
      revision: 1,
      set: { note: '特売' },
      upsert_items: [{ item_id: 1001, amount: 250 }],
    })
    expect(panel(wrapper, 101).find('[data-test="revision"]').text()).toBe('2')
    expect(panel(wrapper, 101).find('[data-test="note"]').text()).toBe('特売')
  })

  it('[covers:web-receipts.stale-revision-reload] revision 不一致は上書きせず最新を読み直す', async () => {
    const { wrapper } = await mountApp('/receipts/101')
    await api.updateReceipt(1, 101, { revision: 1, set: { note: '会話で変更' } })
    const p = panel(wrapper, 101)
    await p.find('[data-test="edit"]').trigger('click')
    await p.find('[data-test="f-note"]').setValue('web で変更')
    await p.find('[data-test="edit-form"]').trigger('submit')
    await settle()
    const after = panel(wrapper, 101)
    expect(after.find('[data-test="error"]').text()).toContain('他の画面や会話で更新')
    expect(after.find('[data-test="revision"]').text()).toBe('2')
    expect(after.find('[data-test="note"]').text()).toBe('会話で変更')
  })

  it('[covers:web-receipts.delete-preview-confirm] preview を示してから revision 付きで削除、Feed のパネル・位置・URL は不変', async () => {
    const del = vi.spyOn(api, 'deleteReceipt')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/receipts/101?from=2026-10-01&to=2026-10-31')
    const position = wrapper.find('[data-test="feed-position"]').text()
    const fullPath = router.currentRoute.value.fullPath
    const listCalls = list.mock.calls.length
    const p = panel(wrapper, 101)
    // deletion is only reachable from the edit mode's danger zone
    expect(p.find('[data-test="delete"]').exists()).toBe(false)
    await p.find('[data-test="edit"]').trigger('click')
    await panel(wrapper, 101).find('[data-test="delete"]').trigger('click')
    await settle()
    expect(del).toHaveBeenLastCalledWith(1, 101, {})
    const preview = panel(wrapper, 101).find('[data-test="delete-preview"]').text()
    expect(preview).toContain('Aマート')
    expect(preview).toContain('90日以内なら復元できます')
    expect(panel(wrapper, 101).find('[data-test="deleted"]').exists()).toBe(false)
    await panel(wrapper, 101).find('[data-test="delete-confirm"]').trigger('click')
    await settle()
    expect(del).toHaveBeenLastCalledWith(1, 101, { confirm: true, revision: 1 })
    // the panel stays in the feed, shown as deleted
    const after = panel(wrapper, 101)
    expect(after.exists()).toBe(true)
    expect(after.find('[data-test="deleted"]').exists()).toBe(true)
    expect(after.find('.deleted-banner').exists()).toBe(true)
    expect(after.find('[data-test="restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="feed-position"]').text()).toBe(position)
    expect(router.currentRoute.value.fullPath).toBe(fullPath)
    expect(list.mock.calls.length).toBe(listCalls)
  })

  it('[covers:web-receipts.restore] 削除済みは確認なしで復元、Feed の位置・URL は不変', async () => {
    await api.deleteReceipt(1, 102, { confirm: true, revision: 1 })
    const del = vi.spyOn(api, 'deleteReceipt')
    const list = vi.spyOn(api, 'listReceipts')
    const { wrapper, router } = await mountApp('/receipts/102?from=2026-10-01&to=2026-10-31&include_deleted=1')
    const position = wrapper.find('[data-test="feed-position"]').text()
    const fullPath = router.currentRoute.value.fullPath
    const listCalls = list.mock.calls.length
    expect(panel(wrapper, 102).find('[data-test="deleted"]').exists()).toBe(true)
    await panel(wrapper, 102).find('[data-test="restore"]').trigger('click')
    await settle()
    expect(del).toHaveBeenCalledWith(1, 102, { restore: true, revision: 2 })
    expect(panel(wrapper, 102).exists()).toBe(true)
    expect(panel(wrapper, 102).find('[data-test="deleted"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="feed-position"]').text()).toBe(position)
    expect(router.currentRoute.value.fullPath).toBe(fullPath)
    expect(list.mock.calls.length).toBe(listCalls)
  })
})

describe('XSS', () => {
  it('[covers:web-xss.text-rendering] 利用者由来の文字列はテキストとして表示', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    await api.updateStore(1, 1, { name: evil })
    const stores = await mountApp('/settings/stores')
    expect(stores.wrapper.find('img').exists()).toBe(false)
    expect(stores.wrapper.find('[data-test="store-1"] [data-test="store-name"]').text()).toBe(evil)
    cleanup()

    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const detail = await mountApp('/receipts/101')
    expect(detail.wrapper.find('img[src="x"]').exists()).toBe(false)
    expect(detail.wrapper.find('[data-test="store-name"]').text()).toBe(evil)
  })
})

describe('ReceiptDetail image', () => {
  it('[covers:web-receipts.detail-image] API由来の/media/img URLのみ表示、期限切れは再取得、画像なしは省略', async () => {
    const { wrapper } = await mountApp('/receipts/101')
    const p = () => wrapper.find('[data-test="receipt-panel-101"]')
    const img = p().find('[data-test="receipt-image"]')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('https://localhost:40281/media/img/mock-token-101')
    expect(p().find('[data-test="image-expired"]').exists()).toBe(false)

    // token expiry -> img load error -> message + reload re-fetches the detail
    await img.trigger('error')
    await settle()
    expect(p().find('[data-test="receipt-image"]').exists()).toBe(false)
    expect(p().find('[data-test="image-expired"]').exists()).toBe(true)
    const spy = vi.spyOn(api, 'getReceipt')
    await p().find('[data-test="image-reload"]').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith(1, 101)
    expect(p().find('[data-test="receipt-image"]').exists()).toBe(true)

    // receipt without an image: nothing rendered in its panel
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const plain = await mountApp('/receipts/102')
    const pp = plain.wrapper.find('[data-test="receipt-panel-102"]')
    expect(pp.exists()).toBe(true)
    expect(pp.find('[data-test="receipt-image"]').exists()).toBe(false)
    expect(pp.find('[data-test="image-expired"]').exists()).toBe(false)

    // a URL outside /media/img/ is never used as the src (spec 11-7 rule)
    cleanup()
    mockFetch({ 'GET /api/auth/me': { body: ME } })
    const r = await api.getReceipt(1, 103)
    vi.spyOn(api, 'getReceipt').mockResolvedValue({
      ...r,
      image_url: { url: 'javascript:alert(1)', expires_at: '2099-01-01T00:00:00+09:00', width: 1, height: 1 },
    })
    const evil = await mountApp('/receipts/103')
    const ep = evil.wrapper.find('[data-test="receipt-panel-103"]')
    expect(ep.exists()).toBe(true)
    expect(ep.find('[data-test="receipt-image"]').exists()).toBe(false)
  })
})

describe('ReceiptsPage label filter (TASK-17)', () => {
  /** listReceipts responses with labels on receipt 101 (red). */
  function withRowLabels() {
    const orig = api.listReceipts.bind(api)
    return vi.spyOn(api, 'listReceipts').mockImplementation(async (l, q) => {
      const r = await orig(l, q)
      return {
        ...r,
        receipts: r.receipts.map((x) => ({
          ...x,
          labels: x.receipt_id === 101 ? [{ color: 'red' as const, title: null }] : [],
        })),
      }
    })
  }

  it('[covers:web-receipts.label-filter][covers:web-labels.no-color-names-on-screen] topbar ラベルチップ+dialog の選択は URL labels に同期し label_colors で流れ、条件チップは1色1チップ（×はその色だけ外す）、行に LabelDots compact', async () => {
    const list = withRowLabels()
    const stats = vi.spyOn(api, 'getStats')
    const { wrapper, router } = await mountApp('/receipts')

    // the label filter moved to the topbar (TASK-44): the chip is icon-only
    // when unselected and the toggles live in its dialog
    const chip = wrapper.find('[data-test="filter-labels"]')
    expect(chip.exists()).toBe(true)
    expect(chip.attributes('aria-label')).toBe('ラベルで絞り込み')
    expect(chip.text()).not.toContain('ラベル')
    await chip.trigger('click')
    await settle()

    // select red + blue (OR) inside the dialog
    await wrapper.find('[data-test="label-filter-red"]').trigger('click')
    await wrapper.find('[data-test="label-filter-blue"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBe('red,blue')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    // the same-page stats (summary / payments / daily) get the filter too
    expect(stats).toHaveBeenCalledWith(1, expect.objectContaining({ label_colors: ['red', 'blue'] }))
    // both toggles show the pressed state; the topbar chip carries the selection
    expect(wrapper.find('[data-test="label-filter-red"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="label-filter-blue"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="filter-labels"]').classes()).toContain('active')

    // the condition chips ride the one-row toolbar (TASK-75): one chip per
    // selected color in the FilterChips form — the title when the ledger
    // defined one, the color key otherwise; no color-name text
    const chips = wrapper.find('[data-test="page-chips"]')
    expect(chips.exists()).toBe(true)
    expect(chips.text()).toContain('red')
    expect(chips.text()).toContain('blue')
    expect(chips.text()).not.toMatch(/赤|黄|緑|青|紫/)
    // one chip's x drops that color alone; the other stays filtering
    await chips.find('[data-test="chip-x-label-red"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBe('blue')
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: ['blue'] }))
    expect(wrapper.find('[data-test="page-chips"]').text()).not.toContain('red')
    // the last chip's x clears the selection and the topbar chip follows
    await wrapper.find('[data-test="page-chips"] [data-test="chip-x-label-blue"]').trigger('click')
    await settle()
    expect(router.currentRoute.value.query['labels']).toBeUndefined()
    expect(list).toHaveBeenLastCalledWith(1, expect.objectContaining({ label_colors: [] }))
    // the topbar chip is back to the unselected state
    expect(wrapper.find('[data-test="filter-labels"]').classes()).not.toContain('active')

    // the reserved row-labels element of a labeled row holds the dots
    expect(
      wrapper.find('[data-test="receipt-101"] [data-test="row-labels"] [data-test="label-dot"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-test="receipt-102"] [data-test="row-labels"] [data-test="label-dot"]').exists(),
    ).toBe(false)
  })
})
