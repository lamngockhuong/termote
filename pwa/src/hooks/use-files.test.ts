import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropDraft,
  type FileDraft,
  filesError,
  followInFiles,
  isDraftDirty,
  isOpenable,
  resetFilesStores,
  useDirtyCheck,
  useFileDraft,
  useFiles,
} from './use-files'
import { type FileEntry, RequestError } from './use-mux-api'

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
    [new RequestError(500, '', 'x'), 'unavailable'],
    [new Error('offline'), 'unavailable'],
  ])('%s is %s', (err, want) => {
    expect(filesError(err)).toBe(want)
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
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
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
