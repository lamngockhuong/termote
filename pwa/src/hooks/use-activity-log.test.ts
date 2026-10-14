import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchActivity } = vi.hoisted(() => ({ mockFetchActivity: vi.fn() }))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchActivity: (after?: number) => mockFetchActivity(after),
}))

import {
  ACTIVITY_MAX,
  ACTIVITY_POLL,
  renameActivityGroup,
  resetActivityLog,
  useActivityLog,
} from './use-activity-log'

const event = (seq: number, key = 'zA:p0') => ({
  seq,
  ts: '2026-10-13T10:00:00Z',
  key,
  groupId: 'zA',
  tabId: 'zA:t0',
  paneId: key,
  agent: 'claude',
  from: '',
  to: 'working',
})

const page = (seqs: number[], reset = false, latest = seqs.at(-1) ?? 0) => ({
  events: seqs.map((s) => event(s)),
  latest,
  oldest: seqs[0] ?? 0,
  reset,
  serverNow: 'now',
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

describe('useActivityLog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetActivityLog()
    mockFetchActivity.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('reads everything first, then only what is newer', async () => {
    mockFetchActivity
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3]))
    const { result } = renderHook(() => useActivityLog())
    await act(async () => {})
    expect(mockFetchActivity).toHaveBeenLastCalledWith(undefined)
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2])
    expect(result.current.loaded).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL)
    })
    expect(mockFetchActivity).toHaveBeenLastCalledWith(2)
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3])
    // A read with nothing new keeps the same array.
    const before = result.current.events
    mockFetchActivity.mockResolvedValueOnce(page([], false, 3))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL)
    })
    expect(result.current.events).toBe(before)
  })

  it('a reset replaces the events; at most ACTIVITY_MAX are kept', async () => {
    const many = Array.from({ length: ACTIVITY_MAX + 3 }, (_, i) => i + 1)
    mockFetchActivity
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page(many, true))
    const { result } = renderHook(() => useActivityLog(1000))
    await act(async () => {})
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.events).toHaveLength(ACTIVITY_MAX)
    expect(result.current.events[0].seq).toBe(4)
  })

  it('keeps the events when a read fails, and reads nothing while hidden', async () => {
    mockFetchActivity
      .mockResolvedValueOnce(page([1], true))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(page([2]))
    const { result, unmount } = renderHook(() => useActivityLog(0))
    await act(async () => {})
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL)
    })
    expect(result.current.error).toBe(true)
    expect(result.current.events).toHaveLength(1)
    setHidden(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL)
    })
    expect(mockFetchActivity).toHaveBeenCalledTimes(2)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchActivity).toHaveBeenCalledTimes(2)
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchActivity).toHaveBeenCalledTimes(3)
    expect(result.current.error).toBe(false)
    unmount()
    // Hidden again with nobody reading: nothing is read.
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockFetchActivity).toHaveBeenCalledTimes(3)
  })

  it('moves the events of a renamed group to its new ids', async () => {
    // Nothing held: nothing to move.
    renameActivityGroup('zA', 'zN')
    mockFetchActivity.mockResolvedValueOnce({
      ...page([1], true),
      events: [event(1), event(2, 'zAB:p0')],
    })
    const { result } = renderHook(() => useActivityLog())
    await act(async () => {})
    act(() => renameActivityGroup('zA', 'zN'))
    expect(result.current.events[0]).toMatchObject({
      key: 'zN:p0',
      groupId: 'zN',
      tabId: 'zN:t0',
      paneId: 'zN:p0',
    })
    // Another session whose name starts the same is left alone.
    expect(result.current.events[1].key).toBe('zAB:p0')
  })

  it('two readers share one poll, which stops with the last', async () => {
    mockFetchActivity.mockResolvedValue(page([1], true))
    const a = renderHook(() => useActivityLog())
    const b = renderHook(() => useActivityLog())
    await act(async () => {})
    expect(mockFetchActivity).toHaveBeenCalledTimes(1)
    a.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL)
    })
    expect(mockFetchActivity).toHaveBeenCalledTimes(2)
    b.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVITY_POLL * 2)
    })
    expect(mockFetchActivity).toHaveBeenCalledTimes(2)
  })
})
