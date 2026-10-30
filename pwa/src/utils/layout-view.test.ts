import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabLayout } from '../types/session'
import {
  layoutFontFits,
  layoutFontSize,
  layoutViewWanted,
  MAX_LAYOUT_PANES,
  measureCell,
  paneBox,
  REF_FONT_SIZE,
  throttle,
  zoomedPane,
} from './layout-view'

const pane = (id: string, x = 0) => ({ id, x, y: 0, cols: 60, rows: 40 })
const LAYOUT: TabLayout = {
  cols: 120,
  rows: 40,
  zoomed: false,
  panes: [pane('a'), pane('b', 60)],
}
const ON = {
  paneStream: true,
  paneLayout: true,
  mobile: false,
  viewOnly: false,
  setting: true,
  layout: LAYOUT,
}

describe('layoutViewWanted', () => {
  it('is on for a desktop with full rights and a split Herdr tab', () => {
    expect(layoutViewWanted(ON)).toBe(true)
  })

  it.each([
    ['no pane streams', { paneStream: false }],
    ['no pane layout (Windows, old Herdr)', { paneLayout: false }],
    ['a phone', { mobile: true }],
    ['view-only', { viewOnly: true }],
    ['the setting off', { setting: false }],
    ['no layout', { layout: undefined }],
    ['one pane', { layout: { ...LAYOUT, panes: [pane('a')] } }],
    [
      'more panes than the limit',
      {
        layout: {
          ...LAYOUT,
          panes: Array.from({ length: MAX_LAYOUT_PANES + 1 }, (_, i) =>
            pane(`p${i}`),
          ),
        },
      },
    ],
    ['no area', { layout: { ...LAYOUT, cols: 0 } }],
    ['no area rows', { layout: { ...LAYOUT, rows: 0 } }],
  ])('is off with %s', (_, change) => {
    expect(layoutViewWanted({ ...ON, ...change })).toBe(false)
  })

  it(`allows ${MAX_LAYOUT_PANES} panes`, () => {
    const panes = Array.from({ length: MAX_LAYOUT_PANES }, (_, i) =>
      pane(`p${i}`),
    )
    expect(layoutViewWanted({ ...ON, layout: { ...LAYOUT, panes } })).toBe(true)
  })
})

describe('layoutFontFits', () => {
  it('keeps a shown view down to the minimum, and needs a pixel more to show again', () => {
    expect(layoutFontFits(6, 6, true)).toBe(true)
    expect(layoutFontFits(5, 6, true)).toBe(false)
    expect(layoutFontFits(6, 6, false)).toBe(false)
    expect(layoutFontFits(7, 6, false)).toBe(true)
  })
})

describe('layoutFontSize', () => {
  const cell = { width: 60, height: 120 } // at 100px

  it('fits the narrower dimension', () => {
    // width: 1200 / (120 * 60) = 0.166…; height: 800 / (40 * 120) = 0.166…
    expect(
      layoutFontSize(
        { cols: 120, rows: 40 },
        { width: 1200, height: 800 },
        cell,
      ),
    ).toBe(16)
    // Height limits: 400 / 4800
    expect(
      layoutFontSize(
        { cols: 120, rows: 40 },
        { width: 1200, height: 400 },
        cell,
      ),
    ).toBe(8)
  })

  it('is not clamped: a desktop far wider than the window falls below any minimum', () => {
    expect(
      layoutFontSize(
        { cols: 300, rows: 80 },
        { width: 1000, height: 600 },
        cell,
      ),
    ).toBe(5)
  })

  it('is 0 until the cell and the box are measured', () => {
    const area = { cols: 120, rows: 40 }
    expect(
      layoutFontSize(area, { width: 1, height: 1 }, { width: 0, height: 1 }),
    ).toBe(0)
    expect(
      layoutFontSize(area, { width: 1, height: 1 }, { width: 1, height: 0 }),
    ).toBe(0)
    expect(layoutFontSize(area, { width: 0, height: 1 }, cell)).toBe(0)
    expect(layoutFontSize(area, { width: 1, height: 0 }, cell)).toBe(0)
  })
})

describe('paneBox', () => {
  it('places a pane as percentages of the area', () => {
    expect(
      paneBox({ cols: 120, rows: 40 }, { x: 60, y: 10, cols: 60, rows: 30 }),
    ).toEqual({ left: '50%', top: '25%', width: '50%', height: '75%' })
  })
})

describe('zoomedPane', () => {
  it('is the zoomed pane of a zoomed layout that lists it', () => {
    expect(zoomedPane({ ...LAYOUT, zoomed: true, zoomedPaneId: 'b' })).toBe('b')
    expect(zoomedPane({ ...LAYOUT, zoomed: true, zoomedPaneId: 'x' })).toBe(
      undefined,
    )
    expect(zoomedPane({ ...LAYOUT, zoomed: true })).toBe(undefined)
    expect(zoomedPane({ ...LAYOUT, zoomedPaneId: 'b' })).toBe(undefined)
    expect(zoomedPane(undefined)).toBe(undefined)
  })
})

describe('throttle', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs at once, then once more at the end of the wait for the calls in between', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const call = throttle(fn, 250)
    call()
    expect(fn).toHaveBeenCalledTimes(1)
    call()
    call()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(2)
    // The trailing call started another wait, with nothing in it
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(2)
    // Quiet: the next call runs at once again
    call()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('cancel drops the trailing call', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const call = throttle(fn, 250)
    call()
    call()
    call.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).toHaveBeenCalledTimes(1)
    call()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('measureCell', () => {
  it('measures a run of W at the reference size in the font, and removes it', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        expect(this.style.fontFamily).toBe('Mono')
        expect(this.style.fontSize).toBe(`${REF_FONT_SIZE}px`)
        return { width: 32 * 60, height: 117 } as DOMRect
      })
    expect(measureCell('Mono')).toEqual({ width: 60, height: 117 })
    expect(document.body.querySelector('span')).toBeNull()
    rect.mockRestore()
  })
})
