import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setFocusWindowForTest } from '../utils/focus-mode'
import { useTaskGroupsCollapsed } from './use-task-groups-collapsed'

const KEY = 'termote-task-groups-collapsed'

describe('useTaskGroupsCollapsed', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => setFocusWindowForTest(false))

  it('starts with every section open', () => {
    const { result } = renderHook(() => useTaskGroupsCollapsed())
    expect(result.current.isCollapsed('script')).toBe(false)
  })

  it('toggles one section and keeps the map', () => {
    const { result } = renderHook(() => useTaskGroupsCollapsed())
    act(() => result.current.toggle('cargo'))
    expect(result.current.isCollapsed('cargo')).toBe(true)
    expect(result.current.isCollapsed('make')).toBe(false)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ cargo: true })
    act(() => result.current.toggle('cargo'))
    expect(result.current.isCollapsed('cargo')).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('{}')
  })

  it('restores the saved map', () => {
    localStorage.setItem(KEY, '{"user":true}')
    const { result } = renderHook(() => useTaskGroupsCollapsed())
    expect(result.current.isCollapsed('user')).toBe(true)
  })

  it.each(['not-json', 'null'])('ignores a bad saved value (%s)', (v) => {
    localStorage.setItem(KEY, v)
    const { result } = renderHook(() => useTaskGroupsCollapsed())
    expect(result.current.isCollapsed('user')).toBe(false)
  })

  it('a focus window folds without keeping it', () => {
    setFocusWindowForTest(true)
    const { result } = renderHook(() => useTaskGroupsCollapsed())
    act(() => result.current.toggle('go'))
    expect(result.current.isCollapsed('go')).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
