import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PaneDirHeader } from './pane-dir-header'

describe('PaneDirHeader', () => {
  it('shows the root short, the branch, and refreshes', () => {
    const onRefresh = vi.fn()
    render(
      <PaneDirHeader
        root="/home/kim/app"
        branch="main"
        onRefresh={onRefresh}
        refreshing
      />,
    )
    expect(screen.getByTestId('pane-root')).toHaveTextContent('~/app')
    expect(screen.getByTestId('pane-root')).toHaveAttribute(
      'title',
      '/home/kim/app',
    )
    expect(screen.getByText('main')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('waits for the root', () => {
    render(<PaneDirHeader onRefresh={vi.fn()} />)
    expect(screen.getByTestId('pane-root')).toHaveTextContent('…')
  })
})
