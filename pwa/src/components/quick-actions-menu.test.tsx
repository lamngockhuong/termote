import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActionsSheet } from './quick-actions-menu'

vi.mock('../hooks/use-haptic', () => ({
  useHaptic: () => ({ trigger: vi.fn(), isSupported: false }),
}))

describe('QuickActionsSheet', () => {
  beforeEach(() => {
    // jsdom has no <dialog> modal support
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('renders nothing while closed', () => {
    render(
      <QuickActionsSheet
        isOpen={false}
        onClose={vi.fn()}
        onSendKey={vi.fn()}
        onSendText={vi.fn()}
      />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists every quick action', () => {
    render(
      <QuickActionsSheet
        isOpen
        onClose={vi.fn()}
        onSendKey={vi.fn()}
        onSendText={vi.fn()}
      />,
    )
    for (const name of ['Clear', 'Cancel', 'Clear line', 'Exit']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(
      screen.queryByRole('button', { name: 'Attach image' }),
    ).not.toBeInTheDocument()
  })

  it('Attach image closes the sheet, then opens the picker', () => {
    const calls: string[] = []
    render(
      <QuickActionsSheet
        isOpen
        onClose={() => calls.push('close')}
        onSendKey={vi.fn()}
        onSendText={vi.fn()}
        onAttachImage={() => calls.push('attach')}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Attach image' }))
    expect(calls).toEqual(['close', 'attach'])
  })

  it.each([
    ['Cancel', 'c'],
    ['Clear line', 'u'],
    ['Exit', 'd'],
  ])('%s sends Ctrl+%s and closes the sheet', (name, key) => {
    const onSendKey = vi.fn()
    const onClose = vi.fn()
    render(
      <QuickActionsSheet
        isOpen
        onClose={onClose}
        onSendKey={onSendKey}
        onSendText={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name }))
    expect(onSendKey).toHaveBeenCalledWith(key, { ctrl: true })
    expect(onClose).toHaveBeenCalled()
  })

  it('the text action sends the text then Enter', () => {
    const onSendKey = vi.fn()
    const onSendText = vi.fn()
    render(
      <QuickActionsSheet
        isOpen
        onClose={vi.fn()}
        onSendKey={onSendKey}
        onSendText={onSendText}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onSendText).toHaveBeenCalledWith('clear')
    expect(onSendKey).toHaveBeenCalledWith('Enter')
  })
})
