// Where Excalidraw loads its fonts from: the copies the build serves
// (pwa/vite.config.ts). Imported before the editor's chunk (FileViewer's
// import of it): @excalidraw/excalidraw reads it as its modules start.
declare const __EXCALIDRAW_ASSETS__: string

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
    EXCALIDRAW_EXPORT_SOURCE?: string
  }
}

// The sources of a FontFace's src that are this origin's (or data:):
// another origin's is one the page's policy refuses, and Chrome reports
// each such source of a face as a violation when the face is made, fetched
// or not. Excalidraw names its CDN after every font of its own.
export function sameOriginSources(src: string, origin: string): string {
  return src
    .split(/,\s*(?=(?:url|local)\()/)
    .filter((s) => {
      const m = /^url\((['"]?)(.*?)\1\)/.exec(s.trim())
      if (!m) return true
      // One that is no URL is left to the browser, which skips it
      if (!URL.canParse(m[2], origin)) return true
      const url = new URL(m[2], origin)
      return url.protocol === 'data:' || url.origin === origin
    })
    .join(', ')
}

// A FontFace made from a src string keeps only its sources on this origin
export function keepFontsHere(win: Window & typeof globalThis = window) {
  const Native = win.FontFace as typeof FontFace & { sameOrigin?: true }
  if (Native.sameOrigin) return
  class SameOriginFontFace extends Native {
    static sameOrigin = true as const
    constructor(
      family: string,
      source: string | BufferSource,
      descriptors?: FontFaceDescriptors,
    ) {
      super(
        family,
        typeof source === 'string'
          ? sameOriginSources(source, win.location.origin)
          : source,
        descriptors,
      )
    }
  }
  win.FontFace = SameOriginFontFace
}

window.EXCALIDRAW_ASSET_PATH = __EXCALIDRAW_ASSETS__
// What a file saved here names as its source when it had none of its own
// (drawing-scene.ts keeps a file's): never this page's origin, a host of
// the user's
window.EXCALIDRAW_EXPORT_SOURCE = 'https://excalidraw.com'
keepFontsHere()
