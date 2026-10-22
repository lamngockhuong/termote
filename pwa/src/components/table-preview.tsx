import { Columns3, ListPlus, Redo2, Undo2 } from 'lucide-react'
import {
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useCsvFind } from '../hooks/use-csv-find'
import {
  type CsvTableState,
  useCsvRows,
  useCsvTable,
} from '../hooks/use-csv-table'
import { useMediaQuery } from '../hooks/use-media-query'
import {
  filledCells,
  makeOp,
  redoOp,
  type TableAction,
  type TableOp,
  undoOp,
} from '../utils/csv-edits'
import { matchFrom } from '../utils/csv-find'
import {
  type CsvTable,
  cellsIn,
  DELIMITER_NAMES,
  type Delimiter,
  delimiterFor,
  valueAt,
} from '../utils/csv-parse'
import type { ViewOptions } from '../utils/csv-view'
import {
  emptyLayout,
  FIT_BUDGET_MS,
  FIT_ROWS,
  fitWidths,
  initialWidths,
  moveColumns,
  movedColumn,
  type ReadCell,
  shownColumns,
  type TableLayout,
  WRAP_LINE_CHOICES,
  WRAP_LINES,
} from '../utils/table-columns'
import { fromTsv, toTsv } from '../utils/tsv-clipboard'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { CellEditSheet } from './cell-edit-sheet'
import { CellSheet } from './cell-sheet'
import { CodeBlock } from './code-block'
import { type CellMove, InlineCellEditor } from './inline-cell-editor'
import { ViewMessage } from './pane-dir-header'
import { TableColumnMenu } from './table-column-menu'
import { type FindFlags, TableFindBar } from './table-find-bar'
import {
  cellText,
  type GridCell,
  type GridRange,
  MAX_CELL_CHARS,
  shownAt,
  TableGrid,
} from './table-grid'
import { TableRecords } from './table-records'
import { Banner } from './ui/banner'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuItemCheckbox,
  MenuItemRadio,
  MenuSeparator,
} from './ui/menu'

// Columns rendered: a 1 MiB file of commas would otherwise be a million
export const MAX_COLUMNS = 200
// Cells one copy, or one paste, takes at most
export const MAX_COPY_CELLS = 100_000

export interface TableState {
  ok: boolean
  delimiter: Delimiter
}

// The table is a draft being edited (FileViewer): text is the draft's
export interface TableEditing {
  // The delimiter edits are written with; it cannot change meanwhile
  delimiter: Delimiter
  // The edits that made text, and the ones undone
  ops: TableOp[]
  redo: TableOp[]
  // A save runs: nothing changes until it ends
  saving: boolean
  // Ctrl+S would save now
  canSave: boolean
  onChange: (text: string, ops: TableOp[], redo: TableOp[]) => void
  onSave: () => void
}

interface Props {
  text: string
  path: string
  // For the source shown when the table cannot be read
  wrap: boolean
  notify: (message: string) => void
  // The table was read (or not) with this delimiter: told after every
  // parse, and undefined while one runs
  onTableState?: (state: TableState | undefined) => void
  editing?: TableEditing
  // Where the grid starts scrolled to (a tab shown again)
  scrollTop?: number
  // Widths and wrapped columns the tab kept, taken as it mounts when set
  // under the same delimiter and header row; told each time they change
  layout?: TableLayout
  onLayout?: (layout: TableLayout) => void
  // A table only viewed, of a file that can be edited: a cell clicked with
  // a fine pointer asks for editing. True when it started (it may ask about
  // the delimiter first), and the cell opens in its field once it can.
  onRequestEdit?: () => boolean
}

const layoutKey = (delimiter: Delimiter, header: boolean) =>
  `${delimiter}|${header ? 1 : 0}`

// A cell opened (file row, column) on the text it was opened on: another
// text closes it, its row may have moved
interface OpenCell {
  row: number
  col: number
  text: string
}

// A cell asked for by a key typed on it: input replaces its value
interface CellAt {
  row: number
  col: number
  input?: string
}

// The values a column delete takes with it
const countText = (n: number) =>
  n === 0
    ? 'It has no values.'
    : `${n} ${n === 1 ? 'cell with a value goes' : 'cells with a value go'} with it.`

type ColumnOp = Extract<TableOp, { kind: 'insert-col' | 'delete-col' }>

const NO_FLAGS: FindFlags = { matchCase: false, wholeCell: false, regex: false }

// A value a cell's own field can take: whole, and with no character the
// field would hide, reorder, or change (\r\n read back as \n). Any other
// opens in the sheet, which shows them.
const editableInline = (value: string) =>
  value.length <= MAX_CELL_CHARS &&
  !value.includes('\r') &&
  visibleUnsafe(value, true) === value

// A CSV/TSV file as a table: a virtual grid, or one record at a time.
// Sorting, filtering, the delimiter and the header row change only what is
// shown, never the file. While editing, a cell opens in a sheet that sets
// it, or with a fine pointer in its own field; every edit is a patch of the
// text (csv-edits.ts), made only on the parse of that very text.
export default function TablePreview({
  text,
  path,
  wrap,
  notify,
  onTableState,
  editing,
  scrollTop,
  layout: kept,
  onLayout,
  onRequestEdit,
}: Props) {
  const [chosen, setDelimiter] = useState(() => delimiterFor(path, text))
  const delimiter = editing?.delimiter ?? chosen
  const [header, setHeader] = useState(true)
  // Widths set by hand and wrapped columns: kept while the text changes (an
  // edit, the file changed on the host), dropped with the delimiter or the
  // header row, which make other columns
  const [layout, setLayoutState] = useState(() => {
    const key = layoutKey(delimiter, header)
    return kept?.key === key ? kept : emptyLayout(key)
  })
  const setLayout = (next: TableLayout) => {
    setLayoutState(next)
    onLayout?.(next)
  }
  // The record shown, as a file row (a sort or a filter moves its place)
  const [recordRow, setRecordRow] = useState<number>()
  // Place in rows of the first row in view of the grid
  const topRef = useRef(0)
  // Opened from a row number: the grid it had the focus in is covered, so
  // the focus goes to the record
  const recordsBox = useRef<HTMLDivElement>(null)
  const focusRecords = useRef(false)
  const [filterInput, setFilterInput] = useState('')
  const filter = useDeferredValue(filterInput)
  const [sort, setSort] = useState<ViewOptions['sort']>(null)
  const [records, setRecords] = useState(false)
  useEffect(() => {
    if (!records || !focusRecords.current) return
    focusRecords.current = false
    recordsBox.current?.focus()
  }, [records])
  // The cell opened in a sheet, with what was typed in its own field
  // before, if any
  const [open, setOpen] = useState<OpenCell & { input?: string }>()
  // The cell edited where it is (a fine pointer), with the key typed on it
  // that it starts from, if any
  const [inline, setInline] = useState<OpenCell & { input?: string }>()
  const fine = useMediaQuery('(pointer: fine)')
  // The cell clicked as editing was asked for, opened once it can be
  const [pending, setPending] = useState<CellAt>()
  // Ctrl+S in a cell's field: the file is saved once the value is in it
  const saveNext = useRef(false)
  // The text now: a field unmounted by another text sets its value with
  // the callback of the render before, whose text is the old one
  const textNow = useRef(text)
  textNow.current = text
  // The row a delete asks about, and the text it was asked on: another
  // text (an edit made elsewhere) may have moved that row
  const [deleting, setDeleting] = useState<{ row: number; text: string }>()
  // The same for a column; and the column whose name is edited in its
  // header, on the text it was opened on
  const [deletingCol, setDeletingCol] = useState<{
    // Cells with a value it takes with it
    values: number
    col: number
    text: string
  }>()
  const [renaming, setRenaming] = useState<{ col: number; text: string }>()
  // A block longer than the rows left, asking to add rows at the end
  const [pasting, setPasting] = useState<{
    cells: { row: number; col: number; value: string }[]
    addRows: number
    text: string
  }>()
  const { parsed: current, client } = useCsvTable(text, delimiter)
  // While an edit of a large file parses, its last table stays on screen,
  // locked: no edit is made on the ranges of an older text
  const lastReady = useRef<CsvTableState>(undefined)
  if (current.status !== 'parsing') lastReady.current = current
  const parsed =
    editing && current.status === 'parsing' && lastReady.current
      ? lastReady.current
      : current
  const stale = parsed !== current
  // The text the table on screen was read from
  const shown = parsed.status === 'parsing' ? text : parsed.text
  const computed = useCsvRows(parsed, client, sort, filter, header)

  useEffect(() => {
    if (!saveNext.current) return
    saveNext.current = false
    if (editing?.canSave && !editing.saving) editing.onSave()
  })

  useEffect(() => {
    onTableState?.(
      current.status === 'parsing'
        ? undefined
        : { ok: current.status === 'ready', delimiter: current.delimiter },
    )
  }, [current, onTableState])

  useEffect(() => {
    setOpen((o) => (o && o.text !== text ? undefined : o))
    setInline((i) => (i && i.text !== text ? undefined : i))
    setDeleting((d) => (d && d.text !== text ? undefined : d))
    setDeletingCol((d) => (d && d.text !== text ? undefined : d))
    setRenaming((r) => (r && r.text !== text ? undefined : r))
    setPasting((b) => (b && b.text !== text ? undefined : b))
  }, [text])

  // While the worker sorts or filters, the last rows of this table stay
  const last = useRef<{ parsed: CsvTableState; rows: Int32Array }>(undefined)
  if (computed) last.current = { parsed, rows: computed }
  const rows =
    computed ??
    (last.current?.parsed === parsed ? last.current.rows : undefined)

  const table = parsed.status === 'ready' ? parsed.table : undefined
  const names = useMemo(() => {
    if (!table) return []
    const n = Math.min(table.columnCount, MAX_COLUMNS)
    return Array.from({ length: n }, (_, c) => {
      const name = header ? valueAt(shown, table, 0, c, MAX_CELL_CHARS + 1) : ''
      return name || `Column ${c + 1}`
    })
  }, [shown, table, header])
  // Called only once there is a table (its widths, a fit)
  const read = useCallback<ReadCell>(
    (r, c, multiline) => shownAt(shown, table as CsvTable, r, c, multiline),
    [shown, table],
  )
  const autoWidths = useMemo(
    () =>
      table
        ? initialWidths(
            read,
            table.rowCount,
            names.map((n) => cellText(n)),
          )
        : [],
    [read, table, names],
  )
  const widths = autoWidths.map((w, c) => layout.widths[c] ?? w)
  const wrapped = useMemo(
    () => new Set(layout.wrapped.filter((c) => c < names.length)),
    [layout.wrapped, names.length],
  )
  const lines = layout.lines ?? WRAP_LINES
  // The columns shown, in order; a hidden one past the columns read is
  // nothing
  const cols = useMemo(
    () => shownColumns(names.length, layout.hidden ?? []),
    [names.length, layout.hidden],
  )
  const hiddenCount = names.length - cols.length

  // Find: open or not, what is typed and how; F3 still finds what was
  // typed once it closed, opening it again. Nothing is searched while it
  // is closed.
  const [finding, setFinding] = useState(false)
  const [findInput, setFindInput] = useState('')
  const findQuery = useDeferredValue(findInput)
  const [findFlags, setFindFlags] = useState(NO_FLAGS)
  const findOpts = useMemo(
    () => ({ ...findFlags, query: finding ? findQuery : '' }),
    [findFlags, finding, findQuery],
  )
  const findBox = useRef<HTMLInputElement>(null)
  const focusFind = useRef(false)
  const found = useCsvFind(shown, delimiter, table, rows, cols, findOpts)
  const matchCount = found.matches.length >> 1
  // The match gone to last: a cell of the file, and its place in rows then
  const [hit, setHit] = useState<{ row: number; col: number; pos: number }>()
  // The current match: that cell while it still matches, else the first
  // match after where it was (from the top when none was gone to)
  const currentMatch = useMemo(() => {
    if (!matchCount) return -1
    if (!hit || !rows) return 0
    let pos = rows.indexOf(hit.row)
    let at = cols.indexOf(hit.col)
    // Filtered out: from its place in the rows of then. Its column hidden:
    // from the next column shown, in the order of the file.
    if (pos < 0) pos = hit.pos
    if (at < 0) at = cols.findIndex((c) => c > hit.col)
    if (at < 0) {
      pos++
      at = 0
    }
    const k = matchFrom(found.matches, pos, at)
    return k < matchCount ? k : 0
  }, [found.matches, matchCount, hit, rows, cols])
  const matchAt = (k: number): GridCell => ({
    pos: found.matches[2 * k],
    at: found.matches[2 * k + 1],
  })
  // A move asked for, made once the matches of now are in: to the next (1)
  // or previous (-1) match, or to the current one (0)
  const [move, setMove] = useState<{ step: -1 | 0 | 1 }>()
  const [goTo, setGoTo] = useState<{
    seq: number
    cell?: GridCell
    focus?: boolean
  }>()
  const goSeq = useRef(0)
  const goToCell = (cell?: GridCell, focus?: boolean) =>
    setGoTo({ seq: ++goSeq.current, cell, focus })
  // Another query or option: to the match at the current one or after
  const lastOpts = useRef(findOpts)
  useEffect(() => {
    if (lastOpts.current === findOpts) return
    lastOpts.current = findOpts
    if (findOpts.query) setMove((m) => m ?? { step: 0 })
  })
  // Edits are taken only on the current parse of text, outside a save
  const live =
    editing && !editing.saving && !stale && table ? editing : undefined

  // The layout and the sort follow the draft's column ops: kept for those
  // it still begins with, moved back for the ones gone (undone, dropped,
  // or replaced as a reload applied them again), moved on for the new
  // ones. Out of editing, a text that is the last one edited was saved, and
  // its ops are the file's now.
  const followed = useRef<{ ops: ColumnOp[]; all: TableOp[]; text?: string }>({
    ops: [],
    all: [],
  })
  useEffect(() => {
    const was = followed.current
    const all = editing?.ops ?? []
    const want = all.filter(
      (op): op is ColumnOp =>
        op.kind === 'insert-col' || op.kind === 'delete-col',
    )
    let have = was.ops
    // A save that ran while more edits were made: those it saved are the
    // file's
    const saved = all.length ? was.all.indexOf(all[0]) : -1
    if (saved > 0)
      have = have.filter((op) => !was.all.slice(0, saved).includes(op))
    if (!editing && was.text === text.replace(/\r\n/g, '\n')) have = []
    followed.current = { ops: want, all, text: editing && text }
    let p = 0
    while (p < have.length && p < want.length && have[p] === want[p]) p++
    if (p === have.length && p === want.length) return
    let next = layout
    let nextSort = sort
    const move = (op: ColumnOp, undone: boolean) => {
      const col =
        op.col + (op.kind === 'insert-col' && op.side === 'right' ? 1 : 0)
      const added = (op.kind === 'insert-col') !== undone
      next = moveColumns(next, col, added)
      if (!nextSort) return
      const to = movedColumn(nextSort.col, col, added)
      nextSort = to === undefined ? null : { ...nextSort, col: to }
    }
    for (let i = have.length - 1; i >= p; i--) move(have[i], true)
    for (let i = p; i < want.length; i++) move(want[i], false)
    setLayout(next)
    setSort(nextSort)
  })

  // Makes the action an op on text; the text it makes, if any
  const act = (a: TableAction): string | undefined => {
    if (!live) return
    const op = makeOp(text, table as CsvTable, a, header)
    if (!op) return
    const next = redoOp(text, op)
    live.onChange(next, [...live.ops, op], [])
    return next
  }
  const undo = () => {
    const op = live?.ops[live.ops.length - 1]
    if (!live || !op) return
    live.onChange(undoOp(text, op), live.ops.slice(0, -1), [...live.redo, op])
  }
  const redo = () => {
    const op = live?.redo[live.redo.length - 1]
    if (!live || !op) return
    live.onChange(redoOp(text, op), [...live.ops, op], live.redo.slice(0, -1))
  }
  // A column's name, edited in its header when its field can take it, else
  // in the sheet of the header row's cell
  // A touch screen keeps the sheet (as for a cell)
  const rename = (col: number) => {
    const name = valueAt(text, table as CsvTable, 0, col, MAX_CELL_CHARS + 1)
    if (fine && editableInline(name)) setRenaming({ col, text })
    else openSheet(0, col)
  }
  const insertColumn = (col: number, side: 'left' | 'right') => {
    const next = act({ kind: 'insert-col', col, side })
    if (next === undefined || !header) return
    // Its name typed at once, when the table has names
    const at = { col: col + (side === 'right' ? 1 : 0), text: next }
    if (fine) setRenaming(at)
    else setOpen({ ...at, row: 0 })
  }
  // A new empty row after row `after`, its first cell opened
  const addRow = (after: number) => {
    const next = act({ kind: 'insert', after })
    if (next !== undefined) setOpen({ row: after + 1, col: 0, text: next })
  }
  const openSheet = (row: number, col: number, input?: string) => {
    if (!editing || live) setOpen({ row, col, text, input })
  }
  // A cell of the grid: in its own field when it can take the value;
  // input, a key typed on it, replaces the value
  const openCell = (row: number, col: number, input?: string) => {
    if (!editing && fine && onRequestEdit) {
      if (onRequestEdit()) setPending({ row, col, input })
      return
    }
    if (
      live &&
      fine &&
      editableInline(
        valueAt(text, table as CsvTable, row, col, MAX_CELL_CHARS + 1),
      )
    ) {
      setInline({ row, col, text, input })
    } else openSheet(row, col, input)
  }
  // Keys that edit a cell, as a spreadsheet's: only with a fine pointer
  // and a keyboard (a touch screen's keyboard types in no cell), on a table
  // that takes edits now or can be asked for them
  const canType = fine && (editing ? !!live || !!pending : !!onRequestEdit)
  // Keys typed while the cell asked for waits for editing go to it too
  const typeIn = (row: number, col: number, input: string) => {
    if (pending)
      setPending({ ...pending, input: (pending.input ?? '') + input })
    else openCell(row, col, input)
  }
  const clearCell = (row: number, col: number) => {
    act({ kind: 'cell', row, col, name: names[col], value: '' })
  }
  // Every cell of a range along the rows and columns shown, as one edit;
  // the cells already empty change nothing
  const clearRange = (r: GridRange) => {
    const n = (r.bottom - r.top + 1) * (r.right - r.left + 1)
    if (n > MAX_COPY_CELLS) {
      notify(`Too many cells to clear: ${n}, at most ${MAX_COPY_CELLS}`)
      return
    }
    const order = computed as Int32Array
    const cells: { row: number; col: number; value: string }[] = []
    for (let p = r.top; p <= r.bottom; p++) {
      for (let i = r.left; i <= r.right; i++) {
        cells.push({ row: order[p], col: cols[i], value: '' })
      }
    }
    act({ kind: 'cells', cells })
  }
  // The cell after (or before) at in the order shown: on along its row,
  // then from the start of the next one; none past the last cell. Only
  // from a field on screen, so with the rows it is in.
  const neighbour = (at: OpenCell, move: CellMove) => {
    const order = computed as Int32Array
    const pos = order.indexOf(at.row)
    // Along the columns shown: a field shows only in one
    const i = cols.indexOf(at.col)
    if (move === 'next') {
      if (i + 1 < cols.length) return { row: at.row, col: cols[i + 1] }
      return pos + 1 < order.length
        ? { row: order[pos + 1], col: cols[0] }
        : undefined
    }
    if (i > 0) return { row: at.row, col: cols[i - 1] }
    return pos > 0
      ? { row: order[pos - 1], col: cols[cols.length - 1] }
      : undefined
  }
  // Sets the cell at to value (when it changed), then goes on to the cell
  // move reaches, if its value can be edited there; save: the file is saved
  // after it
  const commitInline = (
    at: OpenCell,
    value: string,
    move?: CellMove,
    save?: boolean,
  ) => {
    // A field shows only on a table of its text; on another, the effect
    // on text closes it
    if (at.text !== textNow.current) return
    setInline(undefined)
    const t = table as CsvTable
    const target = move && neighbour(at, move)
    const next =
      value === valueAt(text, t, at.row, at.col)
        ? text
        : act({
            kind: 'cell',
            row: at.row,
            col: at.col,
            name: names[at.col],
            value,
          })
    if (next === undefined) return
    if (save) saveNext.current = true
    if (
      target &&
      editableInline(
        valueAt(text, t, target.row, target.col, MAX_CELL_CHARS + 1),
      )
    ) {
      setInline({ ...target, text: next })
    }
  }

  // Editing asked for by a click: the cell opens on the draft's first
  // parse (rows are the same, its text may differ: \r\n read as \n).
  // Editing given up before that drops it.
  const wasEditing = useRef(!!editing)
  useEffect(() => {
    const was = wasEditing.current
    wasEditing.current = !!editing
    if (was && !editing) setPending(undefined)
    if (!pending || !live) return
    setPending(undefined)
    openCell(pending.row, pending.col, pending.input)
  })

  useEffect(() => {
    if (!focusFind.current) return
    focusFind.current = false
    findBox.current?.focus()
    findBox.current?.select()
  })

  // Not on the rows of an older table, nor before the matches are in
  useEffect(() => {
    // Typed just before: the matches are still those of the last query
    const waiting = found.status === 'busy' || findQuery !== findInput
    if (!move || waiting || !computed || stale) return
    setMove(undefined)
    if (!matchCount) return
    const k = (currentMatch + move.step + matchCount) % matchCount
    const cell = matchAt(k)
    const row = computed[cell.pos]
    setHit({ row, col: cols[cell.at], pos: cell.pos })
    if (records) setRecordRow(row)
    goToCell(cell)
  })

  // Its query chosen, to type over
  const openFind = () => {
    const box = findBox.current
    if (box) {
      box.focus()
      box.select()
      return
    }
    setFinding(true)
    focusFind.current = true
  }
  // Back on the current match, or the active cell
  const closeFind = () => {
    setFinding(false)
    if (records) recordsBox.current?.focus()
    else goToCell(matchCount ? matchAt(currentMatch) : undefined, true)
  }
  const stepFind = (step: 1 | -1) => {
    setFinding(true)
    setMove({ step })
  }

  // The table's own keys; never one typed in a field or in a sheet (a
  // <dialog> in this tree, so its keys bubble here)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const plain = !(e.ctrlKey || e.metaKey || e.altKey)
    if (e.key === 'F3' && plain && !target.closest('dialog')) {
      e.preventDefault()
      if (!findInput) {
        openFind()
        return
      }
      // A cell's field is set first, as when it is left
      const grid = target.closest('[role="grid"]') as HTMLElement | null
      if (grid && target.tagName === 'TEXTAREA') grid.focus()
      stepFind(e.shiftKey ? -1 : 1)
      return
    }
    if (!(e.ctrlKey || e.metaKey)) return
    if (target.closest('dialog, input, textarea, select')) return
    const key = e.key.toLowerCase()
    // Not with Shift or Alt (AltGr types a character)
    if (key === 'f' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      openFind()
      return
    }
    if (!editing) return
    if (key === 's') {
      e.preventDefault()
      if (editing.canSave && !editing.saving) editing.onSave()
    } else if (key === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
  }

  if (parsed.status === 'parsing') {
    return (
      <div aria-busy="true" className="flex flex-1">
        <ViewMessage>Reading the table…</ViewMessage>
      </div>
    )
  }
  if (parsed.status === 'error') {
    return (
      <>
        <Banner variant="warning">
          Unclosed quote on line {parsed.line}: shown as source
        </Banner>
        <CodeBlock text={parsed.text} path={path} wrap={wrap} />
      </>
    )
  }
  const t = parsed.table
  if (!t.rowCount) {
    return (
      <ViewMessage>
        No rows
        {editing && (
          <Button size="sm" disabled={!live} onClick={() => addRow(-1)}>
            Add a row
          </Button>
        )}
      </ViewMessage>
    )
  }

  const total = t.rowCount - (header ? 1 : 0)
  const expected = header ? cellsIn(t, 0) : t.columnCount
  // A fit reads the rows on screen: never the rows of an older table, nor
  // none while they are worked out
  const canFit = !!computed && !stale
  const fitColumns = (cols: number[], pos: number) => {
    if (!canFit) return
    const widths = fitWidths(
      read,
      computed.subarray(pos, pos + FIT_ROWS),
      names.map((n) => cellText(n)),
      cols,
      wrapped,
      layout.widths,
      performance.now() + FIT_BUDGET_MS,
    )
    setLayout({ ...layout, widths })
  }
  const resize = (col: number, width: number) =>
    setLayout({ ...layout, widths: { ...layout.widths, [col]: width } })
  const toggleWrap = (col: number) =>
    setLayout({
      ...layout,
      wrapped: wrapped.has(col)
        ? layout.wrapped.filter((c) => c !== col)
        : [...layout.wrapped, col],
    })
  // Only what is shown changes: a hidden column is still filtered on. A
  // sort by it goes, its arrow being gone with it.
  const toggleShown = (col: number) => {
    const hidden = (layout.hidden ?? []).filter((c) => c < names.length)
    if (!hidden.includes(col) && sort?.col === col) setSort(null)
    setLayout({
      ...layout,
      hidden: hidden.includes(col)
        ? hidden.filter((c) => c !== col)
        : [...hidden, col],
    })
  }
  const openRecord = (row: number) => {
    setRecordRow(row)
    setRecords(true)
    focusRecords.current = true
  }
  const toggleSort = (col: number) =>
    setSort((s) =>
      s?.col !== col
        ? { col, dir: 'asc' }
        : s.dir === 'asc'
          ? { col, dir: 'desc' }
          : null,
    )
  // Not before the text's own parse is on screen: a row just added is not
  // in the older table yet
  const cell = open &&
    open.text === text &&
    !stale && {
      row: open.row,
      name: names[open.col],
      value: open.input ?? valueAt(shown, t, open.row, open.col),
    }
  // The same for a cell's own field, and not while the rows are worked
  // out (their order on screen is the old one); while a save runs it
  // stays, and whatever it sets is dropped (act)
  const field = inline?.text === text && !stale && computed ? inline : undefined
  const headerField = renaming?.text === text && live ? renaming : undefined
  const shownRows = rows ?? new Int32Array()
  // A range as text a spreadsheet takes: whole values, in the order shown
  const copyRange = (r: GridRange) => {
    const n = (r.bottom - r.top + 1) * (r.right - r.left + 1)
    if (n > MAX_COPY_CELLS) {
      notify(`Too many cells to copy: ${n}, at most ${MAX_COPY_CELLS}`)
      return
    }
    const values: string[][] = []
    for (let p = r.top; p <= r.bottom; p++) {
      values.push(
        cols
          .slice(r.left, r.right + 1)
          .map((c) => valueAt(shown, t, shownRows[p], c)),
      )
    }
    return toTsv(values)
  }
  // A block pasted from the range's top-left cell: along the rows and
  // columns shown, as one edit. A range as many blocks tall and wide as it
  // holds whole (one cell: any range) gets the block over and over, as a
  // spreadsheet does. Wider than the columns left, it is refused; longer
  // than the rows left, rows are added at the end, asked first, and only in
  // the file's order.
  const pasteBlock = (r: GridRange, clip: string) => {
    const block = fromTsv(clip)
    if (!block.length) return
    const order = computed as Int32Array
    let width = 0
    let n = 0
    for (const row of block) {
      width = Math.max(width, row.length)
      n += row.length
    }
    const tall = r.bottom - r.top + 1
    const wide = r.right - r.left + 1
    // A range the block fits exactly is the same as once
    const fills = tall % block.length === 0 && wide % width === 0
    const down = fills ? tall / block.length : 1
    const across = fills ? wide / width : 1
    const repeats = down * across
    if (repeats > 1) n = tall * wide
    if (n > MAX_COPY_CELLS) {
      notify(
        `Too many cells to paste${repeats > 1 ? ' over the range' : ''}: ${n}, at most ${MAX_COPY_CELLS}`,
      )
      return
    }
    const room = cols.length - r.left
    if (width > room) {
      notify(
        `The block is ${width} columns wide; ${room} ${room === 1 ? 'column' : 'columns'} from here`,
      )
      return
    }
    const left = order.length - r.top
    const over = block.length - left
    if (over > 0 && (sort || filter)) {
      notify(
        `The block is ${block.length} rows long; ${left} ${left === 1 ? 'row' : 'rows'} from here, and no row is added while sorted or filtered`,
      )
      return
    }
    const cells: { row: number; col: number; value: string }[] = []
    for (let i = 0; i < block.length * down; i++) {
      // Past the rows shown (the file's own order): a row added
      const row = i < left ? order[r.top + i] : t.rowCount + i - left
      const values = block[i % block.length]
      // Repeated, a short line's missing cells are empty, as in a spreadsheet
      const count = repeats > 1 ? width : values.length
      for (let k = 0; k < across; k++) {
        for (let j = 0; j < count; j++) {
          cells.push({
            row,
            col: cols[r.left + k * width + j],
            value: values[j] ?? '',
          })
        }
      }
    }
    if (over > 0) setPasting({ cells, addRows: over, text })
    else act({ kind: 'cells', cells })
  }
  // A column's new name, as a cell of the header row; save: the file is
  // saved after it
  const commitName = (
    at: { col: number; text: string },
    value: string,
    save?: boolean,
  ) => {
    if (at.text !== textNow.current) return
    setRenaming(undefined)
    const next =
      value === valueAt(text, t, 0, at.col)
        ? text
        : act({ kind: 'cell', row: 0, col: at.col, name: names[at.col], value })
    if (next !== undefined && save) saveNext.current = true
  }

  return (
    // isolate: the grid's sticky header and the record overlay stack inside
    // the table, never above the viewer header's menu
    <div className="isolate flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-[13px]">
        {editing && (
          <span className="flex items-center gap-1">
            <IconButton
              size="sm"
              aria-label="Undo"
              title="Undo (Ctrl+Z)"
              disabled={!live?.ops.length}
              onClick={undo}
            >
              <Undo2 size={15} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="Redo"
              title="Redo (Ctrl+Shift+Z)"
              disabled={!live?.redo.length}
              onClick={redo}
            >
              <Redo2 size={15} aria-hidden="true" />
            </IconButton>
            <IconButton
              size="sm"
              aria-label="Add a row at the end"
              title="Add a row at the end"
              disabled={!live}
              onClick={() => addRow(t.rowCount - 1)}
            >
              <ListPlus size={15} aria-hidden="true" />
            </IconButton>
          </span>
        )}
        <label className="flex items-center gap-1 text-fg-muted">
          Delimiter
          <select
            value={delimiter}
            disabled={!!editing}
            title={
              editing ? 'Edits are written with this delimiter' : undefined
            }
            onChange={(e) => {
              const next = e.target.value as Delimiter
              setDelimiter(next)
              setSort(null)
              setLayout(emptyLayout(layoutKey(next, header)))
            }}
            className={`h-8 rounded-control border border-border bg-surface px-1.5 text-fg pointer-coarse:h-touch ${FOCUS_RING}`}
          >
            {Object.entries(DELIMITER_NAMES).map(([d, name]) => (
              <option key={name} value={d}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          aria-pressed={header}
          onClick={() => {
            setHeader(!header)
            setLayout(emptyLayout(layoutKey(delimiter, !header)))
          }}
          className={header ? 'text-accent' : ''}
        >
          Header row
        </Button>
        <input
          type="search"
          value={filterInput}
          onChange={(e) => setFilterInput(e.target.value)}
          placeholder="Filter rows"
          aria-label="Filter rows"
          className={`h-8 min-w-0 flex-1 basis-32 rounded-control border border-border bg-surface px-2 text-fg pointer-coarse:h-touch ${FOCUS_RING}`}
        />
        <span className="tabular-nums text-fg-muted" aria-live="polite">
          {rows ? rows.length : '…'} / {total} rows
          {hiddenCount > 0 && (
            <span title="Filter rows also searches hidden columns">
              {' '}
              · {hiddenCount} {hiddenCount === 1 ? 'column' : 'columns'} hidden
            </span>
          )}
        </span>
        <Button
          size="sm"
          aria-pressed={records}
          onClick={() => setRecords((r) => !r)}
          className={records ? 'text-accent' : ''}
        >
          Records
        </Button>
        <Menu
          label="Columns"
          trigger={<Columns3 size={15} aria-hidden="true" />}
          triggerSize="sm"
          className="max-h-[60vh] overflow-y-auto"
        >
          <MenuItem
            disabled={!canFit}
            onSelect={() => fitColumns(cols, topRef.current)}
          >
            Fit columns
          </MenuItem>
          <MenuItem
            disabled={!Object.keys(layout.widths).length}
            onSelect={() => setLayout({ ...layout, widths: {} })}
          >
            Reset widths
          </MenuItem>
          <MenuItemCheckbox
            keepOpen
            checked={!!layout.pinned}
            title="Keeps the first column shown at the left while the table scrolls sideways, unless it is wider than half the table"
            onSelect={() => setLayout({ ...layout, pinned: !layout.pinned })}
          >
            Pin first column
          </MenuItemCheckbox>
          <MenuSeparator />
          {/* Disabled once it ran: the menu closes rather than keep a
              focus that has nowhere to go */}
          <MenuItem
            disabled={!hiddenCount}
            onSelect={() => setLayout({ ...layout, hidden: [] })}
          >
            Show all
          </MenuItem>
          <MenuGroup label="Show">
            {names.map((name, c) => {
              const shownNow = cols.includes(c)
              return (
                <MenuItemCheckbox
                  // biome-ignore lint/suspicious/noArrayIndexKey: a column is its index
                  key={c}
                  keepOpen
                  checked={shownNow}
                  // The last column shown stays
                  disabled={shownNow && cols.length === 1}
                  onSelect={() => toggleShown(c)}
                >
                  <span className="block truncate">
                    {c + 1} · <bdi>{cellText(name)}</bdi>
                  </span>
                </MenuItemCheckbox>
              )
            })}
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup label="Wrap">
            {names.map((name, c) => (
              <MenuItemCheckbox
                // biome-ignore lint/suspicious/noArrayIndexKey: a column is its index
                key={c}
                keepOpen
                checked={wrapped.has(c)}
                onSelect={() => toggleWrap(c)}
              >
                {/* The number tells apart two columns of one name */}
                <span className="block truncate">
                  {c + 1} · <bdi>{cellText(name)}</bdi>
                </span>
              </MenuItemCheckbox>
            ))}
          </MenuGroup>
          <MenuSeparator />
          {/* One height for every row: the lines any wrapped cell shows */}
          <MenuGroup label="Lines">
            {WRAP_LINE_CHOICES.map((n) => (
              <MenuItemRadio
                key={n}
                keepOpen
                disabled={!wrapped.size}
                checked={lines === n}
                onSelect={() => setLayout({ ...layout, lines: n })}
              >
                {n} lines
              </MenuItemRadio>
            ))}
          </MenuGroup>
        </Menu>
      </div>
      {finding && (
        <TableFindBar
          input={findInput}
          onInput={setFindInput}
          flags={findFlags}
          onFlags={setFindFlags}
          status={found.status}
          count={matchCount}
          current={currentMatch}
          hidden={hiddenCount}
          onStep={stepFind}
          onClose={closeFind}
          inputRef={findBox}
        />
      )}
      {t.columnCount > MAX_COLUMNS && (
        <Banner variant="warning">
          Showing {MAX_COLUMNS} of {t.columnCount} columns. See all in Source
        </Banner>
      )}
      {/* Records cover the grid, which stays laid out: back on it, it is
          where it was left */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TableGrid
          text={shown}
          table={t}
          rows={rows ?? new Int32Array()}
          names={names}
          widths={widths}
          cols={cols}
          wrapped={wrapped}
          lines={lines}
          header={header}
          expected={expected}
          sort={sort}
          onSort={toggleSort}
          onOpen={openCell}
          onType={canType ? typeIn : undefined}
          onClear={fine && live ? clearCell : undefined}
          onClearRange={fine && live && computed ? clearRange : undefined}
          editingCell={field}
          editor={
            field && (
              <InlineCellEditor
                value={valueAt(shown, t, field.row, field.col)}
                initial={field.input}
                label={`Edit ${cellText(names[field.col])}, row ${field.row + 1}`}
                onCommit={(value, move, save) =>
                  commitInline(field, value, move, save)
                }
                onCancel={() => setInline(undefined)}
                onExpand={(input) => {
                  setInline(undefined)
                  setOpen({ ...field, input })
                }}
              />
            )
          }
          onOpenRow={openRecord}
          onResize={resize}
          onFit={(col, pos) => fitColumns([col], pos)}
          topRef={topRef}
          busy={!computed || stale}
          covered={records}
          scrollTop={scrollTop}
          pinned={!!layout.pinned}
          matches={finding ? found.matches : undefined}
          current={matchCount ? matchAt(currentMatch) : undefined}
          goTo={goTo}
          columnMenu={
            live &&
            ((col, row, isOpen, onOpenChange) => (
              <TableColumnMenu
                name={cellText(names[col])}
                open={isOpen}
                onOpenChange={onOpenChange}
                fromCell={row !== undefined}
                canDelete={t.columnCount > 1}
                canRename={header}
                onInsertRow={(side) =>
                  addRow((row as number) - (side === 'above' ? 1 : 0))
                }
                onInsertColumn={(side) => insertColumn(col, side)}
                onDeleteColumn={() =>
                  setDeletingCol({
                    col,
                    text,
                    values: filledCells(text, t, col, header ? 1 : 0),
                  })
                }
                onRename={() => rename(col)}
              />
            ))
          }
          onRename={live && header && fine ? rename : undefined}
          clickSelects={fine}
          onCopyRange={copyRange}
          onPasteBlock={live && computed ? pasteBlock : undefined}
          editingHeader={header ? headerField?.col : undefined}
          headerEditor={
            headerField && (
              <InlineCellEditor
                value={valueAt(shown, t, 0, headerField.col)}
                label={`Rename column ${cellText(names[headerField.col])}`}
                onCommit={(value, _move, save) =>
                  commitName(headerField, value, save)
                }
                onCancel={() => setRenaming(undefined)}
                onExpand={(input) => {
                  setRenaming(undefined)
                  setOpen({ row: 0, col: headerField.col, text, input })
                }}
              />
            )
          }
        />
        {records && (
          <div
            ref={recordsBox}
            tabIndex={-1}
            className="absolute inset-0 z-20 flex flex-col bg-bg outline-none"
          >
            {rows ? (
              <TableRecords
                text={shown}
                table={t}
                rows={rows}
                names={names}
                cols={cols}
                row={recordRow}
                onRow={setRecordRow}
                // The grid, covered, cannot show a cell's own field
                onOpen={openSheet}
              />
            ) : (
              <ViewMessage>Sorting and filtering…</ViewMessage>
            )}
          </div>
        )}
      </div>
      {editing && cell ? (
        <CellEditSheet
          cell={cell}
          onApply={(value) => {
            setOpen(undefined)
            act({
              kind: 'cell',
              row: cell.row,
              col: open.col,
              name: cell.name,
              value,
            })
          }}
          // The header row's own: no row is added or deleted around it
          headerRow={header && cell.row === 0}
          onInsertAbove={() => addRow(cell.row - 1)}
          onInsertBelow={() => addRow(cell.row)}
          onDelete={() => {
            setOpen(undefined)
            setDeleting({ row: cell.row, text })
          }}
          onClose={() => setOpen(undefined)}
          notify={notify}
        />
      ) : (
        <CellSheet
          cell={cell || undefined}
          onClose={() => setOpen(undefined)}
          notify={notify}
        />
      )}
      {deleting?.text === text && (
        <ConfirmDialog
          isOpen
          title={`Delete row ${deleting.row + 1}?`}
          confirmLabel="Delete row"
          destructive
          onConfirm={() => {
            setDeleting(undefined)
            act({ kind: 'delete', row: deleting.row })
          }}
          onCancel={() => setDeleting(undefined)}
        >
          {deleting.row === 0
            ? "This is the file's first row, its header when Header row is on: the next row takes its place."
            : 'The row is removed from the file when you save it.'}
        </ConfirmDialog>
      )}
      {pasting?.text === text && (
        <ConfirmDialog
          isOpen
          title={`Add ${pasting.addRows} ${pasting.addRows === 1 ? 'row' : 'rows'} at the end?`}
          confirmLabel="Add and paste"
          onConfirm={() => {
            setPasting(undefined)
            act({
              kind: 'cells',
              cells: pasting.cells,
              addRows: pasting.addRows,
            })
          }}
          onCancel={() => setPasting(undefined)}
        >
          The block is longer than the rows left: empty rows go in at the end,
          then it is pasted.
        </ConfirmDialog>
      )}
      {deletingCol?.text === text && (
        <ConfirmDialog
          isOpen
          title={`Delete column ${cellText(names[deletingCol.col])}?`}
          confirmLabel="Delete column"
          destructive
          onConfirm={() => {
            setDeletingCol(undefined)
            act({ kind: 'delete-col', col: deletingCol.col })
          }}
          onCancel={() => setDeletingCol(undefined)}
        >
          {countText(deletingCol.values)} The column is removed from the file
          when you save it.
        </ConfirmDialog>
      )}
    </div>
  )
}
