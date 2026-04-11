import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type HammerHandler = () => void

const { mockHammerInstance, mockSwipe, mockPinch, mockPress } = vi.hoisted(
  () => {
    const mockSwipe = { set: vi.fn() }
    const mockPinch = { set: vi.fn() }
    const mockPress = { set: vi.fn() }
    const mockHammerInstance = {
      get: vi.fn((name: string) => {
        if (name === 'swipe') return mockSwipe
        if (name === 'pinch') return mockPinch
        if (name === 'press') return mockPress
        return { set: vi.fn() }
      }),
      on: vi.fn(),
      destroy: vi.fn(),
    }
    return { mockHammerInstance, mockSwipe, mockPinch, mockPress }
  },
)

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
