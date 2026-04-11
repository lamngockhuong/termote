import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardVisible } from './use-keyboard-visible'

describe('useKeyboardVisible', () => {
  let visualViewportListeners: Record<string, Array<() => void>>
  let mockViewport: { height: number; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
  const originalInnerHeight = window.innerHeight

  beforeEach(() => {
    visualViewportListeners = { resize: [], scroll: [] }
    mockViewport = {
      height: 800,
      addEventListener: vi.fn((event: string, cb: () => void) => {
        visualViewportListeners[event]?.push(cb)
      }),
      removeEventListener: vi.fn((event: string, cb: () => void) => {
        visualViewportListeners[event] = (visualViewportListeners[event] ?? []).filter((l) => l !== cb)
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
  })

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: originalInnerHeight,
    })
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: undefined,
    })
  })

  it('starts with keyboard not visible', () => {
    const { result } = renderHook(() => useKeyboardVisible())
    expect(result.current.isVisible).toBe(false)
    expect(result.current.keyboardHeight).toBe(0)
  })

  it('detects keyboard open when height diff > 150', () => {
    const { result } = renderHook(() => useKeyboardVisible())

    act(() => {
      mockViewport.height = 400
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
      for (const cb of visualViewportListeners.resize) cb()
    })

    expect(result.current.isVisible).toBe(true)
    expect(result.current.keyboardHeight).toBe(400)
  })

  it('detects keyboard closed when height diff <= 150', () => {
    const { result } = renderHook(() => useKeyboardVisible())

    act(() => {
      mockViewport.height = 700
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
      for (const cb of visualViewportListeners.resize) cb()
    })

    expect(result.current.isVisible).toBe(false)
    expect(result.current.keyboardHeight).toBe(0)
  })

  it('responds to scroll event', () => {
    const { result } = renderHook(() => useKeyboardVisible())

    act(() => {
      mockViewport.height = 400
      for (const cb of visualViewportListeners.scroll) cb()
    })

    expect(result.current.isVisible).toBe(true)
    expect(result.current.keyboardHeight).toBe(400)
  })

  it('removes event listeners on unmount', () => {
    const { unmount } = renderHook(() => useKeyboardVisible())
    unmount()
    expect(mockViewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(mockViewport.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('does nothing when visualViewport is undefined', () => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined })
    const { result } = renderHook(() => useKeyboardVisible())
    expect(result.current.isVisible).toBe(false)
    expect(result.current.keyboardHeight).toBe(0)
  })
})
