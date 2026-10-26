import { useEffect, useRef, useState } from 'react'
import type { FindStatus } from '../hooks/use-csv-find'
import {
  DOC_LOAD_TIMEOUT,
  DocumentWorkerError,
} from '../utils/document-worker-client'
import {
  PDF_MAX_CANVAS_PIXELS,
  PDF_OPEN_TIMEOUT,
  pdfDocumentOptions,
} from '../utils/pdf-options'
import { loadPdfRuntime, makePdfWorker } from '../utils/pdf-runtime'
import { DocumentError, DocumentMessage } from './document-message'
import type { DocumentViewerProps } from './document-preview'
import { PdfToolbar } from './pdf-toolbar'
import { type FindFlags, TableFindBar } from './table-find-bar'

// What the toolbar and find drive, once the document is open
interface Open {
  pages: number
  zoomIn: () => void
  zoomOut: () => void
  fitWidth: () => void
  find: (query: string, matchCase: boolean, previous?: boolean) => void
  closeFind: () => void
}

interface Matches {
  current: number
  total: number
  pending: boolean
}

// A failure of the viewer's own, told by its code (document-message.tsx)
function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

// pdf.js's errors by name: never their text, which may quote the file
function pdfError(err: unknown): unknown {
  const name = err instanceof Error ? err.name : ''
  if (name === 'PasswordException') return failure('password')
  if (name === 'InvalidPDFException') return failure('corrupt')
  if (name === 'ResponseException' || name === 'UnknownErrorException')
    return failure('failed')
  return err
}

// How long a closed document's worker is given to end on its own
export const PDF_DESTROY_WAIT = 1000

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DocumentWorkerError('timeout')), ms)
    p.then(resolve, reject).finally(() => clearTimeout(t))
  })
}

const NO_FLAGS: FindFlags = { matchCase: false, wholeCell: false, regex: false }

// A PDF read only: its pages drawn as they come into view, zoom, text that
// can be selected, find. Each document gets a worker of its own, terminated
// with it (on close, on failure, on timeout).
export default function PdfPreview({
  blob,
  onRetry,
  onDownload,
}: DocumentViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<Open>()
  const [error, setError] = useState<unknown>()
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(100)
  const [findOpen, setFindOpen] = useState(false)
  const [input, setInput] = useState('')
  const [flags, setFlags] = useState<FindFlags>(NO_FLAGS)
  const [matches, setMatches] = useState<Matches>({
    current: 0,
    total: 0,
    pending: false,
  })
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    let worker: Worker | undefined
    let pdfWorker: { destroy: () => void } | undefined
    let task: { destroy: () => Promise<void> } | undefined
    let viewer: { setDocument: (d: null) => void } | undefined
    // Ends the document and its worker, once. pdf.js's destroy waits for
    // the worker to answer: a worker that is stuck (the reason for a timeout)
    // never does, so it is terminated at once on a failure, and at most
    // PDF_DESTROY_WAIT after a close.
    let disposed = false
    const dispose = (now: boolean) => {
      if (disposed) return
      disposed = true
      viewer?.setDocument(null)
      const end = () => {
        pdfWorker?.destroy()
        worker?.terminate()
      }
      const destroyed = task?.destroy().catch(() => {})
      if (now || !destroyed) end()
      else Promise.race([destroyed, wait(PDF_DESTROY_WAIT)]).then(end)
    }
    setOpen(undefined)
    setError(undefined)
    ;(async () => {
      // A chunk that never loads is given up on, and Retry offered
      const { lib, viewer: ui } = await timeout(
        loadPdfRuntime().catch(() => {
          throw new DocumentWorkerError('dead')
        }),
        DOC_LOAD_TIMEOUT,
      )
      const data = await blob.arrayBuffer()
      if (!live) return
      worker = makePdfWorker()
      // pdf.js types the port wrongly (null): a Worker is what it takes
      const pw = new lib.PDFWorker({ port: worker as never })
      pdfWorker = pw
      const loading = lib.getDocument(pdfDocumentOptions(data, pw))
      task = loading
      const doc = await timeout(loading.promise, PDF_OPEN_TIMEOUT)
      if (!live) return
      // Mounted while live: both are there
      const container = containerRef.current as HTMLDivElement
      const view = viewerRef.current as HTMLDivElement
      const eventBus = new ui.EventBus()
      const linkService = new ui.PDFLinkService({
        eventBus,
        externalLinkTarget: ui.LinkTarget.BLANK,
        externalLinkRel: 'noopener noreferrer nofollow',
      })
      const findController = new ui.PDFFindController({ eventBus, linkService })
      const pdfViewer = new ui.PDFViewer({
        container,
        viewer: view,
        eventBus,
        linkService,
        findController,
        maxCanvasPixels: PDF_MAX_CANVAS_PIXELS,
        annotationMode: lib.AnnotationMode.ENABLE,
        annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      })
      viewer = pdfViewer
      linkService.setViewer(pdfViewer)
      eventBus.on('pagesinit', () => {
        pdfViewer.currentScaleValue = 'page-width'
      })
      eventBus.on('pagechanging', (e: { pageNumber: number }) =>
        setPage(e.pageNumber),
      )
      eventBus.on('scalechanging', (e: { scale: number }) =>
        setScale(Math.round(e.scale * 100)),
      )
      const counted = (
        m: { current: number; total: number },
        pending: boolean,
      ) => setMatches({ current: m.current, total: m.total, pending })
      eventBus.on(
        'updatefindmatchescount',
        (e: { matchesCount: { current: number; total: number } }) =>
          counted(e.matchesCount, false),
      )
      eventBus.on(
        'updatefindcontrolstate',
        (e: {
          state: number
          matchesCount: { current: number; total: number }
        }) => counted(e.matchesCount, e.state === ui.FindState.PENDING),
      )
      pdfViewer.setDocument(doc)
      linkService.setDocument(doc)
      const find = (query: string, matchCase: boolean, previous?: boolean) =>
        eventBus.dispatch('find', {
          source: null,
          type: previous === undefined ? '' : 'again',
          query,
          caseSensitive: matchCase,
          entireWord: false,
          highlightAll: true,
          findPrevious: previous === true,
          matchDiacritics: false,
        })
      setOpen({
        pages: doc.numPages,
        zoomIn: () => pdfViewer.increaseScale(),
        zoomOut: () => pdfViewer.decreaseScale(),
        fitWidth: () => {
          pdfViewer.currentScaleValue = 'page-width'
        },
        find,
        closeFind: () => eventBus.dispatch('findbarclose', { source: null }),
      })
    })().catch((err: unknown) => {
      if (!live) return
      dispose(true)
      setError(pdfError(err))
    })
    return () => {
      live = false
      dispose(false)
    }
  }, [blob])

  // The find box takes focus as it opens
  useEffect(() => {
    if (findOpen) inputRef.current?.focus()
  }, [findOpen])

  const closeFind = () => {
    setFindOpen(false)
    open?.closeFind()
  }

  if (error !== undefined)
    return (
      <DocumentError error={error} onRetry={onRetry} onDownload={onDownload} />
    )
  const status: FindStatus = matches.pending ? 'busy' : 'ready'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {open && (
        <PdfToolbar
          page={page}
          pages={open.pages}
          scale={scale}
          onZoomIn={open.zoomIn}
          onZoomOut={open.zoomOut}
          onFitWidth={open.fitWidth}
          findOpen={findOpen}
          onFind={() => {
            if (findOpen) closeFind()
            else setFindOpen(true)
          }}
        />
      )}
      {open && findOpen && (
        <TableFindBar
          label="Find in document"
          toggles={['matchCase']}
          f3={false}
          input={input}
          onInput={(q) => {
            setInput(q)
            open.find(q, flags.matchCase)
          }}
          flags={flags}
          onFlags={(f) => {
            setFlags(f)
            open.find(input, f.matchCase)
          }}
          status={status}
          count={matches.total}
          current={Math.max(matches.current - 1, 0)}
          hidden={0}
          onStep={(step) => open.find(input, flags.matchCase, step === -1)}
          onClose={closeFind}
          inputRef={inputRef}
        />
      )}
      {/* pdf.js lays the pages out in an absolutely placed container, which
          has its width from the start: the first zoom fits it */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          className="absolute inset-0 overflow-auto bg-surface"
        >
          <div ref={viewerRef} className="pdfViewer" />
        </div>
        {!open && (
          <div className="absolute inset-0 flex">
            <DocumentMessage>Opening…</DocumentMessage>
          </div>
        )}
      </div>
    </div>
  )
}
