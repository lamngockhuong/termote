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
})
