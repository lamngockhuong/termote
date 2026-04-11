import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { HelpModal } from './help-modal'

describe('HelpModal', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing when closed', () => {
    render(<HelpModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Usage Guide')).not.toBeInTheDocument()
  })

  it('renders modal content when open', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Usage Guide')).toBeInTheDocument()
  })

  it('calls showModal when isOpen is true', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
  })

  it('unmounts dialog content when isOpen becomes false', () => {
    const { rerender } = render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Usage Guide')).toBeInTheDocument()
    rerender(<HelpModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Usage Guide')).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape key when open', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose on Escape key when closed', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={false} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose on other keys', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when clicking backdrop', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    const dialog = document.querySelector('dialog')!
    fireEvent.click(dialog, { target: dialog })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside content', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByText('Usage Guide'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('renders three tabs: Gestures, Toolbar, tmux', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Gestures')).toBeInTheDocument()
    expect(screen.getByText('Toolbar')).toBeInTheDocument()
    expect(screen.getByText('tmux')).toBeInTheDocument()
  })

  it('shows gestures content by default', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
    expect(screen.getByText('Swipe Left')).toBeInTheDocument()
  })

  it('switches to Toolbar tab on click', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    expect(screen.getByText('Toolbar Buttons')).toBeInTheDocument()
  })

  it('switches to tmux tab on click', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('tmux'))
    expect(screen.getByText('Windows (Ctrl+B, then...)')).toBeInTheDocument()
  })

  it('switches back to Gestures tab', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    fireEvent.click(screen.getByText('Gestures'))
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
  })

  it('removes keydown listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    unmount()
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    removeEventListenerSpy.mockRestore()
  })
})
