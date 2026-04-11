import { type RefObject, useEffect } from 'react'

/**
 * Syncs a <dialog> element's open/close state with a boolean prop.
 * Optionally intercepts the native cancel event (Escape key) to call onClose.
 */
export function useDialogModal(
  ref: RefObject<HTMLDialogElement | null>,
  isOpen: boolean,
  onClose?: () => void,
) {
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (isOpen) {
      dialog.showModal()
      if (onClose) {
        const handleCancel = (e: Event) => {
          e.preventDefault()
          onClose()
        }
        dialog.addEventListener('cancel', handleCancel)
        return () => dialog.removeEventListener('cancel', handleCancel)
      }
    /* v8 ignore start */
    } else {
      dialog.close()
    /* v8 ignore stop */
    }
  }, [isOpen, onClose, ref])
}
