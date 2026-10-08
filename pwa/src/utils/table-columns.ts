// Column widths and row heights of the table view (table-grid.tsx). Widths
// are in ch of the cell font; a row height is one number for the whole
// table, which the virtual grid's scroll math relies on.

// Width of a column as it opens: from the first rows, clamped
export const MIN_WIDTH = 4
export const MAX_WIDTH = 32
export const WIDTH_ROWS = 200
// Ceiling of a width set by a drag, a key or a fit: one huge cell must not
// push every other column out of the screen
export const FIT_MAX_WIDTH = 120
// Rows a fit reads, from the first row in view, and the time it may take
export const FIT_ROWS = 1000
export const FIT_BUDGET_MS = 50
// A resize handle's arrow key step
export const WIDTH_STEP = 2
// Two releases of a handle this close in time and place fit the column
export const DOUBLE_TAP_MS = 300
export const DOUBLE_TAP_SLOP = 4

// Row heights: h-8, and the 44px touch target on a coarse pointer (each with
// its 1px bottom border)
export const ROW_HEIGHT = 32
export const TOUCH_ROW_HEIGHT = 44
// A wrapped cell shows up to WRAP_LINES lines of 16px (leading-4) between
// 6px of padding (py-1.5); + 1 for the row's bottom border, or the third
// line loses its descenders
export const WRAP_LINES = 3
export const WRAP_LINE_HEIGHT = 16
export const WRAP_PAD_Y = 6
export const WRAP_ROW_HEIGHT =
  WRAP_LINES * WRAP_LINE_HEIGHT + 2 * WRAP_PAD_Y + 1

// Tallest scroll height used: browsers cap an element's height (Firefox near
// 17.9 million px), and a 1 MiB file of empty lines is a million rows. Past
// it, a scroll offset maps onto the rows in proportion.
export const MAX_SCROLL_HEIGHT = 8_000_000

// What a table shows beyond its parse, kept per open file (a tab): widths
// set by hand (ch, by column) and the wrapped columns. key is the delimiter
// and header row they were set under: under others they mean nothing.
export interface TableLayout {
  key: string
  widths: Record<number, number>
  wrapped: number[]
}

export function emptyLayout(key: string): TableLayout {
  return { key, widths: {}, wrapped: [] }
}

// A value of a cell as shown: (file row, column, with its line breaks)
export type ReadCell = (row: number, col: number, multiline: boolean) => string

export function clampWidth(w: number): number {
  return Math.min(FIT_MAX_WIDTH, Math.max(MIN_WIDTH, w))
}

// A multiline value as a wrapped cell shows it: ↵ still ends each line, so
// "\n\n\nREJECTED" never looks like an empty cell
export function wrapLines(shown: string): string {
  return shown.replace(/\n/g, '↵\n')
}

export function longestLine(s: string): number {
  let longest = 0
  let start = 0
  for (;;) {
    const end = s.indexOf('\n', start)
    longest = Math.max(longest, (end < 0 ? s.length : end) - start)
    if (end < 0) return longest
    start = end + 1
  }
}

// Rows a fit reads between two looks at the clock
const FIT_CHUNK = 32

// The width fitting a column's name (as shown) and its values on the given
// rows, up to FIT_MAX_WIDTH; past the deadline (performance.now()) it keeps
// what it measured, after FIT_CHUNK rows at least. A wrapped column fits its
// longest line, any other the one line a cell shows (breaks as ↵).
export function fitWidth(
  read: ReadCell,
  rows: ArrayLike<number>,
  name: string,
  col: number,
  wrapped: boolean,
  deadline: number,
): number {
  let w = name.length
  for (let i = 0; i < rows.length && w < FIT_MAX_WIDTH; i++) {
    if (i > 0 && i % FIT_CHUNK === 0 && performance.now() > deadline) break
    const shown = read(rows[i], col, wrapped)
    w = Math.max(w, wrapped ? longestLine(wrapLines(shown)) : shown.length)
  }
  return clampWidth(Math.ceil(w))
}

// Widths fitting the columns cols (names as shown, wrapped by column) over
// the given rows, on top of widths; once past the deadline the columns left
// keep the width they had, never shrunk to their name
export function fitWidths(
  read: ReadCell,
  rows: ArrayLike<number>,
  names: string[],
  cols: number[],
  wrapped: ReadonlySet<number>,
  widths: Record<number, number>,
  deadline: number,
): Record<number, number> {
  const next = { ...widths }
  for (const c of cols) {
    if (performance.now() > deadline) break
    next[c] = fitWidth(read, rows, names[c], c, wrapped.has(c), deadline)
  }
  return next
}

// Widths as a table opens: the names (as shown) and the first rows' values
// on one line, between MIN_WIDTH and MAX_WIDTH
export function initialWidths(
  read: ReadCell,
  rowCount: number,
  names: string[],
): number[] {
  const rows = Math.min(rowCount, WIDTH_ROWS)
  return names.map((name, c) => {
    let w = name.length
    for (let r = 0; r < rows && w < MAX_WIDTH; r++) {
      w = Math.max(w, read(r, c, false).length)
    }
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))
  })
}

export function rowHeightFor(coarse: boolean, wrapping: boolean): number {
  const base = coarse ? TOUCH_ROW_HEIGHT : ROW_HEIGHT
  return wrapping ? Math.max(base, WRAP_ROW_HEIGHT) : base
}

// Content pixels per scroll pixel of count rows in a frame `height` tall:
// 1 unless the rows are taller than MAX_SCROLL_HEIGHT
export function gridScale(
  count: number,
  rowHeight: number,
  height: number,
): number {
  const content = count * rowHeight
  const total = Math.min(content, MAX_SCROLL_HEIGHT)
  return content > total && total > height
    ? (content - height) / (total - height)
    : 1
}

// The scroll offset putting the row at pos on top
export function scrollTopFor(
  pos: number,
  rowHeight: number,
  scale: number,
): number {
  return (pos * rowHeight) / scale
}

// Rows a PageUp/PageDown moves: a frame's worth, at least one
export function pageRows(height: number, rowHeight: number): number {
  return Math.max(1, Math.floor(height / rowHeight))
}
