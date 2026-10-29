import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest'
import { tFor } from '../i18n/i18n-context'
import { BLOB_REVOKE_MS } from './download-file'
import {
  canCopyImage,
  canShareImage,
  copyPng,
  downloadSvg,
  exportName,
  exportScale,
  MAX_PIXELS,
  MAX_SIDE,
  pngOf,
  resetMermaidExport,
  sharePng,
  svgBlob,
} from './mermaid-export'
import type { MermaidImage } from './mermaid-render'

const en = tFor('en')

const SVG_URL = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E'
const IMG: MermaidImage = {
  url: SVG_URL,
  width: 300,
  height: 120,
  background: '#fff',
}
// A diagram with its own URL, so cached PNGs of others never answer for it
const img = (n: number, over: Partial<MermaidImage> = {}): MermaidImage => ({
  ...IMG,
  url: `${SVG_URL}${n}`,
  ...over,
})

// An Image that records its src, and decodes or fails on demand
const made: { src: string }[] = []
let decodeFails = false
class FakeImage {
  src = ''
  constructor() {
    made.push(this)
  }
  decode() {
    return decodeFails
      ? Promise.reject(new Error('bad svg'))
      : Promise.resolve()
  }
}

// The 2d context: records the fill colour at each fillRect and the size
// each drawImage was given
const drawn: { fills: string[]; draws: number[][] } = { fills: [], draws: [] }
let canvases: HTMLCanvasElement[] = []
function stubCanvas({ context = true, blob = true } = {}) {
  const ctx = {
    fillStyle: '',
    fillRect: vi.fn(function (this: { fillStyle: string }) {
      drawn.fills.push(this.fillStyle)
    }),
    drawImage: vi.fn(
      (_img: unknown, _x: number, _y: number, w: number, h: number) => {
        drawn.draws.push([w, h])
      },
    ),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      canvases.push(this)
      return (context ? ctx : null) as never
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (cb: BlobCallback) => {
      cb(blob ? new Blob(['png'], { type: 'image/png' }) : null)
    },
  )
}

// A navigator with only the given members (and the user agent the iOS check
// reads): jsdom's own getters cannot be read through another object
function stubNav(members: Record<string, unknown>) {
  vi.stubGlobal('navigator', { userAgent: navigator.userAgent, ...members })
}

// A ClipboardItem that records what it was made with
const items: { data: Record<string, Promise<Blob>> }[] = []
function stubClipboardItem(supports?: (type: string) => boolean) {
  const Item = class {
    data: Record<string, Promise<Blob>>
    constructor(data: Record<string, Promise<Blob>>) {
      this.data = data
      items.push(this)
    }
  }
  if (supports) Object.assign(Item, { supports })
  vi.stubGlobal('ClipboardItem', Item)
}

// A write that reads every item's PNG, as the browser does: a PNG that fails
// to draw fails the write
const readingWrite = () =>
  vi.fn(async (list: { data: Record<string, Promise<Blob>> }[]) => {
    for (const item of list)
      for (const png of Object.values(item.data)) await png
  })

const share = () => vi.fn().mockResolvedValue(undefined)
const notAllowed = () => new DOMException('no gesture', 'NotAllowedError')

// The links clicked: where, the name, and whether still in the page
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

let notify: Mock<(message: string) => void>
let sheet: Mock<(...args: unknown[]) => Promise<void>>
let clipboardWrite: ReturnType<typeof readingWrite>
beforeEach(() => {
  resetMermaidExport()
  made.length = 0
  decodeFails = false
  canvases = []
  drawn.fills = []
  drawn.draws = []
  items.length = 0
  notify = vi.fn<(message: string) => void>()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('Image', FakeImage)
  stubClipboardItem(() => true)
  sheet = share()
  clipboardWrite = readingWrite()
  stubNav({
    share: sheet,
    canShare: () => true,
    clipboard: { write: clipboardWrite },
  })
  stubCanvas()
  URL.createObjectURL = vi.fn(() => 'blob:svg')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('canCopyImage', () => {
  it('is on in a secure context with a clipboard that takes PNG', () => {
    expect(canCopyImage()).toBe(true)
  })

  it('is off over plain HTTP', () => {
    vi.stubGlobal('isSecureContext', false)
    expect(canCopyImage()).toBe(false)
  })

  it('is off without ClipboardItem', () => {
    vi.stubGlobal('ClipboardItem', undefined)
    expect(canCopyImage()).toBe(false)
  })

  it('is off without a clipboard that can write', () => {
    stubNav({})
    expect(canCopyImage()).toBe(false)
    stubNav({ clipboard: {} })
    expect(canCopyImage()).toBe(false)
  })

  it('is off when the browser cannot take a PNG', () => {
    stubClipboardItem(() => false)
    expect(canCopyImage()).toBe(false)
  })

  it('is on when ClipboardItem has no supports() to ask', () => {
    stubClipboardItem()
    expect(canCopyImage()).toBe(true)
  })
})

describe('canShareImage', () => {
  it('is on in a secure context when the sheet takes a PNG file', () => {
    expect(canShareImage()).toBe(true)
  })

  it('asks canShare about a PNG file', () => {
    const canShare = vi.fn((_opts: { files: File[] }) => true)
    stubNav({ share: share(), canShare })
    canShareImage()
    const [arg] = canShare.mock.calls[0]
    expect(arg.files[0]).toBeInstanceOf(File)
    expect(arg.files[0].name).toBe('diagram.png')
    expect(arg.files[0].type).toBe('image/png')
  })

  it('is off over plain HTTP', () => {
    vi.stubGlobal('isSecureContext', false)
    expect(canShareImage()).toBe(false)
  })

  it('is off without the share sheet', () => {
    stubNav({ canShare: () => true })
    expect(canShareImage()).toBe(false)
  })

  it('is off when the browser cannot say it takes files', () => {
    stubNav({ share: share() })
    expect(canShareImage()).toBe(false)
  })

  it('is off when canShare refuses a PNG file', () => {
    stubNav({ share: share(), canShare: () => false })
    expect(canShareImage()).toBe(false)
  })
})

describe('exportScale', () => {
  it('draws twice the size of a small diagram', () => {
    expect(exportScale(300, 120)).toBe(2)
  })

  it('is cut to the pixel cap for a large diagram', () => {
    const scale = exportScale(10_000, 10_000)
    expect(scale).toBeCloseTo(Math.sqrt(MAX_PIXELS / 1e8))
    expect(10_000 * scale * (10_000 * scale)).toBeLessThanOrEqual(MAX_PIXELS)
  })

  it('is cut to the side cap for a long, thin diagram', () => {
    expect(exportScale(20_000, 10)).toBeCloseTo(MAX_SIDE / 20_000)
  })
})

describe('exportName', () => {
  it.each([
    ['docs/notes.md', 2, 'notes-mermaid-2'],
    ['notes.md', 1, 'notes-mermaid-1'],
    ['README', 1, 'README-mermaid-1'],
    ['x.tar.gz', 3, 'x.tar-mermaid-3'],
    ['deep/dir/a.md', 1, 'a-mermaid-1'],
    // A dot-file keeps its whole name
    ['a/.env', 1, '.env-mermaid-1'],
    // Characters that could make one name pose as another are stripped
    ['a‮gnp.md', 1, 'agnp-mermaid-1'],
    // A path with no file name (or only unsafe characters) falls back
    ['dir/', 4, 'mermaid-4'],
    ['dir/\u0007', 1, 'mermaid-1'],
  ])('names %s as %s', (path, index, name) => {
    expect(exportName(path, index)).toBe(name)
  })
})

describe('svgBlob', () => {
  const svgOf = (svg: string, background = '#fff') =>
    svgBlob({
      ...IMG,
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      background,
    })

  it('is the SVG of the data: URL, as image/svg+xml, on its background', async () => {
    const blob = svgOf('<svg a="1">&amp;')
    expect(blob.type).toBe('image/svg+xml')
    expect(await blob.text()).toBe('<svg a="1" style="background:#fff">&amp;')
  })

  it('puts the background first in a style the root already has', async () => {
    const blob = svgOf(
      '<svg a="x>y" style="--pele-bg:#1a1a1d"><g/></svg>',
      '#1a1a1d',
    )
    expect(await blob.text()).toBe(
      '<svg a="x>y" style="background:#1a1a1d;--pele-bg:#1a1a1d"><g/></svg>',
    )
  })
})

describe('pngOf', () => {
  it('draws the diagram at twice its size on its background', async () => {
    await pngOf(IMG)
    expect(made).toHaveLength(1)
    expect(made[0].src).toBe(SVG_URL)
    expect(drawn.fills).toEqual(['#fff'])
    expect(drawn.draws).toEqual([[600, 240]])
    expect(canvases[0].width).toBe(0)
    expect(canvases[0].height).toBe(0)
  })

  it('fills a dark diagram with its dark background', async () => {
    await pngOf(img(1, { background: '#1a1a1d' }))
    expect(drawn.fills).toEqual(['#1a1a1d'])
  })

  it('resolves to a PNG blob', async () => {
    const png = await pngOf(IMG)
    expect(png).toBeInstanceOf(Blob)
    expect(png.type).toBe('image/png')
  })

  it('draws a huge diagram within the caps', async () => {
    await pngOf(img(2, { width: 20_000, height: 10 }))
    const [w, h] = drawn.draws[0]
    expect(w).toBeLessThanOrEqual(MAX_SIDE)
    expect(w * h).toBeLessThanOrEqual(MAX_PIXELS)
  })

  it('draws a large square diagram within the pixel cap', async () => {
    await pngOf(img(3, { width: 10_000, height: 10_000 }))
    const [w, h] = drawn.draws[0]
    expect(w * h).toBeLessThanOrEqual(MAX_PIXELS)
    expect(w).toBe(4000)
  })

  it('reuses the PNG of a diagram drawn already', async () => {
    const first = pngOf(IMG)
    expect(pngOf(IMG)).toBe(first)
    await first
    expect(made).toHaveLength(1)
  })

  it('keeps the last four PNGs and drops the least recently used', async () => {
    const a = img(1)
    const others = [img(2), img(3), img(4)]
    pngOf(a)
    for (const o of others) pngOf(o)
    // Using a again makes b the least recently used
    pngOf(a)
    pngOf(img(5))
    expect(made).toHaveLength(5)
    pngOf(a)
    pngOf(others[0])
    expect(made).toHaveLength(6)
    expect(made[5].src).toBe(others[0].url)
  })

  it('draws again after resetMermaidExport', async () => {
    await pngOf(IMG)
    resetMermaidExport()
    await pngOf(IMG)
    expect(made).toHaveLength(2)
  })

  it('rejects when the browser gives no 2d context, and zeroes the canvas', async () => {
    stubCanvas({ context: false })
    await expect(pngOf(IMG)).rejects.toThrow('no 2d context')
    expect(canvases[0].width).toBe(0)
  })

  it('rejects when the canvas gives no PNG, and zeroes the canvas', async () => {
    stubCanvas({ blob: false })
    await expect(pngOf(IMG)).rejects.toThrow('canvas too large')
    expect(canvases[0].width).toBe(0)
    expect(canvases[0].height).toBe(0)
  })

  it('rejects when the SVG does not decode', async () => {
    decodeFails = true
    await expect(pngOf(IMG)).rejects.toThrow('bad svg')
  })

  it('draws a failed diagram again next time', async () => {
    decodeFails = true
    await expect(pngOf(IMG)).rejects.toThrow()
    decodeFails = false
    await pngOf(IMG)
    expect(made).toHaveLength(2)
  })

  it('does not drop a newer drawing of the same URL when an older one fails', async () => {
    decodeFails = true
    const failed = pngOf(IMG)
    resetMermaidExport()
    decodeFails = false
    const newer = pngOf(IMG)
    await expect(failed).rejects.toThrow()
    expect(pngOf(IMG)).toBe(newer)
    expect(made).toHaveLength(2)
  })
})

describe('sharePng', () => {
  it('shares the PNG under the given name', async () => {
    await sharePng(IMG, 'a-mermaid-1', notify, en)
    const [arg] = sheet.mock.calls[0] as unknown as [{ files: File[] }]
    expect(arg.files[0].name).toBe('a-mermaid-1.png')
    expect(arg.files[0].type).toBe('image/png')
    expect(notify).not.toHaveBeenCalled()
  })

  it('says nothing when the user closes the sheet', async () => {
    stubNav({
      share: vi
        .fn()
        .mockRejectedValue(new DOMException('closed', 'AbortError')),
      canShare: () => true,
    })
    await sharePng(IMG, 'a-mermaid-1', notify, en)
    expect(notify).not.toHaveBeenCalled()
  })

  it('asks for a new tap when the browser refused the sheet', async () => {
    stubNav({ share: vi.fn().mockRejectedValue(notAllowed()) })
    await sharePng(IMG, 'a-mermaid-1', notify, en)
    expect(notify).toHaveBeenCalledWith('Diagram ready: tap Share again')
  })

  it('tells the user when the sheet fails otherwise', async () => {
    stubNav({ share: vi.fn().mockRejectedValue(new Error('boom')) })
    await sharePng(IMG, 'a-mermaid-1', notify, en)
    expect(notify).toHaveBeenCalledWith('Could not share the diagram')
  })

  it('tells the user when the diagram cannot be drawn', async () => {
    stubCanvas({ context: false })
    await sharePng(IMG, 'a-mermaid-1', notify, en)
    expect(notify).toHaveBeenCalledWith('Could not share the diagram')
  })
})

describe('copyPng', () => {
  it('makes the ClipboardItem before the first await, with the PNG to come', async () => {
    const done = copyPng(IMG, notify, en)
    expect(items).toHaveLength(1)
    const png = items[0].data['image/png']
    expect(png).toBeInstanceOf(Promise)
    expect((await png).type).toBe('image/png')
    await done
    expect(clipboardWrite).toHaveBeenCalledWith([items[0]])
    expect(notify).toHaveBeenCalledWith('Diagram copied')
  })

  it('tells the user when the clipboard refuses', async () => {
    stubNav({
      clipboard: { write: vi.fn().mockRejectedValue(notAllowed()) },
    })
    await copyPng(IMG, notify, en)
    expect(notify).toHaveBeenCalledWith('Could not copy the diagram')
  })

  it('tells the user when the diagram cannot be drawn', async () => {
    stubCanvas({ context: false })
    await copyPng(IMG, notify, en)
    expect(notify).toHaveBeenCalledWith('Could not copy the diagram')
  })
})

describe('downloadSvg', () => {
  it('saves the SVG through a link named for the diagram', async () => {
    const clicks = watchLinks()
    vi.useFakeTimers()
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, false)
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(clicks).toEqual([
      { href: 'blob:svg', download: 'a-mermaid-1.svg', attached: true },
    ])
    expect(notify).not.toHaveBeenCalled()
  })

  it('uses the link on desktop when no iOS flag is given', async () => {
    const clicks = watchLinks()
    await downloadSvg(IMG, 'a-mermaid-1', notify, en)
    expect(clicks).toHaveLength(1)
    expect(clicks[0].download).toBe('a-mermaid-1.svg')
  })

  it('revokes the blob: URL only after the save had time to start', async () => {
    watchLinks()
    vi.useFakeTimers()
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, false)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(BLOB_REVOKE_MS)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:svg')
  })

  it('shares the SVG file from the iOS home-screen app', async () => {
    const clicks = watchLinks()
    const sheet = share()
    stubNav({ share: sheet, canShare: () => true })
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, true)
    const [arg] = sheet.mock.calls[0] as unknown as [{ files: File[] }]
    expect(arg.files[0].name).toBe('a-mermaid-1.svg')
    expect(clicks).toHaveLength(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it('from the iOS home-screen app, falls back to a link when no file can be shared', async () => {
    const clicks = watchLinks()
    stubNav({ share: share() })
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, true)
    expect(clicks).toEqual([
      { href: 'blob:svg', download: 'a-mermaid-1.svg', attached: true },
    ])
  })

  it('asks for a new tap when the iOS share sheet was refused', async () => {
    stubNav({
      share: vi.fn().mockRejectedValue(notAllowed()),
      canShare: () => true,
    })
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, true)
    expect(notify).toHaveBeenCalledWith('Diagram ready: tap Download again')
  })

  it('says nothing when the iOS share sheet is closed', async () => {
    stubNav({
      share: vi
        .fn()
        .mockRejectedValue(new DOMException('closed', 'AbortError')),
      canShare: () => true,
    })
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, true)
    expect(notify).not.toHaveBeenCalled()
  })

  it('tells the user when the save fails otherwise', async () => {
    stubNav({
      share: vi.fn().mockRejectedValue(new Error('boom')),
      canShare: () => true,
    })
    await downloadSvg(IMG, 'a-mermaid-1', notify, en, true)
    expect(notify).toHaveBeenCalledWith('Could not download the diagram')
  })
})

describe('resetMermaidExport', () => {
  it('forgets the PNGs made, so the next one is drawn again', async () => {
    await pngOf(IMG)
    resetMermaidExport()
    expect(made).toHaveLength(1)
    await pngOf(IMG)
    expect(made).toHaveLength(2)
  })
})
