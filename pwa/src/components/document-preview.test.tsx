import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import DocumentPreview from './document-preview'

vi.mock('./docx-preview', () => ({
  default: (p: { path: string }) => <div data-testid="docx">{p.path}</div>,
}))
vi.mock('./xlsx-preview', () => ({
  default: (p: { path: string }) => <div data-testid="xlsx">{p.path}</div>,
}))
vi.mock('./pdf-preview', () => ({
  default: (p: { path: string; blob: Blob; onDownload?: () => void }) => (
    <div data-testid="pdf">
      {p.path} {p.blob.size} {p.onDownload ? 'download' : ''}
    </div>
  ),
}))

const base = { path: 'a.pdf', onRetry: vi.fn(), notify: vi.fn() }

describe('DocumentPreview', () => {
  it('says it is loading until the bytes are read', () => {
    render(
      <DocumentPreview kind="pdf" {...base} state={{ status: 'loading' }} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    render(<DocumentPreview kind="pdf" {...base} state={{ status: 'idle' }} />)
    expect(screen.getAllByText('Loading…')).toHaveLength(2)
  })

  it('says why the bytes could not be read', () => {
    render(
      <DocumentPreview
        kind="xlsx"
        {...base}
        state={{
          status: 'error',
          error: new RequestError(415, 'not_document', 'x'),
        }}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent(/not a valid PDF/)
  })

  it('hands the bytes to the viewer of the kind', () => {
    render(
      <DocumentPreview
        kind="pdf"
        {...base}
        onDownload={vi.fn()}
        state={{ status: 'ready', blob: new Blob(['%PDF']), size: 4 }}
      />,
    )
    expect(screen.getByTestId('pdf')).toHaveTextContent('a.pdf 4 download')
  })

  it('opens a workbook in the sheet viewer', () => {
    render(
      <DocumentPreview
        kind="xlsx"
        {...base}
        path="b.xlsx"
        state={{ status: 'ready', blob: new Blob(['PK']), size: 2 }}
      />,
    )
    expect(screen.getByTestId('xlsx')).toHaveTextContent('b.xlsx')
  })

  it('opens a Word document in the document viewer', () => {
    render(
      <DocumentPreview
        kind="docx"
        {...base}
        path="c.docx"
        state={{ status: 'ready', blob: new Blob(['PK']), size: 2 }}
      />,
    )
    expect(screen.getByTestId('docx')).toHaveTextContent('c.docx')
  })

  it('says when no viewer takes the kind', () => {
    render(
      <DocumentPreview
        kind={'odt' as 'pdf'}
        {...base}
        state={{ status: 'ready', blob: new Blob(['x']), size: 1 }}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('No viewer')
  })
})
