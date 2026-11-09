import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readStoredFontSize,
  resolveFontSize,
  setStoredFontSize,
  useFontSize,
} from './use-font-size'

describe('useFontSize', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns default font size of 14', () => {
    const { result } = renderHook(() => useFontSize())
    expect(result.current.fontSize).toBe(14)
  })

  it('restores saved font size from localStorage', () => {
    localStorage.setItem('terminal-font-size', '18')
    const { result } = renderHook(() => useFontSize())
    expect(result.current.fontSize).toBe(18)
  })

  it('falls back to default for invalid localStorage value', () => {
    localStorage.setItem('terminal-font-size', 'invalid')
    const { result } = renderHook(() => useFontSize())
    expect(result.current.fontSize).toBe(14)
  })

  it('falls back to default for out-of-range value', () => {
    localStorage.setItem('terminal-font-size', '100')
    const { result } = renderHook(() => useFontSize())
    expect(result.current.fontSize).toBe(14)
  })

  it('increases font size by 2', () => {
    const { result } = renderHook(() => useFontSize())
    act(() => result.current.increase())
    expect(result.current.fontSize).toBe(16)
    expect(localStorage.getItem('terminal-font-size')).toBe('16')
  })

  it('decreases font size by 2', () => {
    const { result } = renderHook(() => useFontSize())
    act(() => result.current.decrease())
    expect(result.current.fontSize).toBe(12)
  })

  it('clamps at max size 24', () => {
    localStorage.setItem('terminal-font-size', '24')
    const { result } = renderHook(() => useFontSize())
    act(() => result.current.increase())
    expect(result.current.fontSize).toBe(24)
  })

  it('clamps at min size 6', () => {
    localStorage.setItem('terminal-font-size', '6')
    const { result } = renderHook(() => useFontSize())
    act(() => result.current.decrease())
    expect(result.current.fontSize).toBe(6)
  })

  it('resets to default', () => {
    const { result } = renderHook(() => useFontSize())
    act(() => result.current.increase())
    act(() => result.current.increase())
    expect(result.current.fontSize).toBe(18)

    act(() => result.current.reset())
    expect(result.current.fontSize).toBe(14)
    expect(localStorage.getItem('terminal-font-size')).toBe('14')
  })
})

describe('font size store', () => {
  beforeEach(() => localStorage.clear())

  it('follows a size another tab saved', () => {
    const { result } = renderHook(() => useFontSize())
    localStorage.setItem('terminal-font-size', '20')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other' }))
    })
    expect(result.current.fontSize).toBe(14)
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'terminal-font-size' }),
      )
    })
    expect(result.current.fontSize).toBe(20)
    act(() => setStoredFontSize(8))
    expect(result.current.fontSize).toBe(8)
  })

  it('keeps whole numbers in range only', () => {
    expect(resolveFontSize(12)).toBe(12)
    expect(resolveFontSize('12')).toBe(12)
    expect(resolveFontSize('')).toBe(14)
    expect(resolveFontSize(12.5)).toBe(14)
    expect(resolveFontSize(null)).toBe(14)
  })

  it('works with storage blocked', () => {
    const get = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    const set = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    try {
      expect(readStoredFontSize()).toBe(14)
      expect(() => setStoredFontSize(20)).not.toThrow()
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })
})

it('keeps listening while another view still shows the size', () => {
  localStorage.clear()
  const a = renderHook(() => useFontSize())
  const b = renderHook(() => useFontSize())
  a.unmount()
  localStorage.setItem('terminal-font-size', '22')
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
  })
  expect(b.result.current.fontSize).toBe(22)
  b.unmount()
})
