import Hammer from 'hammerjs'
import { type RefObject, useEffect, useRef } from 'react'

export interface GestureHandlers {
  onTap?: () => void // Focus terminal
  onSwipeLeft?: () => void // Ctrl+C
  onSwipeRight?: () => void // Tab
  onSwipeUp?: () => void // Scroll down
  onSwipeDown?: () => void // Scroll up
  // Drag with one finger: pixels moved since the last call (right and down
  // are positive), along the axis the drag started on only. After a flick it
  // keeps coming, slowing down, until the glide stops or the next touch.
  onPan?: (dx: number, dy: number) => void
  onLongPress?: () => void // Paste
  onPinchIn?: () => void // Font smaller
  onPinchOut?: () => void // Font larger
}

// A glide loses this share of its speed every 16ms, and stops below
// GLIDE_MIN_VELOCITY (px/ms); slower releases do not glide at all.
const GLIDE_FRICTION = 0.95
const GLIDE_MIN_VELOCITY = 0.05
const GLIDE_START_VELOCITY = 0.3

export function useGestures(
  elementRef: RefObject<HTMLElement | null>,
  handlers: GestureHandlers,
) {
  const hammerRef = useRef<HammerManager | null>(null)
  const handlersRef = useRef(handlers)

  // Keep handlers ref updated
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    const hammer = new Hammer(element)
    hammerRef.current = hammer

    // Configure recognizers
    hammer.get('swipe').set({ direction: Hammer.DIRECTION_ALL })
    hammer.get('pinch').set({ enable: true })
    hammer.get('press').set({ time: 500 })
    hammer.get('pan').set({ direction: Hammer.DIRECTION_ALL })
    // A second finger landing after the first has started a drag still
    // pinches.
    hammer.get('pinch').recognizeWith(hammer.get('pan'))

    // Hammer reports a pan's total movement; the handler gets the step.
    let lastX = 0
    let lastY = 0
    // A sideways swipe (Ctrl+C, Tab) must not scroll the history too.
    let horizontal = false
    let glide = 0
    const stopGlide = () => {
      if (glide) cancelAnimationFrame(glide)
      glide = 0
    }
    const pan = (ev: HammerInput) => {
      const dx = ev.deltaX - lastX
      const dy = ev.deltaY - lastY
      lastX = ev.deltaX
      lastY = ev.deltaY
      if (horizontal ? dx : dy) {
        handlersRef.current.onPan?.(horizontal ? dx : 0, horizontal ? 0 : dy)
      }
    }
    const startGlide = (ev: HammerInput) => {
      let vx = horizontal ? ev.velocityX : 0
      let vy = horizontal ? 0 : ev.velocityY
      if (Math.hypot(vx, vy) < GLIDE_START_VELOCITY) return
      let last = performance.now()
      const frame = (now: number) => {
        const dt = now - last
        last = now
        const decay = GLIDE_FRICTION ** (dt / 16)
        vx *= decay
        vy *= decay
        if (Math.hypot(vx, vy) < GLIDE_MIN_VELOCITY) {
          glide = 0
          return
        }
        handlersRef.current.onPan?.(vx * dt, vy * dt)
        glide = requestAnimationFrame(frame)
      }
      glide = requestAnimationFrame(frame)
    }
    // The drag counts from where it was recognised: the threshold before it,
    // or a pinch just ended, would otherwise move the view in one jump.
    hammer.on('panstart', (ev) => {
      stopGlide()
      horizontal = Math.abs(ev.deltaX) > Math.abs(ev.deltaY)
      lastX = ev.deltaX
      lastY = ev.deltaY
    })
    hammer.on('panmove', pan)
    hammer.on('panend', (ev) => {
      pan(ev)
      startGlide(ev)
    })
    // A new touch stops the glide where it is.
    hammer.on('hammer.input', (ev) => {
      if (ev.isFirst) stopGlide()
    })

    // Bind handlers
    hammer.on('tap', () => handlersRef.current.onTap?.())
    hammer.on('swipeleft', () => handlersRef.current.onSwipeLeft?.())
    hammer.on('swiperight', () => handlersRef.current.onSwipeRight?.())
    hammer.on('swipeup', () => handlersRef.current.onSwipeUp?.())
    hammer.on('swipedown', () => handlersRef.current.onSwipeDown?.())
    hammer.on('press', () => handlersRef.current.onLongPress?.())
    hammer.on('pinchin', () => handlersRef.current.onPinchIn?.())
    hammer.on('pinchout', () => handlersRef.current.onPinchOut?.())

    return () => {
      stopGlide()
      hammer.destroy()
    }
  }, [elementRef])
}
