import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transitionMs, useExitTransition } from './use-exit-transition'

let el: HTMLDivElement

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
})

afterEach(() => {
  el.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Gives the element a transition, as a stylesheet would
function animate(duration: string, delay = '0s') {
  el.style.transitionDuration = duration
  el.style.transitionDelay = delay
}

function render(
  open: boolean,
  ref: { current: Element | null } = { current: el },
) {
  return renderHook(({ open }) => useExitTransition(open, ref), {
    initialProps: { open },
  })
}

describe('transitionMs', () => {
  it('is 0 without an element or a transition', () => {
    expect(transitionMs(null)).toBe(0)
    expect(transitionMs(el)).toBe(0)
  })

  it('takes the longest of the list, delay included, in ms', () => {
    animate('150ms, 0.2s', '0s, 10ms')
    expect(transitionMs(el)).toBe(210)
  })

  it('counts a delay missing from a shorter list as none', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transitionDuration: '100ms, 120ms',
      transitionDelay: '5ms',
    } as CSSStyleDeclaration)
    expect(transitionMs(el)).toBe(120)
  })

  it('reads a value it cannot parse as 0', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      transitionDuration: 'bogus',
      transitionDelay: '',
    } as CSSStyleDeclaration)
    expect(transitionMs(el)).toBe(0)
  })
})

describe('useExitTransition', () => {
  it('mounts with open and unmounts at once with nothing to animate', () => {
    const view = render(true)
    expect(view.result.current).toEqual({ mounted: true, closing: false })
    view.rerender({ open: false })
    expect(view.result.current).toEqual({ mounted: false, closing: false })
  })

  it('treats the reduced-motion duration as none', () => {
    animate('0.01ms')
    const view = render(true)
    view.rerender({ open: false })
    expect(view.result.current.mounted).toBe(false)
  })

  it('starts closed when not open, and mounts on open', () => {
    const view = render(false)
    expect(view.result.current.mounted).toBe(false)
    view.rerender({ open: true })
    expect(view.result.current).toEqual({ mounted: true, closing: false })
  })

  it('keeps the element while it closes, until its transitionend', () => {
    animate('150ms')
    const view = render(true)
    view.rerender({ open: false })
    expect(view.result.current).toEqual({ mounted: true, closing: true })
    // A child's transition bubbles up: not the element's own
    const child = document.createElement('span')
    el.append(child)
    act(() => {
      child.dispatchEvent(new Event('transitionend', { bubbles: true }))
    })
    expect(view.result.current.mounted).toBe(true)
    act(() => {
      el.dispatchEvent(new Event('transitionend'))
    })
    expect(view.result.current).toEqual({ mounted: false, closing: false })
  })

  it('removes the element after its duration when no transitionend comes', () => {
    vi.useFakeTimers()
    animate('150ms')
    const view = render(true)
    view.rerender({ open: false })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(view.result.current.mounted).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(view.result.current.mounted).toBe(false)
  })

  it('keeps the element when it opens again while closing', () => {
    vi.useFakeTimers()
    animate('150ms')
    const view = render(true)
    view.rerender({ open: false })
    view.rerender({ open: true })
    expect(view.result.current).toEqual({ mounted: true, closing: false })
    act(() => {
      vi.advanceTimersByTime(500)
      el.dispatchEvent(new Event('transitionend'))
    })
    expect(view.result.current.mounted).toBe(true)
  })

  it('leaves no timer behind when unmounted while closing', () => {
    vi.useFakeTimers()
    animate('150ms')
    const remove = vi.spyOn(el, 'removeEventListener')
    const view = render(true)
    view.rerender({ open: false })
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('transitionend', expect.any(Function))
  })

  it('times out when the element is gone by the time closing starts', () => {
    vi.useFakeTimers()
    animate('150ms')
    // Read once while rendering the close, then gone
    let reads = 0
    const ref = {
      get current() {
        return reads++ === 0 ? el : null
      },
    }
    const view = render(true, ref)
    reads = 0
    view.rerender({ open: false })
    expect(view.result.current.closing).toBe(true)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    expect(view.result.current.mounted).toBe(false)
  })
})
