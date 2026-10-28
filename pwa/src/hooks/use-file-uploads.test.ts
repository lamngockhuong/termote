import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  UploadAt,
  UploadCallbacks,
  UploadResult,
} from '../utils/upload-file'
import {
  cancelUploads,
  confirmUpload,
  onFileUploaded,
  resetFileUploads,
  startUploads,
  UPLOAD_BUSY_RETRY_MS,
  UPLOAD_BUSY_WAIT_MS,
  type UploadTo,
  useFileUploads,
} from './use-file-uploads'

const mockCheck = vi.fn()
const mockUpload = vi.fn()
vi.mock('../utils/upload-file', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-file')>()),
  checkUpload: (...a: unknown[]) => mockCheck(...a),
  uploadFile: (...a: unknown[]) => mockUpload(...a),
}))
const mockTree = vi.fn()
vi.mock('./use-mux-api', async (orig) => ({
  ...(await orig<typeof import('./use-mux-api')>()),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
}))
const mockUploaded = vi.fn()
const mockRootMoved = vi.fn()
vi.mock('./use-files', async (orig) => ({
  ...(await orig<typeof import('./use-files')>()),
  filesUploaded: (...a: unknown[]) => mockUploaded(...a),
  filesRootMoved: (...a: unknown[]) => mockRootMoved(...a),
}))

const file = (name: string, size = 3) =>
  new File([new Uint8Array(size)], name, { type: 'application/pdf' })
const ok = (path: string): UploadResult => ({ ok: true, path })
const no = (reason: string, root?: string) =>
  ({ ok: false, reason, ...(root && { root }) }) as UploadResult
const pathOf = (at: UploadAt) =>
  at.dir === '.' ? at.name : `${at.dir}/${at.name}`
const to = (dir: string, over: Partial<UploadTo> = {}): UploadTo => ({
  target: { paneId: '%1' },
  root: '/r',
  dir,
  ...over,
})

// The check answers the name asked for in the dir asked for, the upload
// sends every byte and saves it there
function happyPath() {
  mockCheck.mockImplementation(async (_t, at: UploadAt) => ok(pathOf(at)))
  mockUpload.mockImplementation(
    async (_t, at: UploadAt, _f, cb: UploadCallbacks) => {
      cb.onProgress?.(0.5)
      cb.onSent?.()
      return ok(pathOf(at))
    },
  )
}

const notify = vi.fn()
const start = (
  files: File[],
  dir = '.',
  opts: { announce?: boolean; folders?: number } = {},
  over: Partial<UploadTo> = {},
) => act(() => startUploads(files, to(dir, over), { notify, ...opts }))
// Lets every pending promise run
const settle = () => act(async () => {})
const last = () => notify.mock.calls[notify.mock.calls.length - 1]

beforeEach(() => {
  resetFileUploads()
  mockCheck.mockReset()
  mockUpload.mockReset()
  mockTree.mockReset()
  mockUploaded.mockReset()
  mockRootMoved.mockReset()
  notify.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('file uploads', () => {
  it('uploads one file at a time, checked first, and tells the run once', async () => {
    happyPath()
    const seen: string[] = []
    mockCheck.mockImplementation(async (_t, at: UploadAt) => {
      seen.push(`check ${at.name}`)
      return ok(pathOf(at))
    })
    mockUpload.mockImplementation(async (_t, at: UploadAt) => {
      seen.push(`up ${at.name}`)
      return ok(pathOf(at))
    })
    const got = vi.fn()
    const off = onFileUploaded(got)
    const { result } = renderHook(() => useFileUploads())
    start(
      [file('a.pdf'), file('b.pdf')],
      'src',
      {},
      {
        target: { paneId: '%2', place: 'p' },
      },
    )
    expect(result.current.status).toMatchObject({
      name: 'a.pdf',
      index: 1,
      total: 2,
    })
    await settle()
    expect(seen).toEqual(['check a.pdf', 'up a.pdf', 'check b.pdf', 'up b.pdf'])
    expect(mockCheck.mock.calls[0][0]).toEqual({ paneId: '%2', place: 'p' })
    expect(mockCheck.mock.calls[0][1]).toEqual({
      root: '/r',
      dir: 'src',
      name: 'a.pdf',
      reveal: false,
    })
    expect(mockUploaded.mock.calls).toEqual([
      ['%2', 'p', '/r', 'src/a.pdf'],
      ['%2', 'p', '/r', 'src/b.pdf'],
    ])
    expect(got).toHaveBeenCalledWith({
      paneId: '%2',
      place: 'p',
      root: '/r',
      path: 'src/b.pdf',
    })
    expect(notify).toHaveBeenCalledOnce()
    expect(last()).toEqual(['Uploaded 2 files.', { variant: 'success' }])
    expect(result.current.status).toBeUndefined()
    off()
  })

  it('shows the progress, and no Cancel once every byte went', async () => {
    happyPath()
    let progress!: (part: number) => void
    let sent!: () => void
    mockUpload.mockImplementation(
      (_t, _at, _f, cb: UploadCallbacks) =>
        new Promise(() => {
          progress = cb.onProgress as (part: number) => void
          sent = cb.onSent as () => void
        }),
    )
    const { result } = renderHook(() => useFileUploads())
    start([file('a.pdf')])
    await settle()
    act(() => progress(0.42))
    expect(result.current.status).toEqual({
      name: 'a.pdf',
      index: 1,
      total: 1,
      percent: 42,
      waiting: false,
      canCancel: true,
    })
    act(() => sent())
    expect(result.current.status).toMatchObject({
      percent: 100,
      canCancel: false,
    })
  })

  it.each<[File[], string, boolean, UploadResult | undefined, string]>([
    [[file('a.pdf')], 'src', false, undefined, 'Uploaded a.pdf'],
    [[file('a.pdf')], '.', false, ok('a (2).pdf'), 'Saved as a (2).pdf'],
    [[file('c.pdf')], 'src', true, undefined, 'Saved to src/c.pdf'],
    [
      [file('c.pdf'), file('d.pdf')],
      'src',
      true,
      undefined,
      'Uploaded 2 files to src.',
    ],
    [
      [file('c.pdf'), file('d.pdf')],
      '.',
      true,
      undefined,
      'Uploaded 2 files to the top folder.',
    ],
  ])('%#: tells it', async (files, dir, announce, answer, text) => {
    happyPath()
    if (answer) mockUpload.mockResolvedValueOnce(answer)
    start(files, dir, { announce })
    await settle()
    expect(last()).toEqual([text, { variant: 'success' }])
  })

  it('says folders a drop held with the result', async () => {
    happyPath()
    start([file('a.pdf')], '.', { folders: 2 })
    await settle()
    expect(last()).toEqual([
      "Uploaded a.pdf. Folders can't be uploaded.",
      { variant: 'success' },
    ])
  })

  it('a later start joins the running queue', async () => {
    happyPath()
    let release!: () => void
    mockCheck.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r(ok('a.pdf'))
        }),
    )
    const { result } = renderHook(() => useFileUploads())
    start([file('a.pdf')])
    start([file('b.pdf')])
    release()
    await settle()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBeUndefined()
    expect(last()).toEqual(['Uploaded 2 files.', { variant: 'success' }])
  })

  it('does nothing without files', async () => {
    start([])
    await settle()
    expect(mockCheck).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('asks once per batch, naming the file and folder, then sends reveal', async () => {
    happyPath()
    mockCheck.mockImplementation(async (_t, at: UploadAt) =>
      at.reveal ? ok(pathOf(at)) : no('sensitive'),
    )
    const { result } = renderHook(() => useFileUploads())
    start([file('a'), file('b')], '.ssh')
    await settle()
    expect(result.current.asking).toEqual({
      name: 'a',
      dir: '.ssh',
      root: '/r',
    })
    expect(mockUpload).not.toHaveBeenCalled()
    act(() => confirmUpload(true))
    await settle()
    expect(result.current.asking).toBeUndefined()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(mockUpload.mock.calls.every((c) => c[1].reveal)).toBe(true)
    // The next batch asks again
    start([file('c')], '.ssh')
    await settle()
    expect(result.current.asking).toEqual({
      name: 'c',
      dir: '.ssh',
      root: '/r',
    })
  })

  it('no at the ask sends nothing of the batch', async () => {
    mockCheck.mockResolvedValue(no('sensitive'))
    start([file('a'), file('b')], '.ssh')
    await settle()
    act(() => confirmUpload(false))
    await settle()
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockCheck).toHaveBeenCalledTimes(2)
    expect(notify).not.toHaveBeenCalled()
    // An answer with no ask open does nothing
    act(() => confirmUpload(true))
  })

  it('no at the ask of a drop with folders still says the folders', async () => {
    mockCheck.mockResolvedValue(no('sensitive'))
    start([file('a')], '.ssh', { folders: 1 })
    await settle()
    act(() => confirmUpload(false))
    await settle()
    expect(last()).toEqual([
      "Folders can't be uploaded.",
      { variant: 'warning' },
    ])
  })

  it('a refusal at the check sends no bytes; the run tells it before any success', async () => {
    happyPath()
    mockCheck.mockResolvedValueOnce(no('not_allowed'))
    start([file('x‮.pdf'), file('b.pdf')])
    await settle()
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledOnce()
    expect(last()).toEqual([
      "1 of 2 uploaded. x⟨U+202E⟩.pdf: Files can't be uploaded to this folder",
      { variant: 'danger' },
    ])
  })

  it('several refusals: the first, and how many more', async () => {
    mockCheck.mockResolvedValue(no('too_large'))
    start([file('a'), file('b'), file('c')], '.', { folders: 1 })
    await settle()
    expect(last()).toEqual([
      "0 of 3 uploaded. a: File is larger than 100 MB (2 more not uploaded) Folders can't be uploaded.",
      { variant: 'danger' },
    ])
  })

  it('one refusal of the upload itself', async () => {
    happyPath()
    mockUpload.mockResolvedValueOnce(no('storage_full'))
    start([file('a.pdf')])
    await settle()
    expect(last()).toEqual([
      "a.pdf: The host's disk or quota is full",
      { variant: 'danger' },
    ])
  })

  it('Cancel before every byte went stops it and drops the rest', async () => {
    happyPath()
    mockUpload.mockImplementationOnce(async (_t, at: UploadAt) =>
      ok(pathOf(at)),
    )
    mockUpload.mockImplementation(
      (_t, _at, _f, cb: UploadCallbacks) =>
        new Promise((r) =>
          cb.signal?.addEventListener('abort', () => r(no('aborted'))),
        ),
    )
    const { result } = renderHook(() => useFileUploads())
    start([file('a'), file('b'), file('c')])
    await settle()
    act(() => cancelUploads())
    await settle()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(last()).toEqual(['Upload canceled after 1 of 3.', undefined])
    expect(result.current.status).toBeUndefined()
    // Nothing running: Cancel does nothing
    act(() => cancelUploads())
  })

  it('files added after a Cancel are their own run', async () => {
    happyPath()
    let release!: () => void
    mockCheck.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r(ok('a'))
        }),
    )
    start([file('a')])
    await settle()
    act(() => cancelUploads())
    start([file('b')])
    release()
    await settle()
    expect(notify.mock.calls).toEqual([
      ['Upload canceled.', undefined],
      ['Uploaded b', { variant: 'success' }],
    ])
  })

  it('Cancel while the ask is open', async () => {
    mockCheck.mockResolvedValue(no('sensitive'))
    const { result } = renderHook(() => useFileUploads())
    start([file('a')], '.ssh')
    await settle()
    act(() => cancelUploads())
    await settle()
    expect(result.current.asking).toBeUndefined()
    expect(last()).toEqual(['Upload canceled.', undefined])
  })

  it('the answer lost after every byte went: saved if the file is there', async () => {
    happyPath()
    mockUpload.mockImplementation(async (_t, _at, _f, cb: UploadCallbacks) => {
      cb.onSent?.()
      return no('network')
    })
    mockTree.mockResolvedValue({
      entries: [{ name: 'a.pdf', type: 'file', size: 3, sensitive: false }],
    })
    start([file('a.pdf', 3)], 'src')
    await settle()
    expect(mockTree).toHaveBeenCalledWith({ paneId: '%1' }, 'src', '/r')
    expect(mockUploaded).toHaveBeenCalledWith(
      '%1',
      undefined,
      '/r',
      'src/a.pdf',
    )
    // Another size there: not sure
    start([file('a.pdf', 9)])
    await settle()
    expect(mockTree).toHaveBeenLastCalledWith({ paneId: '%1' }, '', '/r')
    expect(last()).toEqual([
      'a.pdf: Not sure the file was saved. Check the folder',
      { variant: 'danger' },
    ])
  })

  it('aborted after every byte went, the folder unreadable: not sure', async () => {
    happyPath()
    mockUpload.mockImplementation(async (_t, _at, _f, cb: UploadCallbacks) => {
      cb.onSent?.()
      return no('aborted')
    })
    mockTree.mockRejectedValue(new Error('gone'))
    start([file('a.pdf')])
    await settle()
    expect(last()?.[0]).toBe(
      'a.pdf: Not sure the file was saved. Check the folder',
    )
  })

  it('lost on the way: the check says why, or the network is blamed', async () => {
    happyPath()
    mockUpload.mockResolvedValue(no('network'))
    mockCheck
      .mockResolvedValueOnce(ok('a'))
      .mockResolvedValueOnce(no('read_only'))
    start([file('a')])
    await settle()
    expect(last()?.[0]).toBe('a: The file system there is read-only')
    start([file('b')])
    await settle()
    expect(last()?.[0]).toBe('b: Upload failed: network error')
  })

  it('waits while the check says another upload runs, every 3 s', async () => {
    vi.useFakeTimers()
    happyPath()
    mockCheck
      .mockResolvedValueOnce(no('upload_busy'))
      .mockResolvedValueOnce(no('upload_busy'))
    const { result } = renderHook(() => useFileUploads())
    start([file('a')])
    await settle()
    expect(result.current.status).toMatchObject({
      waiting: true,
      canCancel: true,
    })
    expect(mockUpload).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    expect(mockUpload).toHaveBeenCalledOnce()
    expect(last()?.[0]).toBe('Uploaded a')
  })

  it('waits when the upload itself is refused as busy', async () => {
    vi.useFakeTimers()
    happyPath()
    mockUpload.mockResolvedValueOnce(no('upload_busy'))
    start([file('a')])
    await settle()
    await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(last()?.[0]).toBe('Uploaded a')
  })

  it('a large body refused as busy reaches the page as a reset: the check tells, and it waits', async () => {
    vi.useFakeTimers()
    happyPath()
    mockUpload.mockResolvedValueOnce(no('network'))
    mockCheck
      .mockResolvedValueOnce(ok('a'))
      .mockResolvedValueOnce(no('upload_busy'))
    start([file('a')])
    await settle()
    await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(last()?.[0]).toBe('Uploaded a')
  })

  it('gives up waiting after 2 minutes', async () => {
    vi.useFakeTimers()
    mockCheck.mockResolvedValue(no('upload_busy'))
    const { result } = renderHook(() => useFileUploads())
    start([file('a')])
    for (let t = 0; t <= UPLOAD_BUSY_WAIT_MS; t += UPLOAD_BUSY_RETRY_MS)
      await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    expect(last()).toEqual([
      'a: Another upload is running. Try again shortly',
      { variant: 'danger' },
    ])
    expect(result.current.status).toBeUndefined()
  })

  it('gave up waiting: the rest of the run is not tried', async () => {
    vi.useFakeTimers()
    mockCheck.mockResolvedValue(no('upload_busy'))
    start([file('a'), file('b')])
    for (let t = 0; t <= UPLOAD_BUSY_WAIT_MS; t += UPLOAD_BUSY_RETRY_MS)
      await act(async () => vi.advanceTimersByTime(UPLOAD_BUSY_RETRY_MS))
    expect(mockCheck.mock.calls.every((c) => c[1].name === 'a')).toBe(true)
    expect(last()).toEqual([
      '0 of 2 uploaded. a: Another upload is running. Try again shortly (1 more not uploaded)',
      { variant: 'danger' },
    ])
  })

  it('a listener that throws never leaves the queue stuck', async () => {
    happyPath()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = onFileUploaded(() => {
      throw new Error('boom')
    })
    start([file('a')])
    await settle()
    off()
    expect(error).toHaveBeenCalledWith('uploads:', expect.any(Error))
    start([file('b')])
    await settle()
    expect(mockUpload).toHaveBeenCalledTimes(2)
    expect(last()?.[0]).toBe('Uploaded b')
    error.mockRestore()
  })

  it('Cancel while waiting', async () => {
    vi.useFakeTimers()
    mockCheck.mockResolvedValue(no('upload_busy'))
    start([file('a')])
    await settle()
    act(() => cancelUploads())
    await settle()
    expect(last()).toEqual(['Upload canceled.', undefined])
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('a session that ended opens the sign-in page, says nothing and stops', async () => {
    happyPath()
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    mockUpload.mockResolvedValueOnce(no('unauthorized'))
    start([file('a'), file('b')])
    await settle()
    expect(assign).toHaveBeenCalledWith(expect.stringMatching(/^\/login/))
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it("the pane's folder moved: its view follows and the rest of that root stops", async () => {
    happyPath()
    mockCheck.mockResolvedValueOnce(no('root_changed', '/new'))
    start(
      [file('a'), file('b')],
      '.',
      {},
      {
        target: { paneId: '%1', place: 'p' },
      },
    )
    start([file('c')], '.', {}, { root: '/other' })
    await settle()
    expect(mockRootMoved).toHaveBeenCalledWith('%1', 'p', '/new')
    expect(mockUpload).toHaveBeenCalledOnce()
    expect(mockUpload.mock.calls[0][1].root).toBe('/other')
    expect(last()).toEqual([
      "1 of 3 uploaded. a: This pane's folder changed: not uploaded (1 more not uploaded)",
      { variant: 'danger' },
    ])
  })

  it('goes on when the view that started it goes', async () => {
    happyPath()
    const { result, unmount } = renderHook(() => useFileUploads())
    start([file('a')])
    expect(result.current.status?.name).toBe('a')
    unmount()
    await settle()
    expect(mockUpload).toHaveBeenCalledOnce()
    expect(last()?.[0]).toBe('Uploaded a')
  })

  it('a reset in the middle of an ask answers it', async () => {
    mockCheck.mockResolvedValue(no('sensitive'))
    start([file('a')], '.ssh')
    await settle()
    resetFileUploads()
    await settle()
    expect(mockUpload).not.toHaveBeenCalled()
  })
})
