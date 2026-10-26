import { type RefObject, useEffect } from 'react'

// When the component unmounts, focus goes back to whatever had it when it
// mounted (a modal's opener), if that is still in the page. Call it before
// useDialogModal: the opener still has focus then, before showModal moves it
// into the dialog. fallback takes focus when the opener cannot (gone, or
// disabled) and focus would be left on nothing. skip, read at unmount,
// leaves focus where the component's last action put it.
export function useRestoreFocus(
  fallback?: RefObject<HTMLElement | null>,
  skip?: RefObject<boolean>,
) {
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (skip?.current) return
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
      const at = document.activeElement
      if (!at || at === document.body) fallback?.current?.focus()
    }
  }, [fallback, skip])
}
