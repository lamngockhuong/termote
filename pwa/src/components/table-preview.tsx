import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  type CsvTableState,
  useCsvRows,
  useCsvTable,
} from '../hooks/use-csv-table'
import {
  type CsvTable,
  cellsIn,
  type Delimiter,
  delimiterFor,
  valueAt,
} from '../utils/csv-parse'
import type { ViewOptions } from '../utils/csv-view'
import { CellSheet } from './cell-sheet'
import { CodeBlock } from './code-block'
import { ViewMessage } from './pane-dir-header'
import { cellText, MAX_CELL_CHARS, shownAt, TableGrid } from './table-grid'
import { TableRecords } from './table-records'
import { Banner } from './ui/banner'
import { Button, FOCUS_RING } from './ui/button'

// Columns rendered: a 1 MiB file of commas would otherwise be a million
export const MAX_COLUMNS = 200
// Rows read to size the columns
const WIDTH_ROWS = 200
const MIN_WIDTH = 4
const MAX_WIDTH = 32

const DELIMITER_NAMES: Record<Delimiter, string> = {
  ',': 'Comma',
  ';': 'Semicolon',
  '\t': 'Tab',
  '|': 'Pipe',
}

export interface TableState {
  ok: boolean
  delimiter: Delimiter
}

interface Props {
  text: string
  path: string
  // For the source shown when the table cannot be read
  wrap: boolean
  notify: (message: string) => void
  // The table was read (or not) with this delimiter: told after every parse
  onTableState?: (state: TableState) => void
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
// shown, never the file.
export default function TablePreview({
  text,
  path,
  wrap,
  notify,
  onTableState,
}: Props) {
  const [delimiter, setDelimiter] = useState(() => delimiterFor(path, text))
  const [header, setHeader] = useState(true)
  const [filterInput, setFilterInput] = useState('')
  const filter = useDeferredValue(filterInput)
  const [sort, setSort] = useState<ViewOptions['sort']>(null)
  const [records, setRecords] = useState(false)
  const [open, setOpen] = useState<{ row: number; col: number }>()
  const { parsed, client } = useCsvTable(text, delimiter)
  const computed = useCsvRows(parsed, client, sort, filter, header)

  useEffect(() => {
    if (parsed.status === 'parsing') return
    onTableState?.({
      ok: parsed.status === 'ready',
      delimiter: parsed.delimiter,
    })
  }, [parsed, onTableState])

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
      const name = header ? valueAt(text, table, 0, c, MAX_CELL_CHARS + 1) : ''
      return name || `Column ${c + 1}`
    })
  }, [text, table, header])
  const widths = useMemo(
    () => (table ? columnWidths(text, table, names) : []),
    [text, table, names],
  )

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
        <CodeBlock text={text} path={path} wrap={wrap} />
      </>
    )
  }
  const t = parsed.table
  if (!t.rowCount) return <ViewMessage>No rows</ViewMessage>

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
  const cell = open && {
    row: open.row,
    name: names[open.col],
    value: valueAt(text, t, open.row, open.col),
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-[13px]">
        <label className="flex items-center gap-1 text-fg-muted">
          Delimiter
          <select
            value={delimiter}
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
          text={text}
          table={t}
          rows={rows}
          names={names}
          onOpen={(row, col) => setOpen({ row, col })}
        />
      )}
      {!records && (
        <TableGrid
          text={text}
          table={t}
          rows={rows ?? new Int32Array()}
          names={names}
          widths={widths}
          header={header}
          expected={expected}
          sort={sort}
          onSort={toggleSort}
          onOpen={(row, col) => setOpen({ row, col })}
          busy={!computed}
        />
      )}
      <CellSheet
        cell={cell}
        onClose={() => setOpen(undefined)}
        notify={notify}
      />
    </div>
  )
}
