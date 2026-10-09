import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  clampView,
  fitView,
  type Point,
  type Size,
  toggleDoubleTap,
  type View,
  wheelFactor,
  zoomAt,
  zoomLimits,
} from '../utils/zoom-pan'

// Two taps closer than this in time and distance are a double tap; a press
// that moved further than TAP_SLOP is a drag, not a tap.
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 24
const TAP_SLOP = 8
// No pointer down and no wheel for this long: the gesture has ended
export const SETTLE_MS = 150

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

// Pinch, drag, double tap and wheel zoom of an image of size img on stage,
// through Pointer Events (one finger drags, two pinch around their
// midpoint). settled is true once a gesture has ended: an SVG is then drawn
// again at its new size.
export function useZoomPan(stage: RefObject<HTMLElement | null>, size: Size) {
  // By value: a new object of the same size changes nothing
  const { width, height } = size
  const img = useMemo(() => ({ width, height }), [width, height])
  const [box, setBox] = useState<Size | null>(null)
  const [view, setViewState] = useState<View | null>(null)
  const [settled, setSettled] = useState(true)
  const viewRef = useRef(view)
  const boxRef = useRef(box)
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const setView = useCallback(
    (next: (v: View, box: Size) => View) => {
      const v = viewRef.current
      const b = boxRef.current
      if (!v || !b) return
      viewRef.current = clampView(next(v, b), img, b)
      setViewState(viewRef.current)
    },
    [img],
  )
  // Moving; held: a finger or the button is still down, so it has not ended
  // however long it rests
  const touch = useCallback((held: boolean) => {
    setSettled(false)
    clearTimeout(settleTimer.current)
    if (!held) {
      settleTimer.current = setTimeout(() => setSettled(true), SETTLE_MS)
    }
  }, [])

  // The box, and a new size keeps the zoom relative to fit
  useEffect(() => {
    const el = stage.current as HTMLElement
    const measure = () => {
      const b = { width: el.clientWidth, height: el.clientHeight }
      if (!b.width || !b.height) return
      const old = boxRef.current
      const v = viewRef.current
      let next = fitView(img, b)
      if (old && v) {
        const k = v.scale / fitView(img, old).scale
        const c = { x: b.width / 2, y: b.height / 2 }
        next = clampView(zoomAt(next, k, c, zoomLimits(img, b)), img, b)
      }
      boxRef.current = b
      viewRef.current = next
      setBox(b)
      setViewState(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [stage, img])

  // Listeners the page must not handle: a wheel scrolls nothing behind,
  // Safari's own pinch (gesture events) zooms nothing
  useEffect(() => {
    const el = stage.current as HTMLElement
    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pointers = new Map<number, Point>()
    let lastTap: { t: number; p: Point } | null = null
    let downAt: Point | null = null
    const stop = (e: Event) => e.preventDefault()
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      touch(false)
      const f = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey)
      setView((v, b) => zoomAt(v, f, at(e), zoomLimits(img, b)))
    }
    const onDown = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, at(e))
      downAt = pointers.size === 1 ? at(e) : null
      touch(true)
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      const p = at(e)
      const [a, b] = [...pointers.values()]
      pointers.set(e.pointerId, p)
      touch(true)
      if (pointers.size === 1) {
        setView((v) => ({ ...v, x: v.x + p.x - prev.x, y: v.y + p.y - prev.y }))
        return
      }
      // Two fingers: the other one stays where it was in this event
      const other = a === prev ? b : a
      const m0 = mid(prev, other)
      const m1 = mid(p, other)
      const before = dist(prev, other)
      // Two fingers on one spot: no distance to compare with
      const f = before ? dist(p, other) / before : 1
      setView((v, box) => {
        const z = zoomAt(v, f, m0, zoomLimits(img, box))
        return { ...z, x: z.x + m1.x - m0.x, y: z.y + m1.y - m0.y }
      })
    }
    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return
      if (pointers.size === 0) touch(false)
      const p = at(e)
      // A cancelled press (the browser took it over) is never a tap
      const tap =
        e.type === 'pointerup' && downAt && dist(downAt, p) <= TAP_SLOP
      downAt = null
      if (!tap || pointers.size > 0) return
      const now = e.timeStamp
      if (
        lastTap &&
        now - lastTap.t <= DOUBLE_TAP_MS &&
        dist(lastTap.p, p) <= DOUBLE_TAP_PX
      ) {
        lastTap = null
        setView((v, b) => toggleDoubleTap(v, p, img, b))
      } else {
        lastTap = { t: now, p }
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('gesturestart', stop)
    el.addEventListener('gesturechange', stop)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('gesturestart', stop)
      el.removeEventListener('gesturechange', stop)
      clearTimeout(settleTimer.current)
    }
  }, [stage, img, setView, touch])

  // Buttons and keys: around the middle of the box
  const zoomBy = useCallback(
    (factor: number) =>
      setView((v, b) =>
        zoomAt(
          v,
          factor,
          { x: b.width / 2, y: b.height / 2 },
          zoomLimits(img, b),
        ),
      ),
    [img, setView],
  )
  const reset = useCallback(
    () => setView((_, b) => fitView(img, b)),
    [img, setView],
  )
  const fit = box ? fitView(img, box).scale : 1
  return {
    view,
    box,
    settled,
    zoom: view ? view.scale / fit : 1,
    zoomBy,
    reset,
  }
}
