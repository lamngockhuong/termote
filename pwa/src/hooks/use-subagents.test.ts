import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchSubagents } = vi.hoisted(() => ({
  mockFetchSubagents: vi.fn(),
}))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchSubagents: (id: string) => mockFetchSubagents(id),
}))

import { resetSubagents, SUBAGENTS_POLL, useSubagents } from './use-subagents'

const tree = (id: string) => ({
  nodes: [{ id, type: 't', status: 'running', depth: 1, children: [] }],
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

describe('useSubagents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSubagents()
    mockFetchSubagents.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('reads nothing while closed', async () => {
    const { result } = renderHook(() => useSubagents('p1', false))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL * 2)
    })
    expect(mockFetchSubagents).not.toHaveBeenCalled()
    expect(result.current).toEqual({ error: false })
  })

  it('polls while open, stops when closed and keeps the last tree', async () => {
    mockFetchSubagents
      .mockResolvedValueOnce(tree('a'))
      .mockResolvedValueOnce(tree('b'))
    const { result, rerender } = renderHook(
      ({ open }) => useSubagents('p1', open),
      { initialProps: { open: true } },
    )
    await act(async () => {})
    expect(mockFetchSubagents).toHaveBeenCalledWith('p1')
    expect(result.current.tree?.nodes[0].id).toBe('a')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL)
    })
    expect(result.current.tree?.nodes[0].id).toBe('b')
    rerender({ open: false })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL * 3)
    })
    expect(mockFetchSubagents).toHaveBeenCalledTimes(2)
    expect(result.current.tree?.nodes[0].id).toBe('b')
  })

  it('keeps the tree on a failed read; a hidden page reads again when shown', async () => {
    mockFetchSubagents
      .mockResolvedValueOnce(tree('a'))
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce(tree('c'))
    const { result, unmount } = renderHook(() => useSubagents('p2', true))
    await act(async () => {})
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL)
    })
    expect(result.current.error).toBe(true)
    expect(result.current.tree?.nodes[0].id).toBe('a')
    setHidden(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL)
    })
    expect(mockFetchSubagents).toHaveBeenCalledTimes(2)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchSubagents).toHaveBeenCalledTimes(2)
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current.tree?.nodes[0].id).toBe('c')
    unmount()
  })

  it('two cards of one pane share one read', async () => {
    mockFetchSubagents.mockResolvedValue(tree('a'))
    const a = renderHook(() => useSubagents('p3', true))
    const b = renderHook(() => useSubagents('p3', true))
    await act(async () => {})
    expect(mockFetchSubagents).toHaveBeenCalledTimes(1)
    a.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL)
    })
    expect(mockFetchSubagents).toHaveBeenCalledTimes(2)
    b.unmount()
  })

  it('stops when the card closes during a read, and polls two panes apart', async () => {
    let finish: (v: unknown) => void = () => {}
    mockFetchSubagents.mockImplementationOnce(
      () => new Promise((r) => (finish = r)),
    )
    const one = renderHook(() => useSubagents('p4', true))
    one.unmount()
    await act(async () => finish(tree('late')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUBAGENTS_POLL * 2)
    })
    expect(mockFetchSubagents).toHaveBeenCalledTimes(1)

    mockFetchSubagents.mockResolvedValue(tree('x'))
    const a = renderHook(() => useSubagents('p5', true))
    const b = renderHook(() => useSubagents('p6', true))
    await act(async () => {})
    a.unmount()
    // Shown again: only the pane still open reads (p4 and p5 are closed).
    mockFetchSubagents.mockClear()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchSubagents.mock.calls).toEqual([['p6']])
    b.unmount()
  })
})
