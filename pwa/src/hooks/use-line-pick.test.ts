import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLinePick } from './use-line-pick'

const coarse = (on: boolean) =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: on && query === '(pointer: coarse)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )

afterEach(() => vi.restoreAllMocks())

describe('useLinePick', () => {
  it('extends with Shift on a fine pointer', () => {
    coarse(false)
    const { result } = renderHook(() => useLinePick())
    act(() => result.current.press(0, 3, false))
    act(() => result.current.press(0, 6, false))
    expect(result.current.pick).toEqual({ group: 0, a: 6, b: 6 })
    act(() => result.current.press(0, 2, true))
    expect(result.current.pick).toEqual({ group: 0, a: 6, b: 2 })
    act(() => result.current.clear())
    expect(result.current.pick).toBeNull()
  })

  it('extends with a second tap on a touch screen', () => {
    coarse(true)
    const { result } = renderHook(() => useLinePick())
    act(() => result.current.press(0, 3, false))
    act(() => result.current.press(0, 6, false))
    expect(result.current.pick).toEqual({ group: 0, a: 3, b: 6 })
  })
})
