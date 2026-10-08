// biome-ignore-all lint/a11y/useSemanticElements: a virtual grid needs block rows between spacers, which <table> layout does not allow; the roles give the semantics
// biome-ignore-all lint/a11y/useFocusableInteractive: only cells take focus (roving, arrow keys); rows and headers are structure
import { ArrowDown, ArrowUp } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useMediaQuery } from '../hooks/use-media-query'
import { type CsvTable, cellsIn, valueAt } from '../utils/csv-parse'
import type { ViewOptions } from '../utils/csv-view'
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
// Row heights: h-8, and the 44px touch target on a coarse pointer
const ROW_HEIGHT = 32
const TOUCH_ROW_HEIGHT = 44
// Viewport assumed until the frame has a size (a test, the first frame)
const FALLBACK_HEIGHT = 600
// Tallest scroll height used: browsers cap an element's height (Firefox near
// 17.9 million px), and a 1 MiB file of empty lines is a million rows. Past
// it, a scroll offset maps onto the rows in proportion.
export const MAX_SCROLL_HEIGHT = 8_000_000

const CELL = `truncate px-2 text-left ${FOCUS_RING} focus-visible:-outline-offset-2`

interface Props {
  text: string
  table: CsvTable
  // File row indices, in the order shown (the header row is never one)
  rows: Int32Array
  // Columns rendered, their names and widths (in ch)
  names: string[]
  widths: number[]
  header: boolean
  // Cells a row should have; any other count is flagged
  expected: number
  sort: ViewOptions['sort']
  onSort: (col: number) => void
  onOpen: (row: number, col: number) => void
  busy: boolean
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
  header,
  expected,
  sort,
  onSort,
  onOpen,
  busy,
}: Props) {
  const frame = useRef<HTMLDivElement>(null)
  const coarse = useMediaQuery('(pointer: coarse)')
  const rowHeight = coarse ? TOUCH_ROW_HEIGHT : ROW_HEIGHT
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

  const height = view.height || FALLBACK_HEIGHT
  const content = rows.length * rowHeight
  const total = Math.min(content, MAX_SCROLL_HEIGHT)
  // Content pixels per scroll pixel: 1 unless the rows are taller than
  // MAX_SCROLL_HEIGHT
  const scale =
    content > total && total > height
      ? (content - height) / (total - height)
      : 1
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
  const col = Math.min(active.col, names.length - 1)

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
      PageUp: [-Math.floor(height / rowHeight), 0],
      PageDown: [Math.floor(height / rowHeight), 0],
    }
    const key = moves[e.key]
    if (!key) return
    const move = onCell ? key : [0, 0]
    e.preventDefault()
    const next = {
      pos: Math.max(0, Math.min(rows.length - 1, pos + move[0])),
      col: Math.max(0, Math.min(names.length - 1, col + move[1])),
    }
    // Scroll the row into view below the sticky header
    const el = frame.current as HTMLDivElement
    const y = next.pos * rowHeight
    const now = el.scrollTop * scale
    if (y < now) el.scrollTop = y / scale
    else if (y + 2 * rowHeight > now + height) {
      el.scrollTop = (y + 2 * rowHeight - height) / scale
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
    onOpen(rows[at.pos], at.col)
  }

  const numberWidth = String(table.rowCount).length + 1
  const template = [numberWidth, ...widths]
    .map((w) => `calc(${w}ch + 1rem)`)
    .join(' ')
  const rowHeightClass = 'h-8 pointer-coarse:h-touch'
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
      className="min-h-0 flex-1 overflow-auto bg-bg font-term text-[12px] text-fg"
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <div className="w-max min-w-full">
        <div
          role="row"
          aria-rowindex={1}
          className={`sticky top-0 z-10 grid border-b border-border bg-surface ${rowHeightClass}`}
          style={{ gridTemplateColumns: template }}
        >
          <div
            role="columnheader"
            className="sticky left-0 z-10 bg-surface px-2"
            aria-label="Row"
          />
          {names.map((name, c) => {
            const dir = sort?.col === c ? sort.dir : undefined
            const Arrow = dir === 'desc' ? ArrowDown : ArrowUp
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its index
                key={c}
                role="columnheader"
                aria-sort={
                  dir === 'asc'
                    ? 'ascending'
                    : dir === 'desc'
                      ? 'descending'
                      : 'none'
                }
                className="flex min-w-0"
              >
                <button
                  type="button"
                  onClick={() => onSort(c)}
                  title={cellText(name)}
                  className={`${CELL} flex flex-1 items-center gap-1 font-semibold`}
                >
                  <bdi className="truncate">{cellText(name)}</bdi>
                  {dir && (
                    <Arrow
                      size={12}
                      aria-hidden="true"
                      className="shrink-0 text-accent"
                    />
                  )}
                </button>
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
              className={`grid border-b border-border/50 ${rowHeightClass}`}
              style={{ gridTemplateColumns: template }}
            >
              <div
                role="rowheader"
                aria-label={label}
                title={odd ? label : undefined}
                className={`sticky left-0 flex items-center justify-end bg-bg px-2 tabular-nums ${odd ? 'text-warning' : 'text-fg-subtle'}`}
              >
                {r + 1}
              </div>
              {names.map((_, c) => {
                const shown = shownAt(text, table, r, c)
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
                    className={CELL}
                  >
                    <bdi>{shown}</bdi>
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
