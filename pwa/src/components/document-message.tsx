import type { ReactNode } from 'react'
import { filesError } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import { DocumentWorkerError } from '../utils/document-worker-client'
import { formatSize } from '../utils/files-format'
import { ViewMessage } from './pane-dir-header'
import { Button } from './ui/button'

// Why a document cannot be shown, by the server's code or the viewer's
const CODES: Record<string, string> = {
  not_document: 'Not previewable (not a valid PDF, .xlsx or .docx file)',
  encrypted: 'Password-protected or encrypted file',
  lfs_pointer: 'Stored in Git LFS: only the pointer is in git',
  busy: 'Busy, try again',
  sensitive: 'This file may contain secrets',
  interrupted: 'The download was cut off',
  // The viewer's own
  timeout: 'Took too long to open',
  dead: 'The viewer stopped',
  failed: 'The file could not be read (damaged or not supported)',
  corrupt: 'The file could not be read (damaged or not supported)',
  too_big: 'Too large to preview once unpacked',
  password: 'Password-protected PDF',
}

const ERRORS = {
  'not-allowed': "This file can't be shown",
  'view-only': 'View only: files show in a git repository only',
  'not-found': 'File not found',
  unsupported: 'Not supported by this backend',
  unavailable: 'Could not load the file',
}

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
export function documentErrorText(error: unknown): string {
  const code = documentCode(error)
  if (code === 'too_large') {
    // Only the server says too_large, with the size when it knows it
    const size = (error as RequestError).size
    return size === undefined
      ? 'Larger than 30 MiB'
      : `Larger than 30 MiB (${formatSize(size)})`
  }
  return CODES[code] ?? ERRORS[filesError(error)]
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
  return (
    <ViewMessage>
      <span role="status">{children}</span>
      {(onRetry || onDownload) && (
        <span className="flex gap-1.5">
          {onRetry && (
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
          {onDownload && (
            <Button size="sm" variant="secondary" onClick={onDownload}>
              Download
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
  return (
    <DocumentMessage
      onRetry={RETRY.has(documentCode(error)) ? onRetry : undefined}
      onDownload={onDownload}
    >
      {documentErrorText(error)}
    </DocumentMessage>
  )
}
