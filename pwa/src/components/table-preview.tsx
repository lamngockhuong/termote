import { ListPlus, Redo2, Undo2 } from 'lucide-react'
import {
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  type CsvTableState,
  useCsvRows,
  useCsvTable,
} from '../hooks/use-csv-table'
import {
  makeOp,
  redoOp,
  type TableAction,
  type TableOp,
  undoOp,
} from '../utils/csv-edits'
import {
  type CsvTable,
  cellsIn,
  DELIMITER_NAMES,
  type Delimiter,
  delimiterFor,
  valueAt,
} from '../utils/csv-parse'
import type { ViewOptions } from '../utils/csv-view'
import { CellEditSheet } from './cell-edit-sheet'
import { CellSheet } from './cell-sheet'
import { CodeBlock } from './code-block'
import { ViewMessage } from './pane-dir-header'
import { cellText, MAX_CELL_CHARS, shownAt, TableGrid } from './table-grid'
import { TableRecords } from './table-records'
import { Banner } from './ui/banner'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'

// Columns rendered: a 1 MiB file of commas would otherwise be a million
export const MAX_COLUMNS = 200
// Rows read to size the columns
const WIDTH_ROWS = 200
const MIN_WIDTH = 4
const MAX_WIDTH = 32

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
}

// Column widths in ch, from the first rows: the longest first line, clamped
function columnWidths(text: string, t: CsvTable, names: string[]): number[] {
  const rows = Math.min(t.rowCount, WIDTH_ROWS)
  return names.map((name, c) => {
    let w = cellText(name).length
    for (let r = 0; r < rows && w < MAX_WIDTH; r++) {
      w = Math.max(w, shownAt(text, t, r, c).length)
    }
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w))
  })
}

// A CSV/TSV file as a table: a virtual grid, or one record at a time.
// Sorting, filtering, the delimiter and the header row change only what is
// shown, never the file. While editing, a cell opens in a sheet that sets
// it; every edit is a patch of the text (csv-edits.ts), made only on the
// parse of that very text.
export default function TablePreview({
  text,
  path,
  wrap,
  notify,
  onTableState,
  editing,
}: Props) {
  const [chosen, setDelimiter] = useState(() => delimiterFor(path, text))
  const delimiter = editing?.delimiter ?? chosen
  const [header, setHeader] = useState(true)
  const [filterInput, setFilterInput] = useState('')
  const filter = useDeferredValue(filterInput)
  const [sort, setSort] = useState<ViewOptions['sort']>(null)
  const [records, setRecords] = useState(false)
  // The cell opened, and the text it was opened on: another text closes it
  const [open, setOpen] = useState<{ row: number; col: number; text: string }>()
  // The row a delete asks about
  const [deleting, setDeleting] = useState<number>()
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
    onTableState?.(
      current.status === 'parsing'
        ? undefined
        : { ok: current.status === 'ready', delimiter: current.delimiter },
    )
  }, [current, onTableState])

  useEffect(() => {
    setOpen((o) => (o && o.text !== text ? undefined : o))
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
  const widths = useMemo(
    () => (table ? columnWidths(shown, table, names) : []),
    [shown, table, names],
  )
  // Edits are taken only on the current parse of text, outside a save
  const live =
    editing && !editing.saving && !stale && table ? editing : undefined

  // Makes the action an op on text; the text it makes, if any
  const act = (a: TableAction): string | undefined => {
    if (!live) return
    const op = makeOp(text, table as CsvTable, a)
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
  // A new empty row after row `after`, its first cell opened
  const addRow = (after: number) => {
    const next = act({ kind: 'insert', after })
    if (next !== undefined) setOpen({ row: after + 1, col: 0, text: next })
  }
  const openCell = (row: number, col: number) => {
    if (!editing || live) setOpen({ row, col, text })
  }

  // The table's own keys; never one typed in a field or in a sheet (a
  // <dialog> in this tree, so its keys bubble here)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!editing || !(e.ctrlKey || e.metaKey)) return
    if ((e.target as HTMLElement).closest('dialog, input, textarea, select')) {
      return
    }
    const key = e.key.toLowerCase()
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
      value: valueAt(shown, t, open.row, open.col),
    }

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
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
              setDelimiter(e.target.value as Delimiter)
              setSort(null)
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
          onClick={() => setHeader((h) => !h)}
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
        </span>
        <Button
          size="sm"
          aria-pressed={records}
          onClick={() => setRecords((r) => !r)}
          className={records ? 'text-accent' : ''}
        >
          Records
        </Button>
      </div>
      {t.columnCount > MAX_COLUMNS && (
        <Banner variant="warning">
          Showing {MAX_COLUMNS} of {t.columnCount} columns. See all in Source
        </Banner>
      )}
      {records && !rows && <ViewMessage>Sorting and filtering…</ViewMessage>}
      {records && rows && (
        <TableRecords
          text={shown}
          table={t}
          rows={rows}
          names={names}
          onOpen={openCell}
        />
      )}
      {!records && (
        <TableGrid
          text={shown}
          table={t}
          rows={rows ?? new Int32Array()}
          names={names}
          widths={widths}
          header={header}
          expected={expected}
          sort={sort}
          onSort={toggleSort}
          onOpen={openCell}
          busy={!computed || stale}
        />
      )}
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
          onInsertBelow={() => addRow(cell.row)}
          onDelete={() => {
            setOpen(undefined)
            setDeleting(cell.row)
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
      {deleting !== undefined && (
        <ConfirmDialog
          isOpen
          title={`Delete row ${deleting + 1}?`}
          confirmLabel="Delete row"
          destructive
          onConfirm={() => {
            setDeleting(undefined)
            act({ kind: 'delete', row: deleting })
          }}
          onCancel={() => setDeleting(undefined)}
        >
          {deleting === 0
            ? "This is the file's first row, its header when Header row is on: the next row takes its place."
            : 'The row is removed from the file when you save it.'}
        </ConfirmDialog>
      )}
    </div>
  )
}
