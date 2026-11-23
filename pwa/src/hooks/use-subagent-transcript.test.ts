import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remapPanes } from '../utils/pane-remap'
import { POLL_INTERVAL } from './use-agent-transcript'
import {
  AgentRequestError,
  type TranscriptEntry,
  type TranscriptPage,
} from './use-mux-api'
import {
  resetSubagentTranscriptStores,
  useSubagentTranscript,
} from './use-subagent-transcript'

const mockFetch = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchSubagentTranscript: (...a: unknown[]) => mockFetch(...a),
}))

const text = (id: string): TranscriptEntry => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: id }],
})

const page = (over: Partial<TranscriptPage>): TranscriptPage => ({
  agent: 'claude',
  sessionId: 's1',
  status: 'unknown',
  entries: [],
  cursor: 'c1',
  reset: false,
  ...over,
})

const notFound = () =>
  new AgentRequestError(404, 'session_not_found', 'no such session')

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  resetSubagentTranscriptStores()
  mockFetch.mockReset()
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

const ids = (entries: TranscriptEntry[]) => entries.map((e) => e.id)

// The hook for pane's subagent agent; rerender changes live and listed only
function mount(live: boolean, listed = true, pane = 'p1', agent = 'a1') {
  const r = renderHook(
    (p: { live: boolean; listed: boolean }) =>
      useSubagentTranscript(pane, agent, p.live, p.listed),
    { initialProps: { live, listed } },
  )
  return r
}

describe('useSubagentTranscript', () => {
  it('reads an ended subagent once', async () => {
    mockFetch.mockResolvedValue(
      page({ entries: [text('a')], reset: true, before: 'b0' }),
    )
    const { result } = mount(false)
    expect(result.current.loaded).toBe(false)
    await tick()
    expect(ids(result.current.entries)).toEqual(['a'])
    expect(result.current.hasOlder).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('p1', 'a1', { cursor: undefined })
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('follows a running one from its cursor, and reads once more when it ends', async () => {
    mockFetch
      .mockResolvedValueOnce(page({ entries: [text('a')], reset: true }))
      .mockResolvedValueOnce(page({ entries: [], cursor: 'c1' }))
      .mockResolvedValueOnce(page({ entries: [text('b')], cursor: 'c2' }))
      .mockResolvedValue(page({ entries: [text('c')], cursor: 'c3' }))
    const { result, rerender } = mount(true)
    await tick()
    await tick(POLL_INTERVAL)
    const held = result.current
    await tick(POLL_INTERVAL)
    expect(ids(result.current.entries)).toEqual(['a', 'b'])
    expect(held.entries).not.toBe(result.current.entries)
    expect(mockFetch).toHaveBeenLastCalledWith('p1', 'a1', { cursor: 'c1' })
    rerender({ live: false, listed: true })
    await tick()
    expect(ids(result.current.entries)).toEqual(['a', 'b', 'c'])
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('reads once more when it ends during a read', async () => {
    let resolve: (p: TranscriptPage) => void = () => {}
    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptPage>((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue(page({ entries: [text('end')], cursor: 'c2' }))
    const { result, rerender } = mount(true)
    await tick()
    rerender({ live: false, listed: true })
    await act(async () => resolve(page({ entries: [text('a')], reset: true })))
    await tick()
    expect(ids(result.current.entries)).toEqual(['a', 'end'])
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('waits for a listed running file, and keeps what was read once gone', async () => {
    mockFetch
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(page({ entries: [text('a')], reset: true }))
      .mockRejectedValue(notFound())
    const { result, rerender } = mount(true)
    await tick()
    expect(result.current.loaded).toBe(true)
    expect(result.current.error).toBeUndefined()
    await tick(POLL_INTERVAL)
    expect(ids(result.current.entries)).toEqual(['a'])
    // The tree no longer lists it: the file is gone
    rerender({ live: false, listed: false })
    await tick()
    expect(result.current.error).toBe('gone')
    expect(ids(result.current.entries)).toEqual(['a'])
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('is unsupported by a server without the route', async () => {
    mockFetch.mockRejectedValue(new AgentRequestError(404, '', 'not found'))
    const { result } = mount(true)
    await tick()
    expect(result.current.error).toBe('unsupported')
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('stops on a refusal, and retries a failed read while it runs', async () => {
    mockFetch.mockRejectedValue(new AgentRequestError(403, 'view_only', 'no'))
    const refused = mount(true)
    await tick()
    expect(refused.result.current.error).toBe('failed')
    await tick(POLL_INTERVAL * 5)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    refused.unmount()

    mockFetch.mockReset()
    mockFetch
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page({ entries: [text('a')], reset: true }))
    const { result } = mount(true, true, 'p1', 'a2')
    await tick()
    expect(result.current.error).toBe('failed')
    await tick(POLL_INTERVAL)
    // Backing off: the third read waits twice as long
    await tick(POLL_INTERVAL)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    await tick(POLL_INTERVAL)
    expect(result.current.error).toBeUndefined()
    expect(ids(result.current.entries)).toEqual(['a'])
  })

  it('loads older entries in front, and starts over on a reset', async () => {
    mockFetch
      .mockResolvedValueOnce(
        page({ entries: [text('c')], reset: true, before: 'b1' }),
      )
      .mockResolvedValueOnce(page({ entries: [text('b')], before: 'b0' }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        page({ entries: [text('x')], reset: true, cursor: 'c9' }),
      )
    const { result } = mount(false)
    await tick()
    await act(async () => result.current.loadOlder())
    expect(ids(result.current.entries)).toEqual(['b', 'c'])
    expect(mockFetch).toHaveBeenLastCalledWith('p1', 'a1', { before: 'b1' })
    await act(async () => result.current.loadOlder())
    expect(result.current.loadingOlder).toBe(false)
    expect(ids(result.current.entries)).toEqual(['b', 'c'])
    await act(async () => result.current.loadOlder())
    expect(ids(result.current.entries)).toEqual(['x'])
    expect(result.current.hasOlder).toBe(false)
    // Nothing older: no read
    await act(async () => result.current.loadOlder())
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('drops an older page read across a reset', async () => {
    let older: (p: TranscriptPage) => void = () => {}
    mockFetch
      .mockResolvedValueOnce(
        page({ entries: [text('c')], reset: true, before: 'b1' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptPage>((r) => {
            older = r
          }),
      )
      .mockResolvedValue(page({ entries: [text('n')], reset: true }))
    const { result, rerender } = mount(false)
    await tick()
    act(() => {
      result.current.loadOlder()
    })
    // Asked twice while loading: one read
    act(() => {
      result.current.loadOlder()
    })
    rerender({ live: true, listed: true })
    await tick()
    expect(ids(result.current.entries)).toEqual(['n'])
    await act(async () => older(page({ entries: [text('old')], before: '' })))
    expect(ids(result.current.entries)).toEqual(['n'])
  })

  it('forgets the store when nothing shows it', async () => {
    let resolve: (p: TranscriptPage) => void = () => {}
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<TranscriptPage>((r) => {
          resolve = r
        }),
    )
    const first = mount(true)
    await tick()
    first.unmount()
    await act(async () =>
      resolve(page({ entries: [text('late')], reset: true })),
    )
    await tick(POLL_INTERVAL * 3)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Shown again: read from the start
    mockFetch.mockResolvedValue(page({ entries: [text('a')], reset: true }))
    const { result } = mount(false)
    await tick()
    expect(ids(result.current.entries)).toEqual(['a'])
    expect(mockFetch).toHaveBeenLastCalledWith('p1', 'a1', {
      cursor: undefined,
    })
  })

  it('drops a failed read after the store was let go', async () => {
    let reject: (e: unknown) => void = () => {}
    mockFetch.mockImplementationOnce(
      () =>
        new Promise<TranscriptPage>((_, r) => {
          reject = r
        }),
    )
    const { unmount } = mount(true)
    await tick()
    unmount()
    await act(async () => reject(new Error('offline')))
    await tick(POLL_INTERVAL * 3)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('stops for a pane whose id now names another one', async () => {
    mockFetch.mockResolvedValue(page({ entries: [text('a')], reset: true }))
    mount(true, true, '%1')
    mount(true, true, '%2')
    await tick()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    act(() => remapPanes({ stale: new Set(['%1']), moved: new Map() }))
    await tick(POLL_INTERVAL)
    expect(mockFetch.mock.calls.filter((c) => c[0] === '%1')).toHaveLength(1)
    expect(mockFetch.mock.calls.filter((c) => c[0] === '%2')).toHaveLength(2)
  })

  it('pauses while the page is hidden', async () => {
    mockFetch.mockResolvedValue(page({ entries: [], cursor: 'c1' }))
    mount(true)
    await tick()
    visibility = 'hidden'
    await tick(POLL_INTERVAL * 3)
    const calls = mockFetch.mock.calls.length
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(POLL_INTERVAL * 3)
    expect(mockFetch).toHaveBeenCalledTimes(calls)
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick()
    expect(mockFetch.mock.calls.length).toBeGreaterThan(calls)
  })

  it('does not read again for an ended one shown again on screen', async () => {
    mockFetch.mockResolvedValue(page({ entries: [text('a')], reset: true }))
    mount(false)
    await tick()
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('reads right after a read in flight when asked meanwhile', async () => {
    let resolve: (p: TranscriptPage) => void = () => {}
    mockFetch
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptPage>((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue(page({ entries: [text('b')], cursor: 'c2' }))
    const { result } = mount(true)
    await tick()
    // Back on screen while the first read is in flight
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => resolve(page({ entries: [text('a')], reset: true })))
    await tick()
    expect(ids(result.current.entries)).toEqual(['a', 'b'])
  })

  it('drops a forward page read across a reset', async () => {
    let forward: (p: TranscriptPage) => void = () => {}
    mockFetch
      .mockResolvedValueOnce(
        page({ entries: [text('a')], reset: true, before: 'b1' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptPage>((r) => {
            forward = r
          }),
      )
      .mockResolvedValueOnce(page({ entries: [text('n')], reset: true }))
      .mockResolvedValue(page({ entries: [], cursor: 'c1' }))
    const { result } = mount(true)
    await tick()
    await tick(POLL_INTERVAL)
    // The older read finds the file replaced: its reset wins
    await act(async () => result.current.loadOlder())
    await act(async () => forward(page({ entries: [text('stale')] })))
    expect(ids(result.current.entries)).toEqual(['n'])
  })

  it('shares one store between two readers', async () => {
    mockFetch.mockResolvedValue(page({ entries: [text('a')], reset: true }))
    const one = mount(true)
    const two = mount(true)
    await tick()
    expect(mockFetch).toHaveBeenCalledTimes(1)
    one.unmount()
    await tick(POLL_INTERVAL)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(ids(two.result.current.entries)).toEqual(['a'])
  })

  it('takes its store back when mounted again at once (strict mode)', async () => {
    mockFetch.mockResolvedValue(page({ entries: [text('a')], reset: true }))
    const { result } = renderHook(
      () => useSubagentTranscript('p1', 'a1', true, true),
      { reactStrictMode: true },
    )
    await tick()
    expect(ids(result.current.entries)).toEqual(['a'])
    await tick(POLL_INTERVAL)
    expect(mockFetch.mock.calls.length).toBeGreaterThan(1)
  })

  it('drops an older page read after the store was let go', async () => {
    let older: (p: TranscriptPage) => void = () => {}
    mockFetch
      .mockResolvedValueOnce(
        page({ entries: [text('c')], reset: true, before: 'b1' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TranscriptPage>((r) => {
            older = r
          }),
      )
    const { result, unmount } = mount(false)
    await tick()
    act(() => {
      result.current.loadOlder()
    })
    const loading = result.current
    unmount()
    await act(async () => older(page({ entries: [text('b')] })))
    expect(loading.loadingOlder).toBe(true)
    expect(ids(loading.entries)).toEqual(['c'])
  })

  it('stops every store when reset (tests)', async () => {
    mockFetch.mockResolvedValue(page({ entries: [], cursor: 'c1' }))
    mount(true)
    await tick()
    resetSubagentTranscriptStores()
    await tick(POLL_INTERVAL * 3)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('reads nothing without a pane or a subagent', async () => {
    const { result, rerender } = renderHook(
      (p: { live: boolean }) =>
        useSubagentTranscript(undefined, undefined, p.live, true),
      { initialProps: { live: true } },
    )
    rerender({ live: false })
    await tick(POLL_INTERVAL)
    act(() => result.current.loadOlder())
    expect(result.current.loaded).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
