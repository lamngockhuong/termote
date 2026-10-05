import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ImageRequest,
  type ImageState,
  imageErrorCode,
  useImageBlob,
} from './use-image-blob'
import { RequestError } from './use-mux-api'

const mockImage = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
}))

// A promise settled by the test, and the signal its read was given
function pending() {
  let resolve!: (b: Blob) => void
  let reject!: (e: unknown) => void
  const p = new Promise<Blob>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { p, resolve, reject }
}

const blob = (s = 'png') => new Blob([s], { type: 'image/png' })
const signalOf = (call: number) => mockImage.mock.calls[call][3] as AbortSignal

let made = 0
beforeEach(() => {
  made = 0
  mockImage.mockReset()
  URL.createObjectURL = vi.fn(() => `blob:u${++made}`)
  URL.revokeObjectURL = vi.fn()
})

type HookProps = {
  req: ImageRequest | null
  reloadKey: string
  onRootChanged?: (root: string) => void
}
function hook(initial: HookProps) {
  return renderHook(
    (p: HookProps) => useImageBlob('%1', p.req, p.reloadKey, p.onRootChanged),
    { initialProps: initial },
  )
}

describe('useImageBlob', () => {
  it('reads nothing without a request', () => {
    const { result } = hook({ req: null, reloadKey: '' })
    expect(result.current).toEqual({ status: 'idle' })
    expect(mockImage).not.toHaveBeenCalled()
  })

  it('reads the image into a blob: URL with its size', async () => {
    mockImage.mockResolvedValue(blob('12345'))
    const { result } = hook({
      req: {
        path: 'b.png',
        root: '/r',
        reveal: true,
        side: 'old',
        staged: true,
        orig: 'a.png',
      },
      reloadKey: '',
    })
    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current).toEqual({
      status: 'ready',
      url: 'blob:u1',
      size: 5,
      type: 'image/png',
      stale: false,
    })
    expect(mockImage).toHaveBeenCalledWith(
      '%1',
      'b.png',
      { root: '/r', reveal: true, side: 'old', staged: true, orig: 'a.png' },
      expect.any(AbortSignal),
    )
  })

  it('compares the request by value: a new object reads nothing again', async () => {
    mockImage.mockResolvedValue(blob())
    const { result, rerender } = hook({
      req: { path: 'a.png' },
      reloadKey: '1',
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ req: { path: 'a.png' }, reloadKey: '1' })
    expect(mockImage).toHaveBeenCalledTimes(1)
  })

  it('keeps the earlier image while reading again, then revokes it', async () => {
    const first = pending()
    const second = pending()
    mockImage.mockReturnValueOnce(first.p).mockReturnValueOnce(second.p)
    const { result, rerender } = hook({
      req: { path: 'a.png' },
      reloadKey: '1',
    })
    await act(async () => first.resolve(blob()))
    rerender({ req: { path: 'a.png' }, reloadKey: '2' })
    expect(result.current).toEqual({
      status: 'ready',
      url: 'blob:u1',
      size: 3,
      type: 'image/png',
      stale: true,
    })
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    await act(async () => second.resolve(blob()))
    expect(result.current).toMatchObject({ url: 'blob:u2', stale: false })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:u1')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:u2')
  })

  it('makes no URL for a blob that arrives after unmount, and revokes on unmount', async () => {
    const late = pending()
    mockImage.mockResolvedValueOnce(blob()).mockReturnValueOnce(late.p)
    const { result, rerender, unmount } = hook({
      req: { path: 'a.png' },
      reloadKey: '1',
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ req: { path: 'a.png' }, reloadKey: '2' })
    unmount()
    expect(signalOf(1).aborted).toBe(true)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:u1')
    await act(async () => late.resolve(blob()))
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  })

  it('swallows the abort of a read it replaced', async () => {
    const first = pending()
    mockImage.mockReturnValueOnce(first.p).mockResolvedValueOnce(blob())
    const { result, rerender } = hook({
      req: { path: 'a.png' },
      reloadKey: '',
    })
    rerender({ req: { path: 'b.png' }, reloadKey: '' })
    expect(signalOf(0).aborted).toBe(true)
    await act(async () =>
      first.reject(new DOMException('aborted', 'AbortError')),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mockImage.mock.calls[1][1]).toBe('b.png')
  })

  it('reports a refusal, and an error after an image drops it', async () => {
    const err = new RequestError(413, 'too_large', 'too large')
    mockImage.mockResolvedValueOnce(blob()).mockRejectedValueOnce(err)
    const { result, rerender } = hook({
      req: { path: 'a.png' },
      reloadKey: '1',
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ req: { path: 'a.png' }, reloadKey: '2' })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current).toEqual({ status: 'error', error: err })
    expect(imageErrorCode(result.current)).toBe('too_large')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:u1')
  })

  it('hands a 409 to onRootChanged, else reports it', async () => {
    const moved = new RequestError(
      409,
      '',
      'root changed',
      undefined,
      undefined,
      '/new',
    )
    mockImage.mockRejectedValue(moved)
    const onRootChanged = vi.fn()
    const { result } = hook({
      req: { path: 'a.png' },
      reloadKey: '',
      onRootChanged,
    })
    await waitFor(() => expect(onRootChanged).toHaveBeenCalledWith('/new'))
    expect(result.current.status).toBe('loading')

    const other = hook({ req: { path: 'a.png' }, reloadKey: '' })
    await waitFor(() => expect(other.result.current.status).toBe('error'))
    // A 409 without a root is an error too
    mockImage.mockRejectedValue(new RequestError(409, '', 'root changed'))
    const bare = hook({ req: { path: 'a.png' }, reloadKey: '', onRootChanged })
    await waitFor(() => expect(bare.result.current.status).toBe('error'))
  })

  it('goes idle and revokes when the request goes away', async () => {
    mockImage.mockResolvedValue(blob())
    const { result, rerender } = hook({
      req: { path: 'a.png' },
      reloadKey: '',
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ req: null, reloadKey: '' })
    expect(result.current).toEqual({ status: 'idle' })
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:u1')
  })
})

describe('imageErrorCode', () => {
  it.each<[ImageState, string]>([
    [{ status: 'error', error: new RequestError(429, 'busy', 'busy') }, 'busy'],
    [{ status: 'error', error: new TypeError('offline') }, ''],
    [{ status: 'loading' }, ''],
  ])('%o → %s', (state, code) => {
    expect(imageErrorCode(state)).toBe(code)
  })
})
