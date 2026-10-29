import { createElement, type ReactNode, useEffect, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import {
  DocumentWorkerClient,
  type DocumentWorkerError,
} from '../utils/document-worker-client'
import {
  type DocChild,
  IMAGE_SRC,
  isDocTag,
  safeHref,
} from '../utils/docx-sanitize'
import type { DocxReply, DocxRequest } from '../utils/docx-worker'
import { LINK, PROSE } from '../utils/prose'
import { DocumentError, DocumentMessage } from './document-message'
import type { DocumentViewerProps } from './document-preview'
import { Banner } from './ui/banner'
import { Button } from './ui/button'

const makeWorker = () =>
  new Worker(new URL('../utils/docx-worker.ts', import.meta.url), {
    type: 'module',
  })

type Doc =
  | { status: 'loading' }
  | {
      status: 'ready'
      tree: DocChild[]
      truncated: boolean
      imagesOmitted: number
    }
  | { status: 'error'; error: unknown }

// A failure the worker answered, told by its code (document-message.tsx)
function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

// A cell spans 2 to 1000 columns or rows
const spanOk = (n: number | undefined) =>
  Number.isInteger(n) && (n as number) > 1 && (n as number) <= 1000

// The tree the worker made as React elements. Each tag and attribute is
// checked again here: only allowed ones, links to http(s) or mailto opening
// in a new tab, images from data: URLs of raster types.
export function renderDocTree(
  nodes: DocChild[],
  t: Translate<MessageKey>,
): ReactNode[] {
  return nodes.map((n, key) => {
    if (typeof n === 'string') return n
    if (!isDocTag(n.t)) return null
    const a = n.a ?? {}
    const props: Record<string, unknown> = { key }
    if (n.t === 'a') {
      const href = safeHref(a.href)
      if (!href) return renderDocTree(n.c ?? [], t)
      Object.assign(props, {
        href,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
        className: LINK,
      })
    } else if (n.t === 'img') {
      if (!a.src || !IMAGE_SRC.test(a.src)) return t('files.docx.imageOmitted')
      Object.assign(props, {
        src: a.src,
        alt: a.alt ?? '',
        className: 'inline max-w-full',
      })
      return createElement('img', props)
    } else if (n.t === 'br') {
      return createElement('br', props)
    } else if (n.t === 'td' || n.t === 'th') {
      if (spanOk(a.colspan)) props.colSpan = a.colspan
      if (spanOk(a.rowspan)) props.rowSpan = a.rowspan
    }
    // One keyed array, not spread: a node can hold more children than a
    // call takes arguments
    const el = createElement(n.t, props, renderDocTree(n.c ?? [], t))
    // A wide table scrolls on its own, as in a Markdown preview. The tree
    // never changes once shown: its places are its keys.
    return n.t === 'table'
      ? createElement('div', { key, className: 'my-3 overflow-x-auto' }, el)
      : el
  })
}

// A Word document read only: its text, headings, lists, tables and images,
// converted in a worker that is ended when the document closes, fails or
// takes too long. Find is the browser's: the text is the page's own.
export default function DocxPreview({ blob, onDownload }: DocumentViewerProps) {
  const { t } = useT()
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<Doc>({ status: 'loading' })

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt converts the file again
  useEffect(() => {
    const client = new DocumentWorkerClient<DocxRequest, DocxReply>(makeWorker)
    const ctl = new AbortController()
    setDoc({ status: 'loading' })
    blob
      .arrayBuffer()
      .then((buf) =>
        client.request({ type: 'convert', buf }, [buf], ctl.signal),
      )
      .then(
        (reply) =>
          setDoc(
            reply.type === 'doc'
              ? {
                  status: 'ready',
                  tree: reply.tree,
                  truncated: reply.truncated,
                  imagesOmitted: reply.imagesOmitted,
                }
              : { status: 'error', error: failure(reply.code) },
          ),
        (error: DocumentWorkerError) => {
          if (!ctl.signal.aborted) setDoc({ status: 'error', error })
        },
      )
    return () => {
      ctl.abort()
      client.terminate()
    }
  }, [blob, attempt])

  if (doc.status === 'error')
    return (
      <DocumentError
        error={doc.error}
        onRetry={() => setAttempt((n) => n + 1)}
        onDownload={onDownload}
      />
    )
  if (doc.status === 'loading')
    return <DocumentMessage>{t('files.document.opening')}</DocumentMessage>
  const notes = [
    doc.truncated && t('files.docx.truncated'),
    doc.imagesOmitted > 0 &&
      t('files.docx.imagesOmitted', { count: doc.imagesOmitted }),
  ].filter(Boolean)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {notes.length > 0 && (
        <Banner
          action={
            onDownload && (
              <Button size="sm" variant="secondary" onClick={onDownload}>
                {t('files.download')}
              </Button>
            )
          }
        >
          {notes.join(t('files.docx.noteSeparator'))}
        </Banner>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        <article className={PROSE}>{renderDocTree(doc.tree, t)}</article>
      </div>
    </div>
  )
}
