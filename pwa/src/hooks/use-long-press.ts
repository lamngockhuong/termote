import {
  type MouseEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
} from 'react'

// How long a finger rests on the element, and how far it may drift
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP = 10

// Handlers for an element that does something else when a finger (or pen)
// rests on it: onLongPress runs once the press lasts LONG_PRESS_MS without
// moving more than LONG_PRESS_SLOP pixels. The click that ends such a press
// is swallowed, and so is the context menu the press would open. A mouse
// never long-presses.
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const start = useRef<{ x: number; y: number }>(undefined)
  // The press ran onLongPress: the click (and menu) after it are not acted on
  const fired = useRef(false)
  const callback = useRef(onLongPress)
  callback.current = onLongPress

  const cancel = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    start.current = undefined
  }, [])

  useEffect(() => cancel, [cancel])

  return {
    onPointerDown(e: PointerEvent) {
      cancel()
      fired.current = false
      if (e.pointerType === 'mouse') return
      start.current = { x: e.clientX, y: e.clientY }
      timer.current = setTimeout(() => {
        timer.current = undefined
        fired.current = true
        callback.current()
      }, LONG_PRESS_MS)
    },
    onPointerMove(e: PointerEvent) {
      const s = start.current
      if (!s) return
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > LONG_PRESS_SLOP)
        cancel()
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(e: MouseEvent) {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
    onContextMenu(e: MouseEvent) {
      if (start.current || fired.current) e.preventDefault()
    },
  }
}
