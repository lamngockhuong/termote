import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useFullscreen } from './use-fullscreen'

describe('useFullscreen', () => {
  it('starts not in fullscreen', () => {
    const { result } = renderHook(() => useFullscreen())
    expect(result.current.isFullscreen).toBe(false)
  })

  it('provides toggleFullscreen function', () => {
    const { result } = renderHook(() => useFullscreen())
    expect(typeof result.current.toggleFullscreen).toBe('function')
  })
})
