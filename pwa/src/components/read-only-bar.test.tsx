import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReadOnlyBar } from './read-only-bar'

describe('ReadOnlyBar', () => {
  it('shows its label alone', () => {
    const { container } = render(<ReadOnlyBar label="View only" />)
    expect(screen.getByText('View only')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('h-12')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('puts the action at the end', () => {
    const { container } = render(
      <ReadOnlyBar label="Read only" action={<button>Go</button>} />,
    )
    // Grows by the safe-area inset instead of a fixed height
    expect(container.firstElementChild).not.toHaveClass('h-12')
    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
  })
})
