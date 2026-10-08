import { describe, expect, it } from 'vitest'
import {
  closeTab,
  enforceCap,
  MAX_TABS,
  openTab,
  pinTab,
  type TabBase,
} from './file-tabs'

interface Tab extends TabBase {
  path: string
}

const tab = (path: string, pinned = true, lastUsed = 0): Tab => ({
  id: path,
  path,
  pinned,
  lastUsed,
})
const keyOf = (t: Tab) => t.path
const clean = () => false
const paths = (tabs: Tab[]) => tabs.map((t) => t.path)

// Opens path with the id path, as a caller would
function open(
  tabs: Tab[],
  activeId: string | null,
  path: string,
  pin = false,
  isDirty: (t: Tab) => boolean = clean,
  now = 100,
  max?: number,
) {
  return openTab(
    tabs,
    activeId,
    keyOf,
    path,
    () => tab(path),
    { pin },
    isDirty,
    now,
    max,
  )
}

describe('openTab', () => {
  it('a first file opens as the preview tab', () => {
    const r = open([], null, 'a')
    expect(r.tabs).toEqual([
      { id: 'a', path: 'a', pinned: false, lastUsed: 100 },
    ])
    expect(r.activeId).toBe('a')
    expect(r.closed).toEqual([])
  })

  it('an unpinned open replaces the preview tab in place', () => {
    const tabs = [tab('a'), tab('p', false), tab('b')]
    const r = open(tabs, 'b', 'c')
    expect(paths(r.tabs)).toEqual(['a', 'c', 'b'])
    expect(r.tabs[1].pinned).toBe(false)
    expect(r.activeId).toBe('c')
    expect(r.closed).toEqual([tabs[1]])
  })

  it('a preview tab with unsaved changes is never replaced: it is pinned', () => {
    const tabs = [tab('p', false), tab('b')]
    const r = open(tabs, 'p', 'c', false, (t) => t.path === 'p')
    expect(paths(r.tabs)).toEqual(['p', 'c', 'b'])
    expect(r.tabs.map((t) => t.pinned)).toEqual([true, false, true])
  })

  it('a pinned open adds a tab after the one shown, keeping the preview', () => {
    const tabs = [tab('p', false), tab('a'), tab('b')]
    const r = open(tabs, 'a', 'c', true)
    expect(paths(r.tabs)).toEqual(['p', 'a', 'c', 'b'])
    expect(r.tabs[2].pinned).toBe(true)
  })

  it('with no tab shown, a new one goes last', () => {
    const r = open([tab('a')], null, 'c', true)
    expect(paths(r.tabs)).toEqual(['a', 'c'])
  })

  it('a file already open shows its tab, pinned only when asked', () => {
    const tabs = [tab('a', false, 1), tab('b', true, 2)]
    const r = open(tabs, 'b', 'a', false, clean, 7)
    expect(r.tabs).toHaveLength(2)
    expect(r.tabs[0]).toEqual({
      id: 'a',
      path: 'a',
      pinned: false,
      lastUsed: 7,
    })
    expect(r.activeId).toBe('a')
    const pinned = open(tabs, 'b', 'a', true)
    expect(pinned.tabs[0].pinned).toBe(true)
    // Never unpinned by a single click
    expect(open(tabs, 'a', 'b').tabs[1].pinned).toBe(true)
  })

  it('past the cap the least recently used clean tab closes', () => {
    const tabs = [tab('a', true, 3), tab('b', true, 1), tab('c', true, 2)]
    const r = open(tabs, 'a', 'd', true, clean, 9, 3)
    expect(paths(r.tabs)).toEqual(['a', 'd', 'c'])
    expect(paths(r.closed)).toEqual(['b'])
  })
})

describe('closeTab', () => {
  const tabs = [tab('a'), tab('b'), tab('c')]

  it('the tab to the right shows, else the left, else none', () => {
    expect(closeTab(tabs, 'b', 'b')).toEqual({
      tabs: [tabs[0], tabs[2]],
      activeId: 'c',
    })
    expect(closeTab(tabs, 'c', 'c').activeId).toBe('b')
    expect(closeTab([tabs[0]], 'a', 'a')).toEqual({ tabs: [], activeId: null })
  })

  it('closing another tab keeps the one shown', () => {
    expect(closeTab(tabs, 'a', 'c').activeId).toBe('a')
    expect(closeTab(tabs, null, 'c').activeId).toBeNull()
  })

  it('an unknown id changes nothing', () => {
    const r = closeTab(tabs, 'a', 'x')
    expect(r.tabs).toBe(tabs)
    expect(r.activeId).toBe('a')
  })
})

describe('pinTab', () => {
  it('pins one tab, leaving the others as they are', () => {
    const tabs = [tab('a', false), tab('b')]
    const next = pinTab(tabs, 'a')
    expect(next[0].pinned).toBe(true)
    expect(next[1]).toBe(tabs[1])
    // Already pinned: the same object
    expect(pinTab(next, 'a')[0]).toBe(next[0])
  })
})

describe('enforceCap', () => {
  it('defaults to MAX_TABS', () => {
    const tabs = Array.from({ length: MAX_TABS + 1 }, (_, i) =>
      tab(`f${i}`, true, i),
    )
    const r = enforceCap(tabs, 'f0', clean)
    expect(r.tabs).toHaveLength(MAX_TABS)
    expect(paths(r.closed)).toEqual(['f1'])
  })

  it('never closes the tab shown nor one with unsaved changes', () => {
    const tabs = [tab('a', true, 1), tab('b', true, 2), tab('c', true, 3)]
    const r = enforceCap(tabs, 'a', (t) => t.path === 'b', 2)
    expect(paths(r.tabs)).toEqual(['a', 'b'])
    expect(paths(r.closed)).toEqual(['c'])
  })

  it('stays over the cap when every other tab has unsaved changes', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    const r = enforceCap(tabs, 'a', (t) => t.path !== 'a', 1)
    expect(r.tabs).toBe(tabs)
    expect(r.closed).toEqual([])
  })
})
