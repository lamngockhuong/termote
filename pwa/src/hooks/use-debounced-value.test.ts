import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDebouncedValue } from './use-debounced-value'

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts with the value, then follows it once it stops changing', () => {
    const { result, rerender } = renderHook(
      ({ v, ms }) => useDebouncedValue(v, ms),
      { initialProps: { v: 'a', ms: 250 } },
    )
    expect(result.current).toBe('a')
    rerender({ v: 'b', ms: 250 })
    act(() => vi.advanceTimersByTime(200))
    rerender({ v: 'c', ms: 250 })
    act(() => vi.advanceTimersByTime(200))
    // Each change starts the wait again
    expect(result.current).toBe('a')
    act(() => vi.advanceTimersByTime(50))
    expect(result.current).toBe('c')
  })
})
