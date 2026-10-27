import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  lineToOffset,
  offsetToLine,
  orderAnchors,
  type SyncSide,
  useScrollSync,
} from './use-scroll-sync'

describe('orderAnchors', () => {
  it('sorts by line, keeping the first of a line and only ones further down', () => {
    expect(
      orderAnchors([
        { line: 9, top: 300 },
        { line: 1, top: 0 },
        { line: 4, top: 100 },
        { line: 4, top: 150 },
        // Laid out above line 4: dropped
        { line: 6, top: 50 },
        { line: 7, top: 100 },
      ]),
    ).toEqual([
      { line: 1, top: 0 },
      { line: 4, top: 100 },
      { line: 7, top: 100 },
      { line: 9, top: 300 },
    ])
  })
})

describe('lineToOffset and offsetToLine', () => {
  const anchors = [
    { line: 1, top: 0 },
    { line: 11, top: 200 },
    { line: 21, top: 300 },
  ]

  it('interpolate between the anchors around a line', () => {
    expect(lineToOffset(anchors, 11)).toBe(200)
    expect(lineToOffset(anchors, 6)).toBe(100)
    expect(lineToOffset(anchors, 16)).toBe(250)
    expect(offsetToLine(anchors, 100)).toBe(6)
    expect(offsetToLine(anchors, 250)).toBe(16)
    expect(offsetToLine(anchors, 200)).toBe(11)
  })

  it('stay at the first anchor before it and the last after it', () => {
    const late = [
      { line: 5, top: 40 },
      { line: 9, top: 80 },
    ]
    expect(lineToOffset(late, 2)).toBe(40)
    expect(lineToOffset(late, 30)).toBe(80)
    expect(offsetToLine(late, 10)).toBe(5)
    expect(offsetToLine(late, 900)).toBe(9)
  })

  it('two anchors at the same height go to the later line', () => {
    const same = [
      { line: 1, top: 0 },
      { line: 3, top: 50 },
      { line: 5, top: 50 },
      { line: 9, top: 90 },
    ]
    expect(offsetToLine(same, 50)).toBe(5)
    expect(offsetToLine(same, 70)).toBe(7)
  })

  it('without anchors, the top and line 1', () => {
    expect(lineToOffset([], 7)).toBe(0)
    expect(offsetToLine([], 70)).toBe(1)
  })
})

// A side whose line at the top is its offset over 10
function side(): SyncSide & { el: HTMLElement } {
  const el = document.createElement('div')
  el.append(document.createElement('div'))
  return {
    el,
    topLine: () => el.scrollTop / 10 + 1,
    scrollToLine: vi.fn((line: number) => {
      el.scrollTop = (line - 1) * 10
    }),
  }
}

const frame = () =>
  new Promise<void>((done) => requestAnimationFrame(() => done()))

describe('useScrollSync', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('puts the preview at the editor line, then follows whichever is scrolled', async () => {
    const editor = side()
    const preview = side()
    editor.el.scrollTop = 40
    const { unmount } = renderHook(() => useScrollSync(editor, preview))
    expect(preview.scrollToLine).toHaveBeenLastCalledWith(5)
    expect(preview.el.scrollTop).toBe(40)

    editor.el.scrollTop = 120
    editor.el.dispatchEvent(new Event('scroll'))
    // Once a frame
    editor.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(preview.scrollToLine).toHaveBeenCalledTimes(2)
    expect(preview.el.scrollTop).toBe(120)

    preview.el.scrollTop = 200
    preview.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(editor.scrollToLine).toHaveBeenLastCalledWith(21)
    expect(editor.el.scrollTop).toBe(200)

    unmount()
    editor.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(preview.scrollToLine).toHaveBeenCalledTimes(2)
  })

  it('takes a scroll it caused, or one a step from it, as its own', async () => {
    const editor = side()
    const preview = side()
    renderHook(() => useScrollSync(editor, preview))
    editor.el.scrollTop = 100
    editor.el.dispatchEvent(new Event('scroll'))
    await frame()
    // The preview's scroll events for that move, then a measure nudging it
    preview.el.dispatchEvent(new Event('scroll'))
    preview.el.scrollTop = 101
    preview.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(editor.scrollToLine).not.toHaveBeenCalled()
    // Then the user scrolls it
    preview.el.scrollTop = 300
    preview.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(editor.scrollToLine).toHaveBeenCalledWith(31)
  })

  it('puts the preview back at the editor line when it is laid out again', () => {
    let resized = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe = observe
        disconnect = disconnect
      },
    )
    const editor = side()
    const preview = side()
    const { unmount } = renderHook(() => useScrollSync(editor, preview))
    expect(observe).toHaveBeenCalledWith(preview.el.firstElementChild)
    editor.el.scrollTop = 70
    preview.el.scrollTop = 0
    resized()
    expect(preview.el.scrollTop).toBe(70)
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('when laid out again, keeps the side last scrolled where it is, until the editor is typed in', async () => {
    let resized = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resized = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    const editor = side()
    const preview = side()
    renderHook(() => useScrollSync(editor, preview))
    preview.el.scrollTop = 300
    preview.el.dispatchEvent(new Event('scroll'))
    await frame()
    expect(editor.el.scrollTop).toBe(300)
    // A diagram drawn: the preview stays, the editor follows it
    editor.el.scrollTop = 100
    resized()
    expect(preview.el.scrollTop).toBe(300)
    expect(editor.el.scrollTop).toBe(300)
    // Typed in the editor: the preview follows it again
    editor.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    editor.el.scrollTop = 50
    resized()
    expect(preview.el.scrollTop).toBe(50)
  })

  it('starts from the preview when told to lead from it', () => {
    const editor = side()
    const preview = side()
    preview.el.scrollTop = 80
    renderHook(() => useScrollSync(editor, preview, 'preview'))
    expect(editor.scrollToLine).toHaveBeenCalledWith(9)
    expect(preview.scrollToLine).not.toHaveBeenCalled()
  })

  it('watches the preview itself when it has no content yet', () => {
    const observe = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe
        disconnect() {}
      },
    )
    const preview = side()
    preview.el.replaceChildren()
    renderHook(() => useScrollSync(side(), preview))
    expect(observe).toHaveBeenCalledWith(preview.el)
  })

  it('does nothing while a side is missing', () => {
    const preview = side()
    renderHook(() => useScrollSync(null, preview))
    expect(preview.scrollToLine).not.toHaveBeenCalled()
  })
})
