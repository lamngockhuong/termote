import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TourStep } from '../utils/tour-steps'
import { measureAnchor, useAnchorRect } from './use-anchor-rect'

const step: TourStep = {
  id: 's',
  anchors: ['a', 'b'],
  title: 'tour.chipTitle',
  placement: 'bottom',
}

function anchor(name: string, rect: Partial<DOMRect>) {
  const el = document.createElement('div')
  el.dataset.tour = name
  el.getBoundingClientRect = vi.fn(
    () => ({ top: 0, left: 0, width: 0, height: 0, ...rect }) as DOMRect,
  )
  document.body.append(el)
  return el
}

describe('measureAnchor', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads an anchor on screen, and none hidden or missing', () => {
    anchor('a', { top: 1, left: 2, width: 3, height: 4 })
    anchor('z', { width: 0, height: 4 })
    anchor('y', { width: 4, height: 0 })
    expect(measureAnchor('a')).toEqual({ top: 1, left: 2, width: 3, height: 4 })
    expect(measureAnchor('z')).toBeNull()
    expect(measureAnchor('y')).toBeNull()
    expect(measureAnchor('missing')).toBeNull()
  })
})

describe('useAnchorRect', () => {
  // The frames, run by hand
  let frames: FrameRequestCallback[] = []
  const nextFrame = () => act(() => frames.shift()?.(0))
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
      frames.push(cb),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.splice(id - 1, 1)
    })
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('is null without a step', () => {
    const { result } = renderHook(() => useAnchorRect(null))
    expect(result.current).toBeNull()
    expect(frames).toHaveLength(0)
  })

  it('measures again at each frame, keeping the same area as it was', () => {
    const a = anchor('a', { top: 10, left: 10, width: 20, height: 20 })
    const { result, unmount } = renderHook(() => useAnchorRect(step))
    expect(result.current).toEqual({ top: 10, left: 10, width: 20, height: 20 })
    const first = result.current
    nextFrame()
    expect(result.current).toBe(first)
    // Moved, its size the same
    a.getBoundingClientRect = vi.fn(
      () => ({ top: 10, left: 50, width: 20, height: 20 }) as DOMRect,
    )
    nextFrame()
    expect(result.current).toEqual({ top: 10, left: 50, width: 20, height: 20 })
    // Another anchor joins
    anchor('b', { top: 40, left: 50, width: 20, height: 10 })
    nextFrame()
    expect(result.current).toEqual({ top: 10, left: 50, width: 20, height: 40 })
    // Hidden
    a.getBoundingClientRect = vi.fn(
      () => ({ top: 0, left: 0, width: 0, height: 0 }) as DOMRect,
    )
    nextFrame()
    expect(result.current).toBeNull()
    unmount()
    expect(frames).toHaveLength(0)
  })

  it('clears when the step goes', () => {
    anchor('a', { top: 1, left: 1, width: 1, height: 1 })
    const { result, rerender } = renderHook(
      ({ s }: { s: TourStep | null }) => useAnchorRect(s),
      { initialProps: { s: step as TourStep | null } },
    )
    expect(result.current).not.toBeNull()
    rerender({ s: null })
    expect(result.current).toBeNull()
  })
})
