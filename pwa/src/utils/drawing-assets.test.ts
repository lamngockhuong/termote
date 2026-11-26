import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'http://box.local:7680'

// A FontFace that keeps what it was made with
class FakeFontFace {
  args: unknown[]
  constructor(...args: unknown[]) {
    this.args = args
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function load() {
  vi.stubGlobal('FontFace', FakeFontFace)
  return import('./drawing-assets')
}

describe('sameOriginSources', () => {
  it("keeps this origin's sources and data:, drops another origin's", async () => {
    const { sameOriginSources } = await load()
    const src = [
      'local(Excalifont)',
      `url(${ORIGIN}/assets/a.woff2) format('woff2')`,
      "url(https://esm.sh/@excalidraw/a.woff2) format('woff2')",
      'url("/assets/b.woff2")',
      "url('data:font/woff2;base64,AAAA')",
      'local(Arial)',
      'url(https://esm.sh/b.woff2), local(Kept)',
      'url(http://[bad)',
    ].join(', ')
    expect(sameOriginSources(src, ORIGIN)).toBe(
      [
        'local(Excalifont)',
        `url(${ORIGIN}/assets/a.woff2) format('woff2')`,
        'url("/assets/b.woff2")',
        "url('data:font/woff2;base64,AAAA')",
        'local(Arial)',
        'local(Kept)',
        'url(http://[bad)',
      ].join(', '),
    )
  })
})

describe('keepFontsHere', () => {
  it('makes FontFace keep only the sources on this origin, once', async () => {
    const { keepFontsHere } = await load()
    const win = {
      FontFace: FakeFontFace,
      location: { origin: ORIGIN },
    } as unknown as Window & typeof globalThis
    keepFontsHere(win)
    const Patched = win.FontFace
    expect(Patched).not.toBe(FakeFontFace)
    const face = new Patched(
      'Excalifont',
      `url(${ORIGIN}/a.woff2), url(https://esm.sh/a.woff2)`,
      { style: 'normal' },
    ) as unknown as FakeFontFace
    expect(face.args).toEqual([
      'Excalifont',
      `url(${ORIGIN}/a.woff2)`,
      { style: 'normal' },
    ])
    // A face made from bytes is left as it is
    const bytes = new ArrayBuffer(4)
    expect((new Patched('F', bytes) as unknown as FakeFontFace).args[1]).toBe(
      bytes,
    )
    // Patched once only
    keepFontsHere(win)
    expect(win.FontFace).toBe(Patched)
  })

  it("sets the fonts' path and patches the page's FontFace when imported", async () => {
    await load()
    expect(window.EXCALIDRAW_ASSET_PATH).toMatch(
      /^\/assets\/drawing\/excalidraw-\d+\.\d+\.\d+\/$/,
    )
    expect(window.FontFace).not.toBe(FakeFontFace)
    // A file saved here never names this page's origin
    expect(window.EXCALIDRAW_EXPORT_SOURCE).toBe('https://excalidraw.com')
  })
})
