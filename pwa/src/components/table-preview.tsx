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
import {
  type CsvTableState,
  useCsvRows,
  useCsvTable,
} from '../hooks/use-csv-table'
import { useMediaQuery } from '../hooks/use-media-query'
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
import {
  emptyLayout,
  FIT_BUDGET_MS,
  FIT_ROWS,
  fitWidths,
  initialWidths,
  type ReadCell,
  type TableLayout,
  WRAP_LINE_CHOICES,
  WRAP_LINES,
} from '../utils/table-columns'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { CellEditSheet } from './cell-edit-sheet'
import { CellSheet } from './cell-sheet'
import { CodeBlock } from './code-block'
import { type CellMove, InlineCellEditor } from './inline-cell-editor'
import { ViewMessage } from './pane-dir-header'
import { cellText, MAX_CELL_CHARS, shownAt, TableGrid } from './table-grid'
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
  // The cell after (or before) at in the order shown: on along its row,
  // then from the start of the next one; none past the last cell. Only
  // from a field on screen, so with the rows it is in.
  const neighbour = (at: OpenCell, move: CellMove) => {
    const order = computed as Int32Array
    const pos = order.indexOf(at.row)
    if (move === 'next') {
      if (at.col + 1 < names.length) return { row: at.row, col: at.col + 1 }
      return pos + 1 < order.length
        ? { row: order[pos + 1], col: 0 }
        : undefined
    }
    if (at.col > 0) return { row: at.row, col: at.col - 1 }
    return pos > 0 ? { row: order[pos - 1], col: names.length - 1 } : undefined
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
            onSelect={() =>
              fitColumns(
                names.map((_, c) => c),
                topRef.current,
              )
            }
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
            title="Keeps the first column at the left while the table scrolls sideways, unless it is wider than half the table"
            onSelect={() => setLayout({ ...layout, pinned: !layout.pinned })}
          >
            Pin first column
          </MenuItemCheckbox>
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
          wrapped={wrapped}
          lines={lines}
          header={header}
          expected={expected}
          sort={sort}
          onSort={toggleSort}
          onOpen={openCell}
          onType={canType ? typeIn : undefined}
          onClear={fine && live ? clearCell : undefined}
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
    </div>
  )
}
