import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { remapPanes } from '../utils/pane-remap'
import {
  foldToolResults,
  POLL_INTERVAL,
  resetAgentTranscriptStores,
  useAgentTranscript,
} from './use-agent-transcript'
import {
  AgentRequestError,
  type TranscriptEntry,
  type TranscriptPage,
} from './use-mux-api'

const mockFetchTranscript = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchTranscript: (...a: unknown[]) => mockFetchTranscript(...a),
}))

const text = (id: string, t = id): TranscriptEntry => ({
  id,
  role: 'assistant',
  parts: [{ kind: 'text', text: t }],
})

const page = (over: Partial<TranscriptPage>): TranscriptPage => ({
  agent: 'claude',
  sessionId: 's1',
  status: 'idle',
  entries: [],
  cursor: 'c1',
  reset: false,
  ...over,
})

let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.useFakeTimers()
  resetAgentTranscriptStores()
  mockFetchTranscript.mockReset()
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

// Lets the scheduled poll run and its promise settle.
const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('foldToolResults', () => {
  it('moves a later result onto its call and drops the emptied entry', () => {
    const entries: TranscriptEntry[] = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            tool: 'Bash',
            toolId: 't1',
            input: 'ls',
            clipped: true,
          },
        ],
      },
      {
        id: 'b',
        role: 'user',
        parts: [
          {
            kind: 'tool',
            tool: 'result',
            toolId: 't1',
            result: 'out',
            isError: true,
            orphan: true,
          },
        ],
      },
    ]
    const out = foldToolResults(entries)
    expect(out).toEqual([
      {
        id: 'a',
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            tool: 'Bash',
            toolId: 't1',
            input: 'ls',
            result: 'out',
            isError: true,
            clipped: true,
          },
        ],
      },
    ])
    // The input is not changed
    expect(entries[0].parts[0].result).toBeUndefined()
  })

  it('a result in the same entry as its call folds too; one without a call stays', () => {
    const out = foldToolResults([
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { kind: 'tool', tool: 'Read', toolId: 't1' },
          {
            kind: 'tool',
            toolId: 't1',
            result: 'r',
            orphan: true,
            clipped: true,
          },
          { kind: 'tool', toolId: 'gone', result: 'old', orphan: true },
          { kind: 'tool', tool: 'Grep' },
        ],
      },
    ])
    expect(out[0].parts).toEqual([
      { kind: 'tool', tool: 'Read', toolId: 't1', result: 'r', clipped: true },
      { kind: 'tool', toolId: 'gone', result: 'old', orphan: true },
      { kind: 'tool', tool: 'Grep' },
    ])
  })
})

describe('useAgentTranscript', () => {
  it('reads from the end, then follows with the cursor', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(
        page({ entries: [text('1')], reset: true, before: 'b0' }),
      )
      .mockResolvedValueOnce(page({ entries: [text('2')], cursor: 'c2' }))
      .mockResolvedValue(page({ cursor: 'c2' }))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    expect(result.current.loaded).toBe(false)
    await tick()
    expect(result.current).toMatchObject({
      loaded: true,
      sessionId: 's1',
      status: 'idle',
      cursor: 'c1',
      before: 'b0',
    })
    expect(mockFetchTranscript).toHaveBeenLastCalledWith('p1', {
      cursor: undefined,
    })
    await tick(POLL_INTERVAL)
    expect(mockFetchTranscript).toHaveBeenLastCalledWith('p1', { cursor: 'c1' })
    expect(result.current.entries.map((e) => e.id)).toEqual(['1', '2'])
    // A later page keeps the before of the first one
    expect(result.current.before).toBe('b0')
  })

  it('a reset replaces everything (another session)', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(page({ entries: [text('1')], reset: true }))
      .mockResolvedValueOnce(
        page({ entries: [text('x')], reset: true, sessionId: 's2' }),
      )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await tick(POLL_INTERVAL)
    expect(result.current.entries.map((e) => e.id)).toEqual(['x'])
    expect(result.current.sessionId).toBe('s2')
  })

  it('every reader of a pane shares one poll', async () => {
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    const a = renderHook(() => useAgentTranscript('p1'))
    const b = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await tick(POLL_INTERVAL)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(2)
    a.unmount()
    await tick(POLL_INTERVAL)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(3)
    // The last reader gone: no more polls
    b.unmount()
    await tick(POLL_INTERVAL * 4)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(3)
  })

  it('a hidden page does not poll, and polls at once when shown again', async () => {
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    renderHook(() => useAgentTranscript('p1'))
    await tick()
    visibility = 'hidden'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(POLL_INTERVAL * 10)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick()
    expect(mockFetchTranscript).toHaveBeenCalledTimes(2)
  })

  it('backs off on errors: 1.5, 3, 6, 12, 12 s', async () => {
    mockFetchTranscript.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    expect(result.current.error).toBe('unavailable')
    const calls = () => mockFetchTranscript.mock.calls.length
    for (const wait of [1500, 3000, 6000, 12000, 12000]) {
      const before = calls()
      await tick(wait - 1)
      expect(calls()).toBe(before)
      await tick(1)
      expect(calls()).toBe(before + 1)
    }
    // A success clears the error and the backoff
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    await tick(12000)
    expect(result.current.error).toBeUndefined()
    const before = calls()
    await tick(POLL_INTERVAL)
    expect(calls()).toBe(before + 1)
  })

  it('a 404 means there is no session', async () => {
    mockFetchTranscript.mockRejectedValue(
      new AgentRequestError(404, '', 'no agent session'),
    )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    expect(result.current.error).toBe('no-session')
  })

  it('refresh polls now', async () => {
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    act(() => result.current.refresh())
    await tick()
    expect(mockFetchTranscript).toHaveBeenCalledTimes(2)
  })

  it('a poll due while one is in flight is skipped', async () => {
    let resolve!: (p: TranscriptPage) => void
    mockFetchTranscript.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    act(() => result.current.refresh())
    await tick()
    expect(mockFetchTranscript).toHaveBeenCalledTimes(1)
    mockFetchTranscript.mockResolvedValue(page({}))
    await act(async () => resolve(page({ reset: true })))
    expect(result.current.loaded).toBe(true)
  })

  it('loads older entries before the ones held, folding results', async () => {
    mockFetchTranscript.mockResolvedValueOnce(
      page({
        reset: true,
        before: 'b1',
        entries: [
          {
            id: 'r',
            role: 'user',
            parts: [{ kind: 'tool', toolId: 't', result: 'ok', orphan: true }],
          },
        ],
      }),
    )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    let release!: () => void
    mockFetchTranscript.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () =>
            r(
              page({
                cursor: '',
                before: undefined,
                entries: [
                  {
                    id: 'c',
                    role: 'assistant',
                    parts: [{ kind: 'tool', tool: 'Bash', toolId: 't' }],
                  },
                ],
              }),
            )
        }),
    )
    act(() => {
      result.current.loadOlder()
    })
    expect(result.current.loadingOlder).toBe(true)
    // A second call while loading does nothing
    act(() => {
      result.current.loadOlder()
    })
    await act(async () => release())
    expect(mockFetchTranscript).toHaveBeenCalledWith('p1', { before: 'b1' })
    expect(result.current.loadingOlder).toBe(false)
    expect(result.current.before).toBeUndefined()
    expect(result.current.entries).toEqual([
      {
        id: 'c',
        role: 'assistant',
        parts: [
          {
            kind: 'tool',
            tool: 'Bash',
            toolId: 't',
            result: 'ok',
            isError: undefined,
            clipped: undefined,
          },
        ],
      },
    ])
    // Nothing older: no request
    const n = mockFetchTranscript.mock.calls.length
    act(() => {
      result.current.loadOlder()
    })
    expect(mockFetchTranscript).toHaveBeenCalledTimes(n)
  })

  it('older entries of a session that changed reset the list', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(
        page({ reset: true, before: 'b1', entries: [text('1')] }),
      )
      .mockResolvedValueOnce(
        page({ reset: true, sessionId: 's2', entries: [text('n')] }),
      )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await act(async () => result.current.loadOlder())
    expect(result.current.entries.map((e) => e.id)).toEqual(['n'])
    expect(result.current.sessionId).toBe('s2')
  })

  it('a failed older read can be asked again', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(page({ reset: true, before: 'b1' }))
      .mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await act(async () => result.current.loadOlder())
    expect(result.current).toMatchObject({ loadingOlder: false, before: 'b1' })
  })

  it('no pane: nothing is read', async () => {
    const { result } = renderHook(() => useAgentTranscript(undefined))
    act(() => {
      result.current.refresh()
      result.current.loadOlder()
    })
    await tick(POLL_INTERVAL)
    expect(mockFetchTranscript).not.toHaveBeenCalled()
    expect(result.current.loaded).toBe(false)
  })

  it('a reader that comes back starts from what was read', async () => {
    mockFetchTranscript.mockResolvedValueOnce(
      page({ reset: true, entries: [text('1')] }),
    )
    const a = renderHook(() => useAgentTranscript('p1'))
    await tick()
    a.unmount()
    mockFetchTranscript.mockResolvedValue(page({ cursor: 'c1' }))
    const b = renderHook(() => useAgentTranscript('p1'))
    expect(b.result.current.entries.map((e) => e.id)).toEqual(['1'])
    await tick()
    expect(mockFetchTranscript).toHaveBeenLastCalledWith('p1', { cursor: 'c1' })
  })

  it('loadOlder with no before does nothing', async () => {
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    const calls = mockFetchTranscript.mock.calls.length
    act(() => {
      result.current.loadOlder()
    })
    // loadOlder with no `before` is a no-op
    expect(mockFetchTranscript.mock.calls.length).toBe(calls)
  })

  it('a poll that brings nothing keeps the same state object', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(page({ reset: true, entries: [text('1')] }))
      .mockResolvedValue(page({}))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    const entries = result.current.entries
    const first = entries[0]
    await tick(POLL_INTERVAL)
    await tick(POLL_INTERVAL)
    expect(result.current.entries).toBe(entries)
    // A new status alone is passed on
    mockFetchTranscript.mockResolvedValue(page({ status: 'working' }))
    await tick(POLL_INTERVAL)
    expect(result.current.status).toBe('working')
    expect(result.current.entries).toBe(entries)
    // New entries leave the old ones as they were
    mockFetchTranscript.mockResolvedValue(page({ entries: [text('2')] }))
    await tick(POLL_INTERVAL)
    expect(result.current.entries[0]).toBe(first)
  })

  it('an empty page after an error clears the error', async () => {
    mockFetchTranscript
      .mockResolvedValueOnce(page({ reset: true }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(page({}))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await tick(POLL_INTERVAL)
    expect(result.current.error).toBe('unavailable')
    await tick(POLL_INTERVAL)
    expect(result.current.error).toBeUndefined()
  })

  it('a refresh asked for during a poll runs right after it', async () => {
    let resolve!: (p: TranscriptPage) => void
    mockFetchTranscript
      .mockResolvedValueOnce(page({ reset: true }))
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue(page({}))
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    await tick(POLL_INTERVAL)
    act(() => result.current.refresh())
    await act(async () => resolve(page({})))
    await tick(0)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(3)
  })

  it('older entries of the old session are dropped after a reset', async () => {
    mockFetchTranscript.mockResolvedValueOnce(
      page({ reset: true, before: 'b1', entries: [text('old')] }),
    )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    let older!: (p: TranscriptPage) => void
    mockFetchTranscript.mockImplementationOnce(
      () =>
        new Promise((r) => {
          older = r
        }),
    )
    act(() => {
      result.current.loadOlder()
    })
    // /clear: the poll resets to the new session
    mockFetchTranscript.mockResolvedValueOnce(
      page({ reset: true, sessionId: 's2', entries: [text('new')] }),
    )
    await tick(POLL_INTERVAL)
    await act(async () =>
      older(page({ entries: [text('older')], before: 'b0' })),
    )
    expect(result.current.entries.map((e) => e.id)).toEqual(['new'])
    expect(result.current.before).toBeUndefined()
    expect(result.current.loadingOlder).toBe(false)
  })

  it('a forward page read before a reset is dropped', async () => {
    mockFetchTranscript.mockResolvedValueOnce(
      page({ reset: true, before: 'b1', entries: [text('1')] }),
    )
    const { result } = renderHook(() => useAgentTranscript('p1'))
    await tick()
    let forward!: (p: TranscriptPage) => void
    mockFetchTranscript.mockImplementationOnce(
      () =>
        new Promise((r) => {
          forward = r
        }),
    )
    await tick(POLL_INTERVAL) // the poll is now in flight
    // loadOlder finds the file replaced and resets
    mockFetchTranscript.mockResolvedValueOnce(
      page({ reset: true, cursor: 'c9', entries: [text('1'), text('2')] }),
    )
    await act(async () => result.current.loadOlder())
    await act(async () => forward(page({ cursor: 'c5', entries: [text('2')] })))
    expect(result.current.entries.map((e) => e.id)).toEqual(['1', '2'])
    expect(result.current.cursor).toBe('c9')
  })

  it('a page shown again during a poll polls right after it', async () => {
    let resolve!: (p: TranscriptPage) => void
    mockFetchTranscript
      .mockResolvedValueOnce(page({ reset: true }))
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      .mockResolvedValue(page({}))
    renderHook(() => useAgentTranscript('p1'))
    await tick()
    await tick(POLL_INTERVAL)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await tick(0)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(2)
    await act(async () => resolve(page({})))
    await tick(0)
    expect(mockFetchTranscript).toHaveBeenCalledTimes(3)
  })
})

describe('useAgentTranscript and shifted ids', () => {
  it('a pane id that names another pane now starts again', async () => {
    mockFetchTranscript.mockResolvedValue(page({ reset: true }))
    const a = renderHook(() => useAgentTranscript('%1'))
    await tick()
    expect(a.result.current.loaded).toBe(true)
    a.unmount()
    remapPanes({ moved: new Map(), stale: new Set(['%1']) })
    const b = renderHook(() => useAgentTranscript('%1'))
    expect(b.result.current.loaded).toBe(false)
    b.unmount()
  })
})
