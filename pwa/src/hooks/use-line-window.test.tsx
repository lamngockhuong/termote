import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { type RefObject, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCK_LINES, type LineWindow, useLineWindow } from './use-line-window'

// A layout jsdom does not have: the frame is VIEW px tall at the top of the
// page, a row ROW px, a block as tall as its rows unless set in tall, and
// shift moves every row down (a layout change above them)
const VIEW = 400
const ROW = 19.2
let tall: Record<number, number> = {}
let shift = 0

function rect(top: number, height: number) {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }
}

// ResizeObservers made, each with what it watches; deliver calls one back
class FakeResizeObserver {
  static made: FakeResizeObserver[] = []
  watched = new Set<Element>()
  constructor(public callback: (entries: ResizeObserverEntry[]) => void) {
    FakeResizeObserver.made.push(this)
  }
  observe(el: Element) {
    this.watched.add(el)
  }
  unobserve(el: Element) {
    this.watched.delete(el)
  }
  disconnect() {
    this.watched.clear()
  }
}
const deliver = (ro: FakeResizeObserver, targets: Element[]) =>
  act(() =>
    ro.callback(targets.map((target) => ({ target }) as ResizeObserverEntry)),
  )
// The observer of the frame (made first) and that of the blocks
const frameObserver = () => FakeResizeObserver.made[0]
const blockObserver = () => FakeResizeObserver.made.at(-1) as FakeResizeObserver

let api: RefObject<LineWindow | null>

function Window({
  lines,
  wrap = false,
  enabled = true,
}: {
  lines: string[]
  wrap?: boolean
  enabled?: boolean
}) {
  const frame = useRef<HTMLDivElement>(null)
  const win = useLineWindow(frame, lines, wrap, enabled)
  api = { current: win }
  const blocks = []
  if (win) {
    for (let b = win.first; b <= win.last; b++) {
      const rows = []
      const end = Math.min(lines.length, (b + 1) * BLOCK_LINES)
      for (let i = b * BLOCK_LINES; i < end; i++) {
        rows.push(<div key={i} data-line={i + 1} />)
      }
      blocks.push(
        <div key={b} data-block={b} ref={win.measure(b)}>
          {rows}
        </div>,
      )
    }
  }
  return (
    <div ref={frame} data-testid="frame">
      {win && (
        <>
          <div data-testid="before" style={{ height: win.before }} />
          {blocks}
          <div data-testid="after" style={{ height: win.after }} />
        </>
      )}
    </div>
  )
}

const numbered = (n: number, text = 'x') =>
  Array.from({ length: n }, () => text)
const frame = () => screen.getByTestId('frame')
const block = (b: number) =>
  frame().querySelector(`[data-block="${b}"]`) as HTMLElement
const shown = () =>
  [...frame().querySelectorAll<HTMLElement>('[data-block]')].map((e) =>
    Number(e.dataset.block),
  )
const height = (id: string) =>
  Number.parseFloat(screen.getByTestId(id).style.height)

beforeEach(() => {
  tall = {}
  shift = 0
  FakeResizeObserver.made = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      if (this.dataset.testid === 'frame') return rect(0, VIEW)
      if (this.dataset.block !== undefined) {
        const b = Number(this.dataset.block)
        return rect(0, tall[b] ?? this.children.length * ROW)
      }
      const line = Number(this.dataset.line)
      const scroll = (this.closest('[data-testid="frame"]') as HTMLElement)
        .scrollTop
      return rect((line - 1) * ROW + shift - scroll, ROW)
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useLineWindow', () => {
  it('is off when not enabled, or with no lines', () => {
    render(<Window lines={numbered(5000)} enabled={false} />)
    expect(api.current).toBeNull()
    cleanup()
    render(<Window lines={[]} />)
    expect(api.current).toBeNull()
  })

  it('puts the first block in the page, the rest as space below', () => {
    render(<Window lines={numbered(1000)} />)
    expect(shown()).toEqual([0])
    expect(height('before')).toBe(0)
    expect(height('after')).toBeCloseTo(800 * ROW)
  })

  it('follows the scroll a frame later, one update for several scrolls', async () => {
    render(<Window lines={numbered(5000)} />)
    Object.defineProperty(frame(), 'clientHeight', { value: VIEW })
    frame().scrollTop = 2000 * ROW
    fireEvent.scroll(frame())
    fireEvent.scroll(frame())
    await act(() => new Promise((r) => requestAnimationFrame(r)))
    // A view's height above and below the view
    expect(shown()).toEqual([9, 10])
    expect(height('before')).toBeCloseTo(9 * BLOCK_LINES * ROW)
  })

  it('reveals the block of a line, unless it is in the page already', () => {
    render(<Window lines={numbered(5000)} />)
    act(() => api.current?.reveal(150))
    expect(shown()).toEqual([0])
    act(() => api.current?.reveal(4000))
    expect(shown()).toEqual([18, 19, 20])
    act(() => api.current?.reveal(0))
    expect(shown()).toEqual([18, 19, 20])
  })

  it('syncs the window to a scroll made from outside', () => {
    render(<Window lines={numbered(5000)} />)
    Object.defineProperty(frame(), 'clientHeight', { value: VIEW })
    frame().scrollTop = 4000 * ROW
    act(() => api.current?.sync())
    expect(shown()).toContain(20)
  })

  describe('with ResizeObserver', () => {
    beforeEach(() => vi.stubGlobal('ResizeObserver', FakeResizeObserver))

    it('watches the blocks in the page, and lets go of those it drops', () => {
      const view = render(<Window lines={numbered(5000)} />)
      expect([...blockObserver().watched]).toEqual([block(0)])
      act(() => api.current?.reveal(4000))
      expect([...blockObserver().watched]).toHaveLength(3)
      expect(blockObserver().watched.has(block(19))).toBe(true)
      view.unmount()
      expect(blockObserver().watched.size).toBe(0)
      expect(frameObserver().watched.size).toBe(0)
    })

    it('renders measured heights, and learns a row from a full block', () => {
      render(<Window lines={numbered(1000)} />)
      const after = height('after')
      tall = { 0: BLOCK_LINES * 19 }
      deliver(blockObserver(), [block(0)])
      // The four blocks below are estimated with the row measured
      expect(height('after')).toBeCloseTo(800 * 19)
      expect(height('after')).not.toBeCloseTo(after)
    })

    it('learns no row height from the short last block', () => {
      render(<Window lines={numbered(1050)} />)
      act(() => api.current?.reveal(1050))
      tall = { 5: 50 * 25 }
      deliver(blockObserver(), [block(5)])
      // Back at the top: blocks 1 to 4 still at the default row, block 5
      // as measured
      expect(height('after')).toBeCloseTo(4 * BLOCK_LINES * ROW + 50 * 25)
    })

    it('skips what is not a block, has no height, or is as measured', () => {
      render(<Window lines={numbered(1000)} />)
      const after = height('after')
      tall = { 0: 0 }
      deliver(blockObserver(), [frame(), block(0)])
      expect(height('after')).toBe(after)
      tall = { 0: BLOCK_LINES * 19 }
      deliver(blockObserver(), [block(0)])
      const measured = height('after')
      deliver(blockObserver(), [block(0)])
      expect(height('after')).toBe(measured)
    })

    it('estimates wrapped lines from the frame width once it is known', () => {
      const lines = numbered(1000, 'y'.repeat(300))
      render(<Window lines={lines} wrap />)
      // Width unknown: a row a line
      expect(height('after')).toBeCloseTo(800 * ROW)
      Object.defineProperty(frame(), 'clientWidth', { value: 400 })
      deliver(frameObserver(), [frame()])
      // 300 characters in (400 - gutter) / 7.2 a row: several rows a line
      expect(height('after')).toBeGreaterThan(3 * 800 * ROW)
      // A wrapped block measured teaches no row height
      tall = { 0: 5000 }
      deliver(blockObserver(), [block(0)])
      expect(height('after')).toBeGreaterThan(3 * 800 * ROW)
    })

    it('keeps the line at the top of the view where it was when a render moves it', () => {
      render(<Window lines={numbered(1000)} />)
      frame().scrollTop = 100
      fireEvent.scroll(frame())
      // A measure moves every row 50 px down in the content: the view follows
      shift = 50
      tall = { 0: BLOCK_LINES * 19 }
      deliver(blockObserver(), [block(0)])
      expect(frame().scrollTop).toBe(150)
      // A scroll alone is never undone
      frame().scrollTop = 300
      tall = { 0: BLOCK_LINES * 18 }
      deliver(blockObserver(), [block(0)])
      expect(frame().scrollTop).toBe(300)
    })

    it('lets the anchor go when its line has left the page', () => {
      render(<Window lines={numbered(5000)} />)
      frame().scrollTop = 0
      fireEvent.scroll(frame())
      act(() => api.current?.reveal(4000))
      expect(frame().querySelector('[data-line="1"]')).toBeNull()
      expect(frame().scrollTop).toBe(0)
    })
  })
})
