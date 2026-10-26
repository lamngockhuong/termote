import { describe, expect, it } from 'vitest'
import { PDF_MAX_IMAGE_SIZE, pdfDocumentOptions } from './pdf-options'

describe('pdfDocumentOptions', () => {
  it('opens without XFA or WebAssembly, fetching only pdf.js files of this origin', () => {
    const data = new ArrayBuffer(1)
    const worker = {} as never
    const opts = pdfDocumentOptions(data, worker)
    expect(opts).toEqual({
      data,
      worker,
      enableXfa: false,
      useWasm: false,
      wasmUrl: expect.stringMatching(/^\/assets\/doc\/pdfjs-[\d.]+\/wasm\/$/),
      cMapUrl: expect.stringMatching(/^\/assets\/doc\/pdfjs-[\d.]+\/cmaps\/$/),
      cMapPacked: true,
      standardFontDataUrl: expect.stringMatching(
        /^\/assets\/doc\/pdfjs-[\d.]+\/standard_fonts\/$/,
      ),
      disableAutoFetch: true,
      maxImageSize: PDF_MAX_IMAGE_SIZE,
    })
  })
})
