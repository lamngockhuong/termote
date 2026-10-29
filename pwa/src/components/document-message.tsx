import type { ReactNode } from 'react'
import { filesError } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import type { Locale } from '../i18n'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { DocumentWorkerError } from '../utils/document-worker-client'
import { formatSize } from '../utils/files-format'
import { ViewMessage } from './pane-dir-header'
import { Button } from './ui/button'

// Why a document cannot be shown, by the server's code or the viewer's
const CODES: Record<string, MessageKey> = {
  not_document: 'files.document.notDocument',
  encrypted: 'files.document.encrypted',
  lfs_pointer: 'files.document.lfsPointer',
  busy: 'files.document.busy',
  sensitive: 'files.viewer.sensitive',
  interrupted: 'files.document.interrupted',
  // The viewer's own
  timeout: 'files.document.timeout',
  dead: 'files.document.dead',
  failed: 'files.document.unreadable',
  corrupt: 'files.document.unreadable',
  too_big: 'files.document.tooBig',
  password: 'files.document.password',
}

const ERRORS = {
  'not-allowed': 'files.viewer.notAllowed',
  'view-only': 'files.find.viewOnly',
  'not-found': 'files.delete.fileNotFound',
  unsupported: 'files.find.unsupported',
  unavailable: 'files.viewer.failed',
} as const satisfies Record<string, MessageKey>

// Codes worth reading again: the server was busy, the bytes were cut off,
// or the viewer gave up
const RETRY = new Set(['busy', 'interrupted', 'timeout', 'dead'])

// The code of why a document failed: the server's, or the viewer's
export function documentCode(error: unknown): string {
  if (error instanceof RequestError) return error.code
  if (error instanceof DocumentWorkerError) return error.code
  if (error instanceof Error && 'code' in error)
    return String((error as { code: unknown }).code)
  return ''
}

// What to say about a failed document
export function documentErrorText(
  error: unknown,
  t: Translate<MessageKey>,
  locale: Locale,
): string {
  const code = documentCode(error)
  if (code === 'too_large') {
    // Only the server says too_large, with the size when it knows it
    const size = (error as RequestError).size
    return size === undefined
      ? t('files.document.tooLarge')
      : t('files.document.tooLargeSize', { size: formatSize(size, locale) })
  }
  return t(CODES[code] ?? ERRORS[filesError(error)])
}

interface Props {
  children: ReactNode
  // Reads the file again
  onRetry?: () => void
  // The full file, for whoever may download it
  onDownload?: () => void
}

// A reason in place of the document, with Retry and Download when they help
export function DocumentMessage({ children, onRetry, onDownload }: Props) {
  const { t } = useT()
  return (
    <ViewMessage>
      <span role="status">{children}</span>
      {(onRetry || onDownload) && (
        <span className="flex gap-1.5">
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              {t('files.search.retry')}
            </Button>
          )}
          {onDownload && (
            <Button size="sm" variant="secondary" onClick={onDownload}>
              {t('files.download')}
            </Button>
          )}
        </span>
      )}
    </ViewMessage>
  )
}

// A failed document: why, with Retry when reading again can help
export function DocumentError({
  error,
  onRetry,
  onDownload,
}: {
  error: unknown
  onRetry?: () => void
  onDownload?: () => void
}) {
  const { t, locale } = useT()
  return (
    <DocumentMessage
      onRetry={RETRY.has(documentCode(error)) ? onRetry : undefined}
      onDownload={onDownload}
    >
      {documentErrorText(error, t, locale)}
    </DocumentMessage>
  )
}
