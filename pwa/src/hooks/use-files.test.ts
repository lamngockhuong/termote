import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { filesError, resetFilesStores, useFiles } from './use-files'
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
