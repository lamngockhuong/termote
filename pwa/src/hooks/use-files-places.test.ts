import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAll, persistKey } from '../utils/files-persist'
import { setPaneKeys } from '../utils/pane-remap'
import {
  type FileDraft,
  followInFiles,
  followPathInFiles,
  hydrateDrafts,
  isDraftDirty,
  resetFilesStores,
  useFileDraft,
  useFiles,
  usePlaces,
} from './use-files'
import { type MuxSnapshot, RequestError } from './use-mux-api'

const mockTree = vi.fn()
const mockPlaces = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
  fetchPlaces: () => mockPlaces(),
}))

const PANE = '/home/kim/app'
const NOTES = '/home/kim/notes'
const tree = (root: string, names: string[] = ['a.md']) => ({
  root,
  isRepo: false,
  path: '',
  entries: names.map((name) => ({
    name,
    type: 'file' as const,
    size: 1,
    sensitive: false,
  })),
  truncated: false,
})
const moved = (root: string) =>
  Object.assign(new RequestError(409, '', 'root changed'), { root })

// The server: the pane's folder without place, notes with place=n1; a
// request whose root query is another answers 409 with the right one
function serve() {
  mockTree.mockImplementation(
    async (t: { place?: string }, _path: string, seen?: string) => {
      const root = t.place === 'n1' ? NOTES : PANE
      if (t.place && t.place !== 'n1')
        throw new RequestError(404, 'unknown_place', 'no such place')
      if (seen && seen !== root) throw moved(root)
      return tree(root)
    },
  )
}

const draft = (root: string, path: string, text = 'mine'): FileDraft => ({
  root,
  path,
  baseHash: 'h',
  base: 'old',
  crlf: false,
  text,
  reveal: false,
})

const snapshot = () =>
  setPaneKeys(
    {
      instanceId: 'i1',
      groups: [{ id: '$0', name: 'main', tabs: [{ id: '%1', panes: [] }] }],
    } as unknown as MuxSnapshot,
    new Map([['%1', '@1']]),
  )

beforeEach(() => {
  localStorage.clear()
  resetFilesStores()
  snapshot()
  mockTree.mockReset()
  mockPlaces.mockReset()
  serve()
})

async function loaded() {
  const h = renderHook(() => useFiles('%1'))
  act(() => h.result.current.load())
  await waitFor(() => expect(h.result.current.root).toBe(PANE))
  return h
}

describe('Places in the files store', () => {
  it('switching shows the Place: clean tabs of the old root close', async () => {
    const h = await loaded()
    act(() => h.result.current.open('a.md'))
    expect(h.result.current.tabs).toHaveLength(1)
    act(() => h.result.current.openPlace('n1'))
    await waitFor(() => expect(h.result.current.root).toBe(NOTES))
    expect(h.result.current.place).toBe('n1')
    expect(h.result.current.target).toEqual({ paneId: '%1', place: 'n1' })
    expect(h.result.current.tabs).toEqual([])
    expect(h.result.current.dirs['']?.entries).toHaveLength(1)
    expect(mockTree).toHaveBeenLastCalledWith(
      { paneId: '%1', place: 'n1' },
      '',
      NOTES,
    )
    // Back to the pane's folder
    act(() => h.result.current.openPlace(undefined))
    await waitFor(() => expect(h.result.current.root).toBe(PANE))
    expect(h.result.current.place).toBeUndefined()
  })

  it('a tab with unsaved changes is asked about, not closed', async () => {
    const h = await loaded()
    act(() => h.result.current.open('a.md'))
    renderHook(() => useFileDraft('%1', PANE, 'a.md')).result.current[1](
      draft(PANE, 'a.md'),
    )
    act(() => h.result.current.openPlace('n1'))
    await waitFor(() => expect(h.result.current.root).toBe(NOTES))
    expect(h.result.current.pendingRootClose).toHaveLength(1)
  })

  it('a Place gone answers 404: back to the pane folder, said once', async () => {
    const h = await loaded()
    act(() => h.result.current.openPlace('gone'))
    await waitFor(() => expect(h.result.current.placeLost).toBe(1))
    await waitFor(() => expect(h.result.current.place).toBeUndefined())
    await waitFor(() => expect(h.result.current.root).toBe(PANE))
  })

  it('a view-only client refused a Place goes back to the pane folder', async () => {
    const h = await loaded()
    mockTree.mockImplementation(
      async (t: { place?: string }, _path: string, seen?: string) => {
        if (t.place) throw new RequestError(403, 'view_only', 'view only')
        if (seen && seen !== PANE) throw moved(PANE)
        return tree(PANE)
      },
    )
    act(() => h.result.current.openPlace('n1'))
    await waitFor(() => expect(h.result.current.placeLost).toBe(1))
    await waitFor(() => expect(h.result.current.place).toBeUndefined())
    expect(h.result.current.root).toBe(PANE)
    expect(h.result.current.dirs['']?.error).toBeUndefined()
  })

  it('the Place is kept with the tabs and read first when the app opens', async () => {
    const h = await loaded()
    act(() => h.result.current.openPlace('n1'))
    await waitFor(() => expect(h.result.current.root).toBe(NOTES))
    flushAll()
    const kept = JSON.parse(
      localStorage.getItem(persistKey('files', '%1') as string) as string,
    )
    expect(kept.state).toMatchObject({ place: 'n1', root: NOTES })
    h.unmount()

    resetFilesStores()
    mockTree.mockClear()
    const again = renderHook(() => useFiles('%1'))
    act(() => again.result.current.load())
    await waitFor(() => expect(again.result.current.root).toBe(NOTES))
    expect(mockTree.mock.calls[0]).toEqual([
      { paneId: '%1', place: 'n1' },
      '',
      NOTES,
    ])
  })

  it('a root found by a search opens its Place', async () => {
    mockPlaces.mockResolvedValue([{ id: 'n1', name: 'notes', path: NOTES }])
    const places = renderHook(() => usePlaces(true))
    await waitFor(() => expect(places.result.current).toHaveLength(1))
    const h = await loaded()
    act(() => h.result.current.openFromFind(NOTES, 'a.md'))
    expect(h.result.current.place).toBe('n1')
    expect(h.result.current.root).toBe(NOTES)
    expect(h.result.current.active?.path).toBe('a.md')
    expect(h.result.current.active?.root).toBe(NOTES)
    // Another root is the pane's own
    act(() => h.result.current.openFromFind(PANE, 'a.md'))
    expect(h.result.current.place).toBeUndefined()
  })

  it('usePlaces reads nothing when disabled, and once otherwise', async () => {
    mockPlaces.mockResolvedValue([{ id: 'n1', name: 'notes', path: NOTES }])
    const off = renderHook(() => usePlaces(false))
    expect(off.result.current).toEqual([])
    expect(mockPlaces).not.toHaveBeenCalled()
    renderHook(() => usePlaces(true))
    const second = renderHook(() => usePlaces(true))
    await waitFor(() => expect(second.result.current).toHaveLength(1))
    expect(mockPlaces).toHaveBeenCalledTimes(1)
  })

  it('a failed read of the Places is tried again by the next view', async () => {
    mockPlaces.mockRejectedValueOnce(new Error('offline'))
    renderHook(() => usePlaces(true))
    await waitFor(() => expect(mockPlaces).toHaveBeenCalledTimes(1))
    await act(async () => {})
    mockPlaces.mockResolvedValue([])
    renderHook(() => usePlaces(true))
    await waitFor(() => expect(mockPlaces).toHaveBeenCalledTimes(2))
  })

  it('a link of a Place opens it; a pane path leaves the Place', async () => {
    const h = await loaded()
    await act(async () => {
      await followInFiles('%1', { path: 'a.md' }, 'n1')
    })
    expect(h.result.current.place).toBe('n1')
    expect(h.result.current.root).toBe(NOTES)
    expect(h.result.current.active?.path).toBe('a.md')
    await act(async () => {
      await followInFiles('%1', { path: 'a.md' })
    })
    expect(h.result.current.place).toBeUndefined()
    expect(h.result.current.root).toBe(PANE)
  })
})

describe('a path the agent wrote', () => {
  it('opens in the pane folder, leaving a Place shown', async () => {
    const h = await loaded()
    act(() => h.result.current.openPlace('n1'))
    await waitFor(() => expect(h.result.current.root).toBe(NOTES))
    await act(async () => {
      await followPathInFiles('%1', `${PANE}/a.md`)
    })
    expect(h.result.current.place).toBeUndefined()
    expect(h.result.current.root).toBe(PANE)
    expect(h.result.current.active).toMatchObject({ root: PANE, path: 'a.md' })
  })
})

describe('drafts by root', () => {
  it('one path under the pane folder and a Place keeps two drafts', () => {
    const pane = renderHook(() => useFileDraft('%1', PANE, 'a.md'))
    const place = renderHook(() => useFileDraft('%1', NOTES, 'a.md'))
    act(() => pane.result.current[1](draft(PANE, 'a.md', 'pane text')))
    act(() => place.result.current[1](draft(NOTES, 'a.md', 'notes text')))
    expect(pane.result.current[0]?.text).toBe('pane text')
    expect(place.result.current[0]?.text).toBe('notes text')
    // Dropping one never drops the other
    act(() => pane.result.current[1](undefined))
    expect(isDraftDirty('%1', PANE, 'a.md')).toBe(false)
    expect(isDraftDirty('%1', NOTES, 'a.md')).toBe(true)
  })

  it('a draft kept by a version before Places comes back, under its root', () => {
    const old = persistKey('drafts', '%1', 'a.md') as string
    localStorage.setItem(
      old,
      JSON.stringify({
        v: 1,
        pane: '@1',
        group: 'main',
        editedAt: Date.now(),
        role: 'full',
        draft: { ...draft(PANE, 'a.md', 'unsaved'), reveal: undefined },
      }),
    )
    hydrateDrafts(['%1'])
    const d = renderHook(() => useFileDraft('%1', PANE, 'a.md'))
    expect(d.result.current[0]?.text).toBe('unsaved')
    // Moved to the key with its root
    expect(localStorage.getItem(old)).toBeNull()
    expect(
      localStorage.getItem(
        persistKey('drafts', '%1', `${PANE}\u0000a.md`) as string,
      ),
    ).not.toBeNull()
  })

  it('a draft from before Places that cannot be written again stays in memory, asked about', () => {
    const old = persistKey('drafts', '%1', 'b.md') as string
    localStorage.setItem(
      old,
      JSON.stringify({
        v: 1,
        pane: '@1',
        group: 'main',
        editedAt: Date.now(),
        role: 'full',
        draft: { ...draft(PANE, 'b.md', 'unsaved'), reveal: undefined },
      }),
    )
    const write = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    try {
      hydrateDrafts(['%1'])
    } finally {
      write.mockRestore()
    }
    const d = renderHook(() => useFileDraft('%1', PANE, 'b.md'))
    expect(d.result.current[0]?.text).toBe('unsaved')
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})
