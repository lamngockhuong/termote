import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFullscreen } from './use-fullscreen'

describe('useFullscreen', () => {
  beforeEach(() => {
    // Reset fullscreenElement to null before each test
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: null,
    })
  })

  it('starts not in fullscreen when fullscreenElement is null', () => {
    const { result } = renderHook(() => useFullscreen())
    expect(result.current.isFullscreen).toBe(false)
  })

  it('starts in fullscreen when fullscreenElement is set', () => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    })
    const { result } = renderHook(() => useFullscreen())
    expect(result.current.isFullscreen).toBe(true)
  })

  it('provides toggleFullscreen function', () => {
    const { result } = renderHook(() => useFullscreen())
    expect(typeof result.current.toggleFullscreen).toBe('function')
  })

  it('calls requestFullscreen when not in fullscreen', async () => {
    const requestFullscreen = vi.fn().mockResolvedValue(undefined)
    document.documentElement.requestFullscreen = requestFullscreen

    const { result } = renderHook(() => useFullscreen())
    await act(async () => {
      result.current.toggleFullscreen()
    })

    expect(requestFullscreen).toHaveBeenCalledTimes(1)
  })

  it('calls exitFullscreen when already in fullscreen', async () => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    })
    const exitFullscreen = vi.fn().mockResolvedValue(undefined)
    document.exitFullscreen = exitFullscreen

    const { result } = renderHook(() => useFullscreen())
    await act(async () => {
      result.current.toggleFullscreen()
    })

    expect(exitFullscreen).toHaveBeenCalledTimes(1)
  })

  it('handles requestFullscreen rejection gracefully', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    document.documentElement.requestFullscreen = vi
      .fn()
      .mockRejectedValue(new Error('denied'))

    const { result } = renderHook(() => useFullscreen())
    await act(async () => {
      result.current.toggleFullscreen()
    })

    expect(consoleWarn).toHaveBeenCalledWith(
      'Fullscreen request denied:',
      expect.any(Error),
    )
    consoleWarn.mockRestore()
  })

  it('updates isFullscreen to true on fullscreenchange event', () => {
    const { result } = renderHook(() => useFullscreen())
    expect(result.current.isFullscreen).toBe(false)

    act(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: document.documentElement,
      })
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    expect(result.current.isFullscreen).toBe(true)
  })

  it('updates isFullscreen to false on fullscreenchange event when exiting', () => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      value: document.documentElement,
    })
    const { result } = renderHook(() => useFullscreen())
    expect(result.current.isFullscreen).toBe(true)

    act(() => {
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        value: null,
      })
      document.dispatchEvent(new Event('fullscreenchange'))
    })

    expect(result.current.isFullscreen).toBe(false)
  })

  it('removes fullscreenchange listener on unmount', () => {
    const removeEventListener = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useFullscreen())
    unmount()
    expect(removeEventListener).toHaveBeenCalledWith(
      'fullscreenchange',
      expect.any(Function),
    )
    removeEventListener.mockRestore()
  })
})
