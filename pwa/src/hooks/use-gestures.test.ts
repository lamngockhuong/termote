import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type HammerHandler = (ev?: Partial<HammerInput>) => void

const { mockHammerInstance, mockSwipe, mockPinch, mockPress, mockPan } =
  vi.hoisted(() => {
    const mockSwipe = { set: vi.fn() }
    const mockPan = { set: vi.fn() }
    const mockPinch = { set: vi.fn(), recognizeWith: vi.fn() }
    const mockPress = { set: vi.fn() }
    const mockHammerInstance = {
      get: vi.fn((name: string) => {
        if (name === 'swipe') return mockSwipe
        if (name === 'pinch') return mockPinch
        if (name === 'press') return mockPress
        if (name === 'pan') return mockPan
        return { set: vi.fn() }
      }),
      on: vi.fn(),
      destroy: vi.fn(),
    }
    return { mockHammerInstance, mockSwipe, mockPinch, mockPress, mockPan }
  })

vi.mock('hammerjs', () => {
  function MockHammer() {
    return mockHammerInstance
  }
  MockHammer.DIRECTION_ALL = 31
  return {
    default: MockHammer,
    DIRECTION_ALL: 31,
  }
})

import { useGestures } from './use-gestures'

describe('useGestures', () => {
  let element: HTMLDivElement
  let elementRef: { current: HTMLDivElement }

  beforeEach(() => {
    vi.clearAllMocks()
    // Restore get implementation after clearAllMocks
    mockHammerInstance.get.mockImplementation((name: string) => {
      if (name === 'swipe') return mockSwipe
      if (name === 'pinch') return mockPinch
      if (name === 'press') return mockPress
      if (name === 'pan') return mockPan
      return { set: vi.fn() }
    })
    element = document.createElement('div')
    elementRef = { current: element }
  })

  function getHandler(eventName: string): HammerHandler {
    const call = mockHammerInstance.on.mock.calls.find(
      ([name]) => name === eventName,
    )
    return call?.[1] as HammerHandler
  }

  it('creates Hammer instance and registers event handlers', () => {
    renderHook(() => useGestures(elementRef, {}))
    expect(mockHammerInstance.on).toHaveBeenCalledWith(
      'tap',
      expect.any(Function),
    )
    expect(mockHammerInstance.on).toHaveBeenCalledWith(
      'swipeleft',
      expect.any(Function),
    )
  })

  it('configures swipe direction to DIRECTION_ALL', () => {
    renderHook(() => useGestures(elementRef, {}))
    expect(mockSwipe.set).toHaveBeenCalledWith({ direction: 31 })
  })

  it('configures pinch to be enabled', () => {
    renderHook(() => useGestures(elementRef, {}))
    expect(mockPinch.set).toHaveBeenCalledWith({ enable: true })
  })

  it('configures press time to 500ms', () => {
    renderHook(() => useGestures(elementRef, {}))
    expect(mockPress.set).toHaveBeenCalledWith({ time: 500 })
  })

  it('calls onTap when tap fires', () => {
    const onTap = vi.fn()
    renderHook(() => useGestures(elementRef, { onTap }))
    getHandler('tap')()
    expect(onTap).toHaveBeenCalledTimes(1)
  })

  it('calls onSwipeLeft when swipeleft fires', () => {
    const onSwipeLeft = vi.fn()
    renderHook(() => useGestures(elementRef, { onSwipeLeft }))
    getHandler('swipeleft')()
    expect(onSwipeLeft).toHaveBeenCalledTimes(1)
  })

  it('calls onSwipeRight when swiperight fires', () => {
    const onSwipeRight = vi.fn()
    renderHook(() => useGestures(elementRef, { onSwipeRight }))
    getHandler('swiperight')()
    expect(onSwipeRight).toHaveBeenCalledTimes(1)
  })

  it('calls onSwipeUp when swipeup fires', () => {
    const onSwipeUp = vi.fn()
    renderHook(() => useGestures(elementRef, { onSwipeUp }))
    getHandler('swipeup')()
    expect(onSwipeUp).toHaveBeenCalledTimes(1)
  })

  it('calls onSwipeDown when swipedown fires', () => {
    const onSwipeDown = vi.fn()
    renderHook(() => useGestures(elementRef, { onSwipeDown }))
    getHandler('swipedown')()
    expect(onSwipeDown).toHaveBeenCalledTimes(1)
  })

  it('calls onLongPress when press fires', () => {
    const onLongPress = vi.fn()
    renderHook(() => useGestures(elementRef, { onLongPress }))
    getHandler('press')()
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })

  it('calls onPinchIn when pinchin fires', () => {
    const onPinchIn = vi.fn()
    renderHook(() => useGestures(elementRef, { onPinchIn }))
    getHandler('pinchin')()
    expect(onPinchIn).toHaveBeenCalledTimes(1)
  })

  it('calls onPinchOut when pinchout fires', () => {
    const onPinchOut = vi.fn()
    renderHook(() => useGestures(elementRef, { onPinchOut }))
    getHandler('pinchout')()
    expect(onPinchOut).toHaveBeenCalledTimes(1)
  })

  it('does not throw when handlers are not provided', () => {
    renderHook(() => useGestures(elementRef, {}))
    expect(() => getHandler('tap')()).not.toThrow()
    expect(() => getHandler('swipeleft')()).not.toThrow()
    expect(() => getHandler('swiperight')()).not.toThrow()
    expect(() => getHandler('swipeup')()).not.toThrow()
    expect(() => getHandler('swipedown')()).not.toThrow()
    expect(() => getHandler('press')()).not.toThrow()
    expect(() => getHandler('pinchin')()).not.toThrow()
    expect(() => getHandler('pinchout')()).not.toThrow()
  })

  it('uses latest handlers via ref — rerender does not re-register events', () => {
    const onTap1 = vi.fn()
    const onTap2 = vi.fn()
    const { rerender } = renderHook(({ h }) => useGestures(elementRef, h), {
      initialProps: { h: { onTap: onTap1 } },
    })
    rerender({ h: { onTap: onTap2 } })
    // handlers registered once (elementRef didn't change), latest ref is used
    getHandler('tap')()
    expect(onTap2).toHaveBeenCalledTimes(1)
    expect(onTap1).not.toHaveBeenCalled()
  })

  describe('pan', () => {
    // Animation frames run by hand, 16ms apart.
    let frames: FrameRequestCallback[]
    let now: number
    beforeEach(() => {
      frames = []
      now = 0
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frames.push(cb)
        return frames.length
      })
      vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames[id - 1] = () => {}
      })
      vi.spyOn(performance, 'now').mockImplementation(() => now)
    })
    const runFrame = () => {
      now += 16
      const cb = frames.shift()
      cb?.(now)
      return !!cb
    }
    const move = (deltaX: number, deltaY: number, extra = {}) => ({
      deltaX,
      deltaY,
      velocityX: 0,
      velocityY: 0,
      ...extra,
    })

    it('drags in any direction, and still pinches with a drag started', () => {
      renderHook(() => useGestures(elementRef, {}))
      expect(mockPan.set).toHaveBeenCalledWith({ direction: 31 })
      expect(mockPinch.recognizeWith).toHaveBeenCalledWith(mockPan)
    })

    it('reports each step of a drag along its axis, from where it started', () => {
      const onPan = vi.fn()
      renderHook(() => useGestures(elementRef, { onPan }))
      // Recognised after 12px down: that part is not a step
      getHandler('panstart')(move(2, 12))
      getHandler('panmove')(move(3, 20))
      getHandler('panmove')(move(9, 20)) // sideways only: nothing reported
      getHandler('panend')(move(9, 25))
      expect(onPan.mock.calls).toEqual([
        [0, 8],
        [0, 5],
      ])
      // A slow release does not glide
      expect(frames).toHaveLength(0)
      // A sideways drag never moves vertically
      getHandler('panstart')(move(-12, 3))
      getHandler('panmove')(move(-30, 10))
      expect(onPan).toHaveBeenLastCalledWith(-18, 0)
    })

    it('glides after a flick, slowing down until it stops', () => {
      const onPan = vi.fn()
      renderHook(() => useGestures(elementRef, { onPan }))
      getHandler('panstart')(move(0, 10))
      getHandler('panend')(move(2, 40, { velocityX: 0.5, velocityY: 1 }))
      onPan.mockClear()
      runFrame()
      const first = onPan.mock.calls[0]
      expect(first[0]).toBe(0)
      expect(first[1]).toBeCloseTo(16 * 0.95)
      runFrame()
      expect(onPan.mock.calls[1][1]).toBeLessThan(first[1])
      let n = 2
      while (runFrame()) n++
      expect(n).toBeLessThan(200)
      expect(onPan).toHaveBeenCalledTimes(n - 1)
    })

    it('a new touch stops the glide', () => {
      const onPan = vi.fn()
      const { unmount } = renderHook(() => useGestures(elementRef, { onPan }))
      getHandler('panstart')(move(-10, 0))
      getHandler('panend')(move(-40, 0, { velocityX: -1 }))
      runFrame()
      expect(onPan.mock.calls[1][0]).toBeLessThan(0)
      expect(onPan.mock.calls[1][1]).toBe(0)
      onPan.mockClear()
      getHandler('hammer.input')({ isFirst: false })
      getHandler('hammer.input')({ isFirst: true })
      while (runFrame()) {}
      expect(onPan).not.toHaveBeenCalled()
      // Unmounting while gliding is safe
      getHandler('panend')(move(-40, 0, { velocityX: 1 }))
      unmount()
      while (runFrame()) {}
      expect(onPan).not.toHaveBeenCalled()
    })
  })

  it('destroys Hammer on unmount', () => {
    const { unmount } = renderHook(() => useGestures(elementRef, {}))
    unmount()
    expect(mockHammerInstance.destroy).toHaveBeenCalledTimes(1)
  })

  it('does nothing when elementRef.current is null', () => {
    const nullRef = { current: null }
    const { unmount } = renderHook(() => useGestures(nullRef, {}))
    unmount()
    expect(mockHammerInstance.destroy).not.toHaveBeenCalled()
  })
})
