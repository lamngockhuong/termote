import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './confirm-dialog'

const media = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../hooks/use-media-query', () => ({
  useIsMobile: () => media.mobile,
}))

function renderDialog(
  props: Partial<Parameters<typeof ConfirmDialog>[0]> = {},
) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConfirmDialog
      isOpen
      title="Close session?"
      confirmLabel="Close session"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    >
      <p>Shell will be closed.</p>
    </ConfirmDialog>,
  )
  return { onConfirm, onCancel }
}

describe('ConfirmDialog', () => {
  beforeEach(() => {
    media.mobile = false
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
    renderDialog({ isOpen: false })
    expect(screen.queryByText('Shell will be closed.')).not.toBeInTheDocument()
  })

  it('shows the title and message in a modal dialog', () => {
    renderDialog()
    expect(
      screen.getByRole('dialog', { name: 'Close session?' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Shell will be closed.')).toBeInTheDocument()
  })

  it('the confirm button confirms', () => {
    const { onConfirm, onCancel } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('the cancel button cancels', () => {
    const { onConfirm, onCancel } = renderDialog({ cancelLabel: 'Keep' })
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('Escape cancels', () => {
    const { onCancel } = renderDialog()
    fireEvent(screen.getByRole('dialog'), new Event('cancel'))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('a destructive confirm uses the danger colour', () => {
    renderDialog({ destructive: true })
    expect(
      screen.getByRole('button', { name: 'Close session' }).className,
    ).toContain('text-danger')
  })

  it('a plain confirm uses the primary colour', () => {
    renderDialog()
    expect(
      screen.getByRole('button', { name: 'Close session' }).className,
    ).toContain('bg-accent')
  })

  // jsdom turns no keydown into a click, so the browser's Enter press is the
  // focused button plus a keydown nothing cancelled.
  it('focuses the confirm button on desktop, so Enter presses it', () => {
    renderDialog()
    const button = screen.getByRole('button', { name: 'Close session' })
    expect(button).toHaveFocus()
    const press = createEvent.keyDown(button, { key: 'Enter' })
    fireEvent(button, press)
    expect(press.defaultPrevented).toBe(false)
  })

  it('focuses Cancel with defaultAction cancel, so Enter cancels', () => {
    renderDialog({ defaultAction: 'cancel' })
    const button = screen.getByRole('button', { name: 'Cancel' })
    expect(button).toHaveFocus()
    const press = createEvent.keyDown(button, { key: 'Enter' })
    fireEvent(button, press)
    expect(press.defaultPrevented).toBe(false)
  })

  it.each([
    ['confirm', 'Close session'],
    ['cancel', 'Cancel'],
  ] as const)('ignores a repeated Enter on the %s button', (_, name) => {
    const { onConfirm, onCancel } = renderDialog()
    const button = screen.getByRole('button', { name })
    const held = createEvent.keyDown(button, { key: 'Enter', repeat: true })
    fireEvent(button, held)
    expect(held.defaultPrevented).toBe(true)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('leaves a repeated key other than Enter alone', () => {
    renderDialog()
    const button = screen.getByRole('button', { name: 'Close session' })
    const held = createEvent.keyDown(button, { key: 'a', repeat: true })
    fireEvent(button, held)
    expect(held.defaultPrevented).toBe(false)
  })

  it('keeps the focus on the dialog on a phone', () => {
    media.mobile = true
    renderDialog()
    expect(screen.getByRole('dialog')).toHaveFocus()
    expect(
      screen.getByRole('button', { name: 'Close session' }),
    ).not.toHaveFocus()
  })

  it('returns the focus to the opener when it closes', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const props = {
      title: 'Close session?',
      confirmLabel: 'Close session',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      children: <p>Shell will be closed.</p>,
    }
    const { rerender } = render(<ConfirmDialog isOpen {...props} />)
    expect(screen.getByRole('button', { name: 'Close session' })).toHaveFocus()
    rerender(<ConfirmDialog isOpen={false} {...props} />)
    expect(opener).toHaveFocus()
  })
})
