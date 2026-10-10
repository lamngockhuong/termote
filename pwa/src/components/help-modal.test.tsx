import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HelpModal } from './help-modal'

describe('HelpModal', () => {
  beforeEach(() => {
    // An open dialog is what makes its content reachable by role
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
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

  it('calls onClose on Escape (the dialog cancel event)', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    const cancel = new Event('cancel', { cancelable: true })
    document.querySelector('dialog')!.dispatchEvent(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(cancel.defaultPrevented).toBe(true)
  })

  it('calls onClose when clicking backdrop', () => {
    const onClose = vi.fn()
    render(<HelpModal isOpen={true} onClose={onClose} />)
    const dialog = document.querySelector('dialog')!
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
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
    expect(screen.getByRole('radio', { name: 'Gestures' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Toolbar' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'tmux' })).toBeInTheDocument()
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

  it('explains the agent status badges on the Toolbar tab', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    expect(screen.getByText('Agent Status')).toBeInTheDocument()
    for (const status of ['blocked', 'working', 'done', 'idle']) {
      expect(screen.getByLabelText(`Agent ${status}`)).toBeInTheDocument()
    }
  })

  it('switches to tmux tab on click', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('tmux'))
    expect(screen.getByText('Windows (Ctrl+B, then...)')).toBeInTheDocument()
  })

  it('hides the tmux tab and tmux-only toolbar rows without copy mode', () => {
    render(
      <HelpModal isOpen={true} onClose={vi.fn()} copyModeSupported={false} />,
    )
    expect(screen.queryByText('tmux')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Toolbar'))
    expect(screen.queryByText('Toggle tmux copy mode')).not.toBeInTheDocument()
    expect(screen.queryByText('tmux prefix')).not.toBeInTheDocument()
    expect(screen.getByText('Scroll history')).toBeInTheDocument()
    expect(
      screen.getByText('Paste from the system clipboard'),
    ).toBeInTheDocument()
    expect(screen.getByText('Scroll history up/down')).toBeInTheDocument()
  })

  it('falls back to Gestures when the open tmux tab goes away', () => {
    const { rerender } = render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('tmux'))
    rerender(
      <HelpModal isOpen={true} onClose={vi.fn()} copyModeSupported={false} />,
    )
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
  })

  it('describes the More key and the expanded rows', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    expect(
      screen.getByText(
        'Extra keys: show or hide the expanded rows (pinned at the right)',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Expanded Toolbar Rows')).toBeInTheDocument()
    expect(
      screen.getByText('Clear, Cancel, Clear line, Exit (mobile)'),
    ).toBeInTheDocument()
    expect(screen.getByText('Copy mode and page up/down')).toBeInTheDocument()
    expect(screen.queryByText('Scroll history up/down')).not.toBeInTheDocument()
  })

  it('shows the tmux-only toolbar rows with copy mode', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    expect(screen.getByText('Toggle tmux copy mode')).toBeInTheDocument()
    expect(screen.queryByText('Scroll history')).not.toBeInTheDocument()
  })

  it('switches back to Gestures tab', () => {
    render(<HelpModal isOpen={true} onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Toolbar'))
    fireEvent.click(screen.getByText('Gestures'))
    expect(screen.getByText('Touch Gestures')).toBeInTheDocument()
  })
})
