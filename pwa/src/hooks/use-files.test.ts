import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeOp, redoOp, type TableOp, undoOp } from '../utils/csv-edits'
import { parseCsv } from '../utils/csv-parse'
import { flushAll, signedOut } from '../utils/files-persist'
import { remapPanes, setPaneKeys } from '../utils/pane-remap'
import { emptyLayout } from '../utils/table-columns'
import {
  dropDraft,
  type FileDraft,
  fileRenamed,
  filesError,
  followInFiles,
  hasDirtyDraftAt,
  hydrateDrafts,
  isDraftDirty,
  isOpenable,
  peekFilesState,
  requestFilesFocus,
  resetFilesStores,
  useDirtyCheck,
  useFileDraft,
  useFiles,
  useFilesFocusRequest,
} from './use-files'
import { type FileEntry, type MuxSnapshot, RequestError } from './use-mux-api'

const mockTree = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
}))

const file = (name: string): FileEntry => ({
  name,
  type: 'file',
  size: 1,
  sensitive: false,
})
const dir = (name: string): FileEntry => ({ ...file(name), type: 'dir' })
const tree = (path: string, entries: FileEntry[], root = '/r') => ({
  root,
  isRepo: true,
  path,
  entries,
  truncated: false,
})

beforeEach(() => {
  resetFilesStores()
  mockTree.mockReset()
})

describe('filesError', () => {
  it.each([
    [new RequestError(501, '', 'x'), 'unsupported'],
    [new RequestError(404, '', 'x'), 'not-found'],
    [new RequestError(403, '', 'x'), 'not-allowed'],
    [new RequestError(403, 'view_only', 'x'), 'view-only'],
    [new RequestError(500, '', 'x'), 'unavailable'],
    [new Error('offline'), 'unavailable'],
  ])('%s is %s', (err, want) => {
    expect(filesError(err)).toBe(want)
  })
})

describe('peekFilesState', () => {
  it('reads a store without making one', () => {
    expect(peekFilesState('%9')).toBeNull()
    renderHook(() => useFiles('%9'))
    expect(peekFilesState('%9')?.tabs).toEqual([])
  })
})

describe('useFiles', () => {
  it('reads the root once, then each directory as it opens', async () => {
    mockTree.mockImplementation(async (_p, path) =>
      path === '' ? tree('', [dir('src'), file('a')]) : tree(path, [file('b')]),
    )
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    act(() => result.current.load())
    await waitFor(() =>
      expect(result.current.dirs['']?.entries).toHaveLength(2),
    )
    expect(result.current.root).toBe('/r')
    expect(result.current.isRepo).toBe(true)
    // The first read does not know the root yet
    expect(mockTree).toHaveBeenCalledTimes(1)
    expect(mockTree).toHaveBeenCalledWith('%1', '', undefined)

    act(() => result.current.toggle('src'))
    expect(result.current.expanded.src).toBe(true)
    expect(result.current.dirs.src.loading).toBe(true)
    await waitFor(() => expect(result.current.dirs.src.entries).toHaveLength(1))
    expect(mockTree).toHaveBeenLastCalledWith('%1', 'src', '/r')

    // Closed and opened again: read already
    act(() => result.current.toggle('src'))
    expect(result.current.expanded.src).toBeUndefined()
    act(() => result.current.toggle('src'))
    expect(mockTree).toHaveBeenCalledTimes(2)
  })

  it('keeps one store per pane', async () => {
    mockTree.mockResolvedValue(tree('', []))
    const a = renderHook(() => useFiles('%1'))
    act(() => a.result.current.open('x'))
    const b = renderHook(() => useFiles('%1'))
    expect(b.result.current.active?.path).toBe('x')
    const c = renderHook(() => useFiles('%2'))
    expect(c.result.current.active).toBeUndefined()
    a.unmount()
  })

  it('a directory that fails closes and is read again on the next open', async () => {
    mockTree
      .mockResolvedValueOnce(tree('', [dir('d')]))
      .mockRejectedValueOnce(new RequestError(403, '', 'path not allowed'))
      .mockResolvedValueOnce(tree('d', [file('x')]))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs['']?.entries).toBeDefined())
    act(() => result.current.toggle('d'))
    await waitFor(() => expect(result.current.dirs.d.error).toBe('not-allowed'))
    expect(result.current.expanded.d).toBeUndefined()
    act(() => result.current.toggle('d'))
    await waitFor(() => expect(result.current.dirs.d.entries).toHaveLength(1))
    expect(result.current.dirs.d.error).toBeUndefined()
  })

  it('a root that fails stays failed until refreshed', async () => {
    mockTree
      .mockRejectedValueOnce(new RequestError(501, '', 'not supported'))
      .mockResolvedValueOnce(tree('', []))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() =>
      expect(result.current.dirs[''].error).toBe('unsupported'),
    )
    act(() => result.current.load())
    expect(mockTree).toHaveBeenCalledTimes(1)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.dirs[''].entries).toEqual([]))
  })

  it('refresh reads the root and every open directory again, keeping what is shown', async () => {
    mockTree.mockImplementation(async (_p, path) =>
      path === '' ? tree('', [dir('src')]) : tree(path, [file('b')]),
    )
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs['']?.entries).toBeDefined())
    act(() => result.current.toggle('src'))
    await waitFor(() => expect(result.current.dirs.src.entries).toBeDefined())
    mockTree.mockClear()
    act(() => result.current.refresh())
    expect(result.current.dirs.src.entries).toHaveLength(1)
    expect(result.current.dirs.src.loading).toBe(true)
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(['', 'src'])
    await waitFor(() => expect(result.current.dirs.src.loading).toBe(false))
  })

  it('a moved root restarts the tree from the new one', async () => {
    mockTree
      .mockResolvedValueOnce(tree('', [dir('src')]))
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', { root: '/n' }),
      )
      .mockResolvedValueOnce(tree('', [file('n')], '/n'))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs['']?.entries).toBeDefined())
    act(() => result.current.open('README.md'))
    act(() => result.current.toggle('src'))
    await waitFor(() => expect(result.current.root).toBe('/n'))
    expect(result.current.rootChanges).toBe(1)
    expect(result.current.expanded).toEqual({})
    // The file opened under the old root closes: nothing unsaved in it
    expect(result.current.tabs).toEqual([])
    await waitFor(() =>
      expect(result.current.dirs[''].entries).toEqual([file('n')]),
    )
    expect(mockTree).toHaveBeenLastCalledWith('%1', '', '/n')
    // Told again about the same root: nothing to do
    act(() => result.current.rootChanged('/n'))
    expect(result.current.rootChanges).toBe(1)
  })

  it('drops a read sent for a root that has since moved', async () => {
    let finish!: (v: unknown) => void
    mockTree
      .mockResolvedValueOnce(tree('', [dir('src')]))
      .mockImplementationOnce(() => new Promise((r) => (finish = r)))
      .mockResolvedValueOnce(tree('', [], '/n'))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs['']?.entries).toBeDefined())
    act(() => result.current.toggle('src'))
    act(() => result.current.rootChanged('/n'))
    await waitFor(() => expect(result.current.dirs[''].entries).toEqual([]))
    await act(async () => finish(tree('src', [file('old')])))
    expect(result.current.dirs.src).toBeUndefined()
    expect(result.current.root).toBe('/n')
  })

  it('drops a failure of a read sent for a root that has since moved', async () => {
    let fail!: (e: unknown) => void
    mockTree
      .mockResolvedValueOnce(tree('', [dir('src')]))
      .mockImplementationOnce(() => new Promise((_, r) => (fail = r)))
      .mockResolvedValueOnce(tree('', [], '/n'))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs['']?.entries).toBeDefined())
    act(() => result.current.toggle('src'))
    act(() => result.current.rootChanged('/n'))
    await act(async () => fail(new Error('offline')))
    expect(result.current.dirs.src).toBeUndefined()
  })
})

describe('isOpenable', () => {
  it('files, directories and symlinks to them', () => {
    expect(isOpenable(file('a'))).toBe(true)
    expect(isOpenable(dir('a'))).toBe(true)
    expect(isOpenable({ ...file('a'), type: 'symlink', target: 'file' })).toBe(
      true,
    )
    expect(isOpenable({ ...file('a'), type: 'symlink' })).toBe(false)
    expect(isOpenable({ ...file('a'), type: 'other' })).toBe(false)
  })
})

describe('following links', () => {
  const listing: Record<string, FileEntry[]> = {
    '': [dir('docs'), file('README.md'), { ...file('dev'), type: 'other' }],
    docs: [file('guide.md'), dir('img')],
    'docs/img': [file('a.png')],
  }
  beforeEach(() => {
    mockTree.mockImplementation(async (_p, path: string, root?: string) => {
      if (!listing[path]) throw new RequestError(404, '', 'x')
      return tree(path, listing[path], root ?? '/r')
    })
  })

  it('opens a file, then Back returns to the one before with its offset', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    let r = ''
    await act(async () => {
      r = await result.current.follow(
        { path: 'docs/guide.md', anchor: 'usage' },
        120,
      )
    })
    expect(r).toBe('opened')
    expect(mockTree).toHaveBeenLastCalledWith('%1', 'docs', undefined)
    expect(result.current.active?.path).toBe('docs/guide.md')
    expect(result.current.active?.anchor).toBe('usage')
    expect(result.current.active?.history).toEqual([
      { path: 'README.md', scrollTop: 120 },
    ])

    act(() => result.current.back())
    expect(result.current.active?.path).toBe('README.md')
    expect(result.current.active?.scrollTop).toBe(120)
    expect(result.current.active?.anchor).toBeUndefined()
    expect(result.current.active?.history).toEqual([])

    act(() => result.current.back())
    expect(result.current.active).toBeUndefined()
  })

  it('opening from the tree starts a new trail', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 0))
    act(() => result.current.open('README.md'))
    expect(result.current.active?.history).toEqual([])
  })

  it('a directory shows in the tree, opened with every parent', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.dirs[''].entries).toBeDefined())
    act(() => result.current.open('README.md'))
    let r = ''
    await act(async () => {
      r = await result.current.follow({ path: 'docs/img' }, 0)
    })
    expect(r).toBe('opened')
    expect(result.current.active).toBeUndefined()
    expect(result.current.expanded).toEqual({ docs: true, 'docs/img': true })
    await waitFor(() =>
      expect(result.current.dirs['docs/img'].entries).toHaveLength(1),
    )
  })

  it('the root itself closes the file', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: '' }, 0))
    expect(result.current.active).toBeUndefined()
    expect(mockTree).not.toHaveBeenCalled()
  })

  it.each([
    ['docs/missing.md', 'missing'],
    ['nodir/a.md', 'missing'],
    ['dev', 'failed'],
  ])('%s is %s', async (path, want) => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    let r = ''
    await act(async () => {
      r = await result.current.follow({ path }, 0)
    })
    expect(r).toBe(want)
    expect(result.current.active?.path).toBe('README.md')
  })

  it('a directory that cannot be read fails', async () => {
    mockTree.mockRejectedValue(new RequestError(403, '', 'x'))
    const { result } = renderHook(() => useFiles('%1'))
    let r = ''
    await act(async () => {
      r = await result.current.follow({ path: 'docs/a.md' }, 0)
    })
    expect(r).toBe('failed')
  })

  // A read of docs that answers when told to
  function held() {
    let answer: (v: unknown) => void = () => {}
    mockTree.mockReturnValueOnce(
      new Promise((res) => {
        answer = res
      }),
    )
    return (root = '/r') => answer(tree('docs', listing.docs, root))
  }

  it('tries once more when the root moves under the read', async () => {
    const answer = held()
    const { result } = renderHook(() => useFiles('%1'))
    let pending: Promise<string> = Promise.resolve('')
    act(() => {
      pending = result.current.follow({ path: 'docs/guide.md' }, 0)
    })
    act(() => result.current.rootChanged('/new'))
    answer()
    let r = ''
    await act(async () => {
      r = await pending
    })
    expect(r).toBe('opened')
    expect(mockTree).toHaveBeenLastCalledWith('%1', 'docs', '/new')
    expect(result.current.active?.path).toBe('docs/guide.md')
  })

  it('gives up when the root moves again', async () => {
    const first = held()
    const { result } = renderHook(() => useFiles('%1'))
    let pending: Promise<string> = Promise.resolve('')
    act(() => {
      pending = result.current.follow({ path: 'docs/guide.md' }, 0)
    })
    act(() => result.current.rootChanged('/new'))
    // The second try's read
    const second = held()
    await act(async () => first())
    act(() => result.current.rootChanged('/newer'))
    second('/new')
    let r = ''
    await act(async () => {
      r = await pending
    })
    expect(r).toBe('stale')
    expect(result.current.active).toBeUndefined()
  })

  it('a second tap on a link while it opens counts once', async () => {
    const first = held()
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    const results: Promise<string>[] = []
    act(() => {
      results.push(result.current.follow({ path: 'docs/guide.md' }, 5))
      results.push(result.current.follow({ path: 'docs/guide.md' }, 5))
    })
    await act(async () => {
      first()
      await Promise.all(results)
    })
    expect(await Promise.all(results)).toEqual(['stale', 'opened'])
    expect(result.current.active?.path).toBe('docs/guide.md')
    expect(result.current.active?.history).toEqual([
      { path: 'README.md', scrollTop: 5 },
    ])
  })

  it('Back while a link opens drops the link', async () => {
    const answer = held()
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    let pending: Promise<string> = Promise.resolve('')
    act(() => {
      pending = result.current.follow({ path: 'docs/guide.md' }, 0)
    })
    act(() => result.current.back())
    answer()
    let r = ''
    await act(async () => {
      r = await pending
    })
    expect(r).toBe('stale')
    expect(result.current.active).toBeUndefined()
  })

  it('followInFiles reaches the pane store from elsewhere', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(async () => {
      expect(await followInFiles('%1', { path: 'docs/guide.md' })).toBe(
        'opened',
      )
    })
    expect(result.current.active?.path).toBe('docs/guide.md')
    // Nothing was open: no step back
    expect(result.current.active?.history).toEqual([])
  })

  it('followInFiles starts a new trail: Back goes to the tree', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: 'docs/img/a.png' }, 0))
    await act(() => followInFiles('%1', { path: 'docs/guide.md' }))
    expect(result.current.active?.path).toBe('docs/guide.md')
    expect(result.current.active?.history).toEqual([])
  })
})

describe('a created file', () => {
  // The directories x and x/y were just made, holding z.md
  const listing: Record<string, FileEntry[]> = {
    '': [dir('x'), dir('docs'), file('a.md')],
    x: [dir('y')],
    'x/y': [file('z.md')],
    docs: [],
  }
  beforeEach(() => {
    mockTree.mockImplementation(async (_p, path: string) =>
      tree(path, listing[path]),
    )
  })

  it('opens into editing, the tree read again and opened down to it', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.root).toBe('/r'))
    mockTree.mockClear()
    await act(() => result.current.created('x/y/z.md', '/r', false))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(['', 'x', 'x/y'])
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
    expect(result.current.dirs['x/y'].entries).toEqual([file('z.md')])
    expect(result.current.active).toMatchObject({
      path: 'x/y/z.md',
      root: '/r',
      pinned: true,
      intent: true,
      reveal: false,
    })
    // Back: the tree shows where it went, the tab stays open
    act(() => result.current.back())
    expect(result.current.active).toBeUndefined()
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
    // Editing started: the intent is used up
    act(() => result.current.pin(result.current.tabs[0].id))
    expect(result.current.tabs[0].intent).toBeUndefined()
  })

  it('at the root, with the reveal it was made with', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('a.md', '/r', true))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual([''])
    expect(result.current.expanded).toEqual({})
    expect(result.current.active).toMatchObject({
      path: 'a.md',
      intent: true,
      reveal: true,
    })
  })

  it('a directory found there shows in the tree, opened', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('docs', '/r', false))
    expect(result.current.active).toBeUndefined()
    expect(result.current.tabs).toEqual([])
    expect(result.current.expanded).toEqual({ docs: true })
    await waitFor(() => expect(result.current.dirs.docs.entries).toEqual([]))
  })

  it('the intent goes once a link opens in its tab', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('a.md', '/r', false))
    // Another file opens in another tab: this one keeps its intent
    act(() => result.current.open('x/y/z.md'))
    expect(result.current.tabs.map((t) => [t.path, t.intent])).toEqual([
      ['a.md', true],
      ['x/y/z.md', undefined],
    ])
    act(() => result.current.activate(result.current.tabs[0].id))
    await act(() => result.current.follow({ path: 'x/y/z.md' }, 0))
    // z.md has a tab: shown there, a.md's tab is left as it was
    expect(result.current.active?.path).toBe('x/y/z.md')
    expect(result.current.tabs[0].intent).toBe(true)
  })

  it('a link of the created file drops the intent', async () => {
    listing['x/y'] = [file('z.md'), file('w.md')]
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('a.md', '/r', false))
    await act(() => result.current.follow({ path: 'x/y/w.md' }, 0))
    expect(result.current.active).toMatchObject({ path: 'x/y/w.md' })
    expect(result.current.active?.intent).toBeUndefined()
    listing['x/y'] = [file('z.md')]
  })

  it('opens nothing when the root moves or another file opens meanwhile', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    let finish!: () => void
    const real = mockTree.getMockImplementation()!
    mockTree.mockImplementationOnce(
      (...a: [string, string]) =>
        new Promise((r) => (finish = () => r(real(...a)))),
    )
    let done!: Promise<void>
    act(() => {
      done = result.current.created('a.md', '/r', false)
    })
    act(() => result.current.rootChanged('/n'))
    await act(async () => {
      finish()
      await done
    })
    expect(result.current.active).toBeUndefined()

    mockTree.mockImplementationOnce(
      (...a: [string, string]) =>
        new Promise((r) => (finish = () => r(real(...a)))),
    )
    act(() => {
      done = result.current.created('a.md', '/n', false)
    })
    act(() => result.current.open('x/y/z.md'))
    await act(async () => {
      finish()
      await done
    })
    expect(result.current.active?.path).toBe('x/y/z.md')
    expect(result.current.tabs).toHaveLength(1)
  })
})

describe('tabs', () => {
  const listing: Record<string, FileEntry[]> = {
    '': [dir('docs'), file('a.md'), file('b.md'), file('c.md')],
    docs: [file('guide.md'), file('a.md')],
  }
  beforeEach(() => {
    mockTree.mockImplementation(async (_p, path: string, root?: string) =>
      tree(path, listing[path] ?? [], root ?? '/r'),
    )
  })

  const paths = (tabs: { path: string }[]) => tabs.map((t) => t.path)

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
    const h = renderHook(() => useFiles('%1'))
    act(() => h.result.current.load())
    await waitFor(() => expect(h.result.current.root).toBe('/r'))
    return h
  }

  it('a single click replaces the preview tab; a pinned one stays', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    act(() => result.current.open('b.md'))
    expect(paths(result.current.tabs)).toEqual(['b.md'])
    expect(result.current.active).toMatchObject({ pinned: false, root: '/r' })
    act(() => result.current.pin(result.current.tabs[0].id))
    act(() => result.current.open('c.md'))
    act(() => result.current.open('a.md', { pin: true }))
    expect(paths(result.current.tabs)).toEqual(['b.md', 'c.md', 'a.md'])
    expect(result.current.tabs.map((t) => t.pinned)).toEqual([
      true,
      false,
      true,
    ])
    // Open already: its tab shows, nothing new
    act(() => result.current.open('b.md'))
    expect(result.current.active?.path).toBe('b.md')
    expect(result.current.tabs).toHaveLength(3)
  })

  it('the tree shows with every tab still open; a tab shows again', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    const id = result.current.activeId as string
    act(() => result.current.activate(null))
    expect(result.current.active).toBeUndefined()
    expect(result.current.tabs).toHaveLength(1)
    act(() => result.current.activate(id))
    expect(result.current.active?.path).toBe('a.md')
  })

  it('close shows the tab beside it and drops the draft', async () => {
    const { result } = await loaded()
    for (const p of ['a.md', 'b.md', 'c.md'])
      act(() => result.current.open(p, { pin: true }))
    edit('b.md')
    // Changes' editor of the same file reads the same draft
    const changes = renderHook(() => useFileDraft('%1', 'b.md'))
    expect(changes.result.current[0]?.text).toBe('y')
    const [, b] = result.current.tabs
    act(() => result.current.activate(b.id))
    act(() => result.current.close(b.id))
    expect(paths(result.current.tabs)).toEqual(['a.md', 'c.md'])
    expect(result.current.active?.path).toBe('c.md')
    expect(isDraftDirty('%1', 'b.md')).toBe(false)
    // Closing the tab dropped it there too (the close asked first)
    expect(changes.result.current[0]).toBeUndefined()
    // Unknown: nothing happens
    act(() => result.current.close('nope'))
    expect(result.current.tabs).toHaveLength(2)
  })

  it('past 10 tabs the least recently used clean one closes', async () => {
    const { result } = await loaded()
    for (let i = 0; i < 10; i++)
      act(() => result.current.open(`f${i}`, { pin: true }))
    // f0 has changes, f1 was shown again: f2 goes
    edit('f0')
    act(() => result.current.activate(result.current.tabs[1].id))
    act(() => result.current.open('extra', { pin: true }))
    expect(result.current.tabs).toHaveLength(10)
    expect(paths(result.current.tabs)).not.toContain('f2')
    expect(paths(result.current.tabs)).toContain('f0')
  })

  it('a tab closed to make room takes its untouched draft along', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    edit('a.md', false)
    // The preview tab is replaced by another file
    act(() => result.current.open('b.md'))
    expect(
      renderHook(() => useFileDraft('%1', 'a.md')).result.current[0],
    ).toBeUndefined()
  })

  it('a preview tab with unsaved changes is kept as a tab of its own', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    edit('a.md')
    act(() => result.current.open('b.md'))
    expect(result.current.tabs.map((t) => [t.path, t.pinned])).toEqual([
      ['a.md', true],
      ['b.md', false],
    ])
  })

  it('a link goes on in the same tab; Back returns there', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    act(() => result.current.setReveal(result.current.activeId as string))
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 40))
    expect(result.current.tabs).toHaveLength(1)
    expect(result.current.active).toMatchObject({
      path: 'docs/guide.md',
      // A Show never carries over to another path
      reveal: false,
      history: [{ path: 'a.md', scrollTop: 40 }],
    })
    act(() => result.current.setReveal(result.current.activeId as string))
    act(() => result.current.back())
    expect(result.current.active).toMatchObject({
      path: 'a.md',
      scrollTop: 40,
      reveal: false,
    })
  })

  it('a link to a file open in another tab shows that tab', async () => {
    const { result } = await loaded()
    act(() => result.current.open('docs/guide.md', { pin: true }))
    const guide = result.current.activeId
    act(() => result.current.open('a.md', { pin: true }))
    await act(() =>
      result.current.follow({ path: 'docs/guide.md', anchor: 'x' }, 9),
    )
    expect(result.current.activeId).toBe(guide)
    expect(result.current.active?.anchor).toBe('x')
    // No step back pushed to either tab
    expect(result.current.tabs.map((t) => t.history)).toEqual([[], []])
  })

  it('a link to the file itself stays in its tab without a step back', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    await act(() => result.current.follow({ path: 'a.md', anchor: 'y' }, 3))
    expect(result.current.active).toMatchObject({ anchor: 'y', history: [] })
  })

  it('newTab opens the link in a new pinned tab', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    await act(() =>
      result.current.follow({ path: 'docs/guide.md' }, 0, { newTab: true }),
    )
    expect(paths(result.current.tabs)).toEqual(['a.md', 'docs/guide.md'])
    expect(result.current.active).toMatchObject({ pinned: true, history: [] })
  })

  it('Back to a file that has its own tab now shows that tab', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 0))
    act(() => result.current.open('a.md', { pin: true }))
    const a = result.current.activeId
    act(() => result.current.activate(result.current.tabs[0].id))
    act(() => result.current.back())
    expect(result.current.activeId).toBe(a)
    // The tab gone back from stays, one step less to go back
    expect(paths(result.current.tabs)).toEqual(['docs/guide.md', 'a.md'])
    expect(result.current.tabs[0].history).toEqual([])
    // Nothing shown: Back does nothing
    act(() => result.current.activate(null))
    act(() => result.current.back())
    expect(result.current.active).toBeUndefined()
  })

  it('opens at a line: a new tab, an open one, the same line again', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.ts', { line: 12, col: 4 }))
    const first = result.current.active
    expect(first).toMatchObject({ line: 12, col: 4, scrollTop: undefined })
    expect(first?.jump).toBeGreaterThan(0)
    // The same line again moves there again
    act(() => result.current.open('a.ts', { line: 12, col: 4 }))
    expect(result.current.active?.jump).toBeGreaterThan(first?.jump as number)
    // A tab scrolled by the user drops the line, keeps where it is
    result.current.setScroll(result.current.activeId as string, 30)
    expect(result.current.tabs[0]).toMatchObject({
      line: undefined,
      col: undefined,
      scrollTop: 30,
    })
    // An open tab goes to the line asked for, its offset dropped
    act(() => result.current.open('a.ts', { line: 3 }))
    expect(result.current.active).toMatchObject({
      line: 3,
      scrollTop: undefined,
      anchor: undefined,
    })
    // A link followed in the tab, and Back, start without it
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 0))
    expect(result.current.active?.line).toBeUndefined()
    act(() => result.current.open('docs/guide.md', { line: 5 }))
    act(() => result.current.back())
    expect(result.current.active).toMatchObject({
      path: 'a.ts',
      line: undefined,
    })
  })

  it('setScroll keeps the offset without telling readers', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { anchor: 'usage' }))
    const before = result.current
    result.current.setScroll(result.current.activeId as string, 77)
    result.current.setScroll('nope', 1)
    expect(result.current).toBe(before)
    // The offset wins over the heading it opened at
    expect(result.current.tabs[0]).toMatchObject({
      scrollTop: 77,
      anchor: undefined,
    })
  })

  it('setTableLayout keeps a table layout until the tab shows another path', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.csv', { pin: true }))
    const id = result.current.activeId as string
    const layout = { key: ',|1', widths: { 0: 40 }, wrapped: [1] }
    const before = result.current
    result.current.setTableLayout(id, layout)
    result.current.setTableLayout('nope', layout)
    expect(result.current).toBe(before)
    expect(result.current.tabs[0].table).toBe(layout)
    // A link followed in the tab starts over, and so does Back
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 0))
    expect(result.current.active?.table).toBeUndefined()
    result.current.setTableLayout(id, layout)
    act(() => result.current.back())
    expect(result.current.active).toMatchObject({
      path: 'a.csv',
      table: undefined,
    })
  })

  it('a Show is kept by its own tab only', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    act(() => result.current.open('b.md', { pin: true }))
    act(() => result.current.setReveal(result.current.tabs[1].id))
    expect(result.current.tabs.map((t) => t.reveal)).toEqual([false, true])
  })

  it('resolveRootClose with nothing waiting changes nothing', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    act(() => result.current.resolveRootClose(true))
    expect(paths(result.current.tabs)).toEqual(['a.md'])
    expect(result.current.pendingRootClose).toBeUndefined()
  })

  it('deleting a directory closes every tab under it', async () => {
    const { result } = await loaded()
    for (const p of ['docs/guide.md', 'docs/a.md', 'a.md', 'docsx'])
      act(() => result.current.open(p, { pin: true }))
    act(() => result.current.deleted('docs'))
    expect(paths(result.current.tabs)).toEqual(['a.md', 'docsx'])
  })

  it('a moved root closes clean tabs and asks about the others', async () => {
    const { result } = await loaded()
    for (const p of ['a.md', 'b.md', 'c.md'])
      act(() => result.current.open(p, { pin: true }))
    edit('b.md')
    edit('c.md')
    act(() => result.current.rootChanged('/n'))
    expect(paths(result.current.tabs)).toEqual(['b.md', 'c.md'])
    const ids = result.current.tabs.map((t) => t.id)
    expect(result.current.pendingRootClose).toEqual(ids)
    // Kept: they stay, with their changes
    act(() => result.current.resolveRootClose(false))
    expect(result.current.pendingRootClose).toBeUndefined()
    expect(result.current.tabs).toHaveLength(2)
    expect(isDraftDirty('%1', 'b.md')).toBe(true)
    // Asked again on the next move, then closed with their changes
    act(() => result.current.rootChanged('/m'))
    expect(result.current.pendingRootClose).toEqual(ids)
    act(() => result.current.close(ids[0]))
    expect(result.current.pendingRootClose).toEqual([ids[1]])
    act(() => result.current.resolveRootClose(true))
    expect(result.current.tabs).toEqual([])
    expect(isDraftDirty('%1', 'c.md')).toBe(false)
    expect(result.current.active).toBeUndefined()
  })

  it('a tab is no longer asked about once the pane is back at its root', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    edit('a.md')
    act(() => result.current.rootChanged('/n'))
    expect(result.current.pendingRootClose).toHaveLength(1)
    act(() => result.current.rootChanged('/r'))
    expect(result.current.pendingRootClose).toBeUndefined()
  })

  it('a tab closed to make room is no longer asked about', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    edit('a.md')
    act(() => result.current.rootChanged('/n'))
    const asked = result.current.tabs[0].id
    // Its changes are dropped elsewhere (Changes), then nine more open
    dropDraft('%1', 'a.md')
    for (let i = 0; i < 10; i++)
      act(() => result.current.open(`n${i}`, { pin: true }))
    expect(result.current.tabs.map((t) => t.id)).not.toContain(asked)
    expect(result.current.pendingRootClose).toBeUndefined()
  })

  it('a tab opened under the new root stays when the root moves to it', async () => {
    const { result } = await loaded()
    act(() => result.current.rootChanged('/n'))
    act(() => result.current.open('a.md'))
    expect(result.current.active?.root).toBe('/n')
    // Told again: nothing to do
    act(() => result.current.rootChanged('/n'))
    expect(result.current.tabs).toHaveLength(1)
  })
})

describe('useFiles search, delete and restore', () => {
  const listing: Record<string, FileEntry[]> = {
    '': [dir('x'), file('a.md')],
    x: [dir('y')],
    'x/y': [file('z.md')],
    e: [],
  }
  beforeEach(() => {
    mockTree.mockImplementation(async (_p, path: string) =>
      tree(path, listing[path] ?? []),
    )
  })

  it('reveal opens the tree down to a file, read again, then the file', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.root).toBe('/r'))
    mockTree.mockClear()
    await act(() => result.current.reveal('x/y/z.md'))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(['', 'x', 'x/y'])
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
    expect(result.current.active?.path).toBe('x/y/z.md')
    expect(result.current.active?.history).toEqual([])
    // A directory shows in the tree, opened
    await act(() => result.current.reveal('x/y', 'dir'))
    expect(result.current.active).toBeUndefined()
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
  })

  it('reveal opens nothing once the root moved meanwhile', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    let finish!: () => void
    const real = mockTree.getMockImplementation()!
    mockTree.mockImplementationOnce(
      (...a: [string, string]) =>
        new Promise((r) => (finish = () => r(real(...a)))),
    )
    let done!: Promise<void>
    act(() => {
      done = result.current.reveal('a.md')
    })
    act(() => result.current.rootChanged('/n'))
    await act(async () => {
      finish()
      await done
    })
    expect(result.current.active).toBeUndefined()
  })

  it('list reads a directory again and says what it holds', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    let got: Awaited<ReturnType<typeof result.current.list>> | undefined
    await act(async () => {
      got = await result.current.list('e')
    })
    expect(got?.entries).toEqual([])
  })

  it('deleted closes the file, forgets what was under it and reads its directory', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.reveal('x/y/z.md'))
    mockTree.mockClear()
    act(() => result.current.deleted('x/y/z.md'))
    expect(result.current.active).toBeUndefined()
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(['x/y'])
    // A folder: closed with everything below it, gone from the listings
    act(() => result.current.deleted('x'))
    expect(result.current.expanded).toEqual({})
    expect(result.current.dirs.x).toBeUndefined()
    expect(mockTree).toHaveBeenLastCalledWith('%1', '', '/r')
    // Another file stays open
    await act(() => result.current.reveal('a.md'))
    act(() => result.current.deleted('x/y/z.md'))
    expect(result.current.active?.path).toBe('a.md')
  })

  it('restored opens the tree down to it, read again, keeping what is open', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.reveal('a.md'))
    mockTree.mockClear()
    await act(() => result.current.restored('x/y/z.md'))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual(['', 'x', 'x/y'])
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
    expect(result.current.active?.path).toBe('a.md')
    mockTree.mockClear()
    await act(() => result.current.restored('top.md'))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual([''])
  })
})

describe('useFileDraft', () => {
  const draft = {
    root: '/r',
    path: 'a',
    baseHash: 'h',
    base: 'x',
    crlf: false,
    text: 'y',
    reveal: false,
  }

  it('keeps one draft per pane and path, shared by every reader, until dropped', () => {
    const one = renderHook(() => useFileDraft('%1', 'a'))
    const again = renderHook(() => useFileDraft('%1', 'a'))
    const other = renderHook(() => useFileDraft('%2', 'a'))
    expect(one.result.current[0]).toBeUndefined()
    act(() => one.result.current[1](draft))
    expect(again.result.current[0]).toEqual(draft)
    expect(other.result.current[0]).toBeUndefined()
    // Outlives its readers
    one.unmount()
    again.unmount()
    const later = renderHook(() => useFileDraft('%1', 'a'))
    expect(later.result.current[0]).toEqual(draft)
    act(() => later.result.current[1](undefined))
    expect(later.result.current[0]).toBeUndefined()
  })

  it('follows its pane when ids shift; the tree is read again', async () => {
    mockTree.mockResolvedValue(tree('', [file('a')]))
    const files = renderHook(() => useFiles('1'))
    act(() => files.result.current.load())
    await waitFor(() => expect(files.result.current.dirs['']).toBeDefined())
    act(() => files.result.current.open('a'))
    files.unmount()
    const one = renderHook(() => useFileDraft('1', 'a'))
    const two = renderHook(() => useFileDraft('2', 'a'))
    act(() => one.result.current[1](draft))
    act(() => two.result.current[1]({ ...draft, text: 'other' }))
    // 1 moved to 2; 2's pane is gone
    act(() =>
      remapPanes({ moved: new Map([['1', '2']]), stale: new Set(['1', '2']) }),
    )
    expect(one.result.current[0]).toBeUndefined()
    expect(two.result.current[0]).toEqual(draft)
    // The store went with its pane: its open tab stays, read by the new id
    const moved = renderHook(() => useFiles('2'))
    expect(moved.result.current.tabs.map((t) => t.path)).toEqual(['a'])
    await waitFor(() =>
      expect(mockTree).toHaveBeenLastCalledWith('2', '', '/r'),
    )
    expect(renderHook(() => useFiles('1')).result.current.dirs).toEqual({})
  })

  it('keeps a draft of each file at once', () => {
    const a = renderHook(() => useFileDraft('%1', 'a'))
    const b = renderHook(() => useFileDraft('%1', 'b'))
    act(() => a.result.current[1](draft))
    act(() => b.result.current[1]({ ...draft, path: 'b', text: 'z' }))
    expect(a.result.current[0]?.text).toBe('y')
    expect(b.result.current[0]?.text).toBe('z')
    act(() => dropDraft('%1', 'a'))
    expect(a.result.current[0]).toBeUndefined()
    expect(b.result.current[0]?.text).toBe('z')
  })

  it('useDirtyCheck reads again whenever a draft changes', () => {
    const check = renderHook(() => useDirtyCheck('%1'))
    const first = check.result.current
    expect(first('a')).toBe(false)
    const h = renderHook(() => useFileDraft('%1', 'a'))
    act(() => h.result.current[1](draft))
    expect(check.result.current).not.toBe(first)
    expect(check.result.current('a')).toBe(true)
    act(() => h.result.current[1]({ ...draft, text: draft.base }))
    expect(check.result.current('a')).toBe(false)
  })

  it('updates from the draft in the store now', () => {
    const h = renderHook(() => useFileDraft('%1', 'a'))
    act(() => h.result.current[1](draft))
    act(() =>
      h.result.current[1]((now) => now && { ...now, text: `${now.text}z` }),
    )
    expect(h.result.current[0]?.text).toBe('yz')
    act(() => h.result.current[1](() => undefined))
    expect(h.result.current[0]).toBeUndefined()
  })

  it('is forgotten with the stores', () => {
    const h = renderHook(() => useFileDraft('%1', 'a'))
    act(() => h.result.current[1](draft))
    act(() => resetFilesStores())
    h.rerender()
    expect(h.result.current[0]).toBeUndefined()
  })

  it('leaving the page asks while a draft has changes, shown or not', () => {
    const unload = () => {
      const ev = new Event('beforeunload', { cancelable: true })
      window.dispatchEvent(ev)
      return ev.defaultPrevented
    }
    const h = renderHook(() => useFileDraft('%1', 'a'))
    act(() => h.result.current[1]({ ...draft, text: draft.base }))
    expect(unload()).toBe(false)
    act(() => h.result.current[1](draft))
    h.unmount()
    expect(unload()).toBe(true)
    // Any file with changes keeps asking
    const other = renderHook(() => useFileDraft('%1', 'b'))
    act(() => other.result.current[1]({ ...draft, path: 'b' }))
    act(() => dropDraft('%1', 'a'))
    expect(unload()).toBe(true)
    act(() => resetFilesStores())
    expect(unload()).toBe(false)
  })
})

describe('a renamed file', () => {
  const listing: Record<string, FileEntry[]> = {
    '': [dir('x'), file('a.md'), file('b.md')],
    x: [],
  }
  beforeEach(() => {
    mockTree.mockImplementation(async (_p, path: string) =>
      tree(path, listing[path] ?? []),
    )
  })

  const draft = (path: string, text = 'y', root = '/r'): FileDraft => ({
    root,
    path,
    baseHash: 'h',
    base: 'x',
    crlf: false,
    text,
    reveal: false,
  })

  async function loaded(pane = '%1') {
    const h = renderHook(() => useFiles(pane))
    act(() => h.result.current.load())
    await waitFor(() => expect(h.result.current.root).toBe('/r'))
    return h
  }

  it('its tab follows, keeping its place and pinned state', async () => {
    const { result } = await loaded()
    act(() => result.current.open('b.md', { pin: true }))
    act(() => result.current.open('a.md'))
    const id = result.current.activeId
    mockTree.mockClear()
    act(() => fileRenamed('/r', 'a.md', 'x/c.md', true))
    expect(result.current.tabs.map((t) => [t.path, t.pinned])).toEqual([
      ['b.md', true],
      ['x/c.md', false],
    ])
    expect(result.current.activeId).toBe(id)
    expect(result.current.tabs[1]).toMatchObject({ id, reveal: true })
    await waitFor(() =>
      expect(mockTree.mock.calls.map((c) => c[1]).sort()).toEqual([
        '',
        '',
        'x',
      ]),
    )
    expect(result.current.expanded).toEqual({ x: true })
  })

  it('Back of another tab goes to the new path', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    await act(() => result.current.follow({ path: 'b.md' }, 7))
    await act(() => result.current.follow({ path: 'a.md' }, 8))
    act(() => fileRenamed('/r', 'b.md', 'c.md', false))
    expect(result.current.active?.path).toBe('a.md')
    expect(result.current.active?.history).toEqual([
      { path: 'a.md', scrollTop: 7 },
      { path: 'c.md', scrollTop: 8 },
    ])
  })

  it('a tab already on the new path closes; the moved one shows', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    act(() => result.current.open('b.md', { pin: true }))
    const kept = result.current.tabs[0].id
    act(() => fileRenamed('/r', 'a.md', 'b.md', false))
    expect(result.current.tabs.map((t) => [t.id, t.path])).toEqual([
      [kept, 'b.md'],
    ])
    expect(result.current.activeId).toBe(kept)
  })

  it('its draft follows in every pane of the root, never another root', async () => {
    const one = await loaded('%1')
    const two = await loaded('%2')
    act(() => one.result.current.open('a.md'))
    act(() => two.result.current.open('a.md'))
    renderHook(() => useFileDraft('%1', 'a.md')).result.current[1](
      draft('a.md'),
    )
    renderHook(() => useFileDraft('%2', 'a.md')).result.current[1](
      draft('a.md'),
    )
    renderHook(() => useFileDraft('%3', 'a.md')).result.current[1](
      draft('a.md', 'y', '/other'),
    )
    const moved = renderHook(() => useFileDraft('%2', 'c.md'))
    act(() => fileRenamed('/r', 'a.md', 'c.md', true))
    expect(moved.result.current[0]).toMatchObject({
      path: 'c.md',
      reveal: true,
    })
    expect(isDraftDirty('%1', 'c.md')).toBe(true)
    expect(isDraftDirty('%1', 'a.md')).toBe(false)
    expect(isDraftDirty('%3', 'a.md')).toBe(true)
    expect(two.result.current.tabs[0].path).toBe('c.md')
  })

  it('a tab kept from another root is another file: it stays', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    renderHook(() => useFileDraft('%1', 'a.md')).result.current[1](
      draft('a.md'),
    )
    // The pane moved: the edited tab is kept, asked about
    mockTree.mockImplementation(async (_p, path: string) =>
      tree(path, listing[path] ?? [], '/s'),
    )
    act(() => result.current.rootChanged('/s'))
    await waitFor(() => expect(result.current.root).toBe('/s'))
    act(() => result.current.open('b.md', { pin: true }))
    // Another pane, still on /r, is not touched
    mockTree.mockImplementation(async (_p, path: string) =>
      tree(path, listing[path] ?? []),
    )
    const other = await loaded('%9')
    act(() => other.result.current.open('a.md'))
    act(() => fileRenamed('/s', 'a.md', 'b.md', false))
    expect(other.result.current.tabs[0].path).toBe('a.md')
    expect(result.current.tabs.map((t) => [t.root, t.path])).toEqual([
      ['/r', 'a.md'],
      ['/s', 'b.md'],
    ])
  })

  it('the same path, or no tab and no draft: nothing changes', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    const before = result.current.tabs
    act(() => fileRenamed('/r', 'a.md', 'a.md', false))
    act(() => fileRenamed('/r', 'z.md', 'y.md', false))
    expect(result.current.tabs).toEqual(before)
  })

  it('hasDirtyDraftAt sees unsaved changes of any pane of the root', () => {
    renderHook(() => useFileDraft('%1', 'a.md')).result.current[1](
      draft('a.md', 'x'),
    )
    expect(hasDirtyDraftAt('/r', 'a.md')).toBe(false)
    renderHook(() => useFileDraft('%2', 'a.md')).result.current[1](
      draft('a.md'),
    )
    expect(hasDirtyDraftAt('/r', 'a.md')).toBe(true)
    expect(hasDirtyDraftAt('/other', 'a.md')).toBe(false)
  })
})

describe('tabs kept on the device', () => {
  // Server i1, pane %1 of window @1 in session main
  const snapshot = (instanceId = 'i1', group = 'main') =>
    setPaneKeys(
      {
        instanceId,
        groups: [{ id: '$0', name: group, tabs: [{ id: '%1', panes: [] }] }],
      } as unknown as MuxSnapshot,
      new Map([['%1', '@1']]),
    )
  const edit = (path: string) =>
    renderHook(() => useFileDraft('%1', path)).result.current[1]({
      root: '/r',
      path,
      baseHash: 'h',
      base: 'a',
      crlf: false,
      text: 'b',
      reveal: false,
    })
  // The app closed and opened again: the stores start over, storage stays
  const reopen = () => {
    flushAll()
    resetFilesStores()
  }

  beforeEach(() => snapshot())

  it('open again as they were left', async () => {
    mockTree.mockResolvedValue(tree('', [file('a.md')]))
    const first = renderHook(() => useFiles('%1'))
    act(() => first.result.current.load())
    await waitFor(() => expect(first.result.current.root).toBe('/r'))
    act(() => first.result.current.open('a.md', { pin: true }))
    act(() => first.result.current.open('b.md'))
    act(() => first.result.current.open('s.env'))
    const sensitive = first.result.current.activeId!
    act(() => first.result.current.setReveal(sensitive))
    act(() => first.result.current.open('b.md'))
    const b = first.result.current.activeId!
    act(() => first.result.current.setScroll(b, 120))
    act(() =>
      first.result.current.setTableLayout(b, {
        key: 'k',
        widths: {},
        wrapped: [],
      }),
    )
    // Not a tab: ignored
    act(() => first.result.current.setTableLayout('nope', emptyLayout('k')))
    const before = first.result.current.tabs.filter((t) => !t.reveal)
    first.unmount()
    reopen()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).not.toContain(
      's.env',
    )
    const { result } = renderHook(() => useFiles('%1'))
    expect(result.current.root).toBe('/r')
    expect(result.current.tabs).toEqual(
      before.map((t) => ({ ...t, intent: undefined })),
    )
    expect(result.current.activeId).toBe(b)
    expect(result.current.active?.scrollTop).toBe(120)
    // The first read names the root the tabs were opened under
    act(() => result.current.load())
    expect(mockTree).toHaveBeenLastCalledWith('%1', '', '/r')
    // A tab opened now takes an id of its own
    act(() => result.current.open('c.md', { pin: true }))
    const ids = result.current.tabs.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('of a pane that moved meanwhile close, unless they have changes', async () => {
    mockTree.mockResolvedValue(tree('', []))
    const first = renderHook(() => useFiles('%1'))
    act(() => first.result.current.load())
    await waitFor(() => expect(first.result.current.root).toBe('/r'))
    act(() => first.result.current.open('a.md', { pin: true }))
    act(() => first.result.current.open('b.md', { pin: true }))
    reopen()
    // The draft of b.md came back with the snapshot
    edit('b.md')
    mockTree
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', { root: '/n' }),
      )
      .mockResolvedValue(tree('', [], '/n'))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.load())
    await waitFor(() => expect(result.current.root).toBe('/n'))
    expect(result.current.tabs.map((t) => t.path)).toEqual(['b.md'])
    expect(result.current.pendingRootClose).toEqual([result.current.tabs[0].id])
    // Closed again with the question open: it is asked again
    reopen()
    edit('b.md')
    const again = renderHook(() => useFiles('%1'))
    expect(again.result.current.pendingRootClose).toHaveLength(1)
    // None left: nothing is kept
    act(() => again.result.current.resolveRootClose(true))
    flushAll()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
  })

  it('never keep the name of a sensitive file left by a link', async () => {
    mockTree.mockImplementation(async (_p, path) =>
      tree(path, [file('secrets.md'), file('next.md')]),
    )
    const first = renderHook(() => useFiles('%1'))
    act(() => first.result.current.load())
    await waitFor(() => expect(first.result.current.root).toBe('/r'))
    act(() => first.result.current.open('secrets.md', { pin: true }))
    act(() => first.result.current.setReveal(first.result.current.activeId!))
    await act(() => first.result.current.follow({ path: 'next.md' }, 10))
    expect(first.result.current.active?.history).toEqual([
      { path: 'secrets.md', scrollTop: 10, reveal: true },
    ])
    // Renamed as sensitive: the entry is then a sensitive file's too
    act(() => fileRenamed('/r', 'next.md', 'n.md', false))
    act(() => first.result.current.back())
    await act(() => first.result.current.follow({ path: 'next.md' }, 0))
    act(() => fileRenamed('/r', 'secrets.md', 'x.env', true))
    flushAll()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).not.toContain(
      'secrets',
    )
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).not.toContain(
      'x.env',
    )
  })

  it('opened again are written again, so they never expire while used', () => {
    const first = renderHook(() => useFiles('%1'))
    act(() => first.result.current.open('a.md'))
    reopen()
    localStorage.setItem(
      'termote-files-tabs:i1:@1',
      localStorage
        .getItem('termote-files-tabs:i1:@1')!
        .replace(/"savedAt":\d+/, '"savedAt":1'),
    )
    // A page loaded days later (this one remembers its last write a day)
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 86400000 })
    try {
      renderHook(() => useFiles('%1'))
      flushAll()
    } finally {
      vi.useRealTimers()
    }
    expect(
      JSON.parse(localStorage.getItem('termote-files-tabs:i1:@1')!).savedAt,
    ).toBeGreaterThan(1)
  })

  it('of another server or another session are not opened', () => {
    const first = renderHook(() => useFiles('%1'))
    act(() => first.result.current.open('a.md'))
    reopen()
    snapshot('i2')
    expect(renderHook(() => useFiles('%1')).result.current.tabs).toEqual([])
    resetFilesStores()
    snapshot('i1', 'other')
    expect(renderHook(() => useFiles('%1')).result.current.tabs).toEqual([])
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
  })
})

describe('files opened lately', () => {
  beforeEach(() =>
    setPaneKeys(
      {
        instanceId: 'i1',
        groups: [{ id: '$0', name: 'main', tabs: [{ id: '%1', panes: [] }] }],
      } as unknown as MuxSnapshot,
      new Map([['%1', '@1']]),
    ),
  )
  const listing: Record<string, FileEntry[]> = {
    '': [dir('docs'), file('a.md'), file('b.md')],
    docs: [file('guide.md')],
  }
  const loaded = async () => {
    mockTree.mockImplementation(async (_p, path: string, root?: string) =>
      tree(path, listing[path] ?? [], root ?? '/r'),
    )
    const hook = renderHook(() => useFiles('%1'))
    act(() => hook.result.current.load())
    await waitFor(() => expect(hook.result.current.root).toBe('/r'))
    return hook
  }
  const paths = (r: { current: { recent: { path: string }[] } }) =>
    r.current.recent.map((f) => f.path)

  it('lists the files the user opened, the latest first, kept on the device', async () => {
    const { result, unmount } = await loaded()
    act(() => result.current.open('a.md'))
    act(() => result.current.open('b.md'))
    act(() => result.current.open('a.md'))
    expect(result.current.recent).toEqual([
      { root: '/r', path: 'a.md' },
      { root: '/r', path: 'b.md' },
    ])
    unmount()
    flushAll()
    resetFilesStores()
    const again = renderHook(() => useFiles('%1'))
    expect(paths(again.result)).toEqual(['a.md', 'b.md'])
  })

  it('remembers nothing before the root is known', () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('a.md'))
    expect(result.current.recent).toEqual([])
  })

  it('remembers a followed link and a search pick, not a created file', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    await act(() => result.current.follow({ path: 'b.md' }, 0))
    await act(() =>
      result.current.follow({ path: 'docs/guide.md' }, 0, { newTab: true }),
    )
    await act(() => result.current.reveal('a.md'))
    await act(() => result.current.created('new.md', '/r', false))
    await act(() => result.current.restored('docs/guide.md'))
    expect(paths(result)).toEqual(['a.md', 'docs/guide.md', 'b.md'])
  })

  it('drops a file shown as sensitive, and does not take it back', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    act(() => result.current.open('b.md'))
    act(() => result.current.setReveal(result.current.activeId!))
    expect(paths(result)).toEqual(['a.md'])
    act(() => result.current.setReveal(result.current.activeId!))
    act(() => result.current.setReveal('nope'))
    expect(paths(result)).toEqual(['a.md'])
    expect(localStorage.getItem('termote-recent-files:i1:@1')).not.toContain(
      'b.md',
    )
  })

  it('does not take back a file still shown as sensitive when opened again', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md', { pin: true }))
    act(() => result.current.open('s.env', { pin: true }))
    act(() => result.current.setReveal(result.current.activeId!))
    act(() => result.current.open('a.md'))
    // Its tab, still showing it
    act(() => result.current.open('s.env'))
    act(() => result.current.openFromFind('/r', 's.env'))
    expect(paths(result)).toEqual(['a.md'])
    expect(localStorage.getItem('termote-recent-files:i1:@1')).not.toContain(
      's.env',
    )
  })

  it('follows a rename, and drops a file renamed as sensitive or deleted', async () => {
    const { result } = await loaded()
    act(() => result.current.open('docs/guide.md'))
    act(() => result.current.open('a.md'))
    act(() => fileRenamed('/r', 'a.md', 'c.md', false))
    expect(paths(result)).toEqual(['c.md', 'docs/guide.md'])
    // A file not in the list changes nothing
    act(() => fileRenamed('/r', 'x.md', 'y.md', false))
    expect(paths(result)).toEqual(['c.md', 'docs/guide.md'])
    act(() => fileRenamed('/r', 'c.md', 's.env', true))
    expect(paths(result)).toEqual(['docs/guide.md'])
    act(() => result.current.deleted('docs'))
    expect(result.current.recent).toEqual([])
    // Nothing to drop
    act(() => result.current.deleted('zz'))
  })

  it('a find result opens under its root, moving the store there first', async () => {
    mockTree.mockImplementation(async (_p, path: string, root?: string) =>
      tree(path, [], root ?? '/r'),
    )
    const { result } = renderHook(() => useFiles('%1'))
    // Not loaded yet: the tab gets the root of the result
    act(() => result.current.openFromFind('/r', 'a.md'))
    expect(result.current.root).toBe('/r')
    expect(result.current.active).toMatchObject({ root: '/r', path: 'a.md' })
    expect(paths(result)).toEqual(['a.md'])
    // On that root already
    act(() => result.current.openFromFind('/r', 'b.md', { pin: true }))
    expect(result.current.active).toMatchObject({ path: 'b.md', pinned: true })
    // Another root: the store moves first
    act(() => result.current.openFromFind('/other', 'c.md'))
    expect(result.current.root).toBe('/other')
    expect(result.current.active).toMatchObject({
      root: '/other',
      path: 'c.md',
    })
  })

  it('a deletion before the root is known changes nothing', () => {
    mockTree.mockResolvedValue(tree('', []))
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.deleted('a.md'))
    expect(result.current.recent).toEqual([])
  })

  it('are removed when the user signs out', async () => {
    const { result } = await loaded()
    act(() => result.current.open('a.md'))
    expect(localStorage.getItem('termote-recent-files:i1:@1')).not.toBeNull()
    signedOut()
    expect(localStorage.getItem('termote-recent-files:i1:@1')).toBeNull()
  })
})

describe('focus asked for from outside Files', () => {
  it('reaches the pane once, now or when its view mounts', () => {
    const onRequest = vi.fn()
    requestFilesFocus('%1', 'search')
    const { unmount } = renderHook(() => useFilesFocusRequest('%1', onRequest))
    expect(onRequest).toHaveBeenCalledExactlyOnceWith('search')
    act(() => requestFilesFocus('%2', 'file'))
    expect(onRequest).toHaveBeenCalledOnce()
    act(() => requestFilesFocus('%1', 'file'))
    expect(onRequest).toHaveBeenLastCalledWith('file')
    unmount()
    renderHook(() => useFilesFocusRequest('%1', onRequest))
    expect(onRequest).toHaveBeenCalledTimes(2)
  })

  it('is forgotten with the stores', () => {
    const onRequest = vi.fn()
    requestFilesFocus('%1', 'search')
    resetFilesStores()
    renderHook(() => useFilesFocusRequest('%1', onRequest))
    expect(onRequest).not.toHaveBeenCalled()
  })
})

describe('drafts kept on the device', () => {
  const snapshot = (instanceId = 'i1') =>
    setPaneKeys(
      {
        instanceId,
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
  const draft = (path: string, text = 'mine'): FileDraft => ({
    root: '/r',
    path,
    baseHash: 'h',
    base: 'old',
    crlf: false,
    text,
    reveal: false,
  })
  const set = (paneId: string, path: string, d: FileDraft | undefined) => {
    const setDraft = renderHook(() => useFileDraft(paneId, path)).result
      .current[1]
    act(() => setDraft(d))
  }
  const key = (path: string, pane = '@1') =>
    `termote-file-drafts:i1:${pane}:${path}`
  const stored = (path: string, pane = '@1') =>
    JSON.parse(localStorage.getItem(key(path, pane)) ?? 'null')
  const unload = () => {
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  }
  // The app closed and opened again on the same server
  const reopen = () => {
    resetFilesStores()
    snapshot()
  }

  beforeEach(() => snapshot())

  it('are written at once while they have changes, and go at once', () => {
    set('%1', 'a.md', draft('a.md'))
    expect(stored('a.md')).toMatchObject({
      role: 'full',
      draft: { path: 'a.md', text: 'mine', base: 'old' },
    })
    expect(stored('a.md').draft.reveal).toBeUndefined()
    // Kept: closing the app loses nothing, so it does not ask
    expect(unload()).toBe(false)
    // Back to the text read: nothing to keep
    set('%1', 'a.md', draft('a.md', 'old'))
    expect(stored('a.md')).toBeNull()
    set('%1', 'a.md', draft('a.md'))
    // Saved (or discarded): gone at once, no timer
    act(() => dropDraft('%1', 'a.md'))
    expect(stored('a.md')).toBeNull()
  })

  it('of a sensitive file are never written, and leaving asks', () => {
    set('%1', '.env', { ...draft('.env'), reveal: true })
    expect(Object.keys(localStorage).join()).not.toContain('.env')
    expect(JSON.stringify(localStorage)).not.toContain('mine')
    expect(unload()).toBe(true)
    act(() => dropDraft('%1', '.env'))
    expect(unload()).toBe(false)
  })

  it('that cannot be written are not lost silently', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => set('%1', 'a.md', draft('a.md'))).not.toThrow()
    expect(unload()).toBe(true)
    vi.restoreAllMocks()
    // Written once there is room: no longer asked about
    set('%1', 'a.md', draft('a.md', 'more'))
    expect(unload()).toBe(false)
    act(() => dropDraft('%1', 'a.md'))
  })

  it('keep when they were last edited, not last written', () => {
    vi.useFakeTimers({ now: 1000 })
    try {
      set('%1', 'a.md', draft('a.md'))
      vi.setSystemTime(5000)
      // The same text again (a cell layout, a move): still edited at 1000
      set('%1', 'a.md', { ...draft('a.md'), baseHash: 'h2' })
      expect(stored('a.md').editedAt).toBe(1000)
      set('%1', 'a.md', draft('a.md', 'other'))
      expect(stored('a.md').editedAt).toBe(5000)
      // Renamed: the time moves with it
      act(() => fileRenamed('/r', 'a.md', 'b.md', false))
      expect(stored('a.md')).toBeNull()
      expect(stored('b.md')).toMatchObject({
        editedAt: 5000,
        draft: { path: 'b.md' },
      })
      // Renamed as sensitive: kept no more
      act(() => fileRenamed('/r', 'b.md', 'c.env', true))
      expect(stored('c.env')).toBeNull()
      expect(unload()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('come back once per pane, never over a draft in memory', () => {
    set('%1', 'a.md', draft('a.md'))
    set('%1', 'b.md', draft('b.md'))
    set('%2', 'c.md', draft('c.md'))
    reopen()
    // Newer, made before the snapshot was applied
    set('%1', 'b.md', draft('b.md', 'newer'))
    act(() => hydrateDrafts(['%1', '%2', 'nope']))
    const read = (p: string, f: string) =>
      renderHook(() => useFileDraft(p, f)).result.current[0]
    expect(read('%1', 'a.md')).toEqual(draft('a.md'))
    expect(read('%1', 'b.md')?.text).toBe('newer')
    expect(read('%2', 'c.md')).toEqual(draft('c.md'))
    expect(isDraftDirty('%1', 'a.md')).toBe(true)
    // Kept on the device: no need to ask
    expect(unload()).toBe(false)
    // Read once: a draft dropped since does not come back
    act(() => dropDraft('%1', 'a.md'))
    act(() => hydrateDrafts(['%1']))
    expect(read('%1', 'a.md')).toBeUndefined()
  })

  it('that are not drafts are left out', () => {
    const put = (path: string, d: object) =>
      localStorage.setItem(
        key(path),
        JSON.stringify({
          v: 1,
          pane: '@1',
          group: 'main',
          editedAt: Date.now(),
          role: 'full',
          draft: d,
        }),
      )
    localStorage.clear()
    put('a', { ...draft('a'), crlf: 'no' })
    put('b', { ...draft('b'), cells: 'x' })
    put('c', { ...draft('c'), cells: null })
    put('d', { ...draft('d'), cells: { ops: [], redo: 'x' } })
    put('e', { ...draft('e'), text: 3 })
    put('f', {
      ...draft('f'),
      cells: { delimiter: ',', ops: [{ kind: 'cell' }], redo: [] },
    })
    act(() => hydrateDrafts(['%1']))
    expect(isDraftDirty('%1', 'f')).toBe(true)
    for (const p of ['a', 'b', 'c', 'd', 'e'])
      expect(isDraftDirty('%1', p)).toBe(false)
  })

  it('of another server do not come back; a view-only client keeps none', () => {
    set('%1', 'a.md', draft('a.md'))
    resetFilesStores()
    snapshot('i2')
    act(() => hydrateDrafts(['%1']))
    expect(isDraftDirty('%1', 'a.md')).toBe(false)
    reopen()
    act(() => hydrateDrafts(['%1'], 'view'))
    expect(isDraftDirty('%1', 'a.md')).toBe(false)
    expect(stored('a.md')).toBeNull()
    // Nor writes any
    set('%1', 'b.md', draft('b.md'))
    expect(stored('b.md')).toBeNull()
  })

  it('of one tab of the app never bring back what another saved', () => {
    // Tab A edited a.md, tab B (the same storage) b.md
    set('%1', 'a.md', draft('a.md'))
    set('%1', 'b.md', draft('b.md'))
    // A saves a.md; B goes on editing b.md
    act(() => dropDraft('%1', 'a.md'))
    set('%1', 'b.md', draft('b.md', 'more'))
    reopen()
    act(() => hydrateDrafts(['%1']))
    expect(isDraftDirty('%1', 'a.md')).toBe(false)
    expect(isDraftDirty('%1', 'b.md')).toBe(true)
  })

  it('go from memory when another tab signs out', () => {
    set('%1', 'a.md', draft('a.md'))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: 'termote-signed-out',
        newValue: '1',
      }),
    )
    expect(isDraftDirty('%1', 'a.md')).toBe(false)
    expect(localStorage.getItem(key('a.md'))).toBeNull()
  })

  it('signing out here makes leaving ask again', () => {
    set('%1', 'a.md', draft('a.md'))
    expect(unload()).toBe(false)
    act(() => signedOut())
    expect(unload()).toBe(true)
  })

  it('a draft another tab changes is no longer taken as kept', () => {
    set('%1', 'a.md', draft('a.md'))
    set('%1', 'b.md', draft('b.md'))
    expect(unload()).toBe(false)
    // The other tab saved a.md: its key went
    localStorage.removeItem(key('a.md'))
    window.dispatchEvent(
      new StorageEvent('storage', { key: key('a.md'), newValue: null }),
    )
    expect(unload()).toBe(true)
  })

  it('a table draft with a column edit comes back, and undoes', () => {
    const base = 'a,b\n1,2\n'
    const p = parseCsv(base, ',')
    if (!p.ok) throw new Error('parse')
    const op = makeOp(
      base,
      p.table,
      { kind: 'insert-col', col: 0, side: 'right' },
      true,
    ) as TableOp
    const text = redoOp(base, op)
    const cells = { delimiter: ',' as const, ops: [op], redo: [] }
    set('%1', 't.csv', { ...draft('t.csv', text), cells })
    reopen()
    act(() => hydrateDrafts(['%1']))
    const back = renderHook(() => useFileDraft('%1', 't.csv')).result.current[0]
    expect(back?.cells).toEqual(cells)
    expect(undoOp(back?.text as string, back?.cells?.ops[0] as TableOp)).toBe(
      base,
    )
  })

  it('a table draft comes back with its edits', () => {
    const cells = {
      delimiter: ',' as const,
      ops: [{ kind: 'cell', row: 0, col: 0, name: 'a', from: 'x', to: 'y' }],
      redo: [],
    } as unknown as FileDraft['cells']
    set('%1', 't.csv', { ...draft('t.csv'), cells })
    reopen()
    act(() => hydrateDrafts(['%1']))
    expect(
      renderHook(() => useFileDraft('%1', 't.csv')).result.current[0]?.cells,
    ).toEqual(cells)
  })
})
