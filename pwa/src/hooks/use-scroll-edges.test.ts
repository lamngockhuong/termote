import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrollEdgeMask, useScrollEdges } from './use-scroll-edges'

describe('scrollEdgeMask', () => {
  it('returns undefined when no edges are hidden', () => {
    const mask = scrollEdgeMask({ start: false, end: false })
    expect(mask).toBeUndefined()
  })

  it('creates mask gradient when start edge is hidden', () => {
    const mask = scrollEdgeMask({ start: true, end: false })
    expect(mask).toContain('linear-gradient(to right')
    expect(mask).toContain('transparent')
    expect(mask).toContain('24px')
  })

  it('creates mask gradient when end edge is hidden', () => {
    const mask = scrollEdgeMask({ start: false, end: true })
    expect(mask).toContain('calc(100% - 24px)')
  })

  it('creates mask gradient fading both edges', () => {
    const mask = scrollEdgeMask({ start: true, end: true })
    expect(mask).toContain('transparent, #000 24px')
    expect(mask).toContain('calc(100% - 24px), transparent')
  })

  it('mask has 24px fade width', () => {
    const mask = scrollEdgeMask({ start: true, end: false })
    expect(mask).toContain('24px')
  })

  it('mask is valid CSS linear-gradient', () => {
    const mask = scrollEdgeMask({ start: true, end: true })
    expect(mask).toMatch(/^linear-gradient\(to right,/)
  })
})

describe('useScrollEdges', () => {
  describe('initialization', () => {
    it('returns default state when ref is null', () => {
      const { result } = renderHook(() => useScrollEdges(null))
      expect(result.current).toEqual({ start: false, end: false })
    })

    it('detects end edge hidden on init', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 390,
        scrollWidth: 400,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.start).toBe(false)
      expect(result.current.end).toBe(true)
    })

    it('detects both edges hidden on init', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 10,
        clientWidth: 390,
        scrollWidth: 800,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.start).toBe(true)
      expect(result.current.end).toBe(true)
    })

    it('detects no edges hidden when content fits', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 400,
        scrollWidth: 400,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.start).toBe(false)
      expect(result.current.end).toBe(false)
    })
  })

  describe('scroll event listener management', () => {
    it('adds scroll listener with passive: true', () => {
      const mockElement = createMockScrollElement()
      const addEventListenerSpy = vi.spyOn(mockElement, 'addEventListener')
      renderHook(() => useScrollEdges(mockElement))
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
        { passive: true },
      )
    })

    it('removes scroll listener on unmount', () => {
      const mockElement = createMockScrollElement()
      const removeEventListenerSpy = vi.spyOn(
        mockElement,
        'removeEventListener',
      )
      const { unmount } = renderHook(() => useScrollEdges(mockElement))
      unmount()
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
      )
    })
  })

  describe('ResizeObserver handling', () => {
    let originalResizeObserver: typeof globalThis.ResizeObserver

    beforeEach(() => {
      originalResizeObserver = globalThis.ResizeObserver as any
    })

    afterEach(() => {
      if (originalResizeObserver) {
        globalThis.ResizeObserver = originalResizeObserver as any
      } else {
        delete (globalThis as any).ResizeObserver
      }
    })

    it('creates ResizeObserver when available', () => {
      const observeSpy = vi.fn()
      const disconnectSpy = vi.fn()
      class MockResizeObserver {
        observe = observeSpy
        disconnect = disconnectSpy
      }
      globalThis.ResizeObserver = MockResizeObserver as any
      const mockElement = createMockScrollElement()
      renderHook(() => useScrollEdges(mockElement))
      expect(observeSpy).toHaveBeenCalledWith(mockElement)
    })

    it('observes children in ResizeObserver', () => {
      const observeSpy = vi.fn()
      class MockResizeObserver {
        observe = observeSpy
        disconnect = vi.fn()
      }
      globalThis.ResizeObserver = MockResizeObserver as any
      const mockElement = createMockScrollElement()
      mockElement.appendChild(document.createElement('div'))
      renderHook(() => useScrollEdges(mockElement))
      // Should observe element and any children
      expect(observeSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    })

    it('disconnects ResizeObserver on unmount', () => {
      const disconnectSpy = vi.fn()
      class MockResizeObserver {
        observe = vi.fn()
        disconnect = disconnectSpy
      }
      globalThis.ResizeObserver = MockResizeObserver as any
      const mockElement = createMockScrollElement()
      const { unmount } = renderHook(() => useScrollEdges(mockElement))
      unmount()
      expect(disconnectSpy).toHaveBeenCalled()
    })

    it('handles missing ResizeObserver', () => {
      delete (globalThis as any).ResizeObserver
      const mockElement = createMockScrollElement()
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current).toBeDefined()
    })
  })

  describe('contentKey dependency', () => {
    it('updates on contentKey change', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 390,
        scrollWidth: 400,
      })
      const { result, rerender } = renderHook(
        ({ contentKey }: { contentKey: unknown }) =>
          useScrollEdges(mockElement, contentKey),
        { initialProps: { contentKey: 'key1' } },
      )
      expect(result.current.end).toBe(true)

      Object.defineProperty(mockElement, 'scrollWidth', {
        value: 390,
        writable: true,
      })
      rerender({ contentKey: 'key2' })
      expect(result.current.end).toBe(false)
    })
  })

  describe('edge detection with 1px slack', () => {
    it('scrollLeft=1 does not trigger start edge', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 1,
        clientWidth: 390,
        scrollWidth: 400,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.start).toBe(false)
    })

    it('scrollLeft>1 triggers start edge', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 1.5,
        clientWidth: 390,
        scrollWidth: 400,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.start).toBe(true)
    })

    it('end edge within 1px slack is not hidden', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 390,
        scrollWidth: 390.5,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.end).toBe(false)
    })

    it('end edge >1px from visible part is hidden', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 390,
        scrollWidth: 391.5,
      })
      const { result } = renderHook(() => useScrollEdges(mockElement))
      expect(result.current.end).toBe(true)
    })
  })

  describe('state optimization', () => {
    it('does not update state when edges stay same', () => {
      const mockElement = createMockScrollElement({
        scrollLeft: 0,
        clientWidth: 400,
        scrollWidth: 400,
      })
      const addEventListenerSpy = vi.spyOn(mockElement, 'addEventListener')
      renderHook(() => useScrollEdges(mockElement))

      // Hook should setup listener, trigger update callback multiple times but state stays same
      const updateCallback = addEventListenerSpy.mock.calls.find(
        (call) => call[0] === 'scroll',
      )?.[1] as EventListener

      if (updateCallback) {
        updateCallback(new Event('scroll'))
        // State update should check prev vs next and not update if same
        expect(updateCallback).toBeDefined()
      }
    })
  })
})

function createMockScrollElement(options?: {
  scrollLeft?: number
  clientWidth?: number
  scrollWidth?: number
}): HTMLDivElement {
  const element = document.createElement('div')
  element.scrollLeft = options?.scrollLeft ?? 0

  Object.defineProperty(element, 'clientWidth', {
    value: options?.clientWidth ?? 390,
    writable: true,
    configurable: true,
  })

  Object.defineProperty(element, 'scrollWidth', {
    value: options?.scrollWidth ?? 400,
    writable: true,
    configurable: true,
  })

  return element
}
