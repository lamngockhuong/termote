import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DocumentRequest,
  documentErrorCode,
  useDocumentBytes,
} from './use-document-bytes'
import { RequestError } from './use-mux-api'

const mockDocument = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFileDocument: (...a: unknown[]) => mockDocument(...a),
}))

function pending() {
  let resolve!: (b: Blob) => void
  let reject!: (e: unknown) => void
  const p = new Promise<Blob>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { p, resolve, reject }
}

const signalOf = (call: number) =>
  mockDocument.mock.calls[call][3] as AbortSignal

beforeEach(() => {
  mockDocument.mockReset()
})

type HookProps = {
  req: DocumentRequest | null
  reloadKey: string
  onRootChanged?: (root: string) => void
}
function hook(initial: HookProps) {
  return renderHook(
    (p: HookProps) =>
      useDocumentBytes('%1', p.req, p.reloadKey, p.onRootChanged),
    { initialProps: initial },
  )
}

describe('useDocumentBytes', () => {
  it('reads nothing without a request', () => {
    const { result } = hook({ req: null, reloadKey: '' })
    expect(result.current).toEqual({ status: 'idle' })
    expect(mockDocument).not.toHaveBeenCalled()
  })

  it('keeps the blob, whose bytes can be read again and again', async () => {
    const blob = new Blob(['%PDF-1.7'])
    mockDocument.mockResolvedValue(blob)
    const { result } = hook({
      req: { path: 'a.pdf', root: '/r', reveal: true },
      reloadKey: '',
    })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mockDocument).toHaveBeenCalledWith(
      '%1',
      'a.pdf',
      { root: '/r', reveal: true },
      expect.any(AbortSignal),
    )
    const state = result.current
    if (state.status !== 'ready') throw new Error('not ready')
    expect(state.size).toBe(8)
    // A transferred buffer is detached; the blob makes a new one each time
    const first = await state.blob.arrayBuffer()
    structuredClone(first, { transfer: [first] })
    expect(first.byteLength).toBe(0)
    expect((await state.blob.arrayBuffer()).byteLength).toBe(8)
  })

  it('reads again when reloadKey changes, not for an equal request', async () => {
    mockDocument.mockResolvedValue(new Blob(['x']))
    const { result, rerender } = hook({
      req: { path: 'a.pdf' },
      reloadKey: '0',
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ req: { path: 'a.pdf' }, reloadKey: '0' })
    expect(mockDocument).toHaveBeenCalledTimes(1)
    rerender({ req: { path: 'a.pdf' }, reloadKey: '1' })
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mockDocument).toHaveBeenCalledTimes(2)
    rerender({ req: null, reloadKey: '1' })
    expect(result.current).toEqual({ status: 'idle' })
  })

  it('tells a refusal by its code', async () => {
    const err = new RequestError(413, 'too_large', 'big', { size: 99 })
    mockDocument.mockRejectedValue(err)
    const { result } = hook({ req: { path: 'a.pdf' }, reloadKey: '' })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(documentErrorCode(result.current)).toBe('too_large')
    expect(documentErrorCode({ status: 'loading' })).toBe('')
    expect(documentErrorCode({ status: 'error', error: new Error('x') })).toBe(
      '',
    )
  })

  it('hands a 409 to onRootChanged', async () => {
    const onRootChanged = vi.fn()
    mockDocument.mockRejectedValue(
      new RequestError(409, '', 'root changed', { root: '/new' }),
    )
    const { result } = hook({
      req: { path: 'a.pdf' },
      reloadKey: '',
      onRootChanged,
    })
    await waitFor(() => expect(onRootChanged).toHaveBeenCalledWith('/new'))
    expect(result.current.status).toBe('loading')
  })

  it('a 409 without onRootChanged is an error', async () => {
    mockDocument.mockRejectedValue(
      new RequestError(409, '', 'root changed', { root: '/new' }),
    )
    const { result } = hook({ req: { path: 'a.pdf' }, reloadKey: '' })
    await waitFor(() => expect(result.current.status).toBe('error'))
  })

  it('drops a read that settles after the request changed', async () => {
    const first = pending()
    const second = pending()
    mockDocument
      .mockReturnValueOnce(first.p)
      .mockReturnValueOnce(second.p)
      .mockReturnValueOnce(pending().p)
    const { result, rerender, unmount } = hook({
      req: { path: 'a.pdf' },
      reloadKey: '',
    })
    rerender({ req: { path: 'b.pdf' }, reloadKey: '' })
    expect(signalOf(0).aborted).toBe(true)
    await act(async () => {
      first.resolve(new Blob(['old']))
      second.reject(new Error('x'))
    })
    // The first is dropped; the second is the one shown
    expect(result.current.status).toBe('error')
    rerender({ req: { path: 'c.pdf' }, reloadKey: '' })
    const late = pending()
    mockDocument.mockReturnValueOnce(late.p)
    unmount()
    expect(signalOf(2).aborted).toBe(true)
  })

  it('drops a refusal that arrives after cleanup', async () => {
    const p = pending()
    mockDocument.mockReturnValueOnce(p.p)
    const { result, unmount } = hook({ req: { path: 'a.pdf' }, reloadKey: '' })
    unmount()
    await act(async () => p.reject(new DOMException('aborted', 'AbortError')))
    expect(result.current.status).toBe('loading')
  })
})
