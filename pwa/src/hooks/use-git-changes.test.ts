import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHANGES_POLL,
  resetGitChangesStores,
  useGitChanges,
} from './use-git-changes'
import { type GitChanges, RequestError } from './use-mux-api'

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
