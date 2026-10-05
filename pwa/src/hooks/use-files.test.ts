import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  filesError,
  followInFiles,
  isOpenable,
  resetFilesStores,
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
    expect(b.result.current.openPath).toBe('x')
    const c = renderHook(() => useFiles('%2'))
    expect(c.result.current.openPath).toBeNull()
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
    // The open file stays open
    expect(result.current.openPath).toBe('README.md')
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
    expect(result.current.openPath).toBe('docs/guide.md')
    expect(result.current.openAnchor).toBe('usage')
    expect(result.current.history).toEqual([
      { path: 'README.md', scrollTop: 120 },
    ])

    act(() => result.current.back())
    expect(result.current.openPath).toBe('README.md')
    expect(result.current.openScroll).toBe(120)
    expect(result.current.openAnchor).toBeUndefined()
    expect(result.current.history).toEqual([])

    act(() => result.current.back())
    expect(result.current.openPath).toBeNull()
  })

  it('opening from the tree starts a new trail', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: 'docs/guide.md' }, 0))
    act(() => result.current.open('README.md'))
    expect(result.current.history).toEqual([])
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
    expect(result.current.openPath).toBeNull()
    expect(result.current.expanded).toEqual({ docs: true, 'docs/img': true })
    await waitFor(() =>
      expect(result.current.dirs['docs/img'].entries).toHaveLength(1),
    )
  })

  it('the root itself closes the file', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: '' }, 0))
    expect(result.current.openPath).toBeNull()
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
    expect(result.current.openPath).toBe('README.md')
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
    expect(result.current.openPath).toBe('docs/guide.md')
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
    expect(result.current.openPath).toBeNull()
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
    expect(result.current.openPath).toBe('docs/guide.md')
    expect(result.current.history).toEqual([
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
    expect(result.current.openPath).toBeNull()
  })

  it('followInFiles reaches the pane store from elsewhere', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(async () => {
      expect(await followInFiles('%1', { path: 'docs/guide.md' })).toBe(
        'opened',
      )
    })
    expect(result.current.openPath).toBe('docs/guide.md')
    // Nothing was open: no step back
    expect(result.current.history).toEqual([])
  })

  it('followInFiles starts a new trail: Back goes to the tree', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    act(() => result.current.open('README.md'))
    await act(() => result.current.follow({ path: 'docs/img/a.png' }, 0))
    await act(() => followInFiles('%1', { path: 'docs/guide.md' }))
    expect(result.current.openPath).toBe('docs/guide.md')
    expect(result.current.history).toEqual([])
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
    expect(result.current.openPath).toBe('x/y/z.md')
    expect(result.current.openIntent).toEqual({
      root: '/r',
      path: 'x/y/z.md',
      reveal: false,
    })
    // Back: the tree shows where it went
    act(() => result.current.back())
    expect(result.current.openPath).toBeNull()
    expect(result.current.openIntent).toBeUndefined()
    expect(result.current.expanded).toEqual({ x: true, 'x/y': true })
  })

  it('at the root, with the reveal it was made with', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('a.md', '/r', true))
    expect(mockTree.mock.calls.map((c) => c[1])).toEqual([''])
    expect(result.current.expanded).toEqual({})
    expect(result.current.openIntent).toEqual({
      root: '/r',
      path: 'a.md',
      reveal: true,
    })
  })

  it('a directory found there shows in the tree, opened', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('docs', '/r', false))
    expect(result.current.openPath).toBeNull()
    expect(result.current.openIntent).toBeUndefined()
    expect(result.current.expanded).toEqual({ docs: true })
    await waitFor(() => expect(result.current.dirs.docs.entries).toEqual([]))
  })

  it('the intent goes once another file or a link opens', async () => {
    const { result } = renderHook(() => useFiles('%1'))
    await act(() => result.current.created('a.md', '/r', false))
    act(() => result.current.open('x/y/z.md'))
    expect(result.current.openIntent).toBeUndefined()
    await act(() => result.current.created('a.md', '/r', false))
    await act(() => result.current.follow({ path: 'x/y/z.md' }, 0))
    expect(result.current.openPath).toBe('x/y/z.md')
    expect(result.current.openIntent).toBeUndefined()
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
    expect(result.current.openPath).toBeNull()

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
    expect(result.current.openPath).toBe('x/y/z.md')
    expect(result.current.openIntent).toBeUndefined()
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

  it('keeps one draft per pane, shared by every reader, until dropped', () => {
    const one = renderHook(() => useFileDraft('%1'))
    const again = renderHook(() => useFileDraft('%1'))
    const other = renderHook(() => useFileDraft('%2'))
    expect(one.result.current[0]).toBeUndefined()
    act(() => one.result.current[1](draft))
    expect(again.result.current[0]).toEqual(draft)
    expect(other.result.current[0]).toBeUndefined()
    // Outlives its readers
    one.unmount()
    again.unmount()
    const later = renderHook(() => useFileDraft('%1'))
    expect(later.result.current[0]).toEqual(draft)
    act(() => later.result.current[1](undefined))
    expect(later.result.current[0]).toBeUndefined()
  })

  it('is forgotten with the stores', () => {
    const h = renderHook(() => useFileDraft('%1'))
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
    const h = renderHook(() => useFileDraft('%1'))
    act(() => h.result.current[1]({ ...draft, text: draft.base }))
    expect(unload()).toBe(false)
    act(() => h.result.current[1](draft))
    h.unmount()
    expect(unload()).toBe(true)
    act(() => resetFilesStores())
    expect(unload()).toBe(false)
  })
})
