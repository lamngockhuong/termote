import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentMachineForTest } from '../utils/api-base'

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchMachines: () => mockFetch(),
}))

import { MACHINES_IDLE_POLL, MACHINES_POLL, useMachines } from './use-machines'
import { RequestError } from './use-mux-api'

const BOX = { id: '0123456789abcdef', label: 'Box', status: 'online' }

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

describe('useMachines', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetch.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
    setCurrentMachineForTest('')
  })

  it('reads at once, then often while there is a machine', async () => {
    mockFetch.mockResolvedValue([BOX])
    const { result, unmount } = renderHook(() => useMachines())
    await act(async () => {})
    expect(result.current).toEqual([BOX])
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL)
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    unmount()
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL * 3)
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('reads seldom while there is none, often with a machine open', async () => {
    mockFetch.mockResolvedValue([])
    renderHook(() => useMachines())
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL)
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_IDLE_POLL)
    })
    expect(mockFetch).toHaveBeenCalledTimes(2)
    setCurrentMachineForTest(BOX.id)
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_IDLE_POLL)
    })
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL)
    })
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })

  it('keeps the last list on a failure, and stops on an old server', async () => {
    mockFetch
      .mockResolvedValueOnce([BOX])
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new RequestError(404, '', 'not found'))
    const { result } = renderHook(() => useMachines())
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL)
    })
    expect(result.current).toEqual([BOX])
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL)
    })
    await act(async () => {
      vi.advanceTimersByTime(MACHINES_POLL * 10)
    })
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('reads nothing while hidden, and at once when shown', async () => {
    mockFetch.mockResolvedValue([BOX])
    setHidden(true)
    renderHook(() => useMachines())
    await act(async () => {})
    expect(mockFetch).not.toHaveBeenCalled()
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    setHidden(true)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
