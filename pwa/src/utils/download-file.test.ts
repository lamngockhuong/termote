import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import {
  BLOB_REVOKE_MS,
  downloadErrorMessage,
  downloadFile,
  isIosStandalone,
  startDownload,
} from './download-file'

const mockCheck = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  checkFileDownload: (...a: unknown[]) => mockCheck(...a),
}))

const err = (status: number, code = '', root?: string) =>
  new RequestError(status, code, 'x', undefined, undefined, root)

// The links clicked: href, download name, and whether it was in the page
function watchLinks() {
  const clicks: { href: string; download: string; attached: boolean }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({
      href: this.getAttribute('href') ?? '',
      download: this.download,
      attached: this.isConnected,
    })
  })
  return clicks
}

beforeEach(() => {
  mockCheck.mockReset()
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('downloadErrorMessage', () => {
  it.each([
    [err(403, 'sensitive'), 'a.bin may contain secrets; not downloaded'],
    [err(403, 'not_allowed'), "a.bin can't be downloaded from here"],
    [err(403, 'symlink'), 'A link on that path; not downloaded'],
    [err(400, 'not_file'), 'a.bin is not a regular file; not downloaded'],
    [
      err(413, 'too_large'),
      'a.bin is larger than 100 MiB, too large to download',
    ],
    [err(429, 'busy'), 'Too many files at once; try again'],
    [err(403, 'view_only'), 'This device is view only'],
    [err(409, 'changed'), 'a.bin changed; try again'],
    [err(404), 'a.bin is gone'],
    [err(409, '', '/new'), "The pane's directory changed"],
    [err(500), 'Could not download a.bin'],
    [new Error('offline'), 'Could not download a.bin'],
  ])('%s', (e, text) => {
    expect(downloadErrorMessage(e, 'a.bin')).toBe(text)
  })
})

describe('isIosStandalone', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  const nav = (userAgent: string, standalone?: boolean) =>
    ({ userAgent, maxTouchPoints: 5, standalone }) as Navigator & {
      standalone?: boolean
    }
  it('is the iOS home-screen app only', () => {
    expect(isIosStandalone(nav(iphone, true))).toBe(true)
    expect(isIosStandalone(nav(iphone))).toBe(false)
    expect(isIosStandalone(nav('Mozilla/5.0 (Linux; Android 14)', true))).toBe(
      false,
    )
  })
})

describe('startDownload', () => {
  const deps = (over = {}) => ({
    iosStandalone: false,
    fetchBlob: vi.fn(async () => new Blob(['x'])),
    nav: { share: vi.fn(), canShare: vi.fn(() => true) },
    ...over,
  })

  it('clicks a link with download, then removes it', async () => {
    const clicks = watchLinks()
    const d = deps()
    await startDownload('/api/x', 'a.bin', d)
    expect(clicks).toEqual([
      { href: '/api/x', download: 'a.bin', attached: true },
    ])
    expect(document.querySelector('a')).toBeNull()
    expect(d.fetchBlob).not.toHaveBeenCalled()
  })

  it('iOS home-screen app: shares the file', async () => {
    const clicks = watchLinks()
    const d = deps({ iosStandalone: true })
    await startDownload('/api/x', 'a.bin', d)
    expect(d.fetchBlob).toHaveBeenCalledWith('/api/x')
    const file = d.nav.share.mock.calls[0][0].files[0] as File
    expect(file.name).toBe('a.bin')
    expect(clicks).toEqual([])
  })

  it('iOS: a closed sheet says nothing and starts nothing', async () => {
    const clicks = watchLinks()
    const d = deps({ iosStandalone: true })
    d.nav.share.mockRejectedValue(new DOMException('no', 'AbortError'))
    await startDownload('/api/x', 'a.bin', d)
    expect(clicks).toEqual([])
  })

  it('iOS: a blob: link when the sheet takes no file', async () => {
    vi.useFakeTimers()
    const clicks = watchLinks()
    const nav = { canShare: vi.fn(() => false), share: vi.fn() }
    await startDownload('/api/x', 'a.bin', deps({ iosStandalone: true, nav }))
    expect(nav.share).not.toHaveBeenCalled()
    expect(clicks).toEqual([
      { href: 'blob:x', download: 'a.bin', attached: true },
    ])
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BLOB_REVOKE_MS)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  it('iOS: the tap ran out while reading: shares again from a new tap', async () => {
    const clicks = watchLinks()
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined)
    const onShareBlocked = vi.fn()
    await startDownload(
      '/api/x',
      'a.bin',
      deps({
        iosStandalone: true,
        nav: { canShare: () => true, share },
        onShareBlocked,
      }),
    )
    expect(clicks).toEqual([])
    expect(onShareBlocked).toHaveBeenCalledTimes(1)
    onShareBlocked.mock.calls[0][0]()
    expect(share).toHaveBeenCalledTimes(2)
    expect(share.mock.calls[1][0].files[0]).toBe(
      share.mock.calls[0][0].files[0],
    )
  })

  it('iOS: another share failure is thrown', async () => {
    const share = vi.fn().mockRejectedValue(new TypeError('bad'))
    await expect(
      startDownload(
        '/api/x',
        'a.bin',
        deps({ iosStandalone: true, nav: { canShare: () => true, share } }),
      ),
    ).rejects.toThrow('bad')
  })
})

describe('downloadFile', () => {
  const file = { paneId: '%1', root: '/r', path: 'dir/a b.bin', reveal: true }

  it('checks first, then downloads the file by its base name', async () => {
    const clicks = watchLinks()
    mockCheck.mockResolvedValue({ root: '/r', path: 'dir/a b.bin', size: 1 })
    const notify = vi.fn()
    await downloadFile(file, notify, undefined, { iosStandalone: false })
    expect(mockCheck).toHaveBeenCalledWith('%1', 'dir/a b.bin', {
      root: '/r',
      reveal: true,
    })
    expect(clicks).toEqual([
      {
        href: '/api/mux/panes/%251/files/download?path=dir%2Fa+b.bin&reveal=1&root=%2Fr',
        download: 'a b.bin',
        attached: true,
      },
    ])
    expect(notify).not.toHaveBeenCalled()
  })

  it('a refusal is told and starts nothing', async () => {
    const clicks = watchLinks()
    mockCheck.mockRejectedValue(err(413, 'too_large'))
    const notify = vi.fn()
    await downloadFile(file, notify, undefined, { iosStandalone: false })
    expect(notify).toHaveBeenCalledWith(
      'a b.bin is larger than 100 MiB, too large to download',
      { variant: 'danger' },
    )
    expect(clicks).toEqual([])
  })

  it('a moved root is handed on', async () => {
    mockCheck.mockRejectedValue(err(409, '', '/new'))
    const moved = vi.fn()
    await downloadFile(file, vi.fn(), moved, { iosStandalone: false })
    expect(moved).toHaveBeenCalledWith('/new')
  })

  it('iOS: no check (the read tells a refusal); says it is downloading', async () => {
    const notify = vi.fn()
    const share = vi.fn()
    await downloadFile(file, notify, undefined, {
      iosStandalone: true,
      fetchBlob: async () => new Blob(['x']),
      nav: { share, canShare: () => true },
    })
    expect(mockCheck).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('Downloading a b.bin')
    expect(share).toHaveBeenCalled()
  })

  it('iOS: a refused read is told', async () => {
    const notify = vi.fn()
    await downloadFile(file, notify, undefined, {
      iosStandalone: true,
      fetchBlob: async () => {
        throw err(413, 'too_large')
      },
      nav: { share: vi.fn(), canShare: () => true },
    })
    expect(notify).toHaveBeenLastCalledWith(
      'a b.bin is larger than 100 MiB, too large to download',
      { variant: 'danger' },
    )
  })

  it('iOS: the tap ran out: a toast offers Save', async () => {
    const notify = vi.fn()
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('no', 'NotAllowedError'))
    await downloadFile(file, notify, undefined, {
      iosStandalone: true,
      fetchBlob: async () => new Blob(['x']),
      nav: { share, canShare: () => true },
    })
    const [text, opts] = notify.mock.calls[notify.mock.calls.length - 1]
    expect(text).toBe('a b.bin is ready')
    expect(opts.action.label).toBe('Save')
    opts.action.onClick()
    expect(share).toHaveBeenCalledTimes(2)
  })
})
