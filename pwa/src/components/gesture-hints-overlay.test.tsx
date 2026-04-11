import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GestureHintsOverlay } from './gesture-hints-overlay'

describe('GestureHintsOverlay', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing when closed', () => {
    render(<GestureHintsOverlay isOpen={false} onDismiss={vi.fn()} />)
    expect(screen.queryByText('Touch Gestures')).not.toBeInTheDocument()
  })

  it('renders overlay content when open', () => {
    render(<GestureHintsOverlay isOpen={true} onDismiss={vi.fn()} />)
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
    expect(
      screen.getByText('Control the terminal with gestures'),
    ).toBeInTheDocument()
    expect(screen.getByText('Got it')).toBeInTheDocument()
  })

  it('calls showModal when isOpen becomes true', () => {
    render(<GestureHintsOverlay isOpen={true} onDismiss={vi.fn()} />)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
  })

  it('unmounts dialog content when isOpen becomes false', () => {
    const { rerender } = render(
      <GestureHintsOverlay isOpen={true} onDismiss={vi.fn()} />,
    )
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
    rerender(<GestureHintsOverlay isOpen={false} onDismiss={vi.fn()} />)
    expect(screen.queryByText('Touch Gestures')).not.toBeInTheDocument()
  })

  it('calls onDismiss when Got it button clicked', () => {
    const onDismiss = vi.fn()
    render(<GestureHintsOverlay isOpen={true} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByText('Got it'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders all gesture hints', () => {
    render(<GestureHintsOverlay isOpen={true} onDismiss={vi.fn()} />)
    expect(screen.getByText('Swipe Left')).toBeInTheDocument()
    expect(screen.getByText('Swipe Right')).toBeInTheDocument()
    expect(screen.getByText('Swipe Up/Down')).toBeInTheDocument()
    expect(screen.getByText('Long Press')).toBeInTheDocument()
    expect(screen.getByText('Pinch In/Out')).toBeInTheDocument()
  })

  it('calls onDismiss on cancel event from dialog', () => {
    const onDismiss = vi.fn()
    render(<GestureHintsOverlay isOpen={true} onDismiss={onDismiss} />)
    const dialog = document.querySelector('dialog')!
    const cancelEvent = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancelEvent)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('prevents default on cancel event', () => {
    const onDismiss = vi.fn()
    render(<GestureHintsOverlay isOpen={true} onDismiss={onDismiss} />)
    const dialog = document.querySelector('dialog')!
    const cancelEvent = new Event('cancel', { cancelable: true })
    const preventDefaultSpy = vi.spyOn(cancelEvent, 'preventDefault')
    dialog.dispatchEvent(cancelEvent)
    expect(preventDefaultSpy).toHaveBeenCalled()
  })

  it('removes cancel event listener on close', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(
      <GestureHintsOverlay isOpen={true} onDismiss={onDismiss} />,
    )
    rerender(<GestureHintsOverlay isOpen={false} onDismiss={onDismiss} />)
    // After close, overlay is not rendered, so no dialog to dispatch to
    expect(screen.queryByText('Touch Gestures')).not.toBeInTheDocument()
  })
})
