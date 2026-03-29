import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useFontSize } from './use-font-size'

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
