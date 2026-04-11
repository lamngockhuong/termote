import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewport } from './use-viewport'

describe('useViewport', () => {
  let viewportListeners: Array<() => void>
  let windowResizeListeners: Array<() => void>
  let mockViewport: { height: number; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    viewportListeners = []
    windowResizeListeners = []

    mockViewport = {
      height: 800,
      addEventListener: vi.fn((_event: string, cb: () => void) => {
        viewportListeners.push(cb)
      }),
      removeEventListener: vi.fn((_event: string, cb: () => void) => {
        viewportListeners = viewportListeners.filter((l) => l !== cb)
      }),
    }

    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: mockViewport,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 800,
    })

    vi.spyOn(window, 'addEventListener').mockImplementation((event: string, cb: EventListenerOrEventListenerObject) => {
      if (event === 'resize') windowResizeListeners.push(cb as () => void)
    })
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
  })

  it('initializes with current viewport height', () => {
    mockViewport.height = 800
    const { result } = renderHook(() => useViewport())
    expect(result.current.viewportHeight).toBe(800)
    expect(result.current.keyboardVisible).toBe(false)
  })

  it('updates viewportHeight from visualViewport on resize', () => {
    const { result } = renderHook(() => useViewport())

    act(() => {
      mockViewport.height = 400
      for (const cb of viewportListeners) cb()
    })

    expect(result.current.viewportHeight).toBe(400)
  })

  it('sets keyboardVisible true when height diff > 150', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const { result } = renderHook(() => useViewport())

    act(() => {
      mockViewport.height = 400
      for (const cb of viewportListeners) cb()
    })

    expect(result.current.keyboardVisible).toBe(true)
  })

  it('sets keyboardVisible false when height diff <= 150', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const { result } = renderHook(() => useViewport())

    act(() => {
      mockViewport.height = 700
      for (const cb of viewportListeners) cb()
    })

    expect(result.current.keyboardVisible).toBe(false)
  })

  it('responds to window resize event', () => {
    const { result } = renderHook(() => useViewport())

    act(() => {
      mockViewport.height = 300
      for (const cb of windowResizeListeners) cb()
    })

    expect(result.current.viewportHeight).toBe(300)
  })

  it('removes event listeners on unmount', () => {
    const { unmount } = renderHook(() => useViewport())
    unmount()
    expect(mockViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(window.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('falls back to window.innerHeight when visualViewport is undefined', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const { result } = renderHook(() => useViewport())
    expect(result.current.viewportHeight).toBe(900)
  })
})
