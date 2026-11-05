import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOW_TICK, useNow } from './use-now'

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-05T10:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  const at = (iso: string) => Date.parse(iso)

  it("is the server's time, read again every tick", () => {
    const { result } = renderHook(() => useNow(5_000))
    expect(result.current).toBe(at('2026-11-05T10:00:05Z'))
    act(() => vi.advanceTimersByTime(NOW_TICK))
    expect(result.current).toBe(at('2026-11-05T10:00:35Z'))
  })

  it('follows a new clock offset at once', () => {
    const { result, rerender } = renderHook(({ offset }) => useNow(offset), {
      initialProps: { offset: 0 },
    })
    rerender({ offset: -60_000 })
    expect(result.current).toBe(at('2026-11-05T09:59:00Z'))
  })

  it('stops reading once unmounted', () => {
    const { unmount } = renderHook(() => useNow(0))
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
