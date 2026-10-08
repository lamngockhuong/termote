import { act, renderHook } from '@testing-library/react'
import type { MouseEvent, PointerEvent } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, LONG_PRESS_SLOP, useLongPress } from './use-long-press'

const pointer = (x: number, y: number, pointerType = 'touch') =>
  ({ clientX: x, clientY: y, pointerType }) as PointerEvent
const mouse = () =>
  ({
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  }) as unknown as MouseEvent & {
    preventDefault: ReturnType<typeof vi.fn>
    stopPropagation: ReturnType<typeof vi.fn>
  }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const fn = vi.fn()
  const h = renderHook(() => useLongPress(fn))
  return { fn, h, on: () => h.result.current }
}

describe('useLongPress', () => {
  it('runs once a finger rests long enough, then swallows the click', () => {
    const { fn, on } = setup()
    on().onPointerDown(pointer(0, 0))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1))
    expect(fn).not.toHaveBeenCalled()
    // A small drift is still a press
    on().onPointerMove(pointer(LONG_PRESS_SLOP, 0))
    act(() => vi.advanceTimersByTime(1))
    expect(fn).toHaveBeenCalledTimes(1)
    const menu = mouse()
    on().onContextMenu(menu)
    expect(menu.preventDefault).toHaveBeenCalled()
    on().onPointerUp()
    const click = mouse()
    on().onClickCapture(click)
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
    // Only that click
    const next = mouse()
    on().onClickCapture(next)
    expect(next.stopPropagation).not.toHaveBeenCalled()
  })

  it('a short tap is a click', () => {
    const { fn, on } = setup()
    on().onPointerDown(pointer(0, 0))
    on().onPointerUp()
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(fn).not.toHaveBeenCalled()
    const click = mouse()
    on().onClickCapture(click)
    expect(click.preventDefault).not.toHaveBeenCalled()
    // No press: the menu is the browser's
    const menu = mouse()
    on().onContextMenu(menu)
    expect(menu.preventDefault).not.toHaveBeenCalled()
  })

  it('moving past the slop cancels, and so do cancel and leave', () => {
    const { fn, on } = setup()
    on().onPointerMove(pointer(50, 50))
    on().onPointerDown(pointer(0, 0))
    on().onPointerMove(pointer(LONG_PRESS_SLOP + 1, 0))
    on().onPointerDown(pointer(0, 0))
    on().onPointerCancel()
    on().onPointerDown(pointer(0, 0))
    on().onPointerLeave()
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(fn).not.toHaveBeenCalled()
  })

  it('a pressing finger keeps the menu shut', () => {
    const { on } = setup()
    on().onPointerDown(pointer(0, 0))
    const menu = mouse()
    on().onContextMenu(menu)
    expect(menu.preventDefault).toHaveBeenCalled()
  })

  it('a mouse never long-presses', () => {
    const { fn, on } = setup()
    on().onPointerDown(pointer(0, 0, 'mouse'))
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(fn).not.toHaveBeenCalled()
  })

  it('unmounting drops a pending press', () => {
    const { fn, h, on } = setup()
    on().onPointerDown(pointer(0, 0))
    h.unmount()
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
    expect(fn).not.toHaveBeenCalled()
  })
})
