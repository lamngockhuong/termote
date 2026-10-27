import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useElementWidth } from './use-element-width'

describe('useElementWidth', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('measures the element, then follows it until unmounted', () => {
    let report: (width: number) => void = () => {}
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (e: { contentRect: { width: number } }[]) => void) {
          report = (width) => cb([{ contentRect: { width } }])
        }
        observe() {}
        disconnect = disconnect
      },
    )
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ width: 500 }) as DOMRect
    const ref = { current: el }
    const { result, unmount } = renderHook(() => useElementWidth(ref))
    expect(result.current).toBe(500)
    act(() => report(900))
    expect(result.current).toBe(900)
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('is 0 without an element or without ResizeObserver', () => {
    expect(
      renderHook(() => useElementWidth({ current: null })).result.current,
    ).toBe(0)
    vi.stubGlobal('ResizeObserver', undefined)
    const el = document.createElement('div')
    expect(
      renderHook(() => useElementWidth({ current: el })).result.current,
    ).toBe(0)
  })
})
