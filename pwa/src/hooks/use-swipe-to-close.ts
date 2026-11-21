import { type RefObject, useEffect, useRef } from 'react'

// A pull this far down (or this share of the sheet's height, if less) closes
// it on release; a shorter one springs back.
const CLOSE_PX = 120
const CLOSE_SHARE = 0.25
// A flick this fast (px/ms) closes it from a shorter pull, past FLICK_MIN_PX.
const FLICK_VELOCITY = 0.5
const FLICK_MIN_PX = 30
// Movement before the gesture is read as a pull or left to the page.
const SLOP_PX = 8

// Whether the touch sits in something scrolled away from its top: pulling
// down there scrolls it back rather than moving the sheet.
function scrolledAbove(target: Element | null, root: HTMLElement) {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollTop > 0) return true
  }
  return false
}

function editable(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest('input, textarea, select, [contenteditable="true"]')
  )
}

// Drags a bottom sheet down with one finger and calls onClose when it is
// let go far or fast enough, the same as its close button. Touch events, not
// pointer events: the content scrolls, and a pan there would cancel the
// pointer. A pull starts only downward, vertically, and where nothing under
// the finger is scrolled down.
export function useSwipeToClose(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let start: { id: number; x: number; y: number; t: number } | null = null
    // undefined: not decided yet; true: the sheet follows the finger
    let pulling: boolean | undefined
    let dy = 0

    const reset = () => {
      start = null
      pulling = undefined
      dy = 0
    }
    const springBack = () => {
      el.style.removeProperty('transition')
      el.style.removeProperty('translate')
    }
    const touch = (e: TouchEvent) =>
      start
        ? [...e.changedTouches].find((t) => t.identifier === start?.id)
        : undefined

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || editable(e.target)) {
        if (pulling) springBack()
        reset()
        return
      }
      const t = e.touches[0]
      start = { id: t.identifier, x: t.clientX, y: t.clientY, t: e.timeStamp }
      pulling = scrolledAbove(e.target as Element | null, el)
        ? false
        : undefined
    }
    const onMove = (e: TouchEvent) => {
      const t = touch(e)
      if (!start || !t || pulling === false) return
      const x = t.clientX - start.x
      const y = t.clientY - start.y
      if (pulling === undefined) {
        if (Math.max(Math.abs(x), Math.abs(y)) < SLOP_PX) return
        pulling = y > 0 && y > Math.abs(x)
        if (!pulling) return
        // Measured from here, so the sheet does not jump by the slop
        start.y = t.clientY
        start.t = e.timeStamp
      }
      if (e.cancelable) e.preventDefault()
      dy = Math.max(0, t.clientY - start.y)
      el.style.transition = 'none'
      el.style.translate = `0 ${dy}px`
    }
    const onEnd = (e: TouchEvent) => {
      if (!start || !touch(e)) return
      const wasPulling = pulling
      const elapsed = Math.max(1, e.timeStamp - start.t)
      const pulled = dy
      reset()
      if (!wasPulling) return
      const far = pulled >= Math.min(CLOSE_PX, el.offsetHeight * CLOSE_SHARE)
      const flick = pulled > FLICK_MIN_PX && pulled / elapsed > FLICK_VELOCITY
      if (e.type === 'touchend' && (far || flick)) {
        // Carries on down while it fades out
        el.style.removeProperty('transition')
        el.style.translate = `0 ${el.offsetHeight}px`
        onCloseRef.current()
      } else {
        springBack()
      }
    }

    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      springBack()
    }
  }, [ref, enabled])
}
