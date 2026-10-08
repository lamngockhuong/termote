// biome-ignore-all lint/a11y/useSemanticElements: a virtual grid needs block rows between spacers, which <table> layout does not allow; the roles give the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: only cells take focus (roving, arrow keys); rows and headers are structure
import { ArrowDown, ArrowUp, WrapText } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useMediaQuery } from '../hooks/use-media-query'
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
// A wrapped cell: up to WRAP_LINES lines from the top, never past its row
const WRAP_CELL = `flex items-start overflow-hidden px-2 py-1.5 text-left leading-4 ${FOCUS_RING} focus-visible:-outline-offset-2`

interface Props {
  text: string
  table: CsvTable
  // File row indices, in the order shown (the header row is never one)
  rows: Int32Array
  // Columns rendered, their names and widths (in ch)
  names: string[]
  widths: number[]
  // Columns whose cells show several lines; with any, every row is taller
  wrapped: ReadonlySet<number>
  header: boolean
  // Cells a row should have; any other count is flagged
  expected: number
  sort: ViewOptions['sort']
  onSort: (col: number) => void
  onOpen: (row: number, col: number) => void
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
  wrapped,
  header,
  expected,
  sort,
  onSort,
  onOpen,
  onOpenRow,
  onResize,
  onFit,
  topRef,
  busy,
  covered = false,
  scrollTop,
}: Props) {
  const frame = useRef<HTMLDivElement>(null)
  // Used up by the first rows: the offset is a scroll offset of this frame,
  // so it is set back as it was, whatever the scale
  const restore = useRef(scrollTop)
  const coarse = useMediaQuery('(pointer: coarse)')
  const headerHeight = coarse ? TOUCH_ROW_HEIGHT : ROW_HEIGHT
  // One height for every row, taller while a column wraps
  const rowHeight = rowHeightFor(coarse, wrapped.size > 0)
  const [view, setView] = useState({ top: 0, height: 0 })
  // The cell keyboard focus moves from: its place in rows, and its column
  const [active, setActive] = useState({ pos: 0, col: 0 })
  const focusing = useRef(false)

  useLayoutEffect(() => {
    const el = frame.current as HTMLDivElement
    const read = () => setView({ top: el.scrollTop, height: el.clientHeight })
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
  const col = Math.min(active.col, names.length - 1)
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
    if (!focusing.current) return
    focusing.current = false
    frame.current
      ?.querySelector<HTMLElement>(`[data-pos="${pos}"][data-col="${col}"]`)
      ?.focus()
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
    const key = moves[e.key]
    if (!key) return
    const move = onCell ? key : [0, 0]
    e.preventDefault()
    const next = {
      pos: Math.max(0, Math.min(rows.length - 1, pos + move[0])),
      col: Math.max(-1, Math.min(names.length - 1, col + move[1])),
    }
    // Scroll the row into view below the sticky header
    const el = frame.current as HTMLDivElement
    const y = next.pos * rowHeight
    const now = el.scrollTop * scale
    if (y < now) el.scrollTop = y / scale
    else if (y + headerHeight + rowHeight > now + height) {
      el.scrollTop = (y + headerHeight + rowHeight - height) / scale
    }
    focusing.current = true
    setActive(next)
    setView({ top: el.scrollTop, height: el.clientHeight })
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-pos]')
    if (!cell) return
    const at = { pos: Number(cell.dataset.pos), col: Number(cell.dataset.col) }
    setActive(at)
    if (at.col >= 0) onOpen(rows[at.pos], at.col)
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
  const template = [
    `calc(${numberWidth}ch + 1rem)`,
    ...widths.map((w, c) => `calc(var(--w-${c}, ${w}ch) + 1rem)`),
  ].join(' ')
  // Row 0 is the header row when there is one; a synthetic header otherwise
  const ariaRow = (r: number) => r + (header ? 1 : 2)

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
      className="min-h-0 flex-1 overflow-auto bg-bg font-term text-[12px] text-fg"
      data-scroll-restore
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <div className="w-max min-w-full">
        <div
          role="row"
          aria-rowindex={1}
          className="sticky top-0 z-10 grid h-8 border-b border-border bg-surface pointer-coarse:h-touch"
          style={{ gridTemplateColumns: template }}
        >
          <div
            role="columnheader"
            // Above the resize handles of the columns scrolled under it
            className="sticky left-0 z-30 bg-surface px-2"
            aria-label="Row"
          />
          {names.map((name, c) => {
            const dir = sort?.col === c ? sort.dir : undefined
            const Arrow = dir === 'desc' ? ArrowDown : ArrowUp
            const label = cellText(name)
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its index
                key={c}
                role="columnheader"
                // Its name only, not its resize handle's
                aria-label={label}
                aria-sort={
                  dir === 'asc'
                    ? 'ascending'
                    : dir === 'desc'
                      ? 'descending'
                      : 'none'
                }
                className="relative flex min-w-0"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (performance.now() - touchUp.current >= TOUCH_CLICK_MS) {
                      onSort(c)
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
              className="grid overflow-hidden border-b border-border/50"
              style={{ gridTemplateColumns: template, height: rowHeight }}
            >
              <div
                role="rowheader"
                aria-label={label}
                title={odd ? label : undefined}
                className={`sticky left-0 bg-bg tabular-nums ${odd ? 'text-warning' : 'text-fg-subtle'}`}
              >
                <button
                  type="button"
                  data-pos={p}
                  data-col={-1}
                  tabIndex={p === pos && col === -1 ? 0 : -1}
                  aria-label={`Open row ${r + 1} as a record`}
                  className={`h-full w-full px-2 text-right ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  {r + 1}
                </button>
              </div>
              {names.map((_, c) => {
                const wrap = wrapped.has(c)
                const shown = shownAt(text, table, r, c, wrap)
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its column
                    key={c}
                    type="button"
                    role="gridcell"
                    data-pos={p}
                    data-col={c}
                    tabIndex={p === pos && c === col ? 0 : -1}
                    title={shown}
                    className={wrap ? WRAP_CELL : CELL}
                  >
                    {wrap ? (
                      <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">
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
