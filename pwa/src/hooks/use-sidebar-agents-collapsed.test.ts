import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSidebarAgentsCollapsed } from './use-sidebar-agents-collapsed'

describe('useSidebarAgentsCollapsed', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('starts open, and toggles and keeps the choice', () => {
    const { result } = renderHook(() => useSidebarAgentsCollapsed())
    expect(result.current.isCollapsed).toBe(false)
    act(() => result.current.toggle())
    expect(result.current.isCollapsed).toBe(true)
    expect(localStorage.getItem('sidebar-agents-collapsed')).toBe('true')
    act(() => result.current.toggle())
    expect(localStorage.getItem('sidebar-agents-collapsed')).toBe('false')
  })

  it('restores a saved choice', () => {
    localStorage.setItem('sidebar-agents-collapsed', 'true')
    const { result } = renderHook(() => useSidebarAgentsCollapsed())
    expect(result.current.isCollapsed).toBe(true)
  })

  it('works on without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { result } = renderHook(() => useSidebarAgentsCollapsed())
    expect(result.current.isCollapsed).toBe(false)
    act(() => result.current.toggle())
    expect(result.current.isCollapsed).toBe(true)
  })
})
