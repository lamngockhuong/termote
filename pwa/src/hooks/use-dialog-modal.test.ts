import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDialogModal } from './use-dialog-modal'

describe('useDialogModal', () => {
  it('does nothing before the dialog is in the page', () => {
    const onClose = vi.fn()
    expect(() =>
      renderHook(() => useDialogModal({ current: null }, true, onClose)),
    ).not.toThrow()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens the dialog modally and turns Escape into onClose', () => {
    const dialog = document.createElement('dialog')
    dialog.showModal = vi.fn()
    const onClose = vi.fn()
    const { unmount } = renderHook(() =>
      useDialogModal({ current: dialog }, true, onClose),
    )
    expect(dialog.showModal).toHaveBeenCalled()
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    dialog.dispatchEvent(new Event('cancel'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the dialog once it is no longer open', () => {
    const dialog = document.createElement('dialog')
    dialog.showModal = vi.fn()
    dialog.close = vi.fn()
    const { rerender } = renderHook(
      ({ open }) => useDialogModal({ current: dialog }, open, vi.fn()),
      { initialProps: { open: true } },
    )
    rerender({ open: false })
    expect(dialog.close).toHaveBeenCalledTimes(1)
  })
})
