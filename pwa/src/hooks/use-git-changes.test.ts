import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remapPanes } from '../utils/pane-remap'
import {
  type FileDraft,
  isDraftDirty,
  resetFilesStores,
  useFileDraft,
} from './use-files'
import {
  CHANGES_POLL,
  type ChangeSide,
  changeKey,
  findEntry,
  resetGitChangesStores,
  useGitChanges,
} from './use-git-changes'
import { type ChangeEntry, type GitChanges, RequestError } from './use-mux-api'

const mockChanges = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchGitChanges: (...a: unknown[]) => mockChanges(...a),
}))

const changes = (over: Partial<GitChanges> = {}): GitChanges => ({
  root: '/r',
  isRepo: true,
  branch: 'main',
  entries: [{ path: 'a', staged: '', unstaged: 'M', sensitive: false }],
  truncated: false,
  ...over,
})

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  resetGitChangesStores()
  resetFilesStores()
  mockChanges.mockReset()
  mockChanges.mockResolvedValue(changes())
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useGitChanges', () => {
  it('polls every 5s while shown, sending the root it saw', async () => {
    const { result, unmount } = renderHook(() => useGitChanges('%1'))
    expect(result.current.loaded).toBe(false)
    await tick()
    expect(result.current).toMatchObject({
      loaded: true,
      root: '/r',
      branch: 'main',
      isRepo: true,
    })
    expect(result.current.entries).toHaveLength(1)
    expect(mockChanges).toHaveBeenLastCalledWith('%1', undefined)
    await tick(CHANGES_POLL)
    expect(mockChanges).toHaveBeenCalledTimes(2)
    expect(mockChanges).toHaveBeenLastCalledWith('%1', '/r')
    unmount()
    await tick(CHANGES_POLL * 3)
    expect(mockChanges).toHaveBeenCalledTimes(2)
  })

  it('a poll that brings nothing new does not re-render', async () => {
    let renders = 0
    renderHook(() => {
      renders++
      return useGitChanges('%1')
    })
    await tick()
    const after = renders
    await tick(CHANGES_POLL)
    expect(renders).toBe(after)
    mockChanges.mockResolvedValue(changes({ branch: 'dev' }))
    await tick(CHANGES_POLL)
    expect(renders).toBe(after + 1)
  })

  it('does not poll while the page is hidden, and polls when it shows', async () => {
    renderHook(() => useGitChanges('%1'))
    await tick()
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await tick(CHANGES_POLL * 3)
    expect(mockChanges).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(mockChanges).toHaveBeenCalledTimes(2)
  })

  it('backs off after failures, keeping what it had', async () => {
    const { result } = renderHook(() => useGitChanges('%1'))
    await tick()
    mockChanges.mockRejectedValue(new RequestError(503, '', 'git timed out'))
    await tick(CHANGES_POLL)
    expect(result.current.error).toBe('timeout')
    expect(result.current.entries).toHaveLength(1)
    // 2 failures: 10s
    await tick(CHANGES_POLL)
    expect(mockChanges).toHaveBeenCalledTimes(3)
    await tick(CHANGES_POLL * 2 - 1)
    expect(mockChanges).toHaveBeenCalledTimes(3)
    await tick(1)
    expect(mockChanges).toHaveBeenCalledTimes(4)
    mockChanges.mockRejectedValue(new Error('offline'))
    await tick(CHANGES_POLL * 4)
    expect(result.current.error).toBe('unavailable')
    mockChanges.mockResolvedValue(changes())
    await tick(60000)
    expect(result.current.error).toBeUndefined()
  })

  it('never runs two polls at once; a refresh mid-poll runs right after it', async () => {
    let finish!: (v: unknown) => void
    mockChanges.mockReturnValueOnce(new Promise((r) => (finish = r)))
    const { result } = renderHook(() => useGitChanges('%1'))
    await tick()
    act(() => result.current.refresh())
    act(() => result.current.refresh())
    expect(mockChanges).toHaveBeenCalledTimes(1)
    await act(async () => finish(changes()))
    await tick()
    expect(mockChanges).toHaveBeenCalledTimes(2)
    // Idle: a refresh polls now
    act(() => result.current.refresh())
    await tick()
    expect(mockChanges).toHaveBeenCalledTimes(3)
  })

  it('a moved root reads the status again from the new one', async () => {
    const { result } = renderHook(() => useGitChanges('%1'))
    await tick()
    mockChanges
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
      )
      .mockResolvedValue(changes({ root: '/n', isRepo: false, entries: [] }))
    await tick(CHANGES_POLL)
    expect(result.current.rootChanges).toBe(1)
    // The poll again, set while the timers were being advanced
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(mockChanges).toHaveBeenLastCalledWith('%1', '/n')
    expect(result.current).toMatchObject({
      root: '/n',
      isRepo: false,
      loaded: true,
    })
    // Told about the root it has: nothing
    act(() => result.current.rootChanged('/n'))
    expect(result.current.rootChanges).toBe(1)
  })

  it('a root moved by another request starts over', async () => {
    const { result } = renderHook(() => useGitChanges('%1'))
    await tick()
    act(() => result.current.rootChanged('/n'))
    expect(result.current).toMatchObject({
      root: '/n',
      loaded: false,
      entries: [],
    })
    await tick()
    expect(mockChanges).toHaveBeenLastCalledWith('%1', '/n')
  })

  it('a page shown again mid-poll does not start a second one', async () => {
    let finish!: (v: unknown) => void
    mockChanges.mockReturnValueOnce(new Promise((r) => (finish = r)))
    renderHook(() => useGitChanges('%1'))
    await tick()
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(mockChanges).toHaveBeenCalledTimes(1)
    await act(async () => finish(changes()))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(mockChanges).toHaveBeenCalledTimes(2)
  })

  it('drops the answer to a poll sent for a root that has since moved', async () => {
    let finish!: (v: unknown) => void
    let fail!: (e: unknown) => void
    const { result } = renderHook(() => useGitChanges('%1'))
    await tick()
    mockChanges.mockReturnValueOnce(new Promise((r) => (finish = r)))
    await tick(CHANGES_POLL)
    act(() => result.current.rootChanged('/n'))
    await act(async () => finish(changes({ branch: 'old' })))
    expect(result.current).toMatchObject({ root: '/n', loaded: false })
    // The poll that follows reads the new root; a late failure of the old is dropped too
    mockChanges.mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(mockChanges).toHaveBeenLastCalledWith('%1', '/n')
    act(() => result.current.rootChanged('/m'))
    await act(async () => fail(new Error('offline')))
    expect(result.current.error).toBeUndefined()
    expect(result.current.rootChanges).toBe(2)
  })

  it('shares one poll between readers of a pane', async () => {
    renderHook(() => useGitChanges('%1'))
    renderHook(() => useGitChanges('%1'))
    await tick()
    expect(mockChanges).toHaveBeenCalledTimes(1)
  })
})

describe('findEntry', () => {
  const e = (over: Partial<ChangeEntry>): ChangeEntry => ({
    path: 'a',
    staged: '',
    unstaged: '',
    sensitive: false,
    ...over,
  })
  it('matches the side, the path and a rename source', () => {
    const both = e({ staged: 'M', unstaged: 'M' })
    const staged = e({ path: 'b', staged: 'R', orig: 'o' })
    const conflict = e({ path: 'c', conflict: true })
    const all = [both, staged, conflict]
    expect(findEntry(all, { path: 'a', staged: true })).toBe(both)
    expect(findEntry(all, { path: 'a', staged: false })).toBe(both)
    expect(findEntry(all, { path: 'b', orig: 'o', staged: true })).toBe(staged)
    expect(findEntry(all, { path: 'b', staged: true })).toBeUndefined()
    expect(findEntry(all, { path: 'b', orig: 'o', staged: false })).toBe(
      undefined,
    )
    // A conflict opens its worktree side
    expect(findEntry(all, { path: 'c', staged: false })).toBe(conflict)
  })
})

describe('Changes tabs', () => {
  const e = (path: string, staged: string, unstaged: string): ChangeEntry => ({
    path,
    staged,
    unstaged,
    sensitive: false,
  })
  const ENTRIES = [
    e('a', 'M', 'M'),
    e('b', '', 'M'),
    e('c', '', '?'),
    e('d', 'A', ''),
  ]
  beforeEach(() => {
    mockChanges.mockResolvedValue(changes({ entries: ENTRIES }))
  })

  const side = (path: string, staged = false): ChangeSide => ({
    path,
    staged,
  })
  const keys = (tabs: ChangeSide[]) => tabs.map(changeKey)

  // A draft of path with changes (or none)
  function edit(path: string, changed = true) {
    const d: FileDraft = {
      root: '/r',
      path,
      baseHash: 'h',
      base: 'x',
      crlf: false,
      text: changed ? 'y' : 'x',
      reveal: false,
    }
    renderHook(() => useFileDraft('%1', path)).result.current[1](d)
  }

  async function loaded() {
    const h = renderHook(() => useGitChanges('%1'))
    await tick()
    expect(h.result.current.root).toBe('/r')
    return h
  }

  it('a single click replaces the preview tab; both sides of a file are two tabs', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('a')))
    act(() => result.current.open(side('b')))
    expect(keys(result.current.tabs)).toEqual([changeKey(side('b'))])
    expect(result.current.active).toMatchObject({
      pinned: false,
      root: '/r',
      editing: false,
      revealed: false,
    })
    act(() => result.current.pin(result.current.tabs[0].id))
    act(() => result.current.open(side('a', true), { pin: true }))
    act(() => result.current.open(side('a')))
    expect(keys(result.current.tabs)).toEqual([
      changeKey(side('b')),
      changeKey(side('a', true)),
      changeKey(side('a')),
    ])
    // Open already: its tab shows, nothing new
    act(() => result.current.open(side('b')))
    expect(result.current.active?.path).toBe('b')
    expect(result.current.tabs).toHaveLength(3)
  })

  it('the list shows with every tab open; close shows the tab beside it', async () => {
    const { result } = await loaded()
    for (const p of ['a', 'b', 'c'])
      act(() => result.current.open(side(p), { pin: true }))
    const [, b] = result.current.tabs
    act(() => result.current.activate(null))
    expect(result.current.active).toBeUndefined()
    act(() => result.current.activate(b.id))
    act(() => result.current.close(b.id))
    expect(result.current.active?.path).toBe('c')
    // Unknown: nothing happens
    act(() => result.current.close('nope'))
    act(() => result.current.setEditing('nope', true))
    act(() => result.current.saved('nope'))
    act(() => result.current.setScroll('nope', 1))
    expect(result.current.tabs).toHaveLength(2)
  })

  it('editing pins the tab; Back to the diff keeps the draft', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('b')))
    const id = result.current.activeId as string
    act(() => result.current.setScroll(id, 40))
    act(() => result.current.setEditing(id, true))
    expect(result.current.active).toMatchObject({
      editing: true,
      pinned: true,
      editScrollTop: undefined,
    })
    // The editor's scroll is its own: the diff keeps where it was
    act(() => result.current.setScroll(id, 90))
    edit('b')
    act(() => result.current.setEditing(id, false))
    expect(result.current.active).toMatchObject({
      editing: false,
      scrollTop: 40,
    })
    expect(isDraftDirty('%1', 'b')).toBe(true)
  })

  it('closing an editor drops the draft unless another tab edits the file', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('a'), { pin: true }))
    act(() => result.current.open(side('a', true), { pin: true }))
    const [un, st] = result.current.tabs
    act(() => result.current.setEditing(un.id, true))
    act(() => result.current.setEditing(st.id, true))
    edit('a')
    act(() => result.current.close(st.id))
    expect(isDraftDirty('%1', 'a')).toBe(true)
    act(() => result.current.close(un.id))
    expect(isDraftDirty('%1', 'a')).toBe(false)
    // A diff alone never drops the file's draft (the Files tab may hold it)
    act(() => result.current.open(side('b')))
    edit('b')
    act(() => result.current.close(result.current.tabs[0].id))
    expect(isDraftDirty('%1', 'b')).toBe(true)
  })

  it('past 10 tabs the least recently used clean one closes', async () => {
    mockChanges.mockResolvedValue(
      changes({
        entries: Array.from({ length: 12 }, (_, i) => e(`f${i}`, '', 'M')),
      }),
    )
    const { result } = await loaded()
    for (let i = 0; i < 10; i++)
      act(() => result.current.open(side(`f${i}`), { pin: true }))
    // f0 is edited with changes, f1 was shown again: f2 goes
    act(() => result.current.setEditing(result.current.tabs[0].id, true))
    edit('f0')
    act(() => result.current.activate(result.current.tabs[1].id))
    act(() => result.current.open(side('f10'), { pin: true }))
    const paths = result.current.tabs.map((t) => t.path)
    expect(paths).toHaveLength(10)
    expect(paths).not.toContain('f2')
    expect(paths).toContain('f0')
  })

  it('an editor closed to make room takes its untouched draft along', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('a')))
    // Edited, then back to the preview tab's place: the tab is pinned
    act(() => result.current.setEditing(result.current.tabs[0].id, true))
    edit('a', false)
    act(() => result.current.open(side('b')))
    expect(result.current.tabs).toHaveLength(2)
    for (const p of ['c', 'd'])
      act(() => result.current.open(side(p, p === 'd'), { pin: true }))
    for (let i = 0; i < 7; i++)
      act(() => result.current.open(side(`g${i}`), { pin: true }))
    expect(result.current.tabs.map((t) => t.path)).not.toContain('a')
    expect(
      renderHook(() => useFileDraft('%1', 'a')).result.current[0],
    ).toBeUndefined()
  })

  it('a side git no longer lists closes its tab, unless being edited', async () => {
    const { result } = await loaded()
    for (const p of ['a', 'b', 'c'])
      act(() => result.current.open(side(p), { pin: true }))
    const [a, b] = result.current.tabs
    act(() => result.current.setEditing(b.id, true))
    mockChanges.mockResolvedValue(changes({ entries: [ENTRIES[0]] }))
    await tick(CHANGES_POLL)
    expect(result.current.tabs.map((t) => t.path)).toEqual(['a', 'b'])
    expect(result.current.gone).toEqual({ count: 1, names: ['c'] })
    // Nothing more closes: no second notice
    await tick(CHANGES_POLL)
    expect(result.current.gone.count).toBe(1)
    // The editor left for a diff git no longer lists: it goes
    act(() => result.current.setEditing(b.id, false))
    expect(result.current.tabs.map((t) => t.id)).toEqual([a.id])
    expect(result.current.gone).toEqual({ count: 2, names: ['b'] })
  })

  it('both sides of a file closing at once are one file to tell about', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('a'), { pin: true }))
    act(() => result.current.open(side('a', true), { pin: true }))
    mockChanges.mockResolvedValue(changes({ entries: [ENTRIES[1]] }))
    await tick(CHANGES_POLL)
    expect(result.current.tabs).toEqual([])
    expect(result.current.gone.names).toEqual(['a'])
  })

  it('a save goes back to the diff of what is not staged', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('d', true)))
    const id = result.current.activeId as string
    act(() => result.current.setEditing(id, true))
    act(() => result.current.saved(id))
    // d has no unstaged side yet: kept until the next status says
    expect(result.current.active).toMatchObject({
      id,
      staged: false,
      editing: false,
    })
    act(() => result.current.refresh())
    await tick()
    expect(result.current.tabs).toEqual([])
    expect(result.current.gone.names).toEqual(['d'])
  })

  it('a save shows the unstaged side in the tab it already has', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('a'), { pin: true }))
    act(() => result.current.open(side('a', true), { pin: true }))
    const [un, st] = result.current.tabs
    act(() => result.current.setEditing(st.id, true))
    act(() => result.current.saved(st.id))
    expect(result.current.activeId).toBe(un.id)
    expect(result.current.tabs[1]).toMatchObject({
      staged: true,
      editing: false,
    })
  })

  it('setScroll keeps the offset without telling readers; setReveal does', async () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useGitChanges('%1')
    })
    await tick()
    act(() => result.current.open(side('a')))
    const id = result.current.activeId as string
    const before = renders
    act(() => result.current.setScroll(id, 120))
    expect(renders).toBe(before)
    expect(result.current.active?.scrollTop).toBe(120)
    act(() => result.current.setReveal(id))
    expect(result.current.active?.revealed).toBe(true)
  })

  it('a moved root closes clean tabs and asks about edited ones', async () => {
    const { result } = await loaded()
    for (const p of ['a', 'b', 'c'])
      act(() => result.current.open(side(p), { pin: true }))
    const [, b, c] = result.current.tabs
    act(() => result.current.setEditing(b.id, true))
    act(() => result.current.setEditing(c.id, true))
    edit('b')
    edit('c')
    mockChanges.mockResolvedValue(changes({ root: '/n', entries: [] }))
    act(() => result.current.rootChanged('/n'))
    expect(result.current.tabs.map((t) => t.id)).toEqual([b.id, c.id])
    expect(result.current.pendingRootClose).toEqual([b.id, c.id])
    // Kept: they stay through the next status, with their changes
    act(() => result.current.resolveRootClose(false))
    await tick()
    expect(result.current.tabs).toHaveLength(2)
    expect(isDraftDirty('%1', 'b')).toBe(true)
    // Asked again on the next move, then closed with their changes
    act(() => result.current.rootChanged('/m'))
    expect(result.current.pendingRootClose).toEqual([b.id, c.id])
    act(() => result.current.close(b.id))
    expect(result.current.pendingRootClose).toEqual([c.id])
    act(() => result.current.resolveRootClose(true))
    expect(result.current.tabs).toEqual([])
    expect(isDraftDirty('%1', 'c')).toBe(false)
  })

  it('a kept editor of an old root closes once it goes back to its diff', async () => {
    const { result } = await loaded()
    act(() => result.current.open(side('b'), { pin: true }))
    const id = result.current.activeId as string
    act(() => result.current.setEditing(id, true))
    edit('b')
    mockChanges.mockResolvedValue(changes({ root: '/n', entries: ENTRIES }))
    act(() => result.current.rootChanged('/n'))
    act(() => result.current.resolveRootClose(false))
    await tick()
    act(() => result.current.setEditing(id, false))
    expect(result.current.tabs).toEqual([])
    // Not a side git stopped listing: no notice
    expect(result.current.gone.count).toBe(0)
  })

  it('resolveRootClose with nothing waiting changes nothing', async () => {
    const { result } = renderHook(() => useGitChanges('%1'))
    // Before the first status: a side opened has no root yet
    act(() => result.current.open(side('a')))
    expect(result.current.active?.root).toBe('')
    act(() => result.current.resolveRootClose(true))
    expect(result.current.pendingRootClose).toBeUndefined()
    expect(result.current.tabs).toHaveLength(1)
  })

  it('a tab closed to make room is no longer asked about', async () => {
    mockChanges.mockResolvedValue(
      changes({
        entries: Array.from({ length: 12 }, (_, i) => e(`f${i}`, '', 'M')),
      }),
    )
    const { result } = await loaded()
    act(() => result.current.open(side('f0'), { pin: true }))
    const id = result.current.activeId as string
    act(() => result.current.setEditing(id, true))
    edit('f0')
    act(() => result.current.rootChanged('/n'))
    expect(result.current.pendingRootClose).toEqual([id])
    // Its changes undone meanwhile: a clean tab, closed to make room
    edit('f0', false)
    for (let i = 1; i <= 10; i++)
      act(() => result.current.open(side(`f${i}`), { pin: true }))
    expect(result.current.tabs.map((t) => t.id)).not.toContain(id)
    expect(result.current.pendingRootClose).toBeUndefined()
  })
})

describe('useGitChanges and shifted ids', () => {
  it('a pane id that names another pane now starts again', async () => {
    const a = renderHook(() => useGitChanges('%1'))
    await tick()
    expect(a.result.current.loaded).toBe(true)
    a.unmount()
    remapPanes({ moved: new Map(), stale: new Set(['%1']) })
    const b = renderHook(() => useGitChanges('%1'))
    expect(b.result.current.loaded).toBe(false)
    b.unmount()
  })

  it('a store follows its pane to its new id, polling that one', async () => {
    const a = renderHook(() => useGitChanges('%1'))
    await tick()
    act(() =>
      remapPanes({
        moved: new Map([['%1', '%2']]),
        stale: new Set(['%1', '%2']),
      }),
    )
    const b = renderHook(() => useGitChanges('%2'))
    expect(b.result.current.loaded).toBe(true)
    await tick()
    expect(mockChanges).toHaveBeenLastCalledWith('%2', '/r')
    a.unmount()
    b.unmount()
  })
})
