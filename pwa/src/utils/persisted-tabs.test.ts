import { describe, expect, it } from 'vitest'
import {
  persistedChangesState,
  persistedFilesState,
  restoreChangesState,
  restoredCounters,
  restoreFilesState,
} from './persisted-tabs'

const fileTab = (id: string, more: object = {}) => ({
  id,
  pinned: true,
  lastUsed: 1,
  root: '/r',
  path: `${id}.md`,
  history: [],
  reveal: false,
  ...more,
})

const changeTab = (id: string, more: object = {}) => ({
  id,
  pinned: false,
  lastUsed: 2,
  root: '/r',
  path: `${id}.ts`,
  staged: false,
  editing: false,
  revealed: false,
  ...more,
})

describe('persistedFilesState', () => {
  it('keeps the tabs without what is never kept', () => {
    const p = persistedFilesState({
      root: '/r',
      tabs: [
        fileTab('t1', {
          intent: true,
          anchor: 'h',
          scrollTop: 30,
          table: { key: 'k', widths: { 0: 80 }, wrapped: [1] },
          history: [{ path: 'x.md', scrollTop: 5 }],
        }),
        fileTab('t2', { reveal: true, path: '.env' }),
      ],
      activeId: 't1',
      pendingRootClose: ['t1', 't2'],
    })
    expect(p).toEqual({
      root: '/r',
      tabs: [
        {
          id: 't1',
          pinned: true,
          lastUsed: 1,
          root: '/r',
          path: 't1.md',
          anchor: 'h',
          scrollTop: 30,
          table: { key: 'k', widths: { 0: 80 }, wrapped: [1] },
          history: [{ path: 'x.md', scrollTop: 5 }],
        },
      ],
      activeId: 't1',
      pendingRootClose: ['t1'],
    })
    const json = JSON.stringify(p)
    for (const word of ['reveal', 'intent', 'expanded', '.env'])
      expect(json).not.toContain(word)
  })

  it('shows nothing for a sensitive tab shown, and keeps nothing for none', () => {
    const p = persistedFilesState({
      tabs: [fileTab('t1'), fileTab('t2', { reveal: true })],
      activeId: 't2',
      pendingRootClose: ['t2'],
    })
    expect(p?.activeId).toBeNull()
    expect(p?.pendingRootClose).toBeUndefined()
    expect(
      persistedFilesState({
        tabs: [fileTab('t1', { reveal: true })],
        activeId: null,
      }),
    ).toBeNull()
  })
})

describe('restoreFilesState', () => {
  it('reads back what was kept', () => {
    const kept = persistedFilesState({
      root: '/r',
      tabs: [fileTab('t1'), fileTab('t2')],
      activeId: 't2',
      pendingRootClose: ['t1'],
    })
    expect(restoreFilesState(JSON.parse(JSON.stringify(kept)))).toEqual(kept)
  })

  it('reads the lines of wrapped cells, or none from a tab kept before them', () => {
    const tabs = [
      fileTab('t1', { table: { key: 'k', widths: {}, wrapped: [0] } }),
      fileTab('t2', {
        table: { key: 'k', widths: {}, wrapped: [0], lines: 10 },
      }),
    ]
    const kept = persistedFilesState({ tabs, activeId: 't2' })
    const back = restoreFilesState(JSON.parse(JSON.stringify(kept)))
    expect(back?.tabs.map((t) => t.table?.lines)).toEqual([undefined, 10])
  })

  it('reads a pinned first column, or none from a tab kept before it', () => {
    const tabs = [
      fileTab('t1', { table: { key: 'k', widths: {}, wrapped: [] } }),
      fileTab('t2', {
        table: { key: 'k', widths: {}, wrapped: [], pinned: true },
      }),
    ]
    const kept = persistedFilesState({ tabs, activeId: 't2' })
    const back = restoreFilesState(JSON.parse(JSON.stringify(kept)))
    expect(back?.tabs.map((t) => t.table?.pinned)).toEqual([undefined, true])
  })

  it('leaves out tabs that are not ones, keeps the rest', () => {
    const r = restoreFilesState({
      root: 3,
      tabs: [
        fileTab('t1'),
        fileTab('t1'),
        { ...fileTab('t2'), pinned: 'yes' },
        { ...fileTab('t3'), history: [{ path: 'a' }] },
        { ...fileTab('t4'), table: { key: 'k', widths: { 0: 'x' } } },
        { ...fileTab('t5'), scrollTop: Number.NaN },
        { ...fileTab('t6'), table: 'x' },
        { ...fileTab('t7'), table: { key: 1, widths: {}, wrapped: [] } },
        { ...fileTab('t8'), table: { key: 'k', widths: [], wrapped: [] } },
        { ...fileTab('t9'), table: { key: 'k', widths: {}, wrapped: 'x' } },
        { ...fileTab('t10'), table: { key: 'k', widths: {}, wrapped: ['x'] } },
        {
          ...fileTab('t11'),
          table: { key: 'k', widths: {}, wrapped: [], lines: 7 },
        },
        {
          ...fileTab('t12'),
          table: { key: 'k', widths: {}, wrapped: [], pinned: 'x' },
        },
        null,
        [],
      ],
      activeId: 't2',
      pendingRootClose: ['t1', 't9', 4],
    })
    expect(r?.root).toBeUndefined()
    expect(r?.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(r?.activeId).toBeNull()
    expect(r?.pendingRootClose).toEqual(['t1'])
  })

  it('is null for a record without a tab left', () => {
    expect(restoreFilesState(null)).toBeNull()
    expect(restoreFilesState({ tabs: 'x' })).toBeNull()
    expect(restoreFilesState({ tabs: [{}] })).toBeNull()
    expect(
      restoreFilesState({ tabs: [fileTab('t1')], pendingRootClose: 'x' })
        ?.pendingRootClose,
    ).toBeUndefined()
  })
})

describe('Changes', () => {
  it('keep the tabs without a sensitive one, and read them back', () => {
    const p = persistedChangesState({
      root: '/r',
      tabs: [
        changeTab('c1', {
          orig: 'old.ts',
          staged: true,
          scrollTop: 3,
          editScrollTop: 4,
        }),
        changeTab('c2', { editing: true }),
        changeTab('c3', { revealed: true }),
      ],
      activeId: 'c2',
    })
    expect(p?.tabs.map((t) => t.id)).toEqual(['c1', 'c2'])
    expect(JSON.stringify(p)).not.toContain('revealed')
    expect(restoreChangesState(JSON.parse(JSON.stringify(p)))).toEqual(p)
    expect(
      restoreChangesState({
        tabs: [{ ...changeTab('c1'), editing: 1 }, changeTab('c2')],
      })?.tabs.map((t) => t.id),
    ).toEqual(['c2'])
  })
})

describe('restoredCounters', () => {
  it('start past every tab', () => {
    expect(
      restoredCounters([
        { id: 't3', lastUsed: 9 },
        { id: 't12', lastUsed: 2 },
        { id: 'tx', lastUsed: 1 },
      ]),
    ).toEqual({ clock: 9, ids: 12 })
    expect(restoredCounters([])).toEqual({ clock: 0, ids: 0 })
  })
})
