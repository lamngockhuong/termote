import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_INFO } from '../utils/app-info'
import { AboutModal } from './about-modal'

describe('AboutModal', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn()
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing when closed', () => {
    render(<AboutModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText(/About/)).not.toBeInTheDocument()
  })

  it('renders modal content when open', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(`About ${APP_INFO.name}`)).toBeInTheDocument()
  })

  it('calls showModal when isOpen is true', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
  })

  it('unmounts dialog content when isOpen becomes false', () => {
    const { rerender } = render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(`About ${APP_INFO.name}`)).toBeInTheDocument()
    rerender(<AboutModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText(`About ${APP_INFO.name}`)).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape key when open', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose on Escape key when closed', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={false} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not call onClose on other keys', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when clicking backdrop (dialog element itself)', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    const dialog = document.querySelector('dialog')!
    // Simulate click where target === currentTarget (backdrop click)
    fireEvent.click(dialog, { target: dialog })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside dialog content', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    // Click on the heading inside (target !== currentTarget)
    fireEvent.click(screen.getByText(`About ${APP_INFO.name}`))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows app version', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(APP_INFO.version)).toBeInTheDocument()
  })

  it('shows author name as link', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(APP_INFO.author.name)).toBeInTheDocument()
  })

  it('shows license', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(APP_INFO.license)).toBeInTheDocument()
  })

  it('shows GitHub, Changelog, Report Issue links', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('GitHub')).toBeInTheDocument()
    expect(screen.getByText('Changelog')).toBeInTheDocument()
    expect(screen.getByText('Report Issue')).toBeInTheDocument()
  })

  it('shows sponsor links', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTitle('MoMo')).toBeInTheDocument()
    expect(screen.getByTitle('GitHub Sponsors')).toBeInTheDocument()
    expect(screen.getByTitle('Buy Me a Coffee')).toBeInTheDocument()
  })

  it('shows app description', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(APP_INFO.description)).toBeInTheDocument()
  })

  it('removes keydown listener on unmount', () => {
    const onClose = vi.fn()
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<AboutModal isOpen={true} onClose={onClose} />)
    unmount()
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
    )
    removeEventListenerSpy.mockRestore()
  })
})
