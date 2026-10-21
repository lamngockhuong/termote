// biome-ignore-all lint/a11y/useSemanticElements: a virtual grid needs block rows between spacers, which <table> layout does not allow; the roles give the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: only cells take focus (roving, arrow keys); rows and headers are structure
import { ArrowDown, ArrowUp, WrapText } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useMediaQuery } from '../hooks/use-media-query'
import { matchFrom } from '../utils/csv-find'
import { type CsvTable, cellsIn, valueAt } from '../utils/csv-parse'
import type { ViewOptions } from '../utils/csv-view'
import {
  clampWidth,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP,
  FIT_MAX_WIDTH,
  gridScale,
  MAX_SCROLL_HEIGHT,
  MIN_WIDTH,
  pageRows,
  ROW_HEIGHT,
  rowHeightFor,
  scrollTopFor,
  TOUCH_ROW_HEIGHT,
  WIDTH_STEP,
  WRAP_LINES,
  type WrapLines,
  wrapLines,
} from '../utils/table-columns'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FOCUS_RING } from './ui/button'

// Characters of a value shown in a cell, a record or a tooltip; the whole
// value is only in the cell sheet. A 1 MiB cell would hang the page.
export const MAX_CELL_CHARS = 1024

// The value at row, col as shown: only its start is decoded
export function shownAt(
  text: string,
  t: CsvTable,
  row: number,
  col: number,
  multiline = false,
): string {
  return cellText(valueAt(text, t, row, col, MAX_CELL_CHARS + 1), multiline)
}

// A value as one line of a cell: cut, with every unsafe character visible
export function cellText(value: string, multiline = false): string {
  const cut =
    value.length > MAX_CELL_CHARS ? `${value.slice(0, MAX_CELL_CHARS)}…` : value
  return visibleUnsafe(cut, multiline)
}

// Rows rendered above and below the visible ones
const OVERSCAN = 10
// Viewport assumed until the frame has a size (a test, the first frame)
const FALLBACK_HEIGHT = 600
// Pixels of a cell that are not its text: px-2 on both sides
const CELL_PAD_X = 16
// ch assumed when a header cell has no size to measure (a test)
const FALLBACK_CH_PX = 7
// After a finger lifts off a resize handle, the browser aims its click at
// the point again: the column a fit or drag just widened puts a sort button
// there. No sort is taken that soon after.
const TOUCH_CLICK_MS = 500

const CELL = `truncate px-2 text-left ${FOCUS_RING} focus-visible:-outline-offset-2`
// A wrapped cell: up to its table's lines from the top, never past its row
const WRAP_CELL = `flex items-start overflow-hidden px-2 py-1.5 text-left leading-4 ${FOCUS_RING} focus-visible:-outline-offset-2`
// The pinned column's cell: stuck next to the row numbers (level with them,
// never over them), above the cells scrolled under it
const PIN = 'sticky z-[6] border-r border-border bg-bg'
// A cell found: a tint drawn as an image, over a pinned cell's own opaque
// background too; the current one is outlined as well
const HIT = 'bg-linear-to-r from-accent/15 to-accent/15'
const CURRENT = 'outline-2 -outline-offset-2 outline-accent'
// Whole class names, so Tailwind finds each one in the source
const CLAMP: Record<WrapLines, string> = {
  3: 'line-clamp-3',
  6: 'line-clamp-6',
  10: 'line-clamp-10',
}

interface Props {
  text: string
  table: CsvTable
  // File row indices, in the order shown (the header row is never one)
  rows: Int32Array
  // Names and widths (in ch) of the columns, by column of the file
  names: string[]
  widths: number[]
  // The columns shown, in order (columns of the file): the others are
  // hidden. Keys move along these; data-col is a column of the file,
  // data-at its place here.
  cols: number[]
  // Columns whose cells show several lines, up to lines; with any, every
  // row is taller
  wrapped: ReadonlySet<number>
  lines?: WrapLines
  header: boolean
  // Cells a row should have; any other count is flagged
  expected: number
  sort: ViewOptions['sort']
  onSort: (col: number) => void
  // A cell was clicked, or asked for with Enter or F2
  onOpen: (row: number, col: number) => void
  // A character typed on a cell (file row, column), to edit it from; ''
  // for the first key of an IME, whose text goes to the field it opens.
  // Unset, typing is not taken.
  onType?: (row: number, col: number, input: string) => void
  // Delete or Backspace on a cell: its value is cleared. Unset, not taken.
  onClear?: (row: number, col: number) => void
  // The cell edited where it is (file row, column) and its editor, shown
  // in place of the cell
  editingCell?: { row: number; col: number }
  editor?: ReactNode
  // A file row's number was chosen: show that row as a record
  onOpenRow: (row: number) => void
  // A column's width set by a drag or a key (ch), or asked to fit its
  // values from the row at pos in rows (the first one in view)
  onResize: (col: number, width: number) => void
  onFit: (col: number, pos: number) => void
  // Told the place in rows of the first row in view, for a fit of every
  // column
  topRef: RefObject<number>
  busy: boolean
  // Covered (the records view is on top): out of focus and of the
  // accessibility tree, but still laid out, so it keeps its scroll offset
  covered?: boolean
  // Where it starts scrolled to (a tab shown again), once there are rows
  scrollTop?: number
  // The first column stays at the left, next to the row numbers, while the
  // rest scrolls; not while it is wider than half the frame
  pinned?: boolean
  // Cells found, as pairs (place in rows, place in cols) in that order, and
  // the current one
  matches?: Int32Array
  current?: GridCell
  // A cell to go to, once per seq: made active and scrolled into view, and
  // given the focus when focus is set or the focus is in the grid. With no
  // cell, the active one.
  goTo?: { seq: number; cell?: GridCell; focus?: boolean }
  // A table taking edits: the menu of a column (file column), from its ⋯,
  // or the context menu (key or click) on its name or on one of its cells,
  // then with that cell's file row
  columnMenu?: (
    col: number,
    row: number | undefined,
    open: boolean,
    onOpenChange: (open: boolean) => void,
  ) => ReactNode
  // F2 or a double click on a column's name: rename it. Set, a double click
  // sorts once, not twice.
  onRename?: (col: number) => void
  // The column whose name is edited, and its editor, in place of its name
  editingHeader?: number
  headerEditor?: ReactNode
}

// A place in rows, and one in cols
export interface GridCell {
  pos: number
  at: number
}

interface Drag {
  col: number
  x: number
  start: number
  // Pixels per ch, measured on the header cell as the drag starts
  chPx: number
  last: number
  moved: boolean
}

// Shift+F10 or the context menu key: a menu for where the focus is
const menuKey = (e: KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)

// A virtual grid: one scrolling frame holding a sticky header, a spacer for
// the rows above, the rows in view and a spacer for the rows below. Each row
// is its own CSS grid on the shared column template, so a spacer is never a
// cell. Row numbers stick to the left.
export function TableGrid({
  text,
  table,
  rows,
  names,
  widths,
  cols,
  wrapped,
  lines = WRAP_LINES,
  header,
  expected,
  sort,
  onSort,
  onOpen,
  onType,
  onClear,
  editingCell,
  editor,
  onOpenRow,
  onResize,
  onFit,
  topRef,
  busy,
  covered = false,
  scrollTop,
  pinned = false,
  matches,
  current,
  goTo,
  columnMenu,
  onRename,
  editingHeader,
  headerEditor,
}: Props) {
  const frame = useRef<HTMLDivElement>(null)
  // Used up by the first rows: the offset is a scroll offset of this frame,
  // so it is set back as it was, whatever the scale
  const restore = useRef(scrollTop)
  const coarse = useMediaQuery('(pointer: coarse)')
  const headerHeight = coarse ? TOUCH_ROW_HEIGHT : ROW_HEIGHT
  // One height for every row, taller while a column shown wraps
  const rowHeight = rowHeightFor(
    coarse,
    cols.some((c) => wrapped.has(c)),
    lines,
  )
  const [view, setView] = useState({ top: 0, height: 0 })
  // The frame's width, 0 until it has a size
  const [frameWidth, setFrameWidth] = useState(0)
  // The cell keyboard focus moves from: its place in rows, and its place
  // in cols (-1 is the row number)
  const [active, setActive] = useState({ pos: 0, col: 0 })
  const focusing = useRef(false)
  // The column whose menu is open, and the file row of the cell it was
  // asked from
  const [menu, setMenu] = useState<{ col: number; row?: number }>()
  const backFromMenu = useRef(false)
  // The cell made active by a goTo without the focus: scrolled into view
  // sideways once rendered
  const showing = useRef(false)

  useLayoutEffect(() => {
    const el = frame.current as HTMLDivElement
    const read = () => {
      setView({ top: el.scrollTop, height: el.clientHeight })
      setFrameWidth(el.clientWidth)
    }
    read()
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(read)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(read)
    ro?.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', onScroll)
      ro?.disconnect()
    }
  }, [])

  // The rows come after the first parse: until then the frame cannot scroll
  useLayoutEffect(() => {
    const top = restore.current
    if (!top || !rows.length) return
    restore.current = undefined
    const el = frame.current as HTMLDivElement
    el.scrollTop = top
    setView({ top: el.scrollTop, height: el.clientHeight })
  }, [rows])

  const height = view.height || FALLBACK_HEIGHT
  const total = Math.min(rows.length * rowHeight, MAX_SCROLL_HEIGHT)
  // Content pixels per scroll pixel: 1 unless the rows are taller than
  // MAX_SCROLL_HEIGHT
  const scale = gridScale(rows.length, rowHeight, height)
  // Where the view starts in the rows, from the scroll offset
  const contentTop = view.top * scale
  const last = Math.min(
    rows.length,
    Math.ceil((contentTop + height) / rowHeight) + OVERSCAN,
  )
  // Rows above the view, as many as fit above the scroll offset (all of
  // OVERSCAN unless scaled near the top). A filter can leave fewer rows than
  // the old scroll offset reached.
  const first = Math.min(
    last,
    Math.max(
      0,
      Math.floor(contentTop / rowHeight) - OVERSCAN,
      Math.ceil((contentTop - view.top) / rowHeight),
    ),
  )
  const before = Math.max(0, view.top - contentTop + first * rowHeight)
  const after = Math.max(0, total - before - (last - first) * rowHeight)
  const pos = Math.min(active.pos, Math.max(rows.length - 1, 0))
  // -1 is the row number
  const col = Math.min(active.col, cols.length - 1)
  // The first row in view
  const top = Math.min(
    Math.max(rows.length - 1, 0),
    Math.max(0, Math.floor(contentTop / rowHeight)),
  )
  useEffect(() => {
    topRef.current = top
  })

  // A new row height (a column starts or stops wrapping) keeps the first
  // row in view on top: the old offset would point at another row
  const geometry = useRef({ rowHeight, scale })
  useLayoutEffect(() => {
    const was = geometry.current
    geometry.current = { rowHeight, scale }
    if (was.rowHeight === rowHeight) return
    const el = frame.current as HTMLDivElement
    const at = Math.floor((el.scrollTop * was.scale) / was.rowHeight)
    el.scrollTop = scrollTopFor(at, rowHeight, scale)
    setView({ top: el.scrollTop, height: el.clientHeight })
  })

  // Focus follows the arrow keys onto the cell they reached, once rendered
  useEffect(() => {
    if (!focusing.current && !showing.current) return
    const cell = frame.current?.querySelector<HTMLElement>(
      `[data-pos="${pos}"][data-at="${col}"]`,
    )
    if (focusing.current) cell?.focus()
    else cell?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    focusing.current = false
    showing.current = false
  })

  // The menu gives the focus back to its ⋯ as it closes: from there, back
  // on the active cell
  useEffect(() => {
    if (!backFromMenu.current) return
    backFromMenu.current = false
    if (!document.activeElement?.closest('[aria-haspopup="menu"]')) return
    focusing.current = true
    reveal({ pos, col })
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const onCell = target.dataset.pos !== undefined
    // On the grid itself (the active cell scrolled away), a move key goes
    // back to the active cell
    if (!onCell && target !== frame.current) return
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-pageRows(height, rowHeight), 0],
      PageDown: [pageRows(height, rowHeight), 0],
    }
    // The cell the key is on (focused by a script, it may not be the
    // active one yet)
    const from = onCell
      ? { pos: Number(target.dataset.pos), col: Number(target.dataset.at) }
      : { pos, col }
    const row = rows[from.pos]
    // The column of the file
    const fileCol = cols[from.col]
    const onValue = onCell && from.col >= 0
    // AltGr (Ctrl and Alt on Windows) types a character, never a shortcut
    const modified =
      (e.ctrlKey || e.metaKey || e.altKey) &&
      !e.nativeEvent.getModifierState('AltGraph')
    if (e.key === 'F2' && onValue) {
      e.preventDefault()
      onOpen(row, fileCol)
      return
    }
    if (columnMenu && onValue && menuKey(e)) {
      e.preventDefault()
      setActive(from)
      setMenu({ col: fileCol, row })
      return
    }
    // The first key of an IME: its default goes on, so the text composed
    // can reach the field opened
    const composing =
      e.nativeEvent.isComposing ||
      e.key === 'Process' ||
      e.nativeEvent.keyCode === 229
    if (onType && onValue && composing) {
      onType(row, fileCol, '')
      return
    }
    if (onType && onValue && e.key.length === 1 && !modified) {
      e.preventDefault()
      onType(row, fileCol, e.key)
      return
    }
    if (
      onClear &&
      onValue &&
      (e.key === 'Delete' || e.key === 'Backspace') &&
      !modified
    ) {
      e.preventDefault()
      onClear(row, fileCol)
      return
    }
    const lastPos = Math.max(rows.length - 1, 0)
    const lastCol = cols.length - 1
    let next: { pos: number; col: number }
    if (e.key === 'Home' || e.key === 'End') {
      // The first or last column of the row; with Ctrl (Cmd on a Mac), of
      // the first or last row shown
      const end = e.key === 'End'
      const whole = e.ctrlKey || e.metaKey
      next = onCell
        ? {
            pos: whole ? (end ? lastPos : 0) : from.pos,
            col: end ? lastCol : 0,
          }
        : from
    } else {
      const key = moves[e.key]
      if (!key) return
      const move = onCell ? key : [0, 0]
      next = {
        pos: Math.max(0, Math.min(lastPos, from.pos + move[0])),
        col: Math.max(-1, Math.min(lastCol, from.col + move[1])),
      }
    }
    e.preventDefault()
    focusing.current = true
    reveal(next)
  }

  // Makes the cell active, its row scrolled into view below the sticky
  // header
  const reveal = (next: { pos: number; col: number }) => {
    const el = frame.current as HTMLDivElement
    const y = next.pos * rowHeight
    const now = el.scrollTop * scale
    if (y < now) el.scrollTop = y / scale
    else if (y + headerHeight + rowHeight > now + height) {
      el.scrollTop = (y + headerHeight + rowHeight - height) / scale
    }
    setActive(next)
    setView({ top: el.scrollTop, height: el.clientHeight })
  }

  const went = useRef(goTo?.seq)
  useEffect(() => {
    if (!goTo || goTo.seq === went.current) return
    went.current = goTo.seq
    const el = frame.current as HTMLDivElement
    const focus = goTo.focus || el.contains(document.activeElement)
    focusing.current = focus
    showing.current = !focus
    reveal(goTo.cell ? { pos: goTo.cell.pos, col: goTo.cell.at } : { pos, col })
  })

  // The cell edited becomes the active one, scrolled into view (Tab may
  // reach a row out of it). Once the editing ends by a key (Enter, Escape),
  // the editor leaves the focus on the grid and it goes back to its cell;
  // never from where a click put it, which the browser may move only after
  // this runs.
  const edited = useRef(editingCell)
  useEffect(() => {
    const was = edited.current
    edited.current = editingCell
    if (was?.row === editingCell?.row && was?.col === editingCell?.col) return
    const cell = (editingCell ?? was) as { row: number; col: number }
    // Filtered out, or its column hidden, meanwhile
    const at = rows.indexOf(cell.row)
    const place = cols.indexOf(cell.col)
    if (at < 0 || place < 0) return
    if (editingCell) reveal({ pos: at, col: place })
    else if (document.activeElement === frame.current) {
      focusing.current = true
      setActive({ pos: at, col: place })
    }
  })

  // The context menu of a cell (a right click; its key too, where the
  // browser sends no keydown for it)
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]')
    if (!columnMenu || !cell || cell.dataset.at === '-1') return
    e.preventDefault()
    const at = { pos: Number(cell.dataset.pos), col: Number(cell.dataset.at) }
    setActive(at)
    setMenu({ col: Number(cell.dataset.col), row: rows[at.pos] })
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]')
    if (!cell) return
    const at = { pos: Number(cell.dataset.pos), col: Number(cell.dataset.at) }
    setActive(at)
    if (at.col >= 0) onOpen(rows[at.pos], Number(cell.dataset.col))
    // While the rows are being worked out, the order on screen is the old
    // one: the number may not be the row under it any more
    else if (!busy) onOpenRow(rows[at.pos])
  }

  // A drag sets the width on the frame only (a CSS variable the column
  // template reads): rendering every cell at each move would be slow. The
  // width is told once, as the drag ends.
  const drag = useRef<Drag | null>(null)
  // The last release of a handle with no drag: a second one soon after on
  // the same column fits it (dblclick is unreliable on a touch in Safari)
  const lastTap = useRef<{ col: number; time: number } | null>(null)
  const touchUp = useRef(Number.NEGATIVE_INFINITY)
  const onHandleDown = (e: PointerEvent<HTMLElement>, c: number) => {
    if (e.button !== 0) return
    // No text selection while dragging; the event still reaches the
    // document, where an open menu closes on it
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const w = widths[c]
    const cell = e.currentTarget.parentElement as HTMLElement
    const chPx = (cell.getBoundingClientRect().width - CELL_PAD_X) / w
    drag.current = {
      col: c,
      x: e.clientX,
      start: w,
      chPx: chPx > 0 ? chPx : FALLBACK_CH_PX,
      last: w,
      moved: false,
    }
  }
  const onHandleMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (Math.abs(dx) >= DOUBLE_TAP_SLOP) d.moved = true
    if (!d.moved) return
    d.last = clampWidth(d.start + dx / d.chPx)
    frame.current?.style.setProperty(`--w-${d.col}`, `${d.last}ch`)
  }
  // released: a pointerup, which may be the second tap of a fit; a cancel
  // or a lost capture only ends a drag
  const endDrag = (e: PointerEvent<HTMLElement>, released: boolean) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.pointerType !== 'mouse') touchUp.current = performance.now()
    frame.current?.style.removeProperty(`--w-${d.col}`)
    if (d.moved) {
      lastTap.current = null
      if (d.last !== d.start) onResize(d.col, d.last)
      return
    }
    if (!released) return
    const tap = lastTap.current
    if (tap?.col === d.col && e.timeStamp - tap.time < DOUBLE_TAP_MS) {
      lastTap.current = null
      onFit(d.col, top)
    } else {
      lastTap.current = { col: d.col, time: e.timeStamp }
    }
  }
  const onHandleKey = (e: KeyboardEvent<HTMLElement>, c: number) => {
    const w = widths[c]
    let next: number
    if (e.key === 'ArrowLeft') next = w - WIDTH_STEP
    else if (e.key === 'ArrowRight') next = w + WIDTH_STEP
    else if (e.key === 'Home') next = MIN_WIDTH
    else if (e.key === 'End') next = FIT_MAX_WIDTH
    else if (e.key === 'Enter') {
      e.preventDefault()
      onFit(c, top)
      return
    } else return
    e.preventDefault()
    const clamped = clampWidth(next)
    if (clamped !== w) onResize(c, clamped)
  }

  const numberWidth = String(table.rowCount).length + 1
  const numberCol = `calc(${numberWidth}ch + 1rem)`
  // Pixels the row numbers and the pinned column take, from the header's
  // first two cells (estimated until they have a size)
  const corner = useRef<HTMLDivElement>(null)
  const pinHead = useRef<HTMLDivElement>(null)
  const [pinnedPx, setPinnedPx] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the widths or the frame change
  useLayoutEffect(() => {
    if (!pinned) return
    // Widths, not places: scrolled sideways, an unpinned column has moved
    const width = (el: HTMLDivElement | null) =>
      (el as HTMLDivElement).getBoundingClientRect().width
    setPinnedPx(
      width(corner.current) + width(pinHead.current) ||
        (numberWidth + widths[cols[0]]) * FALLBACK_CH_PX + 2 * CELL_PAD_X,
    )
  }, [pinned, widths[cols[0]], numberWidth, frameWidth])
  // A frame of no size yet (a test, the first frame) is no narrow one
  const sticky = pinned && (!frameWidth || pinnedPx <= frameWidth / 2)
  const pinStyle = sticky ? { left: numberCol } : undefined
  const template = [
    numberCol,
    ...cols.map((c) => `calc(var(--w-${c}, ${widths[c]}ch) + 1rem)`),
  ].join(' ')
  // Row 0 is the header row when there is one; a synthetic header otherwise
  const ariaRow = (r: number) => r + (header ? 1 : 2)
  // The cells found among the rows rendered, as pos * cols.length + at
  const hits = new Set<number>()
  if (matches) {
    for (let k = 2 * matchFrom(matches, first, 0); k < matches.length; k += 2) {
      if (matches[k] >= last) break
      hits.add(matches[k] * cols.length + matches[k + 1])
    }
  }

  return (
    <div
      ref={frame}
      role="grid"
      aria-label="Table"
      aria-rowcount={table.rowCount + (header ? 0 : 1)}
      aria-colcount={table.columnCount + 1}
      // The grid keeps the Tab stop while the active cell is scrolled away
      tabIndex={pos >= first && pos < last ? -1 : 0}
      aria-busy={busy}
      aria-hidden={covered || undefined}
      inert={covered}
      // No scroll anchoring: a jump far down shows only the spacer below for
      // a frame, and the browser, anchored on it, would push the offset down
      // again by the rows drawn above as they render
      className="min-h-0 flex-1 overflow-auto bg-bg font-term text-[12px] text-fg [overflow-anchor:none]"
      // A cell given the focus is scrolled out from under the columns that
      // stick at the left
      style={{
        scrollPaddingLeft: sticky
          ? `calc(${numberWidth + widths[cols[0]]}ch + 2rem)`
          : numberCol,
      }}
      data-scroll-restore
      onKeyDown={onKeyDown}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className="w-max min-w-full">
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-10 grid h-8 border-b border-border bg-surface pointer-coarse:h-touch"
          style={{ gridTemplateColumns: template }}
        >
          <div
            ref={corner}
            role="columnheader"
            aria-colindex={1}
            // Above the resize handles of the columns scrolled under it
            className="sticky left-0 z-30 bg-surface px-2"
            aria-label="Row"
          />
          {cols.map((c, i) => {
            const name = names[c]
            const dir = sort?.col === c ? sort.dir : undefined
            const Arrow = dir === 'desc' ? ArrowDown : ArrowUp
            const label = cellText(name)
            return (
              <div
                key={c}
                ref={i === 0 ? pinHead : undefined}
                role="columnheader"
                // Hidden columns are left out: a screen reader can tell
                aria-colindex={c + 2}
                // Its name only, not its resize handle's
                aria-label={label}
                aria-sort={
                  dir === 'asc'
                    ? 'ascending'
                    : dir === 'desc'
                      ? 'descending'
                      : 'none'
                }
                // Pinned: below the corner, above the resize handles of the
                // columns scrolled under it
                className={`group/head flex min-w-0 ${i === 0 && sticky ? 'sticky z-[25] border-r border-border bg-surface' : 'relative'}`}
                style={i === 0 ? pinStyle : undefined}
                onContextMenu={(e) => {
                  if (!columnMenu || editingHeader === c) return
                  e.preventDefault()
                  // From inside its open menu: it stays as it was opened
                  if ((e.target as HTMLElement).closest('[role="menu"]')) return
                  setMenu({ col: c })
                }}
              >
                {editingHeader === c ? (
                  // The editor's group: in the last column it grows leftward
                  <div
                    className="group/edit relative min-w-0 flex-1"
                    data-last={i === cols.length - 1 || undefined}
                  >
                    {headerEditor}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(e) => {
                      // The second click of a double click renames
                      if (onRename && e.detail > 1) return
                      if (
                        performance.now() - touchUp.current >=
                        TOUCH_CLICK_MS
                      ) {
                        onSort(c)
                      }
                    }}
                    onDoubleClick={() => onRename?.(c)}
                    onKeyDown={(e) => {
                      if (e.key === 'F2' && onRename) {
                        e.preventDefault()
                        onRename(c)
                      } else if (columnMenu && menuKey(e)) {
                        e.preventDefault()
                        setMenu({ col: c })
                      }
                    }}
                    title={label}
                    className={`${CELL} flex flex-1 items-center gap-1 font-semibold`}
                  >
                    <bdi className="truncate">{label}</bdi>
                    {wrapped.has(c) && (
                      <WrapText
                        size={12}
                        aria-hidden="true"
                        className="shrink-0 text-fg-subtle"
                      />
                    )}
                    {dir && (
                      <Arrow
                        size={12}
                        aria-hidden="true"
                        className="shrink-0 text-accent"
                      />
                    )}
                  </button>
                )}
                {columnMenu && editingHeader !== c && (
                  // Shown on hover, while in focus or open, and always on a
                  // touch screen
                  <div
                    className={`absolute inset-y-0 right-2 z-20 flex items-center focus-within:opacity-100 group-hover/head:opacity-100 pointer-coarse:opacity-100 ${menu?.col === c ? 'opacity-100' : 'opacity-0'}`}
                  >
                    {columnMenu(
                      c,
                      menu?.col === c ? menu.row : undefined,
                      menu?.col === c,
                      // Another column's menu may have opened meanwhile,
                      // this one closing as the focus leaves it
                      (open) => {
                        // Closed after it was asked from a cell: the focus
                        // goes back to that cell, unless a field took it
                        if (
                          !open &&
                          menu?.col === c &&
                          menu.row !== undefined
                        ) {
                          backFromMenu.current = true
                        }
                        setMenu((m) =>
                          open ? { col: c } : m?.col === c ? undefined : m,
                        )
                      },
                    )}
                  </div>
                )}
                {/* A sibling of the sort button, inside the column's edge:
                    a drag on it never sorts, and the last column grows the
                    scroll width by nothing */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize column ${label}`}
                  aria-valuenow={Math.round(widths[c])}
                  aria-valuetext={`${Math.round(widths[c])} characters`}
                  aria-valuemin={MIN_WIDTH}
                  aria-valuemax={FIT_MAX_WIDTH}
                  tabIndex={0}
                  title="Drag to resize, double-click to fit"
                  onPointerDown={(e) => onHandleDown(e, c)}
                  onPointerMove={onHandleMove}
                  onPointerUp={(e) => endDrag(e, true)}
                  onPointerCancel={(e) => endDrag(e, false)}
                  onLostPointerCapture={(e) => endDrag(e, false)}
                  onKeyDown={(e) => onHandleKey(e, c)}
                  className="group absolute inset-y-0 right-0 z-20 flex w-2 cursor-col-resize touch-none justify-end outline-none pointer-coarse:w-6"
                >
                  <span
                    aria-hidden="true"
                    className="block h-full w-px bg-border group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent"
                  />
                </div>
              </div>
            )
          })}
        </div>
        <div style={{ height: before }} />
        {Array.from({ length: last - first }, (_, k) => {
          const p = first + k
          const r = rows[p]
          const n = cellsIn(table, r)
          const odd = n !== expected
          const label = odd
            ? `Row ${r + 1}: ${n} cells, ${header ? 'the header has' : 'the widest row has'} ${expected}`
            : `Row ${r + 1}`
          return (
            <div
              key={r}
              role="row"
              aria-rowindex={ariaRow(r)}
              // The row edited lets its editor grow over the rows below,
              // and over their pinned cells when it is in the pinned column.
              // Clipped, not hidden: overflow hidden would make each row a
              // scroll box, and its row number and pinned cell would stick
              // to the row, never to the frame scrolled sideways.
              className={`grid border-b border-border/50 ${editingCell?.row === r ? `relative ${sticky && editingCell.col === cols[0] ? 'z-[7]' : 'z-[5]'}` : 'overflow-clip'}`}
              style={{ gridTemplateColumns: template, height: rowHeight }}
            >
              <div
                role="rowheader"
                aria-colindex={1}
                aria-label={label}
                title={odd ? label : undefined}
                // Above a cell edited on a row before, growing over it
                className={`sticky left-0 z-[6] bg-bg tabular-nums ${odd ? 'text-warning' : 'text-fg-subtle'}`}
              >
                <button
                  type="button"
                  data-pos={p}
                  data-col={-1}
                  data-at={-1}
                  tabIndex={p === pos && col === -1 ? 0 : -1}
                  aria-label={`Open row ${r + 1} as a record`}
                  className={`h-full w-full px-2 text-right ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  {r + 1}
                </button>
              </div>
              {cols.map((c, i) => {
                if (editingCell?.row === r && editingCell.col === c) {
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      aria-colindex={c + 2}
                      // The editor's group: in the last column it grows leftward
                      data-last={i === cols.length - 1 || undefined}
                      // Out of the pinned column, still above it: a field
                      // growing leftward from the last column covers it
                      className={`group/edit min-w-0 ${i === 0 && sticky ? PIN : 'relative z-[7]'}`}
                      style={i === 0 ? pinStyle : undefined}
                    >
                      {editor}
                    </div>
                  )
                }
                const wrap = wrapped.has(c)
                const shown = shownAt(text, table, r, c, wrap)
                const found = hits.has(p * cols.length + i)
                const now = found && current?.pos === p && current.at === i
                return (
                  <button
                    key={c}
                    type="button"
                    role="gridcell"
                    aria-colindex={c + 2}
                    data-pos={p}
                    data-col={c}
                    data-at={i}
                    tabIndex={p === pos && i === col ? 0 : -1}
                    title={shown}
                    className={`${wrap ? WRAP_CELL : CELL} ${i === 0 && sticky ? PIN : ''} ${found ? HIT : ''} ${now ? CURRENT : ''}`}
                    style={i === 0 ? pinStyle : undefined}
                  >
                    {wrap ? (
                      <span
                        className={`${CLAMP[lines]} min-w-0 whitespace-pre-wrap break-words`}
                      >
                        <bdi>{wrapLines(shown)}</bdi>
                      </span>
                    ) : (
                      <bdi>{shown}</bdi>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
        <div style={{ height: after }} />
      </div>
    </div>
  )
}
