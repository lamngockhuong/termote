import { useLayoutEffect, useState } from 'react'
import { type Rect, stepRect, type TourStep } from '../utils/tour-steps'

// The rect of the element named data-tour="anchor", or null when it is
// not in the page or has no size (hidden)
export function measureAnchor(anchor: string): Rect | null {
  const el = document.querySelector(`[data-tour="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

const same = (a: Rect | null, b: Rect | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height)

// The area a step lights, measured again at every frame while it shows:
// the page moves under it in more ways than any event tells (a resize, the
// phone turned, the on-screen keyboard, a scroll, a header control coming
// or going, a sheet closing). A frame measures a couple of elements and
// renders only when the area changed. null while its first anchor is not
// on screen.
export function useAnchorRect(step: TourStep | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    if (!step) {
      setRect(null)
      return
    }
    let frame = 0
    const update = () => {
      const next = stepRect(step, measureAnchor)
      setRect((prev) => (same(prev, next) ? prev : next))
      frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [step])
  return rect
}
