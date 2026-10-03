import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  imageFromClipboard,
  MAX_UPLOAD_BYTES,
  pickImageFile,
  type UploadErrorReason,
  uploadErrorMessage,
  uploadImage,
} from './upload-image'

const png = (size = 8) =>
  new Blob([new Uint8Array(size)], { type: 'image/png' })

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadImage', () => {
  it('posts the raw image and returns the upload', async () => {
    const upload = { id: 'a'.repeat(32), path: '/c/a.png', insert: '/c/a.png' }
    const fetchMock = stubFetch(200, upload)
    const image = png()
    expect(await uploadImage(image)).toEqual({ ok: true, upload })
    expect(fetchMock).toHaveBeenCalledWith('/api/mux/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      credentials: 'same-origin',
      body: image,
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    [413, 'too_large'],
    [415, 'unsupported_image'],
    [429, 'busy'],
    [503, 'uploads_unavailable'],
    [507, 'storage_full'],
  ] as const)('maps %i with code %s', async (status, code) => {
    stubFetch(status, { error: 'x', code })
    expect(await uploadImage(png())).toEqual({ ok: false, reason: code })
  })

  it('treats an old server (plain 404) as unavailable', async () => {
    stubFetch(404, { error: 'not found' })
    expect(await uploadImage(png())).toEqual({
      ok: false,
      reason: 'uploads_unavailable',
    })
  })

  it('reports an unknown code, a bad reply or a 200 without fields as failed', async () => {
    stubFetch(500, { error: 'upload failed', code: 'upload_failed' })
    expect(await uploadImage(png())).toEqual({ ok: false, reason: 'failed' })
    stubFetch(502, '<html>bad gateway</html>')
    expect(await uploadImage(png())).toEqual({ ok: false, reason: 'failed' })
    stubFetch(200, { id: 'x' })
    expect(await uploadImage(png())).toEqual({ ok: false, reason: 'failed' })
  })

  it('reports a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await uploadImage(png())).toEqual({ ok: false, reason: 'network' })
  })

  it('reports an upload that ran past its time limit', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException('timed out', 'TimeoutError')
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await uploadImage(png())).toEqual({ ok: false, reason: 'timeout' })
  })

  it('refuses before sending: HEIC, other types, over 10 MB', async () => {
    const fetchMock = stubFetch(200, {})
    for (const [blob, reason] of [
      [new Blob(['x'], { type: 'image/heic' }), 'heic'],
      [new Blob(['x'], { type: 'image/heif' }), 'heic'],
      [new Blob(['x'], { type: 'image/svg+xml' }), 'unsupported_image'],
      [new Blob(['x'], { type: '' }), 'unsupported_image'],
      [png(MAX_UPLOAD_BYTES + 1), 'too_large'],
    ] as const) {
      expect(await uploadImage(blob)).toEqual({ ok: false, reason })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('uploadErrorMessage', () => {
  it('has a message for every reason', () => {
    const reasons: UploadErrorReason[] = [
      'too_large',
      'unsupported_image',
      'heic',
      'busy',
      'storage_full',
      'uploads_unavailable',
      'network',
      'timeout',
      'failed',
    ]
    const messages = reasons.map(uploadErrorMessage)
    expect(new Set(messages).size).toBe(reasons.length)
    expect(uploadErrorMessage('heic')).toMatch(/JPEG/)
  })
})

// A DataTransfer stand-in: jsdom has none.
function clipboard(
  items: { kind: string; type: string; file?: File | null }[],
  types = items.map((i) => i.type),
): DataTransfer {
  return {
    types,
    items: items.map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => i.file ?? null,
    })),
  } as unknown as DataTransfer
}

describe('imageFromClipboard', () => {
  const file = new File(['x'], 'a.png', { type: 'image/png' })

  it('returns the image of an image-only paste', () => {
    expect(
      imageFromClipboard(
        clipboard([{ kind: 'file', type: 'image/png', file }]),
      ),
    ).toBe(file)
  })

  it('leaves a paste with text, without an image, or without data alone', () => {
    expect(imageFromClipboard(null)).toBeNull()
    expect(
      imageFromClipboard(
        clipboard([
          { kind: 'string', type: 'text/plain' },
          { kind: 'file', type: 'image/png', file },
        ]),
      ),
    ).toBeNull()
    expect(
      imageFromClipboard(
        clipboard([
          { kind: 'file', type: 'application/pdf', file },
          { kind: 'string', type: 'image/png' },
          { kind: 'file', type: 'image/gif', file: null },
        ]),
      ),
    ).toBeNull()
  })
})

describe('pickImageFile', () => {
  function interceptInput() {
    const created: HTMLInputElement[] = []
    const create = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(
      (tag: string, opts?: ElementCreationOptions) => {
        const el = create(tag, opts)
        if (el instanceof HTMLInputElement) {
          vi.spyOn(el, 'click').mockImplementation(() => {})
          created.push(el)
        }
        return el
      },
    )
    return created
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens an image picker and resolves to the chosen file', async () => {
    const created = interceptInput()
    const picked = pickImageFile()
    const input = created[0]
    expect(input.type).toBe('file')
    expect(input.accept).toBe('image/*')
    expect(input.hidden).toBe(true)
    expect(input.isConnected).toBe(true)
    expect(input.click).toHaveBeenCalled()
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change'))
    expect(await picked).toBe(file)
    expect(input.isConnected).toBe(false)
  })

  it('resolves to null when cancelled or nothing is chosen', async () => {
    const created = interceptInput()
    const cancelled = pickImageFile()
    created[0].dispatchEvent(new Event('cancel'))
    expect(await cancelled).toBeNull()
    expect(created[0].isConnected).toBe(false)
    const empty = pickImageFile()
    Object.defineProperty(created[1], 'files', { value: [] })
    created[1].dispatchEvent(new Event('change'))
    expect(await empty).toBeNull()
  })
})
