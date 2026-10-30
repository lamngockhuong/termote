import { type RefObject, useCallback, useEffect, useRef } from 'react'

// When the component unmounts, focus goes back to whatever had it when it
// mounted (a modal's opener), if that is still in the page. Call it before
// useDialogModal: the opener still has focus then, before showModal moves it
// into the dialog. fallback takes focus when the opener cannot (gone, or
// disabled) and focus would be left on nothing. skip, read at unmount,
// leaves focus where the component's last action put it. The opener gets a
// focus ring back only if it had one: Safari rings any focus() after a tap.
// The function it returns gives focus back sooner (a modal starting its exit
// transition); unmount then leaves focus alone.
export function useRestoreFocus(
  fallback?: RefObject<HTMLElement | null>,
  skip?: RefObject<boolean>,
) {
  const restoreRef = useRef<() => void>(() => {})
  useEffect(() => {
    const opener = document.activeElement
    const ring = opener?.matches(':focus-visible')
    let done = false
    const restore = () => {
      if (done) return
      done = true
      if (skip?.current) return
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ focusVisible: ring })
      const at = document.activeElement
      if (!at || at === document.body) fallback?.current?.focus()
    }
    restoreRef.current = restore
    return restore
  }, [fallback, skip])
  return useCallback(() => restoreRef.current(), [])
}
