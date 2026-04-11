import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme } from './theme-context'

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>
}

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('light', 'dark')
  })

  it('defaults to system theme', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.theme).toBe('system')
    // resolvedTheme depends on matchMedia mock (jsdom defaults to no preference = light)
    expect(['light', 'dark']).toContain(result.current.resolvedTheme)
  })

  it('restores theme from localStorage', () => {
    localStorage.setItem('termote-theme', 'light')
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.theme).toBe('light')
    expect(result.current.resolvedTheme).toBe('light')
  })

  it('sets theme and applies class to html element', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => result.current.setTheme('dark'))

    expect(result.current.theme).toBe('dark')
    expect(result.current.resolvedTheme).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('persists theme to localStorage', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    act(() => result.current.setTheme('light'))

    expect(localStorage.getItem('termote-theme')).toBe('light')
  })

  it('switches between themes correctly', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })

    act(() => result.current.setTheme('light'))
    expect(document.documentElement.classList.contains('light')).toBe(true)

    act(() => result.current.setTheme('dark'))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.classList.contains('light')).toBe(false)
  })

  it('throws when useTheme is used outside provider', () => {
    expect(() => {
      renderHook(() => useTheme())
    }).toThrow('useTheme must be used within ThemeProvider')
  })

  it('getSystemTheme returns dark when matchMedia matches dark preference', () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
    const { result } = renderHook(() => useTheme(), { wrapper })
    window.matchMedia = originalMatchMedia
    expect(result.current.resolvedTheme).toBe('dark')
  })

  it('updates resolvedTheme when system prefers dark (matchMedia change event)', () => {
    // Capture the change handler from matchMedia addEventListener
    let capturedHandler: ((e: MediaQueryListEvent) => void) | null = null
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => {
      return {
        matches: false,
        media: query,
        addEventListener: vi.fn(
          (_type: string, handler: (e: MediaQueryListEvent) => void) => {
            capturedHandler = handler
          },
        ),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }
    })

    const { result } = renderHook(() => useTheme(), { wrapper })

    // Simulate system theme change to dark (e.matches = true → 'dark')
    if (capturedHandler) {
      act(() => {
        capturedHandler!({ matches: true } as MediaQueryListEvent)
      })
    }

    window.matchMedia = originalMatchMedia
    expect(result.current.resolvedTheme).toBe('dark')
  })

  it('setSystemTheme sets light when matchMedia change event has matches=false', () => {
    let capturedHandler: ((e: MediaQueryListEvent) => void) | null = null
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true, // start as dark
      media: query,
      addEventListener: vi.fn(
        (_type: string, handler: (e: MediaQueryListEvent) => void) => {
          capturedHandler = handler
        },
      ),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))

    const { result } = renderHook(() => useTheme(), { wrapper })

    // Fire handler with matches=false → setSystemTheme('light')
    if (capturedHandler) {
      act(() => {
        capturedHandler!({ matches: false } as MediaQueryListEvent)
      })
    }

    window.matchMedia = originalMatchMedia
    expect(result.current.resolvedTheme).toBe('light')
  })
})
