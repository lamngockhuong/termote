// Edits of the table view as a list of operations. Each op keeps the patch
// it made (csv-patch.ts) to the text just before it, so undo is the inverse
// patch and never a parse of the whole file; and the values of the row it
// touched, so after the file changed on the host the op finds its row again
// by content, never by an index another writer may have shifted. A column
// op keeps a patch per row, and the column's name to find it by.
import {
  type CsvTable,
  cellsIn,
  type Delimiter,
  parseCsv,
  rowValues,
  valueAt,
} from './csv-parse'
import {
  applyPatch,
  applyPatches,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  invertPatch,
  invertPatches,
  type Patch,
  replaceCell,
  replaceCells,
} from './csv-patch'

// rowValues: every value of the row just before the op, its fingerprint
export type TableOp =
  | {
      kind: 'cell'
      row: number
      col: number
      // The column's name when the op was made, for messages
      name: string
      before: string
      after: string
      rowValues: string[]
      patch: Patch
    }
  | {
      kind: 'insert'
      // The row it follows (-1: first), and that row's values (null: first)
      after: number
      anchor: string[] | null
      values: string[]
      patch: Patch
    }
  | { kind: 'delete'; row: number; rowValues: string[]; patch: Patch }
  // name: the header of col when the op was made (null: no header row), to
  // find the column again; columns: the table's column count then
  | {
      kind: 'insert-col'
      // The column it was added next to, on side
      col: number
      side: 'left' | 'right'
      name: string | null
      columns: number
      patches: Patch[]
    }
  | {
      kind: 'delete-col'
      col: number
      name: string | null
      columns: number
      // Cells with a value that went with it, the header's not counted
      values: number
      patches: Patch[]
    }
  // A block pasted: the rows it set, then rows added at the end, each
  // with the cells set in it
  | {
      kind: 'cells'
      rows: CellsRow[]
      added: { col: number; after: string }[][]
      patches: Patch[]
    }

// The rows a block of cells set, each with its values before (to find it
// again) and its cells
export interface CellsRow {
  rowValues: string[]
  cells: { col: number; before: string; after: string }[]
}

export type TableAction =
  | { kind: 'cell'; row: number; col: number; name: string; value: string }
  | { kind: 'insert'; after: number }
  | { kind: 'delete'; row: number }
  | { kind: 'insert-col'; col: number; side: 'left' | 'right' }
  | { kind: 'delete-col'; col: number }
  // Cells set at once: a row past the last one is one of addRows rows
  // added at the end
  | {
      kind: 'cells'
      cells: { row: number; col: number; value: string }[]
      addRows?: number
    }

// Cells of column col with a value, from row first on
export function filledCells(
  text: string,
  t: CsvTable,
  col: number,
  first: number,
): number {
  let n = 0
  for (let r = first; r < t.rowCount; r++) {
    if (valueAt(text, t, r, col) !== '') n++
  }
  return n
}

// The op an action makes on text (parsed as t); undefined when it changes
// nothing (a cell set to its own value). header: row 0 names the columns.
export function makeOp(
  text: string,
  t: CsvTable,
  a: TableAction,
  header = false,
): TableOp | undefined {
  if (a.kind === 'cells') return cellsOp(text, t, a.cells, a.addRows ?? 0)
  if (a.kind === 'insert-col' || a.kind === 'delete-col') {
    const base = {
      col: a.col,
      // An empty name finds no column: by its place instead
      name: (header && valueAt(text, t, 0, a.col)) || null,
      columns: t.columnCount,
    }
    return a.kind === 'insert-col'
      ? {
          kind: 'insert-col',
          ...base,
          side: a.side,
          patches: insertColumn(t, a.col + (a.side === 'right' ? 1 : 0)),
        }
      : {
          kind: 'delete-col',
          ...base,
          values: filledCells(text, t, a.col, header ? 1 : 0),
          patches: deleteColumn(text, t, a.col),
        }
  }
  if (a.kind === 'cell') {
    const before = valueAt(text, t, a.row, a.col)
    if (before === a.value) return undefined
    return {
      kind: 'cell',
      row: a.row,
      col: a.col,
      name: a.name,
      before,
      after: a.value,
      rowValues: rowValues(text, t, a.row),
      patch: replaceCell(text, t, a.row, a.col, a.value),
    }
  }
  if (a.kind === 'insert') {
    const values: string[] = Array(Math.max(t.columnCount, 1)).fill('')
    return {
      kind: 'insert',
      after: a.after,
      anchor: a.after < 0 ? null : rowValues(text, t, a.after),
      values,
      patch: insertRow(text, t, a.after, values),
    }
  }
  return {
    kind: 'delete',
    row: a.row,
    rowValues: rowValues(text, t, a.row),
    patch: deleteRow(text, t, a.row),
  }
}

// A block of cells: the ones whose value changes in rows of t, then
// addRows rows at the end with theirs; undefined when nothing changes
function cellsOp(
  text: string,
  t: CsvTable,
  cells: { row: number; col: number; value: string }[],
  addRows: number,
): TableOp | undefined {
  const rows = new Map<number, CellsRow>()
  const set: typeof cells = []
  const added: { col: number; after: string }[][] = Array.from(
    { length: addRows },
    () => [],
  )
  for (const c of cells) {
    if (c.row >= t.rowCount) {
      added[c.row - t.rowCount].push({ col: c.col, after: c.value })
      continue
    }
    const before = valueAt(text, t, c.row, c.col)
    if (before === c.value) continue
    const row = rows.get(c.row) ?? {
      rowValues: rowValues(text, t, c.row),
      cells: [],
    }
    row.cells.push({ col: c.col, before, after: c.value })
    rows.set(c.row, row)
    set.push(c)
  }
  if (!set.length && !addRows) return undefined
  const patches = replaceCells(text, t, set)
  const lines = added.map((row) => {
    const values: string[] = Array(Math.max(t.columnCount, 1)).fill('')
    for (const c of row) values[c.col] = c.after
    return insertRow(text, t, t.rowCount - 1, values)
  })
  // No row yet (a reload on an empty file): one insert of every row, as
  // the inserts there carry no line break
  if (!t.rowCount && lines.length) {
    patches.push({
      ...lines[0],
      inserted: lines.map((p) => p.inserted).join(t.eol),
    })
  } else patches.push(...lines)
  return { kind: 'cells', rows: [...rows.values()], added, patches }
}

// A column op has a patch per row; any other, one
export function undoOp(text: string, op: TableOp): string {
  return 'patches' in op
    ? applyPatches(text, invertPatches(op.patches))
    : applyPatch(text, invertPatch(op.patch))
}

export function redoOp(text: string, op: TableOp): string {
  return 'patches' in op
    ? applyPatches(text, op.patches)
    : applyPatch(text, op.patch)
}

// The column of t a column op was made on: by its name in the header row
// (at its place, else the one column of that name), or with no header row
// at its place while the table has as many columns as then
function findColumn(
  text: string,
  t: CsvTable,
  op: { col: number; name: string | null; columns: number },
): number | 'column' | 'columns' {
  if (op.name === null) return t.columnCount === op.columns ? op.col : 'column'
  const width = t.rowCount ? cellsIn(t, 0) : 0
  if (op.col < width && valueAt(text, t, 0, op.col) === op.name) return op.col
  let found: number | 'column' = 'column'
  for (let c = 0; c < width; c++) {
    if (valueAt(text, t, 0, c) !== op.name) continue
    if (found !== 'column') return 'columns'
    found = c
  }
  return found
}

// The row of t whose values are exactly values: its index, or none, or many
export function findRow(
  text: string,
  t: CsvTable,
  values: string[],
): number | 'none' | 'many' {
  let found: number | 'none' = 'none'
  for (let r = 0; r < t.rowCount; r++) {
    if (cellsIn(t, r) !== values.length) continue
    let same = true
    for (let c = 0; c < values.length && same; c++) {
      same = valueAt(text, t, r, c) === values[c]
    }
    if (!same) continue
    if (found !== 'none') return 'many'
    found = r
  }
  return found
}

// Why an op was not applied again: its row is gone, several rows match it,
// its column is gone (or, with no header row, the columns changed), several
// columns have its name, it follows a row or column insert or delete that
// was not applied (it may target what that op made), or the new text is no
// table at all.
export type SkipReason =
  | 'missing'
  | 'many'
  | 'column'
  | 'columns'
  | 'depends'
  | 'unreadable'

export interface Skipped {
  op: TableOp
  reason: SkipReason
}

export type Reapplied =
  | { ok: true; text: string; ops: TableOp[]; skipped: Skipped[] }
  // The new text does not parse with this delimiter
  | { ok: false }

// The values of a row once a cell op is in it: a short row grows to col
function withCell(values: string[], col: number, value: string): string[] {
  const out = [...values]
  while (out.length <= col) out.push('')
  out[col] = value
  return out
}

// ops (made on another text) applied in order to base, the file as it is on
// the host now. Each finds its row by its values: exactly one match is
// applied, with a patch made on base; anything else is skipped and said why.
// A cell already holding the new value counts as applied, with nothing
// left to undo.
export function reapply(
  base: string,
  delimiter: Delimiter,
  ops: TableOp[],
): Reapplied {
  let text = base
  let t: CsvTable | undefined
  const applied: TableOp[] = []
  const skipped: Skipped[] = []
  let broken = false
  for (const op of ops) {
    if (broken) {
      skipped.push({ op, reason: 'depends' })
      continue
    }
    if (!t) {
      const res = parseCsv(text, delimiter)
      if (!res.ok) return { ok: false }
      t = res.table
    }
    let next: TableOp | undefined
    let reason: SkipReason | undefined
    if (op.kind === 'cells') {
      // Every row found once (or already holding its new values), or none
      const cells: { row: number; col: number; value: string }[] = []
      for (const row of op.rows) {
        const now = findRow(text, t, row.rowValues)
        const done = row.cells.reduce(
          (v, c) => withCell(v, c.col, c.after),
          row.rowValues,
        )
        const at = now === 'none' ? findRow(text, t, done) : now
        if (typeof at !== 'number') {
          reason = now === 'none' ? 'missing' : 'many'
          break
        }
        for (const c of row.cells)
          cells.push({ row: at, col: c.col, value: c.after })
      }
      if (reason) {
        // Rows it added may be what the ops after it set
        if (op.added.length) broken = true
      } else {
        const end = t.rowCount
        op.added.forEach((row, i) => {
          for (const c of row) {
            cells.push({ row: end + i, col: c.col, value: c.after })
          }
        })
        next = makeOp(text, t, {
          kind: 'cells',
          cells,
          addRows: op.added.length,
        })
        if (!next) continue
      }
    } else if (op.kind === 'insert-col' || op.kind === 'delete-col') {
      const col = findColumn(text, t, op)
      if (typeof col === 'number') {
        next = makeOp(
          text,
          t,
          op.kind === 'insert-col'
            ? { kind: 'insert-col', col, side: op.side }
            : { kind: 'delete-col', col },
          op.name !== null,
        )
      } else {
        reason = col
        broken = true
      }
    } else if (op.kind === 'cell') {
      const row = findRow(text, t, op.rowValues)
      if (typeof row === 'number') {
        // The row holds op.before at col (it matched), never op.after
        next = makeOp(text, t, {
          kind: 'cell',
          row,
          col: op.col,
          name: op.name,
          value: op.after,
        })
      } else if (
        row === 'none' &&
        typeof findRow(text, t, withCell(op.rowValues, op.col, op.after)) ===
          'number'
      ) {
        continue
      } else reason = row === 'none' ? 'missing' : row
    } else {
      const row =
        op.kind === 'insert'
          ? op.anchor && findRow(text, t, op.anchor)
          : findRow(text, t, op.rowValues)
      if (row === null) next = makeOp(text, t, { kind: 'insert', after: -1 })
      else if (typeof row !== 'number') {
        reason = row === 'none' ? 'missing' : row
        broken = true
      } else {
        next = makeOp(
          text,
          t,
          op.kind === 'insert'
            ? { kind: 'insert', after: row }
            : { kind: 'delete', row },
        )
      }
    }
    if (reason) {
      skipped.push({ op, reason })
      continue
    }
    const made = next as TableOp
    text = redoOp(text, made)
    t = undefined
    applied.push(made)
  }
  return { ok: true, text, ops: applied, skipped }
}
