import { type RefObject, useEffect } from 'react'

// px per line or page when the wheel reports lines (Firefox) or pages
const LINE = 16

// A vertical mouse wheel over the element scrolls it sideways: for a row of
// tabs whose scrollbar is hidden. Only while the row overflows and can still
// move that way; otherwise the event goes on, so the page around it scrolls.
// A sideways swipe (trackpad) is left to the browser. The listener is not
// passive (React's onWheel is), so it can stop the vertical scroll.
export function useWheelScrollX(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      const room = el.scrollWidth - el.clientWidth
      if (room <= 0) return
      const delta =
        e.deltaMode === 0
          ? e.deltaY
          : e.deltaY * (e.deltaMode === 1 ? LINE : el.clientWidth)
      if (
        (delta < 0 && el.scrollLeft <= 0) ||
        // A fractional scrollLeft (a high DPI screen) stops short of room
        (delta > 0 && el.scrollLeft >= room - 1)
      )
        return
      e.preventDefault()
      el.scrollLeft += delta
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref])
}
