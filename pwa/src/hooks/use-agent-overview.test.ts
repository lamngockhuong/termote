import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchOverview } = vi.hoisted(() => ({ mockFetchOverview: vi.fn() }))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchOverview: () => mockFetchOverview(),
}))

import {
  OVERVIEW_POLL,
  resetAgentOverview,
  useAgentOverview,
} from './use-agent-overview'

const page = (text: string) => ({
  serverNow: 'now',
  panes: [{ paneId: 'p1', key: 'p1', lastText: text }],
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

describe('useAgentOverview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAgentOverview()
    mockFetchOverview.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('reads at once, then every poll while someone reads it', async () => {
    mockFetchOverview
      .mockResolvedValueOnce(page('one'))
      .mockResolvedValue(page('two'))
    const a = renderHook(() => useAgentOverview())
    const b = renderHook(() => useAgentOverview())
    await act(async () => {})
    expect(a.result.current.loaded).toBe(true)
    expect(a.result.current.panes.get('p1')?.lastText).toBe('one')
    expect(mockFetchOverview).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(b.result.current.panes.get('p1')?.lastText).toBe('two')
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
    a.unmount()
    b.unmount()
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 3)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
  })

  it('keeps the accounts, none when the server sends none', async () => {
    const account = {
      key: 'k1',
      agent: 'codex' as const,
      windows: [{ usedPercent: 2, windowMinutes: 300 }],
      updatedAt: '2026-10-14T01:00:00.000Z',
    }
    mockFetchOverview
      .mockResolvedValueOnce({ ...page('one'), accounts: [account] })
      .mockResolvedValue(page('two'))
    const { result } = renderHook(() => useAgentOverview())
    expect(result.current.accounts).toEqual([])
    await act(async () => {})
    expect(result.current.accounts).toEqual([account])
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(result.current.accounts).toEqual([])
  })

  it('keeps the last read through a failure', async () => {
    mockFetchOverview
      .mockResolvedValueOnce(page('one'))
      .mockRejectedValue(new Error('down'))
    const { result } = renderHook(() => useAgentOverview())
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(result.current.error).toBe(true)
    expect(result.current.panes.get('p1')?.lastText).toBe('one')
  })

  it('reads nothing while hidden, and at once when shown', async () => {
    setHidden(true)
    mockFetchOverview.mockResolvedValue(page('one'))
    const { result, unmount } = renderHook(() => useAgentOverview())
    await act(async () => {})
    expect(mockFetchOverview).not.toHaveBeenCalled()
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.loaded).toBe(true)
    // Hidden again: a visibilitychange to hidden reads nothing
    setHidden(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('never reads twice at once', async () => {
    let finish = (_v: unknown) => {}
    mockFetchOverview.mockReturnValue(
      new Promise((ok) => {
        finish = ok
      }),
    )
    const { unmount } = renderHook(() => useAgentOverview())
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(1)
    await act(async () => finish(page('x')))
    unmount()
  })

  it('schedules nothing once its last reader left during a read', async () => {
    let finish = (_v: unknown) => {}
    mockFetchOverview.mockReturnValue(
      new Promise((ok) => {
        finish = ok
      }),
    )
    const { unmount } = renderHook(() => useAgentOverview())
    unmount()
    await act(async () => finish(page('x')))
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 2)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(1)
  })

  it('polls at the period it is given', async () => {
    mockFetchOverview.mockResolvedValue(page('x'))
    const { unmount } = renderHook(() => useAgentOverview(10_000))
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(5_000)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
    unmount()
  })

  it('falls back to the default period for a bad one', async () => {
    mockFetchOverview.mockResolvedValue(page('x'))
    const { unmount } = renderHook(() => useAgentOverview(0))
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
    unmount()
  })
})
