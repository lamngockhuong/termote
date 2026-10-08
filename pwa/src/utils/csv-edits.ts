// Edits of the table view as a list of operations. Each op keeps the patch
// it made (csv-patch.ts) to the text just before it, so undo is the inverse
// patch and never a parse of the whole file; and the values of the row it
// touched, so after the file changed on the host the op finds its row again
// by content, never by an index another writer may have shifted.
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
  deleteRow,
  insertRow,
  invertPatch,
  type Patch,
  replaceCell,
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

export type TableAction =
  | { kind: 'cell'; row: number; col: number; name: string; value: string }
  | { kind: 'insert'; after: number }
  | { kind: 'delete'; row: number }

// The op an action makes on text (parsed as t); undefined when it changes
// nothing (a cell set to its own value).
export function makeOp(
  text: string,
  t: CsvTable,
  a: TableAction,
): TableOp | undefined {
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

export function undoOp(text: string, op: TableOp): string {
  return applyPatch(text, invertPatch(op.patch))
}

export function redoOp(text: string, op: TableOp): string {
  return applyPatch(text, op.patch)
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
// it follows a row insert or delete that was not applied (it may target the
// row that op made), or the new text is no table at all.
export type SkipReason = 'missing' | 'many' | 'depends' | 'unreadable'

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
    if (op.kind === 'cell') {
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
