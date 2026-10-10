import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPaneView, remapPaneViews, savePaneView } from './pane-view'

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('pane views', () => {
  it('are kept per pane; null removes one', () => {
    savePaneView('%1', { view: 'chat', panel: null })
    savePaneView('%2', { view: 'terminal', panel: 'files' })
    expect(loadPaneView('%1')).toEqual({ view: 'chat', panel: null })
    expect(loadPaneView('%2')).toEqual({ view: 'terminal', panel: 'files' })
    savePaneView('%1', null)
    expect(sessionStorage.getItem('termote-pane-view:%1')).toBeNull()
    expect(loadPaneView('%1')).toBeNull()
  })

  it('ignore what they cannot read', () => {
    sessionStorage.setItem('termote-pane-view:a', '{')
    sessionStorage.setItem('termote-pane-view:b', '{"panel":"files"}')
    sessionStorage.setItem('termote-pane-view:c', '{"view":"chat","panel":3}')
    expect(loadPaneView('a')).toBeNull()
    expect(loadPaneView('b')).toBeNull()
    expect(loadPaneView('c')).toEqual({ view: 'chat', panel: null })
  })

  it('follow their pane when ids shift, all at once', () => {
    savePaneView('1', { view: 'chat', panel: null })
    savePaneView('2', { view: 'files', panel: null })
    savePaneView('3', { view: 'changes', panel: null })
    savePaneView('9', { view: 'terminal', panel: 'changes' })
    // 1 → 2, 2 → 1 (traded); 3 gone; 4 (nothing kept) → 5
    remapPaneViews({
      moved: new Map([
        ['1', '2'],
        ['2', '1'],
        ['4', '5'],
      ]),
      stale: new Set(['1', '2', '3', '4', '5']),
    })
    expect(loadPaneView('1')?.view).toBe('files')
    expect(loadPaneView('2')?.view).toBe('chat')
    expect(loadPaneView('3')).toBeNull()
    expect(loadPaneView('5')).toBeNull()
    expect(loadPaneView('9')).toEqual({ view: 'terminal', panel: 'changes' })
  })

  it('without storage, nothing is kept and nothing throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() =>
      savePaneView('%1', { view: 'chat', panel: null }),
    ).not.toThrow()
    expect(loadPaneView('%1')).toBeNull()
  })
})
