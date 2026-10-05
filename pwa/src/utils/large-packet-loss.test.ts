import { describe, expect, it, vi } from 'vitest'
import {
  isTimeoutError,
  onLargePacketLoss,
  reportLargePacketLoss,
} from './large-packet-loss'

describe('large packet loss', () => {
  it('calls each listener until it unsubscribes', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = onLargePacketLoss(a)
    const offB = onLargePacketLoss(b)
    reportLargePacketLoss()
    offA()
    reportLargePacketLoss()
    offB()
    reportLargePacketLoss()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('tells a timed out or aborted fetch from other errors', () => {
    expect(isTimeoutError(new DOMException('t', 'TimeoutError'))).toBe(true)
    expect(isTimeoutError(new DOMException('a', 'AbortError'))).toBe(true)
    expect(isTimeoutError(new DOMException('n', 'NetworkError'))).toBe(false)
    expect(isTimeoutError(new TypeError('Failed to fetch'))).toBe(false)
  })
})
