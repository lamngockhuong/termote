import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PdfToolbar } from './pdf-toolbar'

describe('PdfToolbar', () => {
  it('shows where the document is, and drives zoom and find', () => {
    const p = {
      page: 2,
      pages: 9,
      scale: 125,
      onZoomIn: vi.fn(),
      onZoomOut: vi.fn(),
      onFitWidth: vi.fn(),
      findOpen: false,
      onFind: vi.fn(),
    }
    const { rerender } = render(<PdfToolbar {...p} />)
    expect(screen.getByText('Page 2 of 9')).toBeDefined()
    expect(screen.getByText('125%')).toBeDefined()
    for (const [name, fn] of [
      ['Zoom in', p.onZoomIn],
      ['Zoom out', p.onZoomOut],
      ['Fit width', p.onFitWidth],
      ['Find', p.onFind],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }))
      expect(fn).toHaveBeenCalledTimes(1)
    }
    expect(screen.getByRole('button', { name: 'Find' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    rerender(<PdfToolbar {...p} findOpen />)
    expect(screen.getByRole('button', { name: 'Find' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
})
