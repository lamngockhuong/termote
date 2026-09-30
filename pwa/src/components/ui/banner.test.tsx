import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Banner } from './banner'

describe('Banner', () => {
  it('is an info status line by default', () => {
    render(<Banner>View only</Banner>)
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent('View only')
    expect(banner).toHaveAttribute('data-variant', 'info')
    expect(banner).toHaveClass('bg-info/12')
  })

  it.each([
    ['warning', 'bg-warning/12', 'text-warning'],
    ['danger', 'bg-danger/12', 'text-danger'],
  ] as const)('renders the %s variant', (variant, box, icon) => {
    render(<Banner variant={variant}>Lost</Banner>)
    const banner = screen.getByRole('status')
    expect(banner).toHaveClass(box)
    expect(banner.querySelector('svg')).toHaveClass(icon)
  })

  it('shows an action at the end of the line', () => {
    render(
      <Banner variant="danger" action={<button type="button">Retry</button>}>
        Connection lost
      </Banner>,
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
