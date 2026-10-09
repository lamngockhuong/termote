import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Size } from '../utils/zoom-pan'
import { SETTLE_MS, useZoomPan } from './use-zoom-pan'

// The stage's size, read through clientWidth/clientHeight
let stageSize = { width: 400, height: 300 }
let resize: (() => void) | null = null

type Api = ReturnType<typeof useZoomPan>
let api: Api

function Stage({ img }: { img: Size }) {
  const ref = useRef<HTMLDivElement>(null)
  api = useZoomPan(ref, img)
  return <div ref={ref} data-testid="stage" />
}

const big = { width: 1600, height: 600 }

function setup(img: Size = big) {
  const view = render(<Stage img={img} />)
  const stage = view.getByTestId('stage')
  return { ...view, stage }
}

let id = 0
const down = (el: Element, x: number, y: number, pointerId = 1) =>
  fireEvent.pointerDown(el, { pointerId, clientX: x, clientY: y })
const move = (el: Element, x: number, y: number, pointerId = 1) =>
  fireEvent.pointerMove(el, { pointerId, clientX: x, clientY: y })
const up = (el: Element, x: number, y: number, pointerId = 1) =>
  fireEvent.pointerUp(el, { pointerId, clientX: x, clientY: y })
const tap = (el: Element, x: number, y: number) => {
  id++
  down(el, x, y, id)
  up(el, x, y, id)
}

// The time of every event, moved on by the tests
let now = 1000

beforeEach(() => {
  now = 1000
  vi.spyOn(Event.prototype, 'timeStamp', 'get').mockImplementation(() => now)
  stageSize = { width: 400, height: 300 }
  resize = null
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    () => stageSize.width,
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => stageSize.height,
  )
  HTMLElement.prototype.setPointerCapture = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
      observe() {
        resize = () => this.cb()
      }
      disconnect() {
        resize = null
      }
    },
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useZoomPan', () => {
  it('starts fitted and centred', () => {
    setup()
    expect(api.view).toEqual({ scale: 0.25, x: 0, y: 75 })
    expect(api.box).toEqual(stageSize)
    expect(api.zoom).toBe(1)
    expect(api.settled).toBe(true)
  })

  it('waits for a stage with a size', () => {
    stageSize = { width: 0, height: 0 }
    setup()
    expect(api.view).toBeNull()
    expect(api.zoom).toBe(1)
    act(() => api.zoomBy(2))
    expect(api.view).toBeNull()
  })

  it('zooms with the buttons around the middle, within the limits, and back to fit', () => {
    setup()
    act(() => api.zoomBy(2))
    expect(api.zoom).toBe(2)
    act(() => api.zoomBy(100))
    expect(api.zoom).toBe(8)
    act(() => api.reset())
    expect(api.view).toEqual({ scale: 0.25, x: 0, y: 75 })
  })

  it('zooms with the wheel around the cursor, never scrolling the page', () => {
    vi.useFakeTimers()
    const { stage } = setup()
    const ev = new WheelEvent('wheel', {
      deltaY: -200,
      clientX: 0,
      clientY: 75,
      cancelable: true,
    })
    act(() => {
      stage.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(api.zoom).toBeGreaterThan(1)
    // The left edge was under the cursor: it stays there; the image is
    // still lower than the box, so it stays centred up and down
    const v = api.view as NonNullable<Api['view']>
    expect(v.x).toBeCloseTo(0)
    expect(v.y).toBeCloseTo((300 - 600 * v.scale) / 2)
    expect(api.settled).toBe(false)
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(api.settled).toBe(true)
  })

  it('a finger resting on the screen has not ended the gesture', () => {
    vi.useFakeTimers()
    const { stage } = setup()
    down(stage, 100, 100)
    move(stage, 120, 100)
    act(() => vi.advanceTimersByTime(SETTLE_MS * 4))
    expect(api.settled).toBe(false)
    up(stage, 120, 100)
    expect(api.settled).toBe(false)
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(api.settled).toBe(true)
  })

  it('a cancelled press is no tap', () => {
    const { stage } = setup()
    tap(stage, 200, 150)
    down(stage, 200, 150, 50)
    fireEvent.pointerCancel(stage, {
      pointerId: 50,
      clientX: 200,
      clientY: 150,
    })
    expect(api.zoom).toBe(1)
  })

  it('drags with one pointer, keeping the image on screen', () => {
    const { stage } = setup()
    act(() => api.zoomBy(4))
    const before = api.view as NonNullable<Api['view']>
    down(stage, 100, 100)
    expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalledWith(1)
    move(stage, 150, 80)
    expect(api.view).toEqual({
      scale: before.scale,
      x: before.x + 50,
      y: before.y - 20,
    })
    // Far past the edge: stops at it
    move(stage, 5000, 80)
    expect(api.view?.x).toBe(0)
    up(stage, 5000, 80)
  })

  it('pinches with two pointers around their midpoint', () => {
    const { stage } = setup()
    down(stage, 150, 150, 1)
    down(stage, 250, 150, 2)
    move(stage, 300, 150, 2)
    // 100px apart, then 150: 1.5 times the scale
    expect(api.zoom).toBeCloseTo(1.5)
    move(stage, 100, 150, 1)
    // Then 200
    expect(api.zoom).toBeCloseTo(2)
    up(stage, 100, 150, 1)
    up(stage, 300, 150, 2)
  })

  it('a pinch with both pointers at one place changes nothing', () => {
    const { stage } = setup()
    down(stage, 150, 150, 1)
    down(stage, 150, 150, 2)
    move(stage, 150, 150, 2)
    expect(api.zoom).toBe(1)
  })

  it('a double tap zooms to 2× and back to fit', () => {
    const { stage } = setup()
    tap(stage, 200, 150)
    expect(api.zoom).toBe(1)
    tap(stage, 202, 151)
    expect(api.zoom).toBe(2)
    tap(stage, 200, 150)
    tap(stage, 200, 150)
    expect(api.zoom).toBe(1)
  })

  it('taps far apart, a drag or a slow second tap are no double tap', () => {
    const { stage } = setup()
    tap(stage, 10, 150)
    tap(stage, 300, 150)
    expect(api.zoom).toBe(1)
    // A drag ends no tap
    down(stage, 300, 150, 9)
    move(stage, 340, 150, 9)
    up(stage, 340, 150, 9)
    tap(stage, 340, 150)
    expect(api.zoom).toBe(1)
    // Too late after the first
    now += 301
    tap(stage, 340, 150)
    expect(api.zoom).toBe(1)
    now += 300
    tap(stage, 340, 150)
    expect(api.zoom).toBe(2)
  })

  it('a lift while another pointer is down is no tap', () => {
    const { stage } = setup()
    down(stage, 100, 100, 1)
    down(stage, 200, 100, 2)
    up(stage, 200, 100, 2)
    up(stage, 100, 100, 1)
    tap(stage, 100, 100)
    expect(api.zoom).toBe(1)
  })

  it('ignores pointers it never saw go down, and handles pointercancel', () => {
    const { stage } = setup()
    move(stage, 10, 10, 7)
    up(stage, 10, 10, 7)
    expect(api.zoom).toBe(1)
    act(() => api.zoomBy(4))
    const before = api.view
    down(stage, 100, 100)
    fireEvent.pointerCancel(stage, { pointerId: 1, clientX: 100, clientY: 100 })
    move(stage, 150, 100)
    expect(api.view).toEqual(before)
  })

  it('stops Safari’s own pinch', () => {
    const { stage } = setup()
    for (const type of ['gesturestart', 'gesturechange']) {
      const ev = new Event(type, { cancelable: true })
      stage.dispatchEvent(ev)
      expect(ev.defaultPrevented).toBe(true)
    }
  })

  it('a new stage size keeps the zoom relative to fit', () => {
    setup()
    act(() => api.zoomBy(2))
    stageSize = { width: 800, height: 600 }
    act(() => resize?.())
    expect(api.box).toEqual(stageSize)
    expect(api.zoom).toBeCloseTo(2)
    expect(api.view?.scale).toBeCloseTo(1)
  })

  it('a new object of the same size changes nothing', () => {
    const view = setup()
    act(() => api.zoomBy(2))
    view.rerender(<Stage img={{ ...big }} />)
    expect(api.zoom).toBe(2)
  })

  it('works without ResizeObserver, and stops listening once gone', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('ResizeObserver', undefined)
    const view = setup()
    expect(api.zoom).toBe(1)
    view.unmount()
  })

  it('disconnects its observer once gone', () => {
    const view = setup()
    view.unmount()
    expect(resize).toBeNull()
  })
})
