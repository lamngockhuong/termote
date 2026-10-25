import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toast } from './toast'

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs its action and closes', () => {
    const onClose = vi.fn()
    const onClick = vi.fn()
    render(
      <Toast
        message="Image uploaded"
        onClose={onClose}
        action={{ label: 'Insert', onClick }}
      />,
    )
    act(() => {
      screen.getByRole('button', { name: 'Insert' }).click()
    })
    expect(onClick).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
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

  describe('swipe to dismiss', () => {
    const elapse = (ms: number) =>
      act(() => {
        vi.advanceTimersByTime(ms)
      })
    const press = (el: HTMLElement, pointerId = 1, button = 0) =>
      fireEvent.pointerDown(el, {
        button,
        pointerId,
        clientX: 100,
        clientY: 100,
      })
    const move = (el: HTMLElement, x: number, y: number, pointerId = 1) =>
      fireEvent.pointerMove(el, {
        pointerId,
        clientX: 100 + x,
        clientY: 100 + y,
      })
    const release = (el: HTMLElement, x: number, y: number) =>
      fireEvent.pointerUp(el, {
        pointerId: 1,
        clientX: 100 + x,
        clientY: 100 + y,
      })
    const swipe = (el: HTMLElement, x: number, y: number) => {
      press(el)
      move(el, x, y)
      release(el, x, y)
    }

    it.each([
      ['left', -60, 0],
      ['right', 60, 0],
      ['up', 0, -60],
    ])('closes once after a swipe %s', (_, x, y) => {
      const onClose = vi.fn()
      render(<Toast message="Hi" onClose={onClose} duration={1000} />)
      const status = screen.getByRole('status')
      swipe(status, x, y)
      expect(status).toHaveClass('opacity-0')
      expect(status).not.toHaveClass('motion-safe:-translate-y-2')
      expect(onClose).not.toHaveBeenCalled()
      elapse(150)
      expect(onClose).toHaveBeenCalledTimes(1)
      // The auto-dismiss timer does not close it a second time
      elapse(1000)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['a short swipe', 20, -20],
      ['a pull down', 0, 100],
    ])('springs back from %s', (_, x, y) => {
      const onClose = vi.fn()
      render(<Toast message="Hi" onClose={onClose} />)
      const status = screen.getByRole('status')
      swipe(status, x, y)
      expect(status).not.toHaveClass('opacity-0')
      expect(status.style.translate).toBe('')
      elapse(1000)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('follows the finger while held, but not down', () => {
      render(<Toast message="Hi" onClose={vi.fn()} />)
      const status = screen.getByRole('status')
      press(status)
      move(status, 30, -10)
      expect(status.style.translate).toBe('30px -10px')
      move(status, 0, 50)
      expect(status.style.translate).toBe('0px 0px')
    })

    it('waits while held and starts its time again on release', () => {
      const onClose = vi.fn()
      render(<Toast message="Hi" onClose={onClose} duration={1000} />)
      const status = screen.getByRole('status')
      elapse(800)
      press(status)
      elapse(5000)
      expect(onClose).not.toHaveBeenCalled()
      release(status, 0, 0)
      elapse(999)
      expect(onClose).not.toHaveBeenCalled()
      elapse(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['cancelled', fireEvent.pointerCancel],
      ['loses its capture', fireEvent.lostPointerCapture],
    ])('springs back when the gesture is %s', (_, interrupt) => {
      const onClose = vi.fn()
      render(<Toast message="Hi" onClose={onClose} />)
      const status = screen.getByRole('status')
      press(status)
      move(status, 60, 0)
      interrupt(status, { pointerId: 1, clientX: 160 })
      expect(status.style.translate).toBe('')
      elapse(1000)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('follows only the first finger', () => {
      render(<Toast message="Hi" onClose={vi.fn()} />)
      const status = screen.getByRole('status')
      press(status, 1)
      move(status, 30, 0)
      press(status, 2)
      move(status, 90, 0, 2)
      expect(status.style.translate).toBe('30px 0px')
    })

    it('ignores a press on the action and a secondary button', () => {
      const onClose = vi.fn()
      render(
        <Toast
          message="Hi"
          onClose={onClose}
          action={{ label: 'Undo', onClick: vi.fn() }}
        />,
      )
      swipe(screen.getByRole('button', { name: 'Undo' }), 60, 0)
      const status = screen.getByRole('status')
      press(status, 1, 2)
      move(status, 100, 0)
      release(status, 100, 0)
      elapse(1000)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('cannot be grabbed while it fades out', () => {
      render(<Toast message="Hi" onClose={vi.fn()} duration={1000} />)
      const status = screen.getByRole('status')
      elapse(900)
      press(status)
      move(status, 30, 0)
      expect(status.style.translate).toBe('')
    })
  })
})
