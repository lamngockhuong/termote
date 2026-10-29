import type { DocumentBytes } from '../hooks/use-document-bytes'
import { useT } from '../i18n/i18n-context'
import type { DocumentKind } from '../utils/document-path'
import { DocumentError, DocumentMessage } from './document-message'
import DocxPreview from './docx-preview'
import PdfPreview from './pdf-preview'
import XlsxPreview from './xlsx-preview'

// What a viewer of one kind gets: the file's bytes (read again for each
// worker, never a buffer kept after it was transferred)
export interface DocumentViewerProps {
  blob: Blob
  path: string
  // Reads the file again from the server
  onRetry: () => void
  onDownload?: () => void
  notify: (message: string) => void
}

interface Props {
  kind: DocumentKind
  path: string
  state: DocumentBytes
  onRetry: () => void
  onDownload?: () => void
  notify: (message: string) => void
}

// A PDF, .xlsx or .docx, read only: loading, the viewer of its kind, or why
// it cannot be shown with the full file to download
export default function DocumentPreview({
  kind,
  path,
  state,
  onRetry,
  onDownload,
  notify,
}: Props) {
  const { t } = useT()
  if (state.status === 'error')
    return (
      <DocumentError
        error={state.error}
        onRetry={onRetry}
        onDownload={onDownload}
      />
    )
  if (state.status !== 'ready')
    return <DocumentMessage>{t('files.loading')}</DocumentMessage>
  const props: DocumentViewerProps = {
    blob: state.blob,
    path,
    onRetry,
    onDownload,
    notify,
  }
  switch (kind) {
    case 'pdf':
      return <PdfPreview {...props} />
    case 'xlsx':
      return <XlsxPreview {...props} />
    case 'docx':
      return <DocxPreview {...props} />
    default:
      return (
        <DocumentMessage onDownload={props.onDownload}>
          {t('files.document.noViewer')}
        </DocumentMessage>
      )
  }
}
