import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePaneText } from './use-pane-text'

const fetchPaneText = vi.hoisted(() =>
  vi.fn<
    (
      pane: string,
      lines: number,
      signal?: AbortSignal,
    ) => Promise<{
      text: string
      lines: number
      truncated: boolean
      more?: boolean
    }>
  >(),
)
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchPaneText,
}))

describe('usePaneText', () => {
  const readBuffer = vi.fn(() => 'screen only')
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the history from the server, then more of it', async () => {
    fetchPaneText.mockResolvedValueOnce({
      text: 'old\nnew',
      lines: 2,
      truncated: false,
      more: true,
    })
    const { result } = renderHook(() =>
      usePaneText({ paneId: 'w1:p2', useServer: true, readBuffer }),
    )
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({
      text: 'old\nnew',
      source: 'server',
      truncated: false,
      canLoadMore: true,
    })
    expect(fetchPaneText).toHaveBeenCalledWith(
      'w1:p2',
      1000,
      expect.any(AbortSignal),
    )

    fetchPaneText.mockResolvedValueOnce({
      text: 'older\nold\nnew',
      lines: 3,
      truncated: false,
      // More still, but 5000 is the most it reads
      more: true,
    })
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.text).toBe('older\nold\nnew'))
    expect(fetchPaneText).toHaveBeenLastCalledWith(
      'w1:p2',
      5000,
      expect.any(AbortSignal),
    )
    expect(result.current.canLoadMore).toBe(false)
    expect(readBuffer).not.toHaveBeenCalled()
  })

  it('offers no more when the server holds none', async () => {
    fetchPaneText.mockResolvedValueOnce({
      text: 'x',
      lines: 40,
      truncated: false,
    })
    const { result } = renderHook(() =>
      usePaneText({ paneId: '0', useServer: true, readBuffer }),
    )
    await waitFor(() => expect(result.current.source).toBe('server'))
    expect(result.current.canLoadMore).toBe(false)
  })

  it('reads the terminal buffer without the server, or without a pane', () => {
    const view = renderHook(() =>
      usePaneText({ paneId: '0', useServer: false, readBuffer }),
    )
    expect(view.result.current).toMatchObject({
      text: 'screen only',
      source: 'buffer',
      loading: false,
      canLoadMore: false,
    })
    const none = renderHook(() =>
      usePaneText({ paneId: undefined, useServer: true, readBuffer }),
    )
    expect(none.result.current.source).toBe('buffer')
    expect(fetchPaneText).not.toHaveBeenCalled()
  })

  it('falls back to the buffer when the read fails', async () => {
    fetchPaneText.mockRejectedValueOnce(new Error('501'))
    const { result } = renderHook(() =>
      usePaneText({ paneId: '0', useServer: true, readBuffer }),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({
      text: 'screen only',
      source: 'buffer',
    })
  })

  it('aborts a read still running on unmount, and shows nothing of it', async () => {
    let signal: AbortSignal | undefined
    fetchPaneText.mockImplementationOnce(
      (_p, _l, s) =>
        new Promise((_resolve, reject) => {
          signal = s
          s?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const { unmount } = renderHook(() =>
      usePaneText({ paneId: '0', useServer: true, readBuffer }),
    )
    unmount()
    expect(signal?.aborted).toBe(true)
    await Promise.resolve()
    expect(readBuffer).not.toHaveBeenCalled()
  })
})
