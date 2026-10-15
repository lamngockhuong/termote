import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetchOverview } = vi.hoisted(() => ({ mockFetchOverview: vi.fn() }))
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchOverview: (pane?: string) => mockFetchOverview(pane),
}))

import { OVERVIEW_POLL } from './use-agent-overview'
import { usePaneOverview } from './use-pane-overview'

const page = (pane: string, text: string) => ({
  serverNow: 'now',
  panes: [{ paneId: pane, key: pane, lastText: text }],
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    value: hidden,
    configurable: true,
  })
}

type Props = { pane?: string; on: boolean; every?: number }
const render = (initialProps: Props) =>
  renderHook(
    ({ pane, on, every = OVERVIEW_POLL }: Props) =>
      usePaneOverview(pane, every, on),
    { initialProps },
  )

describe('usePaneOverview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockFetchOverview.mockReset()
    setHidden(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    setHidden(false)
  })

  it('reads its pane at once, then every period, until unmounted', async () => {
    mockFetchOverview
      .mockResolvedValueOnce(page('p1', 'one'))
      .mockResolvedValue(page('p1', 'two'))
    const { result, unmount } = render({ pane: 'p1', on: true, every: 0 })
    await act(async () => {})
    expect(mockFetchOverview).toHaveBeenLastCalledWith('p1')
    expect(result.current?.panes[0].lastText).toBe('one')
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(result.current?.panes[0].lastText).toBe('two')
    unmount()
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 3)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
  })

  it('reads nothing while off or without a pane', async () => {
    mockFetchOverview.mockResolvedValue(page('p1', 'one'))
    const { result, rerender } = render({ pane: 'p1', on: false })
    rerender({ pane: undefined, on: true })
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 2)
    })
    expect(mockFetchOverview).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
  })

  it('keeps the last read through a failure, and hides it when turned off', async () => {
    mockFetchOverview
      .mockResolvedValueOnce(page('p1', 'one'))
      .mockRejectedValue(new Error('down'))
    const { result, rerender } = render({ pane: 'p1', on: true })
    await act(async () => {})
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL)
    })
    expect(mockFetchOverview).toHaveBeenCalledTimes(2)
    expect(result.current?.panes[0].lastText).toBe('one')
    rerender({ pane: 'p1', on: false })
    expect(result.current).toBeUndefined()
  })

  it("never shows another pane's read, nor one that ends after a switch", async () => {
    let finish: (v: unknown) => void = () => {}
    mockFetchOverview
      .mockResolvedValueOnce(page('p1', 'one'))
      .mockReturnValueOnce(
        new Promise((r) => {
          finish = r
        }),
      )
      .mockResolvedValue(page('p3', 'three'))
    const { result, rerender } = render({ pane: 'p1', on: true })
    await act(async () => {})
    rerender({ pane: 'p2', on: true })
    expect(result.current).toBeUndefined()
    rerender({ pane: 'p3', on: true })
    await act(async () => {
      finish(page('p2', 'late'))
    })
    expect(result.current?.panes[0].lastText).toBe('three')
  })

  it('reads nothing while hidden, and at once when shown', async () => {
    setHidden(true)
    mockFetchOverview.mockResolvedValue(page('p1', 'one'))
    const { result } = render({ pane: 'p1', on: true })
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_POLL * 2)
    })
    expect(mockFetchOverview).not.toHaveBeenCalled()
    // Still hidden: a visibility event changes nothing
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchOverview).not.toHaveBeenCalled()
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      // A second event while that read runs starts no other
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mockFetchOverview).toHaveBeenCalledOnce()
    expect(result.current?.panes[0].lastText).toBe('one')
  })
})
