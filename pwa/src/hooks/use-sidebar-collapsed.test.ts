import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSidebarCollapsed } from './use-sidebar-collapsed'

describe('useSidebarCollapsed', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('defaults to expanded (not collapsed)', () => {
    const { result } = renderHook(() => useSidebarCollapsed())
    expect(result.current.isCollapsed).toBe(false)
  })

  it('restores collapsed state from localStorage', () => {
    localStorage.setItem('sidebar-collapsed', 'true')
    const { result } = renderHook(() => useSidebarCollapsed())
    expect(result.current.isCollapsed).toBe(true)
  })

  it('toggles and persists to localStorage', () => {
    const { result } = renderHook(() => useSidebarCollapsed())

    act(() => result.current.toggle())
    expect(result.current.isCollapsed).toBe(true)
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true')

    act(() => result.current.toggle())
    expect(result.current.isCollapsed).toBe(false)
    expect(localStorage.getItem('sidebar-collapsed')).toBe('false')
  })
})
