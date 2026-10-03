import { afterEach, describe, expect, it, vi } from 'vitest'
import { imageThumbnail } from './image-thumbnail'

const bitmap = (width: number, height: number) => ({
  width,
  height,
  close: vi.fn(),
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('imageThumbnail', () => {
  it('scales down to fit and returns a data: URL', async () => {
    const b = bitmap(1000, 500)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => b),
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/png;base64,AA==',
    )
    expect(await imageThumbnail(new Blob(['x']))).toBe(
      'data:image/png;base64,AA==',
    )
    expect(drawImage).toHaveBeenCalledWith(b, 0, 0, 128, 64)
    expect(b.close).toHaveBeenCalled()
  })

  it('never scales up', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap(10, 20)),
    )
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:')
    await imageThumbnail(new Blob(['x']))
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 10, 20)
  })

  it('null without a 2D context', async () => {
    const b = bitmap(10, 10)
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => b),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    expect(await imageThumbnail(new Blob(['x']))).toBeNull()
    expect(b.close).toHaveBeenCalled()
  })

  it('null when the image cannot be decoded', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('bad image')
      }),
    )
    expect(await imageThumbnail(new Blob(['x']))).toBeNull()
  })
})
