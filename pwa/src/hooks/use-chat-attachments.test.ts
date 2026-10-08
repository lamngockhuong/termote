import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { remapPanes } from '../utils/pane-remap'
import {
  resetChatAttachments,
  useChatAttachments,
} from './use-chat-attachments'

const mockUpload = vi.fn()
vi.mock('../utils/upload-image', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-image')>()),
  uploadImage: (...a: unknown[]) => mockUpload(...a),
}))
vi.mock('../utils/image-thumbnail', () => ({
  imageThumbnail: async () => 'data:thumb',
}))

const png = () => new File(['x'], 'a.png', { type: 'image/png' })

beforeEach(() => {
  vi.clearAllMocks()
  resetChatAttachments()
})

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

  it('each pane has its own images, which follow it when its id shifts', async () => {
    const one = renderHook(() => useChatAttachments('1', vi.fn()))
    const two = renderHook(() => useChatAttachments('2', vi.fn()))
    const three = renderHook(() => useChatAttachments('3', vi.fn()))
    // Another pane's image, which the answer below leaves alone
    mockUpload.mockResolvedValueOnce({
      ok: true,
      upload: { id: 'y', path: '', insert: '' },
    })
    let finish: (v: unknown) => void = () => {}
    mockUpload.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    let pending: Promise<void> = Promise.resolve()
    await act(async () => {
      await three.result.current.add(png())
    })
    act(() => {
      pending = one.result.current.add(png())
    })
    expect(two.result.current.items).toEqual([])
    act(() =>
      remapPanes({ moved: new Map([['1', '2']]), stale: new Set(['1', '2']) }),
    )
    expect(one.result.current.items).toEqual([])
    expect(two.result.current.uploading).toBe(true)
    // The upload's answer finds the image where it is now
    await act(async () => {
      finish({ ok: true, upload: { id: 'x', path: '', insert: '' } })
      await pending
    })
    expect(two.result.current.ids).toEqual(['x'])
    expect(three.result.current.ids).toEqual(['y'])
  })

  it('at most five images per pane', async () => {
    mockUpload.mockResolvedValue({
      ok: true,
      upload: { id: 'a', path: '', insert: '' },
    })
    const onError = vi.fn()
    const { result } = renderHook(() => useChatAttachments('%1', onError))
    await act(async () => {
      for (let i = 0; i < 6; i++) await result.current.add(png())
    })
    expect(result.current.items).toHaveLength(5)
    expect(result.current.full).toBe(true)
    expect(onError).toHaveBeenCalledWith('At most 5 images per message.')
  })
})
