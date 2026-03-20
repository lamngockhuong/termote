import { useEffect, useRef, RefObject } from 'react'
import Hammer from 'hammerjs'

export interface GestureHandlers {
  onSwipeLeft?: () => void // Ctrl+C
  onSwipeRight?: () => void // Tab
  onSwipeUp?: () => void // History prev
  onSwipeDown?: () => void // History next
  onLongPress?: () => void // Paste
  onPinchIn?: () => void // Font smaller
  onPinchOut?: () => void // Font larger
}

export function useGestures(
  elementRef: RefObject<HTMLElement | null>,
  handlers: GestureHandlers
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

    // Bind handlers
    hammer.on('swipeleft', () => handlersRef.current.onSwipeLeft?.())
    hammer.on('swiperight', () => handlersRef.current.onSwipeRight?.())
    hammer.on('swipeup', () => handlersRef.current.onSwipeUp?.())
    hammer.on('swipedown', () => handlersRef.current.onSwipeDown?.())
    hammer.on('press', () => handlersRef.current.onLongPress?.())
    hammer.on('pinchin', () => handlersRef.current.onPinchIn?.())
    hammer.on('pinchout', () => handlersRef.current.onPinchOut?.())

    return () => {
      hammer.destroy()
    }
  }, [elementRef])
}
