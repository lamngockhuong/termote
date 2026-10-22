import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_INFO } from '../utils/app-info'
import { AboutModal } from './about-modal'

describe('AboutModal', () => {
  beforeEach(() => {
    // Open it as the browser does, so role queries see its content
    HTMLDialogElement.prototype.showModal = vi
      .fn()
      .mockImplementation(function (this: HTMLDialogElement) {
        this.setAttribute('open', '')
      })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing when closed', () => {
    render(<AboutModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText(/About/)).not.toBeInTheDocument()
  })

  it('renders modal content when open', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('About Termote')).toBeInTheDocument()
  })

  it('calls showModal when isOpen is true', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
  })

  it('unmounts dialog content when isOpen becomes false', () => {
    const { rerender } = render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText('About Termote')).toBeInTheDocument()
    rerender(<AboutModal isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText('About Termote')).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose on Escape (the dialog cancel event)', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    const cancel = new Event('cancel', { cancelable: true })
    document.querySelector('dialog')!.dispatchEvent(cancel)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(cancel.defaultPrevented).toBe(true)
  })

  it('calls onClose when clicking backdrop (dialog element itself)', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    const dialog = document.querySelector('dialog')!
    // Simulate click where target === currentTarget (backdrop click)
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when clicking inside dialog content', () => {
    const onClose = vi.fn()
    render(<AboutModal isOpen={true} onClose={onClose} />)
    // Click on the heading inside (target !== currentTarget)
    fireEvent.click(screen.getByText('About Termote'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows app version', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(
      screen.getByText(`v${APP_INFO.version} · ${APP_INFO.license}`),
    ).toBeInTheDocument()
  })

  it('shows the owl and the wordmark', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    // The one place the owl blinks on its own: a sheet the user opened
    expect(screen.getByTestId('brand-mark')).toHaveClass('owl-blink-idle')
    expect(screen.getByText('Termote', { selector: 'p' })).toBeInTheDocument()
  })

  it('links the author in a new tab', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    const link = screen.getByRole('link', { name: /Author/ })
    expect(link).toHaveTextContent(APP_INFO.author.name)
    expect(within(link).getByText('(opens in a new tab)')).toHaveClass(
      'sr-only',
    )
    expect(link).toHaveAttribute('href', APP_INFO.author.url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it.each([
    ['GitHub', APP_INFO.repository],
    ['Changelog', APP_INFO.links.changelog],
    ['Report an issue', APP_INFO.links.issues],
  ])('links %s in a new tab', (name, href) => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    // jsdom joins the name without the spaces a browser adds
    const link = screen.getByRole('link', { name: new RegExp(`^${name}`) })
    expect(within(link).getByText('(opens in a new tab)')).toHaveClass(
      'sr-only',
    )
    expect(link).toHaveAttribute('href', href)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('opens the updates through onCheckUpdates', () => {
    const onCheckUpdates = vi.fn()
    render(
      <AboutModal
        isOpen={true}
        onClose={vi.fn()}
        onCheckUpdates={onCheckUpdates}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(onCheckUpdates).toHaveBeenCalledTimes(1)
  })

  it('names an available update on the Check for updates row', () => {
    render(
      <AboutModal
        isOpen={true}
        onClose={vi.fn()}
        onCheckUpdates={vi.fn()}
        updateVersion="2.5.0"
      />,
    )
    expect(
      screen.getByRole('button', { name: /Check for updates/ }),
    ).toHaveTextContent('v2.5.0 available')
  })

  it('leaves out Check for updates without a handler', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(
      screen.queryByRole('button', { name: 'Check for updates' }),
    ).not.toBeInTheDocument()
  })

  it('shows sponsor links', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByTitle('MoMo')).toBeInTheDocument()
    expect(screen.getByTitle('GitHub Sponsors')).toBeInTheDocument()
    expect(screen.getByTitle('Buy Me a Coffee')).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Support this project' }),
    ).toBeInTheDocument()
  })

  it('shows app description', () => {
    render(<AboutModal isOpen={true} onClose={vi.fn()} />)
    expect(screen.getByText(APP_INFO.description)).toBeInTheDocument()
  })
})
