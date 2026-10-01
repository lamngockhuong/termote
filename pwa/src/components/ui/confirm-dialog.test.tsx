import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './confirm-dialog'

vi.mock('../../hooks/use-media-query', () => ({
  useIsMobile: () => false,
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
})
