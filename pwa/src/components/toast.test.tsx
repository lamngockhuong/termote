import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toast } from './toast'

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the message', () => {
    render(<Toast message="Hello world" onClose={vi.fn()} />)
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('calls onClose after default duration (4000ms)', () => {
    const onClose = vi.fn()
    render(<Toast message="Test" onClose={onClose} />)
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose after custom duration', () => {
    const onClose = vi.fn()
    render(<Toast message="Test" onClose={onClose} duration={1500} />)
    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clears timer on unmount', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Toast message="Test" onClose={onClose} />)
    unmount()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('resets timer when duration changes', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Toast message="Test" onClose={onClose} duration={2000} />,
    )
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender(<Toast message="Test" onClose={onClose} duration={5000} />)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('is a status region', () => {
    render(<Toast message="Saved" onClose={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Saved')
  })

  it('uses the info variant by default and takes another', () => {
    const { rerender } = render(<Toast message="Hi" onClose={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'info')
    rerender(<Toast message="Hi" onClose={vi.fn()} variant="warning" />)
    expect(screen.getByRole('status')).toHaveAttribute(
      'data-variant',
      'warning',
    )
  })

  it('announces an error as an alert', () => {
    render(<Toast message="Failed" onClose={vi.fn()} variant="danger" />)
    expect(screen.getByRole('alert')).toHaveAttribute('data-variant', 'danger')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not sit over the bottom toolbar', () => {
    const { container } = render(<Toast message="Hi" onClose={vi.fn()} />)
    expect(container.firstElementChild?.className).toMatch(/\btop-/)
    expect(container.firstElementChild?.className).not.toMatch(/\bbottom-/)
  })

  it('fades out shortly before it closes', () => {
    render(<Toast message="Hi" onClose={vi.fn()} duration={1000} />)
    const status = screen.getByRole('status')
    expect(status).not.toHaveClass('opacity-0')
    act(() => {
      vi.advanceTimersByTime(900)
    })
    expect(status).toHaveClass('opacity-0')
  })

  it('keeps its timer when the parent re-renders with a new onClose', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <Toast message="Hi" onClose={first} duration={1000} />,
    )
    act(() => {
      vi.advanceTimersByTime(900)
    })
    rerender(<Toast message="Hi" onClose={second} duration={1000} />)
    expect(screen.getByRole('status')).toHaveClass('opacity-0')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('restarts its timer for a new message', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Toast message="One" onClose={onClose} duration={1000} />,
    )
    act(() => {
      vi.advanceTimersByTime(900)
    })
    rerender(<Toast message="Two" onClose={onClose} duration={1000} />)
    expect(screen.getByRole('status')).not.toHaveClass('opacity-0')
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onClose).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
