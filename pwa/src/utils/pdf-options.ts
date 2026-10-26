import type {
  DocumentInitParameters,
  PDFWorker,
} from 'pdfjs-dist/types/src/display/api'

// Where the build puts pdf.js's character maps, standard fonts and the JS
// decoders of JPEG 2000 and JBIG2 (vite.config.ts), named by its version
declare const __PDFJS_ASSETS__: string

// Opening a document, once its worker answers
export const PDF_OPEN_TIMEOUT = 20000
// A page's canvas holds at most this many pixels; zoomed past it, the page
// is drawn at a lower resolution
export const PDF_MAX_CANVAS_PIXELS = 16_777_216
// An image in the file larger than this many pixels is not decoded
export const PDF_MAX_IMAGE_SIZE = 40_000_000

// The options every document is opened with, never taken from elsewhere:
// no XFA forms, no WebAssembly (the page's CSP has no 'wasm-unsafe-eval';
// JPEG 2000 and JBIG2 decode through the JS fallbacks at wasmUrl), nothing
// fetched but pdf.js's own files from this origin. The policy (no eval) is
// the page's CSP and the worker's: pdf.js runs no PDF JavaScript without a
// scripting manager, which the viewer never gets.
export function pdfDocumentOptions(
  data: ArrayBuffer,
  worker: PDFWorker,
): DocumentInitParameters {
  return {
    data,
    worker,
    enableXfa: false,
    useWasm: false,
    wasmUrl: `${__PDFJS_ASSETS__}wasm/`,
    cMapUrl: `${__PDFJS_ASSETS__}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${__PDFJS_ASSETS__}standard_fonts/`,
    disableAutoFetch: true,
    maxImageSize: PDF_MAX_IMAGE_SIZE,
  }
}
