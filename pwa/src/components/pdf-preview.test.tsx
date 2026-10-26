import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOC_LOAD_TIMEOUT } from '../utils/document-worker-client'
import { PDF_OPEN_TIMEOUT } from '../utils/pdf-options'
import PdfPreview, { PDF_DESTROY_WAIT } from './pdf-preview'

// pdf.js stands in: records what the viewer is made with and what it is told
const rt = vi.hoisted(() => {
  type Handler = (e: unknown) => void
  class EventBus {
    handlers = new Map<string, Handler[]>()
    dispatched: [string, unknown][] = []
    on(name: string, h: Handler) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), h])
    }
    dispatch(name: string, e: unknown) {
      this.dispatched.push([name, e])
      for (const h of this.handlers.get(name) ?? []) h(e)
    }
  }
  const state = {
    bus: undefined as EventBus | undefined,
    viewer: undefined as Record<string, unknown> | undefined,
    viewerOpts: undefined as Record<string, unknown> | undefined,
    linkOpts: undefined as Record<string, unknown> | undefined,
    docOpts: undefined as Record<string, unknown> | undefined,
    pdfWorkers: [] as { port: unknown; destroy: () => void }[],
    workers: [] as { terminate: () => void }[],
    tasks: [] as { destroy: () => Promise<void> }[],
    open: undefined as
      | { resolve: (d: unknown) => void; reject: (e: unknown) => void }
      | undefined,
    load: undefined as unknown as () => Promise<unknown>,
  }
  const lib = {
    AnnotationMode: { ENABLE: 2 },
    AnnotationEditorType: { DISABLE: -1 },
    PDFWorker: class {
      destroy = vi.fn()
      constructor({ port }: { port: unknown }) {
        state.pdfWorkers.push({ port, destroy: this.destroy })
      }
    },
    getDocument(opts: Record<string, unknown>) {
      state.docOpts = opts
      const task = {
        promise: new Promise((resolve, reject) => {
          state.open = { resolve, reject }
        }),
        destroy: vi.fn(() => Promise.resolve()),
      }
      state.tasks.push(task)
      return task
    },
  }
  const ui = {
    EventBus: class extends EventBus {
      constructor() {
        super()
        state.bus = this
      }
    },
    LinkTarget: { BLANK: 2 },
    FindState: { PENDING: 3 },
    PDFLinkService: class {
      setViewer = vi.fn()
      setDocument = vi.fn()
      constructor(opts: Record<string, unknown>) {
        state.linkOpts = opts
      }
    },
    PDFFindController: class {},
    PDFViewer: class {
      currentScaleValue = ''
      setDocument = vi.fn()
      increaseScale = vi.fn()
      decreaseScale = vi.fn()
      constructor(opts: Record<string, unknown>) {
        state.viewerOpts = opts
        state.viewer = this as unknown as Record<string, unknown>
      }
    },
  }
  state.load = () => Promise.resolve({ lib, viewer: ui })
  return { state, lib, ui }
})

vi.mock('../utils/pdf-runtime', () => ({
  loadPdfRuntime: () => rt.state.load(),
  makePdfWorker: () => {
    const w = { terminate: vi.fn() }
    rt.state.workers.push(w)
    return w
  },
}))

const s = rt.state
const blob = new Blob(['%PDF-1.7'])

function show(over: Record<string, unknown> = {}) {
  const props = {
    blob,
    path: 'a.pdf',
    onRetry: vi.fn(),
    onDownload: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  return { props, ...render(<PdfPreview {...props} />) }
}

// Lets the runtime and the bytes resolve, then opens the document
async function opened(pages = 3) {
  await act(async () => {})
  await act(async () => s.open?.resolve({ numPages: pages }))
}

beforeEach(() => {
  s.pdfWorkers = []
  s.workers = []
  s.tasks = []
  s.open = undefined
  s.load = () => Promise.resolve({ lib: rt.lib, viewer: rt.ui })
})
afterEach(() => vi.useRealTimers())

describe('PdfPreview', () => {
  it('opens a document in a worker of its own, fit to the width', async () => {
    show()
    expect(screen.getByText('Opening…')).toBeDefined()
    await opened()
    expect(s.pdfWorkers[0].port).toBe(s.workers[0])
    expect(s.docOpts).toMatchObject({
      worker: expect.any(rt.lib.PDFWorker),
      useWasm: false,
      enableXfa: false,
    })
    expect((s.docOpts as { data: ArrayBuffer }).data.byteLength).toBe(8)
    expect(s.linkOpts).toMatchObject({
      externalLinkTarget: 2,
      externalLinkRel: 'noopener noreferrer nofollow',
    })
    expect(s.viewerOpts).toMatchObject({
      maxCanvasPixels: 16_777_216,
      annotationMode: 2,
      annotationEditorMode: -1,
    })
    expect(screen.queryByText('Opening…')).toBeNull()
    expect(screen.getByText('Page 1 of 3')).toBeDefined()
    act(() => {
      s.bus?.dispatch('pagesinit', {})
      s.bus?.dispatch('pagechanging', { pageNumber: 2 })
      s.bus?.dispatch('scalechanging', { scale: 1.5 })
    })
    expect(s.viewer?.currentScaleValue).toBe('page-width')
    expect(screen.getByText('Page 2 of 3')).toBeDefined()
    expect(screen.getByText('150%')).toBeDefined()
  })

  it('zooms in, out and back to the width', async () => {
    show()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(s.viewer?.increaseScale).toHaveBeenCalled()
    expect(s.viewer?.decreaseScale).toHaveBeenCalled()
    ;(s.viewer as Record<string, unknown>).currentScaleValue = '2'
    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }))
    expect(s.viewer?.currentScaleValue).toBe('page-width')
  })

  it('finds text, steps through it and closes', async () => {
    show()
    await opened()
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    const box = screen.getByRole('textbox', { name: 'Find' })
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: 'zebra' } })
    const finds = () =>
      s.bus?.dispatched.filter(([n]) => n === 'find').map(([, e]) => e)
    expect(finds()?.at(-1)).toMatchObject({
      type: '',
      query: 'zebra',
      caseSensitive: false,
      highlightAll: true,
      findPrevious: false,
    })
    act(() =>
      s.bus?.dispatch('updatefindcontrolstate', {
        state: 3,
        matchesCount: { current: 0, total: 0 },
      }),
    )
    expect(screen.getByText('…')).toBeDefined()
    act(() =>
      s.bus?.dispatch('updatefindmatchescount', {
        matchesCount: { current: 2, total: 3 },
      }),
    )
    expect(screen.getByText('2 of 3')).toBeDefined()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(finds()?.at(-1)).toMatchObject({
      type: 'again',
      findPrevious: false,
    })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(finds()?.at(-1)).toMatchObject({ type: 'again', findPrevious: true })
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    expect(finds()?.at(-1)).toMatchObject({ type: '', caseSensitive: true })
    // The toolbar button closes it too
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(s.bus?.dispatched.at(-1)?.[0]).toBe('findbarclose')
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('ends the document and its worker when closed', async () => {
    const { unmount } = show()
    await opened()
    unmount()
    expect(s.viewer?.setDocument).toHaveBeenLastCalledWith(null)
    expect(s.tasks[0].destroy).toHaveBeenCalled()
    await act(async () => {})
    expect(s.pdfWorkers[0].destroy).toHaveBeenCalled()
    expect(s.workers[0].terminate).toHaveBeenCalled()
  })

  it('makes no worker when closed before pdf.js loads', async () => {
    const { unmount } = show()
    unmount()
    await act(async () => {})
    expect(s.workers).toHaveLength(0)
  })

  it('opens again for new bytes, ending the first worker', async () => {
    const { rerender, props } = show()
    await opened()
    rerender(<PdfPreview {...props} blob={new Blob(['%PDF-2'])} />)
    await act(async () => {})
    expect(s.workers[0].terminate).toHaveBeenCalled()
    await opened(5)
    expect(screen.getByText('Page 1 of 5')).toBeDefined()
    expect(s.workers).toHaveLength(2)
  })

  it('drops a document that opens after it was closed', async () => {
    const { unmount } = show()
    await act(async () => {})
    unmount()
    await act(async () => s.open?.resolve({ numPages: 1 }))
    expect(s.viewer).toBeDefined()
    expect(s.workers[0].terminate).toHaveBeenCalled()
  })

  it.each([
    ['PasswordException', 'Password-protected PDF'],
    [
      'InvalidPDFException',
      'The file could not be read (damaged or not supported)',
    ],
    [
      'ResponseException',
      'The file could not be read (damaged or not supported)',
    ],
    [
      'UnknownErrorException',
      'The file could not be read (damaged or not supported)',
    ],
    ['TypeError', 'Could not load the file'],
  ])(
    'says why it cannot open (%s), and ends the worker',
    async (name, text) => {
      const { props } = show()
      await act(async () => {})
      const err = Object.assign(new Error('the file says: secret'), { name })
      await act(async () => s.open?.reject(err))
      expect(screen.getByText(text)).toBeDefined()
      expect(screen.queryByText(/secret/)).toBeNull()
      expect(s.workers[0].terminate).toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      expect(props.onDownload).toHaveBeenCalled()
    },
  )

  it('drops a failure that arrives after it was closed', async () => {
    const { unmount } = show()
    await act(async () => {})
    unmount()
    await act(async () => s.open?.reject(new Error('late')))
    expect(s.workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('offers Retry when pdf.js cannot load', async () => {
    s.load = () => Promise.reject('offline')
    const { props } = show()
    await act(async () => {})
    expect(screen.getByText('The viewer stopped')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(props.onRetry).toHaveBeenCalled()
    expect(s.workers).toHaveLength(0)
  })

  it('gives up on pdf.js that never loads', async () => {
    vi.useFakeTimers()
    s.load = () => new Promise(() => {})
    show()
    await act(async () => vi.advanceTimersByTime(DOC_LOAD_TIMEOUT))
    expect(screen.getByText('Took too long to open')).toBeDefined()
  })

  it('ends a worker whose destroy never answers', async () => {
    vi.useFakeTimers()
    const { unmount } = show()
    await opened()
    s.tasks[0].destroy = vi.fn(() => new Promise<void>(() => {}))
    unmount()
    await act(async () => {})
    expect(s.workers[0].terminate).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(PDF_DESTROY_WAIT))
    expect(s.workers[0].terminate).toHaveBeenCalled()
    expect(s.pdfWorkers[0].destroy).toHaveBeenCalled()
  })

  it('ends the worker when destroy fails', async () => {
    const { unmount } = show()
    await opened()
    s.tasks[0].destroy = vi.fn(() => Promise.reject(new Error('gone')))
    unmount()
    await act(async () => {})
    expect(s.workers[0].terminate).toHaveBeenCalled()
  })

  it('ends a stuck worker at once when opening fails', async () => {
    show()
    await act(async () => {})
    s.tasks[0].destroy = vi.fn(() => new Promise<void>(() => {}))
    await act(async () => s.open?.reject(new Error('x')))
    expect(s.workers[0].terminate).toHaveBeenCalled()
  })

  it('tells a failure that is no Error', async () => {
    show()
    await act(async () => {})
    await act(async () => s.open?.reject('odd'))
    expect(screen.getByText('Could not load the file')).toBeDefined()
  })

  it('gives up on a document that takes too long, offering Retry', async () => {
    vi.useFakeTimers()
    const { props } = show()
    await act(async () => {})
    await act(async () => vi.advanceTimersByTime(PDF_OPEN_TIMEOUT))
    expect(screen.getByText('Took too long to open')).toBeDefined()
    expect(s.tasks[0].destroy).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(props.onRetry).toHaveBeenCalled()
  })
})
