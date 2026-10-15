import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MuxSnapshot } from '../hooks/use-mux-api'
import { setPaneKeys } from './pane-remap'
import { loadPaneView, savePaneView } from './pane-view'

afterEach(() => {
  vi.restoreAllMocks()
})

// A snapshot of server i1 with panes %1, %2 (keys @1, @2) in group main
function snapshot() {
  setPaneKeys(
    {
      instanceId: 'i1',
      groups: [
        {
          id: '$0',
          name: 'main',
          tabs: [
            { id: '%1', panes: [] },
            { id: '%2', panes: [] },
          ],
        },
      ],
    } as unknown as MuxSnapshot,
    new Map([
      ['%1', '@1'],
      ['%2', '@2'],
    ]),
  )
}

describe('pane views', () => {
  it('are kept per pane key on this device; null removes one', () => {
    snapshot()
    savePaneView('%1', { view: 'chat', panel: null })
    savePaneView('%2', { view: 'terminal', panel: 'files' })
    expect(loadPaneView('%1')).toEqual({ view: 'chat', panel: null })
    expect(loadPaneView('%2')).toEqual({ view: 'terminal', panel: 'files' })
    expect(localStorage.getItem('termote-pane-view:i1:@1')).toContain('"chat"')
    savePaneView('%1', null)
    expect(localStorage.getItem('termote-pane-view:i1:@1')).toBeNull()
    expect(loadPaneView('%1')).toBeNull()
  })

  it('a pane without a key keeps nothing', () => {
    savePaneView('0', { view: 'chat', panel: null })
    expect(localStorage.length).toBe(0)
    expect(loadPaneView('0')).toBeNull()
  })

  it('ignore what they cannot read', () => {
    snapshot()
    const rec = (view: object) =>
      JSON.stringify({ v: 1, pane: '@1', group: 'main', savedAt: 1, view })
    localStorage.setItem('termote-pane-view:i1:@1', rec({ panel: 'files' }))
    expect(loadPaneView('%1')).toBeNull()
    localStorage.setItem(
      'termote-pane-view:i1:@1',
      JSON.stringify({
        v: 1,
        pane: '@1',
        group: 'main',
        savedAt: 1,
        view: { view: 'chat', panel: 3 },
      }),
    )
    expect(loadPaneView('%1')).toEqual({ view: 'chat', panel: null })
  })
})
