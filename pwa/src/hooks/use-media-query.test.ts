import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useIsMobile, useMediaQuery } from './use-media-query'

describe('useMediaQuery', () => {
  let listeners: Array<(e: MediaQueryListEvent) => void>
  let mockMql: {
    matches: boolean
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    listeners = []
    mockMql = {
      matches: false,
      addEventListener: vi.fn(
        (_event: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners.push(cb)
        },
      ),
      removeEventListener: vi.fn(
        (_event: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners = listeners.filter((l) => l !== cb)
        },
      ),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      mockMql as unknown as MediaQueryList,
    )
  })

  it('returns initial matches value (false)', () => {
    mockMql.matches = false
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(false)
  })

  it('returns initial matches value (true)', () => {
    mockMql.matches = true
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(true)
  })

  it('updates when media query changes', () => {
    mockMql.matches = false
    const { result } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    expect(result.current).toBe(false)

    act(() => {
      for (const l of listeners) l({ matches: true } as MediaQueryListEvent)
    })

    expect(result.current).toBe(true)
  })

  it('removes event listener on unmount', () => {
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 767px)'))
    unmount()
    expect(mockMql.removeEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    )
  })

  it('re-subscribes when query changes', () => {
    const { rerender } = renderHook(({ q }) => useMediaQuery(q), {
      initialProps: { q: '(max-width: 767px)' },
    })
    rerender({ q: '(min-width: 1024px)' })
    expect(mockMql.addEventListener).toHaveBeenCalledTimes(2)
    expect(mockMql.removeEventListener).toHaveBeenCalledTimes(1)
  })
})

describe('useIsMobile', () => {
  beforeEach(() => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList)
  })

  it('calls matchMedia with mobile breakpoint', () => {
    renderHook(() => useIsMobile())
    expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)')
  })

  it('returns false when not mobile', () => {
    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })
})
