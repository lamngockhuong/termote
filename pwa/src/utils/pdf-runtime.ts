// pdf.js on the main thread: the library, then its viewer, which reads the
// library from globalThis.pdfjsLib as it loads (pdf.mjs sets it). Loaded the
// first time a PDF is opened, in that order, with the viewer's stylesheet.

export type PdfLib = typeof import('pdfjs-dist')
export type PdfViewerLib = typeof import('pdfjs-dist/web/pdf_viewer.mjs')

export interface PdfRuntime {
  lib: PdfLib
  viewer: PdfViewerLib
}

let loading: Promise<PdfRuntime> | undefined

export function loadPdfRuntime(): Promise<PdfRuntime> {
  loading ??= (async () => {
    const lib = await import('pdfjs-dist')
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs')
    await import('pdfjs-dist/web/pdf_viewer.css')
    return { lib, viewer }
  })().catch((err: unknown) => {
    // A chunk that failed to load is imported again next time
    loading = undefined
    throw err
  })
  return loading
}

// The worker of one document, owned by its viewer: pdf.js never terminates
// a port it was given, so the viewer does
export function makePdfWorker(): Worker {
  return new Worker(
    new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
    { type: 'module' },
  )
}
