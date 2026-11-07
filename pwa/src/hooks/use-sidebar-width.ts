import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  clampSidebarWidth,
  maxSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_STEP,
} from '../utils/sidebar-width'

// The expanded desktop sidebar's width, dragged from a handle on its right
// edge or stepped with the arrow keys on it. The saved width is shown within
// the limits of the row the sidebar shares with the main area; while
// dragging only the shown width follows the pointer, saved on release.
export function useSidebarWidth({
  active,
  width,
  onWidthChange,
  onResizingChange,
}: {
  // The expanded desktop sidebar is on screen (the aside holds asideRef)
  active: boolean
  width: unknown
  onWidthChange?: (width: number) => void
  // True from the drag's start to its end: the terminal keeps its size
  // until then, so the pane is resized once
  onResizingChange?: (resizing: boolean) => void
}) {
  const asideRef = useRef<HTMLElement>(null)
  // null until measured, and with no ResizeObserver (tests)
  const [rowWidth, setRowWidth] = useState<number | null>(null)
  // Before paint: a saved width too wide for the row never shows first
  useLayoutEffect(() => {
    const row = active ? asideRef.current?.parentElement : undefined
    if (!row || typeof ResizeObserver === 'undefined') return
    setRowWidth(row.clientWidth)
    const ro = new ResizeObserver(() => setRowWidth(row.clientWidth))
    ro.observe(row)
    return () => ro.disconnect()
  }, [active])

  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const drag = useRef<{ x: number; width: number; last: number } | null>(null)
  const shown = clampSidebarWidth(dragWidth ?? width, rowWidth)
  const max = maxSidebarWidth(rowWidth)

  // A drag cut short (the sidebar collapsed or went) must not leave the
  // terminal held
  const resizingRef = useRef(onResizingChange)
  resizingRef.current = onResizingChange
  useEffect(() => {
    if (!active) return
    return () => {
      if (!drag.current) return
      drag.current = null
      setDragWidth(null)
      resizingRef.current?.(false)
    }
  }, [active])

  const commit = (next: number) => {
    if (next !== shown) onWidthChange?.(next)
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // No text selection while dragging
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { x: e.clientX, width: shown, last: shown }
    setDragWidth(shown)
    onResizingChange?.(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // The handle is on the right edge: moving right widens the sidebar
    d.last = clampSidebarWidth(d.width + e.clientX - d.x, rowWidth)
    setDragWidth(d.last)
  }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.last !== d.width) onWidthChange?.(d.last)
    setDragWidth(null)
    onResizingChange?.(false)
  }
  // Right and Left step, Home and End go to the limits; each step is saved
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (e.key === 'ArrowRight') next = shown + SIDEBAR_STEP
    else if (e.key === 'ArrowLeft') next = shown - SIDEBAR_STEP
    else if (e.key === 'Home') next = SIDEBAR_MIN
    else if (e.key === 'End') next = max
    else return
    e.preventDefault()
    commit(clampSidebarWidth(next, rowWidth))
  }

  return {
    asideRef,
    shown,
    dragging: dragWidth !== null,
    max,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onDoubleClick: () => commit(SIDEBAR_DEFAULT),
      onKeyDown,
    },
  }
}
