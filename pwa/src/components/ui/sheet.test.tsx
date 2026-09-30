import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sheet } from './sheet'

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock('../../hooks/use-media-query', () => ({
  useIsMobile: () => mobile.value,
}))

function renderSheet(props: Partial<Parameters<typeof Sheet>[0]> = {}) {
  const onClose = vi.fn()
  const view = render(
    <Sheet isOpen onClose={onClose} title="Sessions" {...props}>
      <p>Body</p>
    </Sheet>,
  )
  return { ...view, onClose }
}

describe('Sheet', () => {
  beforeEach(() => {
    mobile.value = false
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders nothing when closed', () => {
    renderSheet({ isOpen: false })
    expect(screen.queryByText('Body')).not.toBeInTheDocument()
  })

  it('opens as a modal dialog named by its title', () => {
    renderSheet()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Sessions' })
    expect(dialog).toHaveTextContent('Body')
  })

  it('is a centred dialog on desktop and a bottom sheet on phones', () => {
    const { unmount } = renderSheet()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('data-layout', 'dialog')
    expect(dialog).toHaveClass('m-auto', 'max-w-lg')
    expect(screen.queryByTestId('sheet-grabber')).not.toBeInTheDocument()
    unmount()

    mobile.value = true
    renderSheet()
    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveAttribute('data-layout', 'sheet')
    expect(sheet).toHaveClass('mt-auto', 'rounded-t-sheet')
    // The grabber is only drawn in the native style
    expect(screen.getByTestId('sheet-grabber')).toHaveClass(
      'hidden',
      'ui-native:flex',
    )
  })

  it('closes from the close button with its label', () => {
    const { onClose } = renderSheet({ closeLabel: 'Close sessions' })
    fireEvent.click(screen.getByRole('button', { name: 'Close sessions' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on Escape (the dialog cancel event) without closing itself', () => {
    const { onClose } = renderSheet()
    const cancel = new Event('cancel', { cancelable: true })
    screen.getByRole('dialog').dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes on a tap on the scrim, not on its content', () => {
    const { onClose } = renderSheet()
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(screen.getByText('Body'))
    fireEvent.click(screen.getByText('Body'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stays open when a text selection is dragged from the content onto the scrim', () => {
    const { onClose } = renderSheet()
    // The browser fires the click on the common ancestor: the dialog itself
    fireEvent.pointerDown(screen.getByText('Body'))
    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps the dialog as is when the caller passes a new onClose', () => {
    const first = vi.fn()
    const { rerender } = render(
      <Sheet isOpen onClose={first} title="Sessions">
        <p>Body</p>
      </Sheet>,
    )
    const second = vi.fn()
    rerender(
      <Sheet isOpen onClose={second} title="Sessions">
        <p>Body</p>
      </Sheet>,
    )
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })

  it('shows header actions before the close button', () => {
    renderSheet({ actions: <button type="button">New</button> })
    const buttons = screen.getAllByRole('button')
    expect(
      buttons.map((b) => b.textContent || b.getAttribute('aria-label')),
    ).toEqual(['New', 'Close'])
  })

  it('focuses the dialog itself on open, not its first button', () => {
    renderSheet()
    expect(screen.getByRole('dialog')).toHaveFocus()
  })

  it('returns focus to the opener when it closes', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { rerender } = renderSheet()
    screen.getByRole('button', { name: 'Close' }).focus()
    rerender(
      <Sheet isOpen={false} onClose={vi.fn()} title="Sessions">
        <p>Body</p>
      </Sheet>,
    )
    expect(document.activeElement).toBe(opener)
  })

  it('does not focus an opener that has left the page', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const focus = vi.spyOn(opener, 'focus')
    const { unmount } = renderSheet()
    opener.remove()
    unmount()
    expect(focus).not.toHaveBeenCalled()
  })
})
