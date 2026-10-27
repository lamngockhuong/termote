import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useWheelScrollX } from './use-wheel-scroll-x'

// A row 100px wide holding 300px, scrolled to left
const row = (left = 0, scrollWidth = 300) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: 100 })
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth })
  el.scrollLeft = left
  return el
}

const wheel = (el: HTMLElement, init: WheelEventInit) => {
  const e = new WheelEvent('wheel', { cancelable: true, ...init })
  el.dispatchEvent(e)
  return e
}

describe('useWheelScrollX', () => {
  it('turns a vertical wheel into a sideways scroll', () => {
    const el = row()
    renderHook(() => useWheelScrollX({ current: el }))
    const e = wheel(el, { deltaY: 40 })
    expect(e.defaultPrevented).toBe(true)
    expect(el.scrollLeft).toBe(40)
  })

  it('scales lines and pages to px', () => {
    const el = row()
    renderHook(() => useWheelScrollX({ current: el }))
    wheel(el, { deltaY: 3, deltaMode: 1 })
    expect(el.scrollLeft).toBe(48)
    wheel(el, { deltaY: 1, deltaMode: 2 })
    expect(el.scrollLeft).toBe(148)
  })

  it('lets the event go when the row cannot move that way', () => {
    const el = row()
    renderHook(() => useWheelScrollX({ current: el }))
    expect(wheel(el, { deltaY: -40 }).defaultPrevented).toBe(false)
    el.scrollLeft = 200
    expect(wheel(el, { deltaY: 40 }).defaultPrevented).toBe(false)
  })

  it('lets the event go when the row does not overflow', () => {
    const el = row(0, 100)
    renderHook(() => useWheelScrollX({ current: el }))
    expect(wheel(el, { deltaY: 40 }).defaultPrevented).toBe(false)
  })

  it('leaves a sideways swipe and a pinch zoom to the browser', () => {
    const el = row()
    renderHook(() => useWheelScrollX({ current: el }))
    expect(wheel(el, { deltaX: 40, deltaY: 10 }).defaultPrevented).toBe(false)
    expect(wheel(el, { deltaY: 40, ctrlKey: true }).defaultPrevented).toBe(
      false,
    )
    expect(el.scrollLeft).toBe(0)
  })

  it('stops listening when unmounted, and does nothing without an element', () => {
    const el = row()
    const { unmount } = renderHook(() => useWheelScrollX({ current: el }))
    unmount()
    expect(wheel(el, { deltaY: 40 }).defaultPrevented).toBe(false)
    renderHook(() => useWheelScrollX({ current: null }))
  })
})
