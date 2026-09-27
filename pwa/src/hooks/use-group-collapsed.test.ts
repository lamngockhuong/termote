import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useGroupCollapsed } from './use-group-collapsed'

describe('useGroupCollapsed', () => {
  beforeEach(() => localStorage.clear())

  it('starts with every group expanded', () => {
    const { result } = renderHook(() => useGroupCollapsed())
    expect(result.current.isCollapsed('w1')).toBe(false)
  })

  it('toggles one group and persists the map', () => {
    const { result } = renderHook(() => useGroupCollapsed())
    act(() => result.current.toggle('w1'))
    expect(result.current.isCollapsed('w1')).toBe(true)
    expect(result.current.isCollapsed('w2')).toBe(false)
    expect(
      JSON.parse(localStorage.getItem('termote-group-collapsed')!),
    ).toEqual({ w1: true })
    act(() => result.current.toggle('w1'))
    expect(result.current.isCollapsed('w1')).toBe(false)
    expect(localStorage.getItem('termote-group-collapsed')).toBe('{}')
  })

  it('restores the saved map', () => {
    localStorage.setItem('termote-group-collapsed', '{"w2":true}')
    const { result } = renderHook(() => useGroupCollapsed())
    expect(result.current.isCollapsed('w2')).toBe(true)
  })

  it('ignores a corrupt saved map', () => {
    localStorage.setItem('termote-group-collapsed', 'not-json')
    const { result } = renderHook(() => useGroupCollapsed())
    expect(result.current.isCollapsed('w2')).toBe(false)
  })

  it('ignores a saved value that is not a map', () => {
    localStorage.setItem('termote-group-collapsed', 'null')
    const { result } = renderHook(() => useGroupCollapsed())
    expect(result.current.isCollapsed('w2')).toBe(false)
  })

  it('does not touch the whole-sidebar collapse key', () => {
    const { result } = renderHook(() => useGroupCollapsed())
    act(() => result.current.toggle('w1'))
    expect(localStorage.getItem('sidebar-collapsed')).toBeNull()
  })
})
