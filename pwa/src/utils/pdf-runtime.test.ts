import { afterEach, describe, expect, it, vi } from 'vitest'

const order: string[] = []
vi.mock('pdfjs-dist', () => {
  order.push('lib')
  ;(globalThis as Record<string, unknown>).pdfjsLib = { loaded: true }
  return { version: 'x' }
})
vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  // The viewer reads the library as it loads
  order.push(
    (globalThis as Record<string, unknown>).pdfjsLib ? 'viewer' : 'too soon',
  )
  return { PDFViewer: class {} }
})
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => {
  order.push('css')
  return {}
})

afterEach(() => {
  vi.resetModules()
  order.length = 0
})

describe('loadPdfRuntime', () => {
  it('loads the library, then the viewer, once', async () => {
    const { loadPdfRuntime } = await import('./pdf-runtime')
    const a = loadPdfRuntime()
    expect(loadPdfRuntime()).toBe(a)
    const rt = await a
    expect(order).toEqual(['lib', 'viewer', 'css'])
    expect(rt.lib).toMatchObject({ version: 'x' })
    expect(rt.viewer.PDFViewer).toBeDefined()
  })

  it('imports again after a failure', async () => {
    vi.doMock('pdfjs-dist', () => {
      throw new Error('offline')
    })
    const { loadPdfRuntime } = await import('./pdf-runtime')
    await expect(loadPdfRuntime()).rejects.toThrow()
    vi.doMock('pdfjs-dist', () => ({ version: 'y' }))
    vi.resetModules()
    await expect(loadPdfRuntime()).resolves.toMatchObject({
      lib: { version: 'y' },
    })
    vi.doUnmock('pdfjs-dist')
  })
})

describe('makePdfWorker', () => {
  it('makes a module worker of pdf.js', async () => {
    const made: unknown[] = []
    vi.stubGlobal(
      'Worker',
      class {
        constructor(...a: unknown[]) {
          made.push(a)
        }
      },
    )
    const { makePdfWorker } = await import('./pdf-runtime')
    makePdfWorker()
    expect(made).toEqual([
      [
        expect.objectContaining({
          href: expect.stringContaining('pdf.worker'),
        }),
        { type: 'module' },
      ],
    ])
    vi.unstubAllGlobals()
  })
})
