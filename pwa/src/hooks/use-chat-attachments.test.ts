import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatAttachments } from './use-chat-attachments'

const mockUpload = vi.fn()
vi.mock('../utils/upload-image', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-image')>()),
  uploadImage: (...a: unknown[]) => mockUpload(...a),
}))
vi.mock('../utils/image-thumbnail', () => ({
  imageThumbnail: async () => 'data:thumb',
}))

const png = () => new File(['x'], 'a.png', { type: 'image/png' })

beforeEach(() => vi.clearAllMocks())

describe('useChatAttachments', () => {
  it('an upload finishing after its image was removed changes nothing', async () => {
    let finish: (v: unknown) => void = () => {}
    mockUpload.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    const onError = vi.fn()
    const { result } = renderHook(() => useChatAttachments('%1', onError))
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.add(png())
    })
    expect(result.current.uploading).toBe(true)
    const key = result.current.items[0].key
    act(() => result.current.remove(key))
    await act(async () => {
      finish({ ok: false, reason: 'busy' })
      await pending
    })
    expect(result.current.items).toEqual([])
    expect(onError).toHaveBeenCalledWith(
      'Another upload is running. Try again in a moment.',
    )
  })

  it('marks only the ids the host lost; clear empties the list', async () => {
    mockUpload
      .mockResolvedValueOnce({
        ok: true,
        upload: { id: 'a', path: '', insert: '' },
      })
      .mockResolvedValueOnce({
        ok: true,
        upload: { id: 'b', path: '', insert: '' },
      })
    const { result } = renderHook(() => useChatAttachments('%1', vi.fn()))
    await act(async () => {
      await result.current.add(png())
      await result.current.add(png())
    })
    expect(result.current.ids).toEqual(['a', 'b'])
    expect(result.current.items[0].thumb).toBe('data:thumb')
    act(() => result.current.markGone(['b']))
    expect(result.current.ids).toEqual(['a'])
    expect(result.current.failed).toBe(true)
    act(() => result.current.clear())
    expect(result.current.items).toEqual([])
  })
})
