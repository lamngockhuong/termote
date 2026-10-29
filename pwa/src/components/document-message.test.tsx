import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import { DocumentWorkerError } from '../utils/document-worker-client'
import { ZipGuardError } from '../utils/zip-guard'
import {
  DocumentError,
  DocumentMessage,
  documentCode,
  documentErrorText,
} from './document-message'

describe('documentErrorText', () => {
  it.each([
    [
      new RequestError(413, 'too_large', 'x', { size: 31 << 20 }),
      'Larger than 30 MiB (31.0 MiB)',
    ],
    [new RequestError(413, 'too_large', 'x'), 'Larger than 30 MiB'],
    [
      new RequestError(415, 'not_document', 'x'),
      'Not previewable (not a valid PDF, .xlsx or .docx file)',
    ],
    [
      new RequestError(415, 'encrypted', 'x'),
      'Password-protected or encrypted file',
    ],
    [new RequestError(0, 'interrupted', 'x'), 'The download was cut off'],
    [new RequestError(404, '', 'x'), 'File not found'],
    [new DocumentWorkerError('timeout'), 'Took too long to open'],
    [new ZipGuardError('too_big', 'x'), 'Too large to preview once unpacked'],
    [new Error('x'), 'Could not load the file'],
    ['x', 'Could not load the file'],
  ])('%s', (error, text) => {
    expect(documentErrorText(error, tFor('en'), 'en')).toBe(text)
  })

  it('tells the code of each kind of failure', () => {
    expect(documentCode(new RequestError(429, 'busy', 'x'))).toBe('busy')
    expect(documentCode(new DocumentWorkerError('dead'))).toBe('dead')
    expect(documentCode(Object.assign(new Error('x'), { code: 7 }))).toBe('7')
    expect(documentCode(null)).toBe('')
  })
})

describe('DocumentMessage', () => {
  it('shows only the reason without actions', () => {
    render(<DocumentMessage>Loading…</DocumentMessage>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading…')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers Retry for what reading again can help, and Download', () => {
    const onRetry = vi.fn()
    const onDownload = vi.fn()
    const { rerender } = render(
      <DocumentError
        error={new DocumentWorkerError('timeout')}
        onRetry={onRetry}
        onDownload={onDownload}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onRetry).toHaveBeenCalled()
    expect(onDownload).toHaveBeenCalled()
    rerender(
      <DocumentError
        error={new RequestError(415, 'encrypted', 'x')}
        onRetry={onRetry}
      />,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
