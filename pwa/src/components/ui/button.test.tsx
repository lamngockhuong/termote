import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Button, IconButton } from './button'

describe('Button', () => {
  it('is a secondary medium button of type button by default', () => {
    render(<Button>Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('bg-surface', 'h-9', 'pointer-coarse:h-touch')
  })

  it.each([
    ['primary', 'bg-accent'],
    ['secondary', 'bg-surface'],
    ['ghost', 'text-fg-muted'],
    ['danger', 'text-danger'],
  ] as const)('renders the %s variant', (variant, cls) => {
    render(<Button variant={variant}>Go</Button>)
    expect(screen.getByRole('button')).toHaveClass(cls)
  })

  it('renders the small size and keeps extra classes and props', () => {
    const onClick = vi.fn()
    render(
      <Button size="sm" type="submit" className="w-full" onClick={onClick}>
        Send
      </Button>,
    )
    const button = screen.getByRole('button')
    expect(button).toHaveClass('h-8', 'w-full')
    expect(button).toHaveAttribute('type', 'submit')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not fire when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Send
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('is a ghost icon button named by aria-label, 44px on touch screens', () => {
    render(
      <IconButton aria-label="Close">
        <svg />
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Close' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass(
      'text-fg-muted',
      'size-10',
      'pointer-coarse:size-touch',
    )
  })

  it('takes a variant, a size and extra classes', () => {
    render(
      <IconButton aria-label="Add" variant="primary" size="sm" className="ml-2">
        +
      </IconButton>,
    )
    expect(screen.getByRole('button', { name: 'Add' })).toHaveClass(
      'bg-accent',
      'size-8',
      'ml-2',
    )
  })

  it('shows a focus ring for keyboard focus', () => {
    render(<IconButton aria-label="Menu">≡</IconButton>)
    expect(screen.getByRole('button')).toHaveClass(
      'focus-visible:outline-accent',
    )
  })
})
