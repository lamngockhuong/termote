import { beforeEach, describe, expect, it, vi } from 'vitest'
import { canVibrate, vibrate } from './haptic'

describe('canVibrate', () => {
  it('returns true when navigator.vibrate is available', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    })
    expect(canVibrate()).toBe(true)
  })

  it('returns false when navigator.vibrate is not available', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
    // Delete the property so `'vibrate' in navigator` returns false
    Reflect.deleteProperty(navigator, 'vibrate')
    expect(canVibrate()).toBe(false)
    // Restore
    if (original) {
      Object.defineProperty(navigator, 'vibrate', original)
    }
  })
})

describe('vibrate', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'vibrate', {
      value: vi.fn(),
      writable: true,
      configurable: true,
    })
  })

  it('calls navigator.vibrate with light pattern (10) by default', () => {
    vibrate()
    expect(navigator.vibrate).toHaveBeenCalledWith(10)
  })

  it('calls navigator.vibrate with light pattern (10)', () => {
    vibrate('light')
    expect(navigator.vibrate).toHaveBeenCalledWith(10)
  })

  it('calls navigator.vibrate with medium pattern (25)', () => {
    vibrate('medium')
    expect(navigator.vibrate).toHaveBeenCalledWith(25)
  })

  it('calls navigator.vibrate with heavy pattern (50)', () => {
    vibrate('heavy')
    expect(navigator.vibrate).toHaveBeenCalledWith(50)
  })

  it('calls navigator.vibrate with selection pattern ([10, 30, 10])', () => {
    vibrate('selection')
    expect(navigator.vibrate).toHaveBeenCalledWith([10, 30, 10])
  })

  it('does nothing when navigator.vibrate is not available', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
    Reflect.deleteProperty(navigator, 'vibrate')
    // Should not throw
    expect(() => vibrate('light')).not.toThrow()
    if (original) {
      Object.defineProperty(navigator, 'vibrate', original)
    }
  })

  it('silently catches errors thrown by navigator.vibrate', () => {
    Object.defineProperty(navigator, 'vibrate', {
      value: () => { throw new Error('vibrate error') },
      writable: true,
      configurable: true,
    })
    expect(() => vibrate('light')).not.toThrow()
  })
})
