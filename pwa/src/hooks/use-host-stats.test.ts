import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchHostStats: () => mockFetch(),
}))

import { HOST_POLL, useHostStats } from './use-host-stats'

const stats = (cpu: number) => ({
  scope: 'host',
  cpu: { percent: cpu, count: 4 },
  load: null,
  memory: null,
  swap: null,
  disks: null,
  battery: null,
  sampledAt: 'now',
  history: [],
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

describe('useHostStats', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('reads at once, then every period, until unmounted', async () => {
    mockFetch.mockResolvedValueOnce(stats(1)).mockResolvedValue(stats(2))
    const { result, unmount } = renderHook(() => useHostStats(true))
    await act(async () => {})
    expect(result.current?.cpu?.percent).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL)
    })
    expect(result.current?.cpu?.percent).toBe(2)
    unmount()
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL * 3)
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('reads nothing while disabled', async () => {
    const { result } = renderHook(() => useHostStats(false))
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL * 2)
    })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })

  it('stops while hidden and reads once when shown again', async () => {
    mockFetch.mockResolvedValue(stats(5))
    renderHook(() => useHostStats(true))
    await act(async () => {})
    expect(mockFetch).toHaveBeenCalledTimes(1)
    setHidden(true)
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL * 3)
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('sets nothing when unmounted during a read, ok or failed', async () => {
    for (const settle of ['resolve', 'reject'] as const) {
      mockFetch.mockReset()
      let done: (v?: unknown) => void = () => {}
      mockFetch.mockReturnValue(
        new Promise((res, rej) => {
          done =
            settle === 'resolve'
              ? () => res(stats(1))
              : () => rej(new Error('x'))
        }),
      )
      const { unmount } = renderHook(() => useHostStats(true))
      unmount()
      await act(async () => {
        done()
      })
      await act(async () => {
        vi.advanceTimersByTime(HOST_POLL * 2)
      })
      expect(mockFetch).toHaveBeenCalledTimes(1)
    }
  })

  it('starts no second read while one is running, nor while hidden', async () => {
    let done: (v: unknown) => void = () => {}
    mockFetch.mockReturnValueOnce(new Promise((res) => (done = res)))
    renderHook(() => useHostStats(true))
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    setHidden(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      done(stats(3))
    })
  })

  it('clears what it showed when a read fails', async () => {
    mockFetch
      .mockResolvedValueOnce(stats(1))
      .mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useHostStats(true))
    await act(async () => {})
    expect(result.current).toBeDefined()
    await act(async () => {
      vi.advanceTimersByTime(HOST_POLL)
    })
    expect(result.current).toBeUndefined()
  })
})
