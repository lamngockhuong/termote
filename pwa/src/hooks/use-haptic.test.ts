import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as haptic from '../utils/haptic'
import { useHaptic } from './use-haptic'

vi.mock('../utils/haptic', () => ({
  canVibrate: vi.fn(),
  vibrate: vi.fn(),
}))

describe('useHaptic', () => {
  beforeEach(() => {
    vi.mocked(haptic.canVibrate).mockReturnValue(true)
    vi.mocked(haptic.vibrate).mockReset()
  })

  it('returns isSupported from canVibrate', () => {
    vi.mocked(haptic.canVibrate).mockReturnValue(true)
    const { result } = renderHook(() => useHaptic())
    expect(result.current.isSupported).toBe(true)
  })

  it('returns isSupported false when canVibrate is false', () => {
    vi.mocked(haptic.canVibrate).mockReturnValue(false)
    const { result } = renderHook(() => useHaptic())
    expect(result.current.isSupported).toBe(false)
  })

  it('calls vibrate with default pattern "light"', () => {
    const { result } = renderHook(() => useHaptic())
    result.current.trigger()
    expect(haptic.vibrate).toHaveBeenCalledWith('light')
  })

  it('calls vibrate with specified pattern', () => {
    const { result } = renderHook(() => useHaptic())
    result.current.trigger('heavy')
    expect(haptic.vibrate).toHaveBeenCalledWith('heavy')
  })

  it('calls vibrate with medium pattern', () => {
    const { result } = renderHook(() => useHaptic())
    result.current.trigger('medium')
    expect(haptic.vibrate).toHaveBeenCalledWith('medium')
  })

  it('calls vibrate with selection pattern', () => {
    const { result } = renderHook(() => useHaptic())
    result.current.trigger('selection')
    expect(haptic.vibrate).toHaveBeenCalledWith('selection')
  })

  it('does not call vibrate when enabled is false', () => {
    const { result } = renderHook(() => useHaptic({ enabled: false }))
    result.current.trigger()
    expect(haptic.vibrate).not.toHaveBeenCalled()
  })

  it('calls vibrate when enabled is explicitly true', () => {
    const { result } = renderHook(() => useHaptic({ enabled: true }))
    result.current.trigger('medium')
    expect(haptic.vibrate).toHaveBeenCalledWith('medium')
  })
})
