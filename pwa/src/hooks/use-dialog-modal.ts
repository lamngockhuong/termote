import { type RefObject, useEffect } from 'react'

/**
 * Syncs a <dialog> element's open/close state with a boolean prop.
 * Intercepts the native cancel event (Escape key) to call onClose.
 */
export function useDialogModal(
  ref: RefObject<HTMLDialogElement | null>,
  isOpen: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (isOpen) {
      dialog.showModal()
      const handleCancel = (e: Event) => {
        e.preventDefault()
        onClose()
      }
      dialog.addEventListener('cancel', handleCancel)
      return () => dialog.removeEventListener('cancel', handleCancel)
    }
    // close() on a modal gives focus back by itself when focus is inside it,
    // with a ring after a tap on Safari and over keepFocus: useRestoreFocus
    // decides that instead.
    const active = document.activeElement
    if (active instanceof HTMLElement && dialog.contains(active)) active.blur()
    dialog.close()
  }, [isOpen, onClose, ref])
}
