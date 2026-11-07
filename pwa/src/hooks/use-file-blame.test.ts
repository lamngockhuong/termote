import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type BlameRequest, useFileBlame } from './use-file-blame'
import { type FileBlame, RequestError } from './use-mux-api'

const mockBlame = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFileBlame: (...a: unknown[]) => mockBlame(...a),
}))

const blame: FileBlame = {
  root: '/r',
  path: 'a.ts',
  lines: 1,
  commits: { h: { author: 'A', time: 1, summary: 's' } },
  ranges: [{ start: 1, count: 1, commit: 'h' }],
  uncommitted: [],
}

type HookProps = { req: BlameRequest | null }
function hook(
  initial: HookProps,
  onChanged = vi.fn(),
  onRootChanged?: (root: string) => void,
) {
  return renderHook(
    (p: HookProps) => useFileBlame('%1', p.req, onChanged, onRootChanged),
    { initialProps: initial },
  )
}

const signalOf = (call: number) => mockBlame.mock.calls[call][3] as AbortSignal

beforeEach(() => {
  mockBlame.mockReset()
})

describe('useFileBlame', () => {
  it('reads nothing while off', () => {
    const { result } = hook({ req: null })
    expect(result.current).toEqual({ status: 'off' })
    expect(mockBlame).not.toHaveBeenCalled()
  })

  it('reads the blame of the bytes shown, again for a new hash', async () => {
    mockBlame.mockResolvedValue(blame)
    const req = { path: 'a.ts', hash: 'h1', root: '/r', place: 'p' }
    const { result, rerender } = hook({ req })
    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'ready', blame }),
    )
    expect(mockBlame).toHaveBeenCalledWith(
      { paneId: '%1', place: 'p' },
      'a.ts',
      { hash: 'h1', root: '/r', reveal: undefined },
      expect.any(AbortSignal),
    )
    // The same fields in a new object: no read
    rerender({ req: { ...req } })
    expect(mockBlame).toHaveBeenCalledTimes(1)
    rerender({ req: { ...req, hash: 'h2' } })
    await waitFor(() => expect(mockBlame).toHaveBeenCalledTimes(2))
    // Turned off
    rerender({ req: null })
    expect(result.current).toEqual({ status: 'off' })
  })

  it('aborts a read still running when the request changes or on unmount', async () => {
    mockBlame.mockReturnValue(new Promise(() => {}))
    const { rerender, unmount } = hook({ req: { path: 'a', hash: '1' } })
    rerender({ req: { path: 'a', hash: '2' } })
    expect(signalOf(0).aborted).toBe(true)
    unmount()
    expect(signalOf(1).aborted).toBe(true)
  })

  it('drops an answer that comes after an abort', async () => {
    let resolve!: (b: FileBlame) => void
    let reject!: (e: unknown) => void
    mockBlame
      .mockReturnValueOnce(
        new Promise((res) => {
          resolve = res
        }),
      )
      .mockReturnValueOnce(
        new Promise((_, rej) => {
          reject = rej
        }),
      )
      .mockReturnValue(new Promise(() => {}))
    const { result, rerender } = hook({ req: { path: 'a', hash: '1' } })
    rerender({ req: { path: 'a', hash: '2' } })
    rerender({ req: { path: 'a', hash: '3' } })
    resolve(blame)
    reject(new Error('x'))
    await Promise.resolve()
    await Promise.resolve()
    expect(result.current).toEqual({ status: 'loading' })
  })

  it('has no blame for a sensitive file not shown', async () => {
    mockBlame.mockResolvedValue({ sensitive: true })
    const { result } = hook({ req: { path: '.env', hash: '1' } })
    await waitFor(() => expect(result.current).toEqual({ status: 'off' }))
  })

  it.each([
    [new RequestError(404, 'not_repo', ''), 'not-repo'],
    [new RequestError(404, 'not_tracked', ''), 'not-tracked'],
    [new RequestError(413, 'too_large', ''), 'too-large'],
    [new RequestError(503, '', 'git timed out'), 'timeout'],
    [new RequestError(500, '', 'failed'), 'failed'],
    [new RequestError(409, 'other', ''), 'failed'],
    [new TypeError('offline'), 'failed'],
  ])('says why there is no blame: %s', async (e, error) => {
    mockBlame.mockRejectedValue(e)
    const { result } = hook({ req: { path: 'a', hash: '1' } })
    await waitFor(() =>
      expect(result.current).toEqual({ status: 'error', error }),
    )
  })

  it('reads the file again when it changed, follows a new root', async () => {
    const onChanged = vi.fn()
    const onRootChanged = vi.fn()
    mockBlame.mockRejectedValueOnce(new RequestError(409, 'file_changed', ''))
    const { result } = hook(
      { req: { path: 'a', hash: '1' } },
      onChanged,
      onRootChanged,
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(result.current).toEqual({ status: 'loading' })

    mockBlame.mockRejectedValueOnce(
      new RequestError(409, 'root_changed', '', { root: '/new' }),
    )
    hook({ req: { path: 'a', hash: '2' } }, onChanged, onRootChanged)
    await waitFor(() => expect(onRootChanged).toHaveBeenCalledWith('/new'))
    // Without a handler a new root is an error
    mockBlame.mockRejectedValueOnce(
      new RequestError(409, 'root_changed', '', { root: '/new' }),
    )
    const other = hook({ req: { path: 'a', hash: '3' } }, onChanged)
    await waitFor(() =>
      expect(other.result.current).toEqual({
        status: 'error',
        error: 'failed',
      }),
    )
  })
})
