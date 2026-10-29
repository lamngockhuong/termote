import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import {
  DocumentWorkerClient,
  type DocumentWorkerError,
} from '../utils/document-worker-client'
import type { SheetTsv } from '../utils/sheet-tsv'
import type { TableLayout } from '../utils/table-columns'
import type { SheetInfo, XlsxReply, XlsxRequest } from '../utils/xlsx-worker'
import { DocumentError, DocumentMessage } from './document-message'
import type { DocumentViewerProps } from './document-preview'
import TablePreview from './table-preview'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

type Client = DocumentWorkerClient<XlsxRequest, XlsxReply>

const makeWorker = () =>
  new Worker(new URL('../utils/xlsx-worker.ts', import.meta.url), {
    type: 'module',
  })

type Book =
  | { status: 'loading' }
  | { status: 'ready'; sheets: SheetInfo[] }
  | { status: 'error'; error: unknown }

type Sheet =
  | { status: 'loading' }
  | { status: 'ready'; tsv: SheetTsv; totalRows: number }
  | { status: 'error'; error: unknown }

// A failure the worker answered, told by its code (document-message.tsx)
function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

// An Excel workbook read only: a tab for each sheet shown in Excel, each in
// the table view (filter, sort, find, records) without editing. The worker
// reads one sheet at a time; one that fails or takes too long is ended, and
// Retry opens the file again from its bytes.
export default function XlsxPreview({
  blob,
  onDownload,
  notify,
}: DocumentViewerProps) {
  const { t } = useT()
  const [attempt, setAttempt] = useState(0)
  const [book, setBook] = useState<Book>({ status: 'loading' })
  const [sheets, setSheets] = useState<Record<string, Sheet>>({})
  const [active, setActive] = useState(0)
  // The open file's client, undefined once closed; the sheets asked of it
  const client = useRef<Client>(undefined)
  const requested = useRef(new Set<string>())
  // Each sheet's widths and wrapped columns, while the file is open
  const layouts = useRef(new Map<string, TableLayout>())
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  // Unique to this viewer: a page can show two workbooks
  const ids = useId()

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt opens the file again
  useEffect(() => {
    const c: Client = new DocumentWorkerClient(makeWorker)
    const ctl = new AbortController()
    client.current = c
    requested.current.clear()
    setBook({ status: 'loading' })
    setSheets({})
    setActive(0)
    layouts.current.clear()
    blob
      .arrayBuffer()
      .then((buf) => c.request({ type: 'open', buf }, [buf], ctl.signal))
      .then(
        (reply) =>
          setBook(
            reply.type === 'open'
              ? { status: 'ready', sheets: reply.sheets }
              : {
                  status: 'error',
                  error: failure(
                    reply.type === 'error' ? reply.code : 'failed',
                  ),
                },
          ),
        (error) => {
          if (!ctl.signal.aborted) setBook({ status: 'error', error })
        },
      )
    return () => {
      client.current = undefined
      ctl.abort()
      c.terminate()
    }
  }, [blob, attempt])

  const shown =
    book.status === 'ready' ? book.sheets.filter((s) => !s.hidden) : []
  const name = shown[active]?.name
  const sheet = name === undefined ? undefined : sheets[name]

  // The sheet shown, read the first time it is; an answer of a file closed
  // since is dropped
  useEffect(() => {
    const c = client.current
    if (name === undefined || !c || requested.current.has(name)) return
    requested.current.add(name)
    const set = (s: Sheet) => setSheets((all) => ({ ...all, [name]: s }))
    set({ status: 'loading' })
    c.request({ type: 'sheet', name }).then(
      (reply) =>
        client.current === c &&
        set(
          reply.type === 'sheet'
            ? { status: 'ready', tsv: reply.tsv, totalRows: reply.totalRows }
            : {
                status: 'error',
                error: failure(reply.type === 'error' ? reply.code : 'failed'),
              },
        ),
      // The worker was ended (DocumentWorkerError): the whole file is
      // opened again on Retry
      (error: DocumentWorkerError) =>
        client.current === c && setBook({ status: 'error', error }),
    )
  }, [name])

  const reopen = () => setAttempt((n) => n + 1)

  if (book.status === 'error')
    return (
      <DocumentError
        error={book.error}
        onRetry={reopen}
        onDownload={onDownload}
      />
    )
  if (book.status === 'loading')
    return <DocumentMessage>{t('files.document.opening')}</DocumentMessage>
  const hidden = book.sheets.length - shown.length
  if (shown.length === 0)
    return (
      <DocumentMessage onDownload={onDownload}>
        {t('files.xlsx.allHidden')}
      </DocumentMessage>
    )

  const go = (i: number) => {
    setActive(i)
    tabs.current[i]?.focus()
  }
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = shown.length
    const to =
      e.key === 'ArrowRight'
        ? (active + 1) % n
        : e.key === 'ArrowLeft'
          ? (active - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : undefined
    if (to === undefined) return
    e.preventDefault()
    go(to)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-[13px]">
        <div
          role="tablist"
          aria-label={t('files.xlsx.sheets')}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          onKeyDown={onTabKey}
        >
          {shown.map((s, i) => (
            <button
              key={s.name}
              ref={(el) => {
                tabs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`${ids}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${ids}-panel`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              className={`shrink-0 rounded-control px-2 py-1 pointer-coarse:min-h-touch ${
                i === active
                  ? 'bg-surface-raised text-fg'
                  : 'text-fg-muted hover:text-fg'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        {hidden > 0 && (
          <span className="shrink-0 text-fg-subtle">
            {t('files.xlsx.hidden', { count: hidden })}
          </span>
        )}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-tab-${active}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {sheet?.status === 'error' && (
          <DocumentError error={sheet.error} onDownload={onDownload} />
        )}
        {sheet?.status === 'ready' && name !== undefined && (
          <>
            {(sheet.tsv.truncated || sheet.tsv.columnsCut) && (
              <Banner
                action={
                  onDownload && (
                    <Button size="sm" variant="secondary" onClick={onDownload}>
                      {t('files.download')}
                    </Button>
                  )
                }
              >
                {t(
                  sheet.tsv.truncated
                    ? onDownload
                      ? 'files.xlsx.rowsCutDownload'
                      : 'files.xlsx.rowsCut'
                    : onDownload
                      ? 'files.xlsx.columnsCutDownload'
                      : 'files.xlsx.columnsCut',
                  { rows: sheet.tsv.rows, total: sheet.totalRows },
                )}
              </Banner>
            )}
            <TablePreview
              key={name}
              text={sheet.tsv.text}
              path={`${name}.tsv`}
              wrap={false}
              notify={notify}
              layout={layouts.current.get(name)}
              onLayout={(l) => layouts.current.set(name, l)}
            />
          </>
        )}
        {(sheet === undefined || sheet.status === 'loading') && (
          <DocumentMessage>{t('files.xlsx.reading')}</DocumentMessage>
        )}
      </div>
    </div>
  )
}
