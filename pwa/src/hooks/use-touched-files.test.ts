import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError, type TouchedFiles } from './use-mux-api'
import { TOUCHED_POLL, useTouchedFiles } from './use-touched-files'

const mockFetch = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchTouchedFiles: (...a: unknown[]) => mockFetch(...a),
}))

const files = (path: string): TouchedFiles => ({
  files: [{ path, sensitive: false }],
  skipped: 0,
  truncated: false,
})

let hidden = false
beforeEach(() => {
  vi.useFakeTimers()
  mockFetch.mockReset()
  hidden = false
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

const flush = () => act(async () => {})

describe('useTouchedFiles', () => {
  it('reads nothing while disabled', async () => {
    renderHook(() => useTouchedFiles('p1', false))
    await flush()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("polls the pane's running session while the page is visible", async () => {
    mockFetch.mockResolvedValueOnce(files('a.ts'))
    const { result, unmount } = renderHook(() => useTouchedFiles('p1', true))
    await flush()
    expect(mockFetch).toHaveBeenCalledWith('p1', undefined)
    expect(result.current.data?.files[0].path).toBe('a.ts')
    // A failed poll keeps what was read
    mockFetch.mockRejectedValueOnce(new Error('down'))
    await act(async () => vi.advanceTimersByTime(TOUCHED_POLL))
    expect(result.current).toMatchObject({
      error: 'failed',
      data: { files: [{ path: 'a.ts' }] },
    })
    // Hidden: no read until it shows again
    hidden = true
    await act(async () => vi.advanceTimersByTime(TOUCHED_POLL))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockFetch).toHaveBeenCalledTimes(2)
    hidden = false
    mockFetch.mockResolvedValueOnce(files('b.ts'))
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(result.current).toEqual({ data: files('b.ts') })
    unmount()
    await act(async () => vi.advanceTimersByTime(TOUCHED_POLL * 2))
    expect(mockFetch).toHaveBeenCalledTimes(3)
  })

  it('reads an old session once, telling why it could not', async () => {
    const one = { agent: 'codex' as const, id: 's1' }
    mockFetch.mockRejectedValueOnce(
      new RequestError(403, 'view_only', 'view-only device'),
    )
    const { result, rerender } = renderHook(
      ({ id }) => useTouchedFiles('p1', true, { ...one, id }),
      { initialProps: { id: 's1' } },
    )
    await flush()
    expect(mockFetch).toHaveBeenCalledWith('p1', one)
    expect(result.current.error).toBe('view-only')
    await act(async () => vi.advanceTimersByTime(TOUCHED_POLL * 2))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // A visible page does not read it again
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    mockFetch.mockRejectedValueOnce(new RequestError(404, '', 'gone'))
    rerender({ id: 's2' })
    await flush()
    expect(result.current.error).toBe('none')
    mockFetch.mockRejectedValueOnce(new RequestError(500, 'internal', 'x'))
    rerender({ id: 's3' })
    await flush()
    expect(result.current.error).toBe('failed')
  })

  it('drops an answer that comes after it stopped', async () => {
    let resolve: (v: TouchedFiles) => void = () => {}
    mockFetch.mockReturnValueOnce(
      new Promise<TouchedFiles>((r) => {
        resolve = r
      }),
    )
    const { result, rerender } = renderHook(
      ({ on }) => useTouchedFiles('p1', on),
      { initialProps: { on: true } },
    )
    // Shown again while it reads: no second read
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    rerender({ on: false })
    await act(async () => resolve(files('late.ts')))
    expect(result.current).toEqual({})
    let reject: (e: Error) => void = () => {}
    mockFetch.mockReturnValueOnce(
      new Promise<TouchedFiles>((_, r) => {
        reject = r
      }),
    )
    rerender({ on: true })
    rerender({ on: false })
    await act(async () => reject(new Error('late')))
    expect(result.current).toEqual({})
  })
})
