import { afterEach, describe, expect, it, vi } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import {
  checkUpload,
  droppedFiles,
  type FileUploadReason,
  fileUploadErrorMessage,
  MAX_FILE_UPLOAD_BYTES,
  type UploadAt,
  uploadDir,
  uploadFile,
} from './upload-file'

const target = { paneId: '%1' }
const at: UploadAt = { root: '/r', dir: 'src', name: 'a b.pdf', reveal: false }
const file = (size = 3, type = 'application/pdf', name = 'a b.pdf') =>
  new File([new Uint8Array(size)], name, { type })

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// A fake XMLHttpRequest: the test plays the network through its handlers
class FakeXHR {
  static last: FakeXHR
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown
  status = 0
  responseText = ''
  aborted = false
  upload: {
    onprogress?: (e: Partial<ProgressEvent>) => void
    onload?: () => void
  } = {}
  onload?: () => void
  onerror?: () => void
  onabort?: () => void
  constructor() {
    FakeXHR.last = this
  }
  open(method: string, url: string) {
    this.method = method
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v
  }
  send(body: unknown) {
    this.body = body
  }
  abort() {
    this.aborted = true
    this.onabort?.()
  }
  answer(status: number, text: string) {
    this.status = status
    this.responseText = text
    this.onload?.()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadDir', () => {
  it.each([
    ['', '.'],
    ['src/', 'src'],
    ['src/lib', 'src/lib'],
  ])('%j → %s', (p, want) => expect(uploadDir(p)).toBe(want))
})

describe('checkUpload', () => {
  it('asks with check=1 and a JSON body, and returns the path it would get', async () => {
    const fetchMock = stubFetch(200, { root: '/r', path: 'src/a b (2).pdf' })
    expect(
      await checkUpload({ paneId: '%1', place: 'p1' }, at, file()),
    ).toEqual({
      ok: true,
      path: 'src/a b (2).pdf',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/mux/panes/%251/files/upload?root=%2Fr&dir=src&name=a+b.pdf&check=1&place=p1',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      },
    )
  })

  it('sends reveal=1 once the user agreed', async () => {
    const fetchMock = stubFetch(200, { root: '/r', path: 'x' })
    await checkUpload(target, { ...at, reveal: true }, file())
    expect(fetchMock.mock.calls[0][0]).toContain('reveal=1')
  })

  it('refuses a file over 100 MB without a request', async () => {
    const fetchMock = stubFetch(200, {})
    const big = file()
    Object.defineProperty(big, 'size', { value: MAX_FILE_UPLOAD_BYTES + 1 })
    expect(await checkUpload(target, at, big)).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each<[number, unknown, FileUploadReason]>([
    [403, { code: 'sensitive' }, 'sensitive'],
    [403, { code: 'place_moved' }, 'place_moved'],
    [404, { code: 'unknown_place' }, 'unknown_place'],
    [409, { code: 'exists' }, 'exists'],
    [401, 'Unauthorized', 'unauthorized'],
    [500, { code: 'whatever' }, 'failed'],
    [502, 'not json', 'failed'],
    [200, {}, 'failed'],
  ])('%i %j → %s', async (status, body, reason) => {
    stubFetch(status, body)
    expect(await checkUpload(target, at, file())).toEqual({
      ok: false,
      reason,
    })
  })

  it('the root moved: the new one', async () => {
    stubFetch(409, { error: 'root changed', root: '/new' })
    expect(await checkUpload(target, at, file())).toEqual({
      ok: false,
      reason: 'root_changed',
      root: '/new',
    })
  })

  it('canceled while it runs', async () => {
    const ctrl = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        expect(init.signal).toBe(ctrl.signal)
        ctrl.abort()
        throw new DOMException('aborted', 'AbortError')
      }),
    )
    expect(await checkUpload(target, at, file(), ctrl.signal)).toEqual({
      ok: false,
      reason: 'aborted',
    })
  })

  it('a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('offline')
      }),
    )
    expect(await checkUpload(target, at, file())).toEqual({
      ok: false,
      reason: 'network',
    })
  })
})

describe('uploadFile', () => {
  const start = (opts = {}, f = file()) => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR)
    const p = uploadFile(target, at, f, opts)
    return { p, xhr: FakeXHR.last }
  }

  it('sends the raw bytes as octet-stream, whatever the type, with progress', async () => {
    const onProgress = vi.fn()
    const onSent = vi.fn()
    const png = file(3, 'image/png')
    const { p, xhr } = start({ onProgress, onSent }, png)
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe(
      '/api/mux/panes/%251/files/upload?root=%2Fr&dir=src&name=a+b.pdf',
    )
    expect(xhr.headers).toEqual({ 'Content-Type': 'application/octet-stream' })
    expect(xhr.body).toBe(png)
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 })
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 2, total: 0 })
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 0, total: 0 })
    expect(onProgress).toHaveBeenCalledOnce()
    expect(onProgress).toHaveBeenCalledWith(0.25)
    xhr.upload.onload?.()
    expect(onSent).toHaveBeenCalledOnce()
    xhr.answer(201, JSON.stringify({ root: '/r', path: 'src/a b (2).pdf' }))
    expect(await p).toEqual({ ok: true, path: 'src/a b (2).pdf' })
  })

  it('works without callbacks', async () => {
    const { p, xhr } = start()
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    xhr.upload.onload?.()
    xhr.answer(201, JSON.stringify({ path: 'src/a b.pdf' }))
    expect(await p).toEqual({ ok: true, path: 'src/a b.pdf' })
  })

  it.each<[number, string, FileUploadReason]>([
    [429, '{"code":"upload_busy"}', 'upload_busy'],
    [408, '{"code":"timeout"}', 'timeout'],
    [413, '{"code":"too_large"}', 'too_large'],
    [415, '{"code":"unsupported_type"}', 'unsupported_type'],
    [507, '{"code":"storage_full"}', 'storage_full'],
    [401, 'Unauthorized', 'unauthorized'],
    [502, '<html>', 'failed'],
  ])('%i → %s', async (status, text, reason) => {
    const { p, xhr } = start()
    xhr.answer(status, text)
    expect(await p).toEqual({ ok: false, reason })
  })

  it('a network failure, and an abort', async () => {
    let s = start()
    s.xhr.onerror?.()
    expect(await s.p).toEqual({ ok: false, reason: 'network' })
    const ctrl = new AbortController()
    s = start({ signal: ctrl.signal })
    ctrl.abort()
    expect(s.xhr.aborted).toBe(true)
    expect(await s.p).toEqual({ ok: false, reason: 'aborted' })
  })

  it('an abort before it starts sends nothing', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const xhrs = vi.fn()
    vi.stubGlobal('XMLHttpRequest', xhrs)
    expect(
      await uploadFile(target, at, file(), { signal: ctrl.signal }),
    ).toEqual({ ok: false, reason: 'aborted' })
    expect(xhrs).not.toHaveBeenCalled()
  })
})

describe('fileUploadErrorMessage', () => {
  it.each<FileUploadReason>([
    'view_only',
    'sensitive',
    'symlink',
    'not_directory',
    'exists',
    'invalid_name',
    'not_allowed',
    'not_found',
    'permission',
    'read_only',
    'place_moved',
    'unknown_place',
    'too_large',
    'timeout',
    'upload_busy',
    'storage_full',
    'unsupported_type',
    'root_changed',
    'unauthorized',
    'network',
    'aborted',
    'unsure',
    'failed',
  ])('%s has its own words, never the image texts', (reason) => {
    const msg = fileUploadErrorMessage(reason, tFor('en'))
    expect(msg).toBeTruthy()
    expect(msg).not.toMatch(/image|10 MB|saves/i)
  })

  it('says the limit and the busy slot plainly', () => {
    expect(fileUploadErrorMessage('too_large', tFor('en'))).toBe(
      'File is larger than 100 MB',
    )
    expect(fileUploadErrorMessage('upload_busy', tFor('en'))).toBe(
      'Another upload is running. Try again shortly',
    )
  })
})

describe('droppedFiles', () => {
  const item = (f: File | null, entry?: { isDirectory: boolean } | null) => ({
    kind: 'file',
    getAsFile: () => f,
    ...(entry !== undefined && { webkitGetAsEntry: () => entry }),
  })
  const dt = (over: object) =>
    ({
      items: [],
      files: [],
      types: ['Files'],
      ...over,
    }) as unknown as DataTransfer

  it('keeps files and counts folders by their entry', () => {
    const a = file()
    const folder = file(0, '', 'dir')
    const empty = file(0, '', 'Makefile')
    expect(
      droppedFiles(
        dt({
          items: [
            item(a, { isDirectory: false }),
            item(folder, { isDirectory: true }),
            // A file whose entry the browser does not give: by its looks
            item(empty, null),
            item(null, { isDirectory: false }),
            { kind: 'string', getAsFile: () => null },
          ],
        }),
      ),
    ).toEqual({ files: [a], folders: 2 })
  })

  it('without webkitGetAsEntry: by its looks', () => {
    const a = file()
    const folder = file(0, '', 'dir')
    const typed = file(0, 'text/plain', 'empty.txt')
    expect(
      droppedFiles(dt({ items: [item(a), item(folder), item(typed)] })),
    ).toEqual({ files: [a, typed], folders: 1 })
  })

  it('without items: the files list', () => {
    const a = file()
    const folder = file(0, '', 'dir')
    expect(droppedFiles(dt({ items: undefined, files: [a, folder] }))).toEqual({
      files: [a],
      folders: 1,
    })
  })
})
