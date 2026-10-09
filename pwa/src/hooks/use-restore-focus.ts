import { useEffect } from 'react'

// When the component unmounts, focus goes back to whatever had it when it
// mounted (a modal's opener), if that is still in the page. Call it before
// useDialogModal: the opener still has focus then, before showModal moves it
// into the dialog.
export function useRestoreFocus() {
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])
}
