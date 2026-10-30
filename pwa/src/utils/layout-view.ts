// Layout view: a Herdr tab's panes side by side, as the desktop shows them.
// Each pane is its own terminal, placed at its rect and drawn at one font
// size for the whole tab, so the tab's area fits the space on screen.

import type { TabLayout } from '../types/session'

// More panes than this show one at a time (the pane strip): each one is a
// stream, and the server holds 16 on Herdr.
export const MAX_LAYOUT_PANES = 4

// Size of one character cell at REF_FONT_SIZE pixels, measured in the
// terminal's font.
export interface CellSize {
  width: number
  height: number
}

export const REF_FONT_SIZE = 100

// What decides whether the layout view can show, but the font size.
export interface LayoutViewInput {
  paneStream: boolean
  paneLayout: boolean
  mobile: boolean
  viewOnly: boolean
  setting: boolean
  layout: TabLayout | undefined
}

// The layout view is offered: a desktop with full rights, a backend that
// streams panes one by one and arranges them, the setting on, and a tab of
// 2 to MAX_LAYOUT_PANES panes with an area.
export function layoutViewWanted(i: LayoutViewInput): boolean {
  const n = i.layout?.panes.length ?? 0
  return (
    i.paneStream &&
    i.paneLayout &&
    !i.mobile &&
    !i.viewOnly &&
    i.setting &&
    !!i.layout?.cols &&
    !!i.layout.rows &&
    n >= 2 &&
    n <= MAX_LAYOUT_PANES
  )
}

// Whether the font fits: below minimum the panes would be unreadable. Once
// shown, the view stays down to minimum; once left, it comes back only a
// pixel above it, so a size right at the edge does not flip it to and fro.
export function layoutFontFits(
  fontSize: number,
  minimum: number,
  shown: boolean,
): boolean {
  return fontSize >= (shown ? minimum : minimum + 1)
}

// The height xterm.js gives a row at fontSize: the character's height
// rounded up to whole device pixels (at line height 1). Rounding up, a row
// is up to a device pixel taller than the cell measured at REF_FONT_SIZE
// scales to.
export function rowHeight(cell: CellSize, fontSize: number, dpr: number) {
  return Math.ceil(((cell.height * fontSize) / REF_FONT_SIZE) * dpr) / dpr
}

// The font size at which the area's grid fits a box of width x height
// pixels, from the cell size at REF_FONT_SIZE. Not clamped: the caller
// compares it with its minimum. 0 when nothing is measured yet.
export function layoutFontSize(
  area: { cols: number; rows: number },
  box: { width: number; height: number },
  cell: CellSize,
  dpr = window.devicePixelRatio || 1,
): number {
  if (!cell.width || !cell.height || !box.width || !box.height) return 0
  const scale = Math.min(
    box.width / (area.cols * cell.width),
    box.height / (area.rows * cell.height),
  )
  let size = Math.floor(REF_FONT_SIZE * scale)
  // Rows rounded up may not fit at the size the scale gives
  while (size > 0 && area.rows * rowHeight(cell, size, dpr) > box.height) size--
  return size
}

// Where a pane sits in the box, as CSS percentages of the area.
export interface PaneBox {
  left: string
  top: string
  width: string
  height: string
}

const percent = (part: number, whole: number) => `${(part / whole) * 100}%`

export function paneBox(
  area: { cols: number; rows: number },
  pane: { x: number; y: number; cols: number; rows: number },
): PaneBox {
  return {
    left: percent(pane.x, area.cols),
    top: percent(pane.y, area.rows),
    width: percent(pane.cols, area.cols),
    height: percent(pane.rows, area.rows),
  }
}

// The pane a zoomed layout shows, when it is one of the tab's.
export function zoomedPane(layout: TabLayout | undefined): string | undefined {
  if (!layout?.zoomed || !layout.zoomedPaneId) return undefined
  return layout.panes.some((p) => p.id === layout.zoomedPaneId)
    ? layout.zoomedPaneId
    : undefined
}

// Calls fn at once, then at most once per ms while calls keep coming, the
// last of them at the end of the wait.
export function throttle(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = false
  const run = () => {
    timer = undefined
    if (!pending) return
    pending = false
    fn()
    timer = setTimeout(run, ms)
  }
  const call = () => {
    if (timer) {
      pending = true
      return
    }
    fn()
    timer = setTimeout(run, ms)
  }
  call.cancel = () => {
    clearTimeout(timer)
    timer = undefined
    pending = false
  }
  return call
}

// Cell size of the terminal font at REF_FONT_SIZE, measured the way xterm.js
// measures it: a run of W in a hidden span. Zero where nothing lays out
// (jsdom).
export function measureCell(fontFamily: string): CellSize {
  const span = document.createElement('span')
  const run = 32
  span.textContent = 'W'.repeat(run)
  Object.assign(span.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre',
    fontFamily,
    fontSize: `${REF_FONT_SIZE}px`,
    lineHeight: 'normal',
    fontKerning: 'none',
  })
  document.body.appendChild(span)
  const rect = span.getBoundingClientRect()
  span.remove()
  return { width: rect.width / run, height: rect.height }
}
